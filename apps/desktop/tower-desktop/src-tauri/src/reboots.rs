//! Reviewed Ubuntu reboots with durable dispatch and observation-only recovery.
use crate::{
    automation,
    inventory::{self, AutomationTargets, Host, Result, Store},
    ssh::{self, Environment},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{fd::AsRawFd, unix::fs::OpenOptionsExt},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

const JOURNAL: &str = "reboots.json";
const LIMIT: u64 = 4 * 1024 * 1024;
const HELPER: &str = include_str!("ubuntu_reboot.py");

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub boot_id: String,
    pub requested_by: Vec<String>,
    #[serde(default)]
    pub ssh_startup: String,
    pub os: String,
    pub created_at: u64,
    pub failed_services: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostResult {
    pub host: Host,
    pub state: String,
    pub message: String,
    pub plan: Option<Plan>,
    pub boot_id: String,
    pub reboot_required: bool,
    #[serde(default)]
    pub logs: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub target_label: String,
    pub phase: String,
    pub active: bool,
    pub stop_requested: bool,
    pub results: Vec<HostResult>,
}
impl Run {
    pub(crate) fn unresolved(&self) -> bool {
        self.results
            .iter()
            .any(|r| matches!(r.state.as_str(), "launching" | "running" | "unknown"))
    }
    fn recover(&mut self) {
        if !self.active {
            return;
        }
        self.active = false;
        self.stop_requested = true;
        for result in &mut self.results {
            match result.state.as_str() {
                "launching" | "running" => {
                    result.state = "unknown".into();
                    result.message = "The desktop stopped monitoring. Refresh remote status before another reboot.".into();
                }
                "waiting" => {
                    result.state = "failed".into();
                    result.message = "Preview interrupted. Preview again.".into();
                }
                "ready" if self.phase == "apply" => {
                    result.state = "skipped".into();
                    result.message = "Not started; rollout interrupted.".into();
                }
                _ => {}
            }
        }
        self.phase = "finished".into();
    }
}
#[derive(Default)]
struct Session {
    run: Option<Run>,
    lock: Option<File>,
    closing: bool,
    persistence_error: Option<String>,
}
#[derive(Default)]
pub struct Reboots {
    session: Arc<Mutex<Session>>,
}

fn save(directory: &Path, run: &Run) -> Result<()> {
    // Live output is session-only; keep the durable reboot journal bounded.
    let mut durable = run.clone();
    for result in &mut durable.results {
        result.logs.clear();
    }
    let bytes = serde_json::to_vec(&durable).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > LIMIT {
        return Err("Reboot results exceed the journal size limit.".into());
    }
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    file.persist(directory.join(JOURNAL))
        .map_err(|e| e.to_string())?;
    File::open(directory)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())
}
fn initialize(session: &mut Session, directory: &Path) -> Result<()> {
    if let Some(error) = &session.persistence_error {
        return Err(error.clone());
    }
    if session.lock.is_some() {
        return Ok(());
    }
    inventory::private_dir(directory)?;
    let lock_path = directory.join("reboots.lock");
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&lock_path)
        .map_err(|e| e.to_string())?;
    inventory::protected_file(&lock_path, true)?;
    // SAFETY: the file remains owned by this Session for the entire app lifetime.
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("Reboots are managed by another Admin-Tower instance.".into());
    }
    let path = directory.join(JOURNAL);
    if path.try_exists().map_err(|e| e.to_string())? {
        let mut bytes = Vec::new();
        inventory::protected_file(&path, true)?
            .take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > LIMIT {
            return Err("Reboot journal is too large; preserved for recovery.".into());
        }
        let mut run: Run = serde_json::from_slice(&bytes)
            .map_err(|_| "Cannot read reboot journal; preserved for recovery.")?;
        inventory::validate_id(&run.id)?;
        for result in &run.results {
            inventory::validate_host(&result.host.settings)?;
        }
        run.recover();
        save(directory, &run)?;
        session.run = Some(run);
    }
    session.lock = Some(lock);
    Ok(())
}
impl Reboots {
    pub fn latest(&self, store: &Store) -> Result<Option<Run>> {
        let mut session = self.session.lock().map_err(|_| "Reboots unavailable.")?;
        initialize(&mut session, &store.directory)?;
        Ok(session.run.clone())
    }
    pub fn preview(
        &self,
        store: &Store,
        env: &Environment,
        targets: &AutomationTargets,
    ) -> Result<Run> {
        let mut session = self.session.lock().map_err(|_| "Reboots unavailable.")?;
        initialize(&mut session, &store.directory)?;
        if session.closing
            || session
                .run
                .as_ref()
                .is_some_and(|r| r.active || r.unresolved())
        {
            return Err("A reboot is active or unconfirmed. Refresh its status first.".into());
        }
        let (target_label, hosts) = store.automation_snapshot(targets)?;
        let run = Run {
            id: uuid::Uuid::new_v4().to_string(),
            target_label,
            phase: "preview".into(),
            active: true,
            stop_requested: false,
            results: hosts
                .into_iter()
                .map(|host| HostResult {
                    host,
                    state: "waiting".into(),
                    message: String::new(),
                    plan: None,
                    boot_id: String::new(),
                    reboot_required: false,
                    logs: String::new(),
                })
                .collect(),
        };
        save(&store.directory, &run)?;
        session.run = Some(run.clone());
        self.spawn(
            &mut session,
            store.directory.clone(),
            env.clone(),
            "preview",
        )?;
        Ok(run)
    }
    pub fn apply(&self, store: &Store, env: &Environment, id: &str) -> Result<Run> {
        let mut session = self.session.lock().map_err(|_| "Reboots unavailable.")?;
        initialize(&mut session, &store.directory)?;
        if session.closing {
            return Err("Application is closing.".into());
        }
        let run = session.run.as_mut().ok_or("Preview reboots first.")?;
        if run.id != id
            || run.active
            || run.phase != "review"
            || run.results.iter().any(|r| r.state != "ready")
        {
            return Err("A complete, successful preview is required.".into());
        }
        for result in &run.results {
            let current = store.get(&result.host.id)?;
            if serde_json::to_value(&current).ok() != serde_json::to_value(&result.host).ok() {
                return Err("Inventory changed since preview. Preview again.".into());
            }
            let plan = result.plan.as_ref().ok_or("Missing reboot review.")?;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_secs();
            if now < plan.created_at || now - plan.created_at > 900 {
                return Err("Preview expired. Preview again.".into());
            }
        }
        run.phase = "apply".into();
        run.active = true;
        run.stop_requested = false;
        save(&store.directory, run)?;
        let accepted = run.clone();
        self.spawn(&mut session, store.directory.clone(), env.clone(), "apply")?;
        Ok(accepted)
    }
    pub fn refresh(&self, store: &Store, env: &Environment, id: &str) -> Result<Run> {
        let mut session = self.session.lock().map_err(|_| "Reboots unavailable.")?;
        initialize(&mut session, &store.directory)?;
        let run = session.run.as_mut().ok_or("No reboot run exists.")?;
        if run.id != id || run.active {
            return Err("Run changed or is already being monitored.".into());
        }
        run.active = true;
        save(&store.directory, run)?;
        let accepted = run.clone();
        self.spawn(&mut session, store.directory.clone(), env.clone(), "status")?;
        Ok(accepted)
    }
    pub fn stop(&self, store: &Store, id: &str) -> Result<()> {
        let mut session = self.session.lock().map_err(|_| "Reboots unavailable.")?;
        initialize(&mut session, &store.directory)?;
        let run = session.run.as_mut().ok_or("No reboot run exists.")?;
        if run.id != id {
            return Err("Run changed.".into());
        }
        run.stop_requested = true;
        save(&store.directory, run)
    }
    pub fn shutdown(&self) {
        if let Ok(mut session) = self.session.lock() {
            session.closing = true;
        }
    }
    fn spawn(
        &self,
        session: &mut Session,
        directory: PathBuf,
        env: Environment,
        mode: &'static str,
    ) -> Result<()> {
        let shared = self.session.clone();
        let error_directory = directory.clone();
        if thread::Builder::new()
            .name("ubuntu-reboots".into())
            .spawn(move || {
                let execution = execute(&shared, &directory, &env, mode, |host, env, action, id, boot_id| {
                    remote(&shared, host, env, action, id, boot_id)
                });
                let mut session = shared.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(run) = &mut session.run {
                    if let Err(error) = execution {
                        for result in &mut run.results {
                            if matches!(
                                result.state.as_str(),
                                "waiting" | "ready" | "launching" | "running"
                            ) {
                                result.state =
                                    if matches!(result.state.as_str(), "launching" | "running") {
                                        "unknown"
                                    } else {
                                        "failed"
                                    }
                                    .into();
                                result.message = error.clone();
                            }
                        }
                    }
                    run.active = false;
                    if mode == "apply" {
                        for result in &mut run.results {
                            if result.state == "ready" {
                                result.state = "skipped".into();
                                result.message = "Not started; rollout stopped.".into();
                            }
                        }
                    }
                    run.phase =
                        if mode == "preview" && run.results.iter().all(|r| r.state == "ready") {
                            "review"
                        } else {
                            "finished"
                        }
                        .into();
                    if let Err(error) = save(&directory, run) {
                        // The last durable record remains unresolved on restart.
                        log::error!("Could not persist reboot results: {error}");
                        session.persistence_error = Some(format!("Reboot journal could not be saved: {error}. Restart to recover before another reboot."));
                    }
                }
            })
            .is_err()
        {
            if let Some(run) = &mut session.run {
                run.recover();
                save(&error_directory, run).ok();
            }
            return Err(
                "Cannot start reboot worker. Reopen Admin-Tower to recover its journal.".into(),
            );
        }
        Ok(())
    }
}

fn execute<F>(
    shared: &Arc<Mutex<Session>>,
    directory: &Path,
    env: &Environment,
    mode: &str,
    mut remote: F,
) -> Result<()>
where
    F: FnMut(&Host, &Environment, &str, &str, &str) -> Result<Value>,
{
    let snapshot = shared
        .lock()
        .map_err(|_| "Run unavailable.")?
        .run
        .clone()
        .ok_or("No run.")?;
    let mut halt = false;
    for (index, original) in snapshot.results.iter().enumerate() {
        if mode == "status"
            && !matches!(original.state.as_str(), "unknown" | "running" | "launching")
        {
            continue;
        }
        {
            let mut session = shared.lock().map_err(|_| "Run unavailable.")?;
            if session.closing {
                break;
            }
            let run = session.run.as_mut().ok_or("No run.")?;
            if mode != "status" && (halt || run.stop_requested) {
                run.results[index].state = "skipped".into();
                run.results[index].message = "Not started; rollout stopped.".into();
                save(directory, run)?;
                continue;
            }
            if mode == "apply" {
                run.results[index].state = "launching".into();
                save(directory, run)?;
            }
        }
        let result = remote(&original.host, env, mode, &snapshot.id, &original.boot_id);
        let mut session = shared.lock().map_err(|_| "Run unavailable.")?;
        let run = session.run.as_mut().ok_or("No run.")?;
        update_result(&mut run.results[index], &result, mode)?;
        halt = !matches!(run.results[index].state.as_str(), "successful" | "ready");
        save(directory, run)?;
    }
    Ok(())
}
fn update_result(host: &mut HostResult, result: &Result<Value>, mode: &str) -> Result<()> {
    match result {
        Err(error) => {
            host.state = if mode == "preview" {
                "failed"
            } else {
                "unknown"
            }
            .into();
            host.message = error.clone();
        }
        Ok(value) => {
            let state = value["state"]
                .as_str()
                .ok_or("Missing remote result state.")?;
            if !matches!(
                state,
                "ready" | "running" | "successful" | "failed" | "unknown"
            ) || (mode != "preview" && state == "ready")
            {
                return Err("Unexpected remote result state.".into());
            }
            host.message = value["message"]
                .as_str()
                .unwrap_or_default()
                .chars()
                .take(8000)
                .collect();
            host.reboot_required = value["rebootRequired"]
                .as_bool()
                .unwrap_or(host.reboot_required);
            if state == "ready" {
                host.plan = Some(
                    serde_json::from_value(value["plan"].clone())
                        .map_err(|_| "Invalid reboot review.")?,
                );
                let boot_id = &host.plan.as_ref().unwrap().boot_id;
                inventory::validate_id(boot_id)?;
                host.boot_id = boot_id.clone();
            }
            host.state = state.into();
        }
    }
    Ok(())
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn remote(
    shared: &Arc<Mutex<Session>>,
    host: &Host,
    env: &Environment,
    action: &str,
    id: &str,
    boot_id: &str,
) -> Result<Value> {
    inventory::validate_id(id)?;
    if !matches!(action, "preview" | "apply" | "status") {
        return Err("Invalid reboot action.".into());
    }
    if action != "preview" {
        inventory::validate_id(boot_id)?;
    }
    let root = automation::private_root()?;
    let prepared = ssh::prepare(host, env, root.path())?;
    let mut variables = automation::host_variables(host, &prepared);
    variables["ansible_become"] = json!(true);
    variables["ansible_become_method"] = json!("sudo");
    variables["ansible_become_user"] = json!("root");
    variables["ansible_become_flags"] = json!("-H -S -n");
    let original = shared
        .lock()
        .map_err(|_| "Reboot unavailable.")?
        .run
        .as_ref()
        .and_then(|r| r.results.iter().find(|r| r.host.id == host.id))
        .cloned()
        .ok_or("Reboot host unavailable.")?;
    let prefix = format!("{}\n--- {} ---\n", original.logs, action);
    let mut logs = |output: String| {
        let text = format!("{prefix}{output}");
        let bytes = text.as_bytes();
        let tail =
            String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(65536)..]).into_owned();
        if let Ok(mut session) = shared.lock() {
            if let Some(run) = &mut session.run {
                if run.id == id {
                    if let Some(result) = run.results.iter_mut().find(|r| r.host.id == host.id) {
                        result.logs = tail;
                    }
                }
            }
        }
    };
    if action == "apply" {
        let plan = original.plan.as_ref().ok_or("Review reboot first.")?;
        let args = reboot_arguments(id, boot_id, plan.created_at)?;
        // Failure after dispatch is ambiguous. Recovery only observes; it never calls this module.
        invoke(
            root.path(),
            variables.clone(),
            "ansible.builtin.reboot",
            args,
            Duration::from_secs(1230),
            &mut logs,
        )?;
        return remote(shared, host, env, "status", id, boot_id);
    }
    let script = root.path().join("ubuntu_reboot.py");
    fs::write(&script, HELPER).map_err(|e| e.to_string())?;
    let probe = if action == "preview" {
        "preview"
    } else {
        "status"
    };
    let args = json!({"cmd": format!("{} {probe} {id} {boot_id}", script.display()), "executable": "/usr/bin/python3"});
    let value = invoke(
        root.path(),
        variables,
        "ansible.builtin.script",
        args,
        Duration::from_secs(90),
        &mut logs,
    )?;
    let mut result = value["stdout"]
        .as_str()
        .unwrap_or_default()
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line).ok())
        .ok_or("Invalid reboot response.")?;
    if result["state"] == "successful" {
        let new: Plan = serde_json::from_value(result["plan"].clone())
            .map_err(|_| "Invalid reboot verification.")?;
        if new.boot_id == boot_id {
            return Err("A new boot has not been verified.".into());
        }
        let before = original
            .plan
            .as_ref()
            .ok_or("Missing original reboot review.")?;
        let failures: Vec<_> = new
            .failed_services
            .iter()
            .filter(|name| !before.failed_services.contains(name))
            .collect();
        if !failures.is_empty() {
            result["state"] = json!("failed");
            result["message"] = json!(format!("New boot verified, but additional services failed: {}. Remaining hosts were stopped.", failures.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")));
        }
    }
    Ok(result)
}

fn reboot_arguments(id: &str, boot_id: &str, created_at: u64) -> Result<Value> {
    inventory::validate_id(id)?;
    inventory::validate_id(boot_id)?;
    Ok(json!({
        "reboot_command": format!("/usr/bin/python3 -c {} reboot {id} {boot_id} {created_at}", quote(HELPER)),
        "boot_time_command": "/usr/bin/cat /proc/sys/kernel/random/boot_id",
        "test_command": r#"/bin/sh -c 's=$(/usr/bin/systemctl is-system-running); [ "$s" = running ] || [ "$s" = degraded ]'"#,
        "connect_timeout": 5,
        "reboot_timeout": 600
    }))
}

fn invoke(
    root: &Path,
    variables: Value,
    module: &str,
    args: Value,
    limit: Duration,
    logs: &mut dyn FnMut(String),
) -> Result<Value> {
    fs::write(
        root.join("inventory.json"),
        serde_json::to_vec(&json!({"all":{"hosts":{"target":variables}}})).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    let tree = root.join(uuid::Uuid::new_v4().to_string());
    inventory::private_dir(&tree)?;
    let output = tempfile::tempfile().map_err(|e| e.to_string())?;
    let mut command = automation::context(root)?;
    let mut process = automation::Process(
        command
            .args([
                "target",
                "-i",
                "inventory.json",
                "-m",
                module,
                "-a",
                &args.to_string(),
                "-vvv",
                "-T",
                "15",
                "--tree",
            ])
            .arg(&tree)
            .stdout(output.try_clone().map_err(|e| e.to_string())?)
            .stderr(output.try_clone().map_err(|e| e.to_string())?)
            .spawn()
            .map_err(|_| {
                "Cannot run /usr/bin/ansible. Install ansible-core outside Admin-Tower."
            })?,
    );
    let started = Instant::now();
    let status = loop {
        logs(automation::log_tail(&output)?);
        if let Some(status) = process.0.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if started.elapsed() > limit {
            return Err(
                "Reboot monitoring timed out. Refresh remote status; do not submit another reboot."
                    .into(),
            );
        }
        thread::sleep(Duration::from_millis(150));
    };
    drop(process);
    logs(automation::log_tail(&output)?);
    let mut bytes = Vec::new();
    File::open(tree.join("target"))
        .map_err(|_| {
            "Ansible did not return a reboot result. Refresh status if dispatch was started."
        })?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 1024 * 1024 {
        return Err("Oversized Ansible reboot result.".into());
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid Ansible reboot result.")?;
    if !status.success()
        || value["failed"] == true
        || value["unreachable"] == true
        || value["rc"].as_i64().is_some_and(|rc| rc != 0)
    {
        return Err(value["msg"]
            .as_str()
            .or(value["stdout"].as_str())
            .unwrap_or("Reboot could not be verified. Refresh status.")
            .chars()
            .take(8000)
            .collect());
    }
    if module == "ansible.builtin.reboot" && value["rebooted"] != true {
        return Err("Ansible did not verify a reboot. Refresh status.".into());
    }
    Ok(value)
}
#[cfg(test)]
pub(crate) fn exercise_reboot_transport(
    host: &Host,
    env: &Environment,
    output: &mut dyn FnMut(String),
) -> Result<Value> {
    let root = automation::private_root()?;
    let prepared = ssh::prepare(host, env, root.path())?;
    let variables = automation::host_variables(host, &prepared);
    let args = reboot_arguments(
        &uuid::Uuid::new_v4().to_string(),
        "11111111-1111-4111-8111-111111111111",
        1,
    )?;
    invoke(
        root.path(),
        variables,
        "ansible.builtin.reboot",
        args,
        Duration::from_secs(60),
        output,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_directory() -> tempfile::TempDir {
        use std::os::unix::fs::PermissionsExt;
        tempfile::Builder::new()
            .permissions(fs::Permissions::from_mode(0o700))
            .tempdir()
            .unwrap()
    }
    fn fixture() -> Run {
        Run {
            id: uuid::Uuid::new_v4().to_string(),
            target_label: "Servers".into(),
            phase: "apply".into(),
            active: true,
            stop_requested: false,
            results: (1..=2)
                .map(|i| HostResult {
                    host: Host {
                        id: uuid::Uuid::new_v4().to_string(),
                        settings: inventory::HostInput {
                            name: format!("Host {i}"),
                            address: format!("192.0.2.{i}"),
                            username: "root".into(),
                            port: 22,
                            authentication: inventory::Authentication::KeyFile {
                                filename: "id_ed25519".into(),
                            },
                        },
                    },
                    state: "ready".into(),
                    message: String::new(),
                    boot_id: "11111111-1111-4111-8111-111111111111".into(),
                    reboot_required: false,
                    logs: String::new(),
                    plan: Some(Plan {
                        boot_id: "11111111-1111-4111-8111-111111111111".into(),
                        requested_by: vec![],
                        ssh_startup: String::new(),
                        os: "Ubuntu".into(),
                        created_at: 0,
                        failed_services: vec![],
                    }),
                })
                .collect(),
        }
    }
    #[test]
    fn interrupted_launch_is_unknown_and_queued_hosts_never_resume() {
        let mut run = fixture();
        run.results[0].state = "launching".into();
        run.recover();
        assert!(!run.active);
        assert!(run.unresolved());
        assert_eq!(run.results[0].state, "unknown");
        assert_eq!(run.results[1].state, "skipped");
    }
    #[test]
    fn review_cannot_overwrite_an_unconfirmed_reboot() {
        let directory = test_directory();
        let store = Store {
            directory: directory.path().to_owned(),
        };
        let mut run = fixture();
        run.results[0].state = "running".into();
        save(directory.path(), &run).unwrap();
        let reboots = Reboots::default();
        let env = Environment {
            home: directory.path().to_owned(),
            agent_socket: None,
        };
        assert!(reboots
            .preview(
                &store,
                &env,
                &AutomationTargets {
                    host_ids: vec![],
                    group_ids: vec![]
                }
            )
            .unwrap_err()
            .contains("unconfirmed"));
        let recovered = reboots.latest(&store).unwrap().unwrap();
        assert_eq!(recovered.id, run.id);
        assert!(recovered.unresolved());
    }
    #[test]
    fn separate_instances_cannot_dispatch_concurrent_reboots() {
        let directory = test_directory();
        let store = Store {
            directory: directory.path().to_owned(),
        };
        let first = Reboots::default();
        let second = Reboots::default();
        assert!(first.latest(&store).unwrap().is_none());
        assert!(second.latest(&store).unwrap_err().contains("another"));
    }
    #[test]
    fn corrupt_journal_is_preserved_and_blocks_execution() {
        let directory = test_directory();
        let file = directory.path().join(JOURNAL);
        fs::write(&file, "broken").unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(Reboots::default()
            .latest(&Store {
                directory: directory.path().to_owned()
            })
            .unwrap_err()
            .contains("preserved"));
        assert_eq!(fs::read_to_string(file).unwrap(), "broken");
    }
    #[test]
    fn dispatch_is_journaled_before_contact_and_failure_stops_remaining_hosts() {
        let directory = test_directory();
        let shared = Arc::new(Mutex::new(Session {
            run: Some(fixture()),
            ..Default::default()
        }));
        let env = Environment {
            home: directory.path().to_owned(),
            agent_socket: None,
        };
        let mut calls = 0;
        execute(
            &shared,
            directory.path(),
            &env,
            "apply",
            |_, _, action, _, _| {
                calls += 1;
                assert_eq!(action, "apply");
                let durable: Run =
                    serde_json::from_slice(&fs::read(directory.path().join(JOURNAL)).unwrap())
                        .unwrap();
                assert_eq!(durable.results[0].state, "launching");
                Err("SSH connection lost".into())
            },
        )
        .unwrap();
        assert_eq!(calls, 1);
        let session = shared.lock().unwrap();
        let run = session.run.as_ref().unwrap();
        assert_eq!(run.results[0].state, "unknown");
        assert_eq!(run.results[1].state, "skipped");
    }
    #[test]
    fn stop_after_current_host_does_not_cancel_the_submitted_reboot() {
        let directory = test_directory();
        let shared = Arc::new(Mutex::new(Session {
            run: Some(fixture()),
            ..Default::default()
        }));
        let env = Environment {
            home: directory.path().to_owned(),
            agent_socket: None,
        };
        let mut calls = 0;
        execute(&shared, directory.path(), &env, "apply", |_, _, _, _, _| {
            calls += 1;
            shared.lock().unwrap().run.as_mut().unwrap().stop_requested = true;
            Ok(json!({"state":"successful", "message":"done", "rebootRequired":true}))
        })
        .unwrap();
        assert_eq!(calls, 1);
        let session = shared.lock().unwrap();
        let run = session.run.as_ref().unwrap();
        assert_eq!(run.results[0].state, "successful");
        assert!(run.results[0].reboot_required);
        assert_eq!(run.results[1].state, "skipped");
    }
    #[test]
    fn reconciliation_only_observes_and_never_starts_a_ready_host() {
        let directory = test_directory();
        let mut run = fixture();
        run.results[0].state = "unknown".into();
        let shared = Arc::new(Mutex::new(Session {
            run: Some(run),
            ..Default::default()
        }));
        let env = Environment {
            home: directory.path().to_owned(),
            agent_socket: None,
        };
        let mut calls = 0;
        execute(
            &shared,
            directory.path(),
            &env,
            "status",
            |_, _, action, _, _| {
                calls += 1;
                assert_eq!(action, "status");
                Ok(json!({"state":"successful"}))
            },
        )
        .unwrap();
        assert_eq!(calls, 1);
    }
    #[test]
    fn a_stale_or_missing_preview_never_starts_a_worker() {
        let directory = test_directory();
        let store = Store {
            directory: directory.path().to_owned(),
        };
        let reboots = Reboots::default();
        let env = Environment {
            home: directory.path().to_owned(),
            agent_socket: None,
        };
        assert!(reboots.apply(&store, &env, "anything").is_err());
        let mut run = fixture();
        run.phase = "review".into();
        run.active = false;
        for result in &mut run.results {
            result.host = store.save(None, result.host.settings.clone()).unwrap();
        }
        let id = run.id.clone();
        reboots.session.lock().unwrap().run = Some(run);
        assert!(reboots
            .apply(&store, &env, &id)
            .unwrap_err()
            .contains("expired"));
        assert!(!reboots.latest(&store).unwrap().unwrap().active);
    }
    #[test]
    fn reboot_helper_regressions() {
        let status = std::process::Command::new("/usr/bin/python3")
            .args([
                "-B",
                "-m",
                "unittest",
                "discover",
                "-s",
                "tests",
                "-p",
                "test_ubuntu_reboot.py",
            ])
            .status()
            .unwrap();
        assert!(status.success());
    }
}
