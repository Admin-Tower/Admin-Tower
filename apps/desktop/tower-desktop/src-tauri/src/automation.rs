//! Fixed Ansible ping runner. No caller-supplied commands, variables or paths.
use crate::{
    inventory::{self, Host, Result, Store},
    ssh::{self, Environment},
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    os::unix::{fs::PermissionsExt, process::CommandExt},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const OUTPUT_LIMIT: u64 = 1024 * 1024;
const RUN_LIMIT: Duration = Duration::from_secs(600);
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostResult {
    pub host: Host,
    pub outcome: String,
    pub diagnostics: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub target_label: String,
    pub active: bool,
    pub elapsed_ms: u64,
    pub results: Vec<HostResult>,
    pub message: String,
}
struct Job {
    run: Arc<Mutex<Run>>,
    cancel: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}
#[derive(Default)]
pub struct Automation {
    job: Mutex<Option<Job>>,
}
impl Automation {
    /// Called once during native app setup, before the UI can start another run.
    pub fn startup(&self, store: &Store, environment: &Environment) -> Result<Option<Run>> {
        let hosts = store.list()?;
        if hosts.is_empty() {
            return Ok(None);
        }
        self.start(
            store,
            environment,
            &crate::inventory::AutomationTargets {
                host_ids: hosts.into_iter().map(|host| host.id).collect(),
                group_ids: Vec::new(),
            },
        )
        .map(Some)
    }

    pub fn latest(&self) -> Result<Option<Run>> {
        let job = self.job.lock().map_err(|_| "Automation unavailable.")?;
        job.as_ref()
            .map(|j| {
                j.run
                    .lock()
                    .map(|r| r.clone())
                    .map_err(|_| "Run unavailable.".into())
            })
            .transpose()
    }
    pub fn start(
        &self,
        store: &Store,
        environment: &Environment,
        targets: &crate::inventory::AutomationTargets,
    ) -> Result<Run> {
        self.start_with_limit(store, environment, targets, RUN_LIMIT)
    }
    pub(crate) fn start_with_limit(
        &self,
        store: &Store,
        environment: &Environment,
        targets: &crate::inventory::AutomationTargets,
        limit: Duration,
    ) -> Result<Run> {
        let mut slot = self.job.lock().map_err(|_| "Automation unavailable.")?;
        if let Some(job) = slot.as_ref() {
            if job.run.lock().map_err(|_| "Run unavailable.")?.active {
                return Err("A ping is already running.".into());
            }
        }
        let (target_label, hosts) = store.automation_snapshot(targets)?;
        if let Some(mut old) = slot.take() {
            if let Some(worker) = old.worker.take() {
                let _ = worker.join();
            }
        }
        let run = Run {
            id: uuid::Uuid::new_v4().to_string(),
            target_label,
            active: true,
            elapsed_ms: 0,
            message: String::new(),
            results: hosts
                .into_iter()
                .map(|host| HostResult {
                    host,
                    outcome: "waiting".into(),
                    diagnostics: String::new(),
                })
                .collect(),
        };
        let shared = Arc::new(Mutex::new(run.clone()));
        let cancel = Arc::new(AtomicBool::new(false));
        let (state, stop, env) = (shared.clone(), cancel.clone(), environment.clone());
        let worker = thread::Builder::new()
            .name("ansible-ping".into())
            .spawn(move || {
                let started = Instant::now();
                let result = execute(&state, &stop, &env, limit);
                let mut run = state.lock().unwrap_or_else(|e| e.into_inner());
                if let Err(error) = result {
                    run.message = error;
                }
                let message = if run.message.is_empty() {
                    "Ansible exited without a result for this host.".to_owned()
                } else {
                    run.message.clone()
                };
                let outcome = if stop.load(Ordering::SeqCst) {
                    "cancelled"
                } else if started.elapsed() >= limit {
                    "timed-out"
                } else {
                    "failed"
                };
                finish_pending(&mut run, outcome, &message);
                run.active = false;
                run.elapsed_ms = started.elapsed().as_millis() as u64;
            })
            .map_err(|_| "Cannot start automation worker.")?;
        *slot = Some(Job {
            run: shared,
            cancel,
            worker: Some(worker),
        });
        Ok(run)
    }
    pub fn cancel(&self, id: &str) -> Result<()> {
        let slot = self.job.lock().map_err(|_| "Automation unavailable.")?;
        let job = slot.as_ref().ok_or("No ping exists.")?;
        if job.run.lock().map_err(|_| "Run unavailable.")?.id != id {
            return Err("Run no longer exists.".into());
        }
        job.cancel.store(true, Ordering::SeqCst);
        Ok(())
    }
    pub fn shutdown(&self) {
        if let Ok(mut slot) = self.job.lock() {
            if let Some(mut job) = slot.take() {
                job.cancel.store(true, Ordering::SeqCst);
                if let Some(worker) = job.worker.take() {
                    let _ = worker.join();
                }
            }
        }
    }
}
impl Drop for Automation {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// The guard also kills descendants after normal exit, before private files are removed.
struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        // SAFETY: child was spawned with a new process group equal to its PID.
        unsafe {
            libc::kill(-(self.0.id() as i32), libc::SIGKILL);
        }
        let _ = self.0.wait();
    }
}
fn context(root: &Path) -> Result<Command> {
    let empty = root.join("plugins");
    fs::create_dir_all(&empty).map_err(|_| "Cannot create private plugin directory.")?;
    let config = String::from("[defaults]\nretry_files_enabled=False\nhost_key_checking=True\ncollections_scan_sys_path=False\nvars_plugins_enabled=\nstdout_callback=ansible.builtin.default\n[inventory]\nenable_plugins=ansible.builtin.yaml\n[privilege_escalation]\nbecome=False\n[ssh_connection]\npipelining=True\nssh_executable=/usr/bin/ssh\ntransfer_method=piped\n");
    // No home/system extension directories; builtin plugins remain available.
    fs::write(root.join("ansible.cfg"), config)
        .map_err(|_| "Cannot write Ansible configuration.")?;
    let mut command = Command::new("/usr/bin/ansible");
    command
        .env_clear()
        .current_dir(root)
        .process_group(0)
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", "C.UTF-8")
        .env("HOME", root)
        .env("TMPDIR", root)
        .env("PYTHONNOUSERSITE", "1")
        .env("ANSIBLE_CONFIG", root.join("ansible.cfg"))
        .env("ANSIBLE_HOME", root)
        .env("ANSIBLE_LOCAL_TEMP", root.join("tmp"))
        .env("ANSIBLE_COLLECTIONS_PATH", &empty)
        .env("ANSIBLE_NOCOLOR", "1")
        .env("SSH_ASKPASS_REQUIRE", "never")
        .stdin(Stdio::null());
    for kind in [
        "ACTION",
        "BECOME",
        "CACHE",
        "CALLBACK",
        "CONNECTION",
        "FILTER",
        "INVENTORY",
        "LOOKUP",
        "MODULE_UTILS",
        "STRATEGY",
        "TERMINAL",
        "TEST",
        "VARS",
    ] {
        command.env(format!("ANSIBLE_{kind}_PLUGINS"), &empty);
    }
    command
        .env("ANSIBLE_LIBRARY", &empty)
        .env("ANSIBLE_MODULE_UTILS", &empty);
    // Bound each local output/result file even between polling ticks.
    // SAFETY: only the async-signal-safe setrlimit syscall runs between fork and exec.
    unsafe {
        command.pre_exec(|| {
            let bound = libc::rlimit {
                rlim_cur: OUTPUT_LIMIT,
                rlim_max: OUTPUT_LIMIT,
            };
            if libc::setrlimit(libc::RLIMIT_FSIZE, &bound) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Ok(command)
}
fn private_root() -> Result<tempfile::TempDir> {
    tempfile::Builder::new()
        .prefix(&format!("admin-tower-ping-{}-", std::process::id()))
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir_in("/tmp")
        .map_err(|_| "Cannot allocate private automation directory.".into())
}
pub fn availability() -> Result<String> {
    let root = private_root()?;
    let output = tempfile::tempfile().map_err(|_| "Cannot capture Ansible version.")?;
    let mut command = context(root.path())?;
    let mut child = Process(
        command
            .arg("--version")
            .stdout(output.try_clone().map_err(|e| e.to_string())?)
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| {
                "Cannot run /usr/bin/ansible. Install ansible-core outside Admin-Tower."
            })?,
    );
    let start = Instant::now();
    loop {
        if let Some(status) = child.0.try_wait().map_err(|e| e.to_string())? {
            if !status.success() {
                return Err("/usr/bin/ansible is unusable. Check its installation.".into());
            }
            return Ok(read_output(output)?
                .lines()
                .next()
                .unwrap_or("Ansible available")
                .to_owned());
        }
        if start.elapsed() > Duration::from_secs(5)
            || output.metadata().map_err(|e| e.to_string())?.len() > OUTPUT_LIMIT
        {
            return Err("Ansible availability check exceeded its limits.".into());
        }
        thread::sleep(Duration::from_millis(50));
    }
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
fn host_variables(host: &Host, prepared: &ssh::Prepared) -> Value {
    // Drop only the terminal destination, retaining all hardened SSH options.
    let args = prepared.arguments[..prepared.arguments.len() - 2]
        .iter()
        .map(|arg| quote(&arg.to_string_lossy()))
        .collect::<Vec<_>>()
        .join(" ");
    json!({"ansible_host": host.settings.address, "ansible_user": host.settings.username,
        "ansible_port": host.settings.port, "ansible_connection": "ansible.builtin.ssh",
        "ansible_become": false, "ansible_ssh_args": format!("-o BatchMode=yes {args}"),
        "ansible_ssh_common_args": "", "ansible_ssh_extra_args": "",
        "ansible_ssh_executable": "/usr/bin/ssh", "ansible_pipelining": true,
        "ansible_ssh_transfer_method": "piped", "ansible_python_interpreter": "auto_silent"})
}
fn read_output(mut file: fs::File) -> Result<String> {
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(OUTPUT_LIMIT)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
fn classify(value: Value) -> (String, String) {
    let outcome = if value.get("timedout").is_some_and(Value::is_object) {
        "timed-out"
    } else if value.get("unreachable") == Some(&Value::Bool(true)) {
        "unreachable"
    } else if value.get("failed") == Some(&Value::Bool(true)) {
        "failed"
    } else if value.get("ping").and_then(Value::as_str) == Some("pong") {
        "successful"
    } else {
        "failed"
    };
    let mut diagnostics = serde_json::to_string_pretty(&value).unwrap_or_default();
    if outcome == "unreachable" {
        diagnostics = format!("Verify host trust and SSH access outside Admin-Tower. Authentication cannot prompt: for a passphrase-protected key, load it into your SSH agent and select that agent identity.\n\n{diagnostics}");
    }
    (outcome.into(), diagnostics.chars().take(16_384).collect())
}
fn finish_pending(run: &mut Run, outcome: &str, diagnostics: &str) {
    for host in &mut run.results {
        if host.outcome == "waiting" {
            host.outcome = outcome.to_owned();
            host.diagnostics = diagnostics.to_owned();
        }
    }
}
fn collect(run: &mut Run, tree: &Path, final_read: bool) {
    for (index, host) in run.results.iter_mut().enumerate() {
        if host.outcome != "waiting" {
            continue;
        }
        let path = tree.join(format!("host_{index}"));
        let Ok(file) = fs::File::open(path) else {
            continue;
        };
        let mut bytes = Vec::new();
        let parsed = file
            .take(OUTPUT_LIMIT + 1)
            .read_to_end(&mut bytes)
            .ok()
            .map(|_| bytes)
            .filter(|b| b.len() as u64 <= OUTPUT_LIMIT)
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
        if let Some(value) = parsed {
            (host.outcome, host.diagnostics) = classify(value);
        } else if final_read {
            host.outcome = "failed".into();
            host.diagnostics = "Malformed or oversized Ansible result.".into();
        }
    }
}
fn execute(
    state: &Arc<Mutex<Run>>,
    cancel: &AtomicBool,
    environment: &Environment,
    limit: Duration,
) -> Result<()> {
    let started = Instant::now();
    let root = private_root()?;
    let tree = root.path().join("results");
    inventory::private_dir(&tree)?;
    let hosts = state
        .lock()
        .unwrap()
        .results
        .iter()
        .map(|r| r.host.clone())
        .collect::<Vec<_>>();
    let mut variables = serde_json::Map::new();
    let mut identities = Vec::new();
    for (index, host) in hosts.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Ok(());
        }
        if started.elapsed() >= limit {
            return Err("Group ping exceeded its overall time limit during preparation.".into());
        }
        match ssh::prepare(host, environment, root.path()) {
            Ok(prepared) => {
                variables.insert(format!("host_{index}"), host_variables(host, &prepared));
                identities.push(prepared);
            }
            Err(error) => {
                let mut run = state.lock().unwrap();
                run.results[index].outcome = "failed".into();
                run.results[index].diagnostics = error;
            }
        }
    }
    if variables.is_empty() {
        return Ok(());
    }
    let inventory = root.path().join("inventory.json");
    fs::write(
        &inventory,
        serde_json::to_vec(&json!({"all": {"hosts": variables}})).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    let output = tempfile::tempfile().map_err(|e| e.to_string())?;
    let mut command = context(root.path())?;
    command
        .args([
            "all",
            "-m",
            "ansible.builtin.ping",
            "-f",
            "5",
            "-T",
            "15",
            "--task-timeout",
            "60",
            "-i",
        ])
        .arg(&inventory)
        .arg("--tree")
        .arg(&tree)
        .stdout(output.try_clone().map_err(|e| e.to_string())?)
        .stderr(output.try_clone().map_err(|e| e.to_string())?);
    let mut child =
        Process(command.spawn().map_err(|_| {
            "Cannot run /usr/bin/ansible. Install ansible-core outside Admin-Tower."
        })?);
    let reason = loop {
        let mut run = state.lock().unwrap();
        collect(&mut run, &tree, false);
        run.elapsed_ms = started.elapsed().as_millis() as u64;
        drop(run);
        if cancel.load(Ordering::SeqCst) {
            break "cancelled";
        }
        if started.elapsed() >= limit {
            break "timed-out";
        }
        if output.metadata().map_err(|e| e.to_string())?.len() > OUTPUT_LIMIT {
            break "output-limit";
        }
        if child.0.try_wait().map_err(|e| e.to_string())?.is_some() {
            break "exited";
        }
        thread::sleep(Duration::from_millis(100));
    };
    drop(child);
    let mut run = state.lock().unwrap();
    collect(&mut run, &tree, true);
    let outcome = match reason {
        "cancelled" => "cancelled",
        "timed-out" => "timed-out",
        _ => "failed",
    };
    finish_pending(&mut run, outcome, &format!("Ansible {reason} without a result. Check host trust, selected identity and remote Python. Authentication is noninteractive."));
    if run.results.iter().any(|h| h.outcome != "successful") {
        run.message = read_output(output)?.chars().take(16_384).collect();
    }
    drop(identities);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_skips_empty_inventory_and_snapshots_every_saved_host() {
        let root = tempfile::tempdir().unwrap();
        let store = Store {
            directory: root.path().join("inventory"),
        };
        let environment = Environment {
            home: root.path().join("empty-home"),
            agent_socket: None,
        };
        let automation = Automation::default();
        assert!(automation.startup(&store, &environment).unwrap().is_none());
        assert!(automation.latest().unwrap().is_none());
        let mut ids = Vec::new();
        for address in ["192.0.2.1", "192.0.2.2"] {
            let host = store
                .save(
                    None,
                    crate::inventory::HostInput {
                        name: "Duplicate name".into(),
                        address: address.into(),
                        username: "fixture".into(),
                        port: 2222,
                        authentication: crate::inventory::Authentication::KeyFile {
                            filename: "missing-fixture-key".into(),
                        },
                    },
                )
                .unwrap();
            ids.push(host.id);
        }
        let run = automation.startup(&store, &environment).unwrap().unwrap();
        assert_eq!(run.results.len(), 2);
        assert!(run
            .results
            .iter()
            .all(|result| ids.contains(&result.host.id) && result.outcome == "waiting"));
        automation.shutdown();
    }

    #[test]
    fn structured_results_never_infer_success_from_messages() {
        for value in [
            json!({"msg":"pong"}),
            json!({"failed":true,"ping":"pong"}),
            json!(null),
            json!({}),
        ] {
            assert_eq!(classify(value).0, "failed");
        }
        assert_eq!(classify(json!({"ping":"pong"})).0, "successful");
        assert_eq!(
            classify(json!({"failed":true,"timedout":{"period":60}})).0,
            "timed-out"
        );
        assert_eq!(classify(json!({"unreachable":true})).0, "unreachable");
    }
    #[test]
    fn inventory_keeps_ipv6_ports_and_literal_key_paths_without_display_names() {
        let root = private_root().unwrap();
        let home = root.path().join("home with spaces");
        inventory::private_dir(&home.join(".ssh")).unwrap();
        for name in ["key with spaces", "known_hosts"] {
            let path = home.join(".ssh").join(name);
            fs::write(&path, "fixture metadata only").unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        let host = Host {
            id: uuid::Uuid::new_v4().to_string(),
            settings: crate::inventory::HostInput {
                name: "{{ lookup('pipe', 'invalid') }}".into(),
                address: "2001:db8::1".into(),
                username: "fixture".into(),
                port: 2222,
                authentication: crate::inventory::Authentication::KeyFile {
                    filename: "key with spaces".into(),
                },
            },
        };
        let env = Environment {
            home: home.clone(),
            agent_socket: None,
        };
        let prepared = ssh::prepare(&host, &env, root.path()).unwrap();
        let vars = host_variables(&host, &prepared);
        assert_eq!(vars["ansible_host"], "2001:db8::1");
        assert_eq!(vars["ansible_port"], 2222);
        assert_eq!(vars["ansible_become"], false);
        let args = vars["ansible_ssh_args"].as_str().unwrap();
        assert!(args.contains(&quote(home.join(".ssh/key with spaces").to_str().unwrap())));
        assert!(args.contains("'StrictHostKeyChecking=yes'"));
        assert!(args.contains("'IdentityAgent=\"none\"'"));
        assert!(args.contains("'-p' '2222' '-l' 'fixture'"));
        assert!(!args.contains("2001:db8::1"));
        assert!(!vars.to_string().contains("lookup"));
        let command = context(root.path()).unwrap();
        assert_eq!(command.get_program(), "/usr/bin/ansible");
        let env = command
            .get_envs()
            .filter_map(|(k, v)| {
                v.map(|v| {
                    (
                        k.to_string_lossy().into_owned(),
                        v.to_string_lossy().into_owned(),
                    )
                })
            })
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(env["HOME"], root.path().to_str().unwrap());
        assert!(!env.contains_key("SSH_AUTH_SOCK"));
        assert!(!env.contains_key("PYTHONPATH"));
        assert!(env["ANSIBLE_CONFIG"].starts_with(root.path().to_str().unwrap()));
    }

    #[test]
    fn partial_json_waits_then_malformed_results_fail() {
        let root = tempfile::tempdir().unwrap();
        let host = Host {
            id: "id".into(),
            settings: crate::inventory::HostInput {
                name: "same name".into(),
                address: "::1".into(),
                username: "fixture".into(),
                port: 2222,
                authentication: crate::inventory::Authentication::KeyFile {
                    filename: "key with spaces".into(),
                },
            },
        };
        let mut run = Run {
            id: "run".into(),
            target_label: "Group".into(),
            active: true,
            elapsed_ms: 0,
            message: String::new(),
            results: vec![HostResult {
                host,
                outcome: "waiting".into(),
                diagnostics: String::new(),
            }],
        };
        let mut missing = run.clone();
        collect(&mut missing, root.path(), true);
        finish_pending(&mut missing, "failed", "No result after exit");
        assert_eq!(missing.results[0].outcome, "failed");
        for outcome in ["cancelled", "timed-out"] {
            let mut interrupted = run.clone();
            interrupted.results.push(HostResult {
                host: run.results[0].host.clone(),
                outcome: "successful".into(),
                diagnostics: "pong".into(),
            });
            finish_pending(&mut interrupted, outcome, "Run stopped");
            assert_eq!(interrupted.results[0].outcome, outcome);
            assert_eq!(interrupted.results[1].outcome, "successful");
        }
        fs::write(root.path().join("host_0"), "{").unwrap();
        collect(&mut run, root.path(), false);
        assert_eq!(run.results[0].outcome, "waiting");
        collect(&mut run, root.path(), true);
        assert_eq!(run.results[0].outcome, "failed");
    }
}
