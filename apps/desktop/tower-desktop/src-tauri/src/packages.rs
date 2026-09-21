//! Durable, reviewed Ubuntu package updates. A remote systemd service owns APT.
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

const JOURNAL: &str = "package-updates.json";
const LIMIT: u64 = 4 * 1024 * 1024;
const HELPER: &str = include_str!("ubuntu_packages.py");

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    pub name: String,
    pub from_version: String,
    pub to_version: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub packages: Vec<Package>,
    pub os: String,
    pub created_at: u64,
    pub failed_services: Vec<String>,
    pub deferred: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostResult {
    pub host: Host,
    pub state: String,
    pub message: String,
    pub plan: Option<Plan>,
    pub digest: String,
    pub reboot_required: bool,
    #[serde(default)]
    pub logs: String,
    #[serde(default)]
    pub log_error: String,
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
                    result.message = "The desktop stopped monitoring. Refresh remote status before further updates.".into();
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
pub struct Packages {
    session: Arc<Mutex<Session>>,
}

fn save(directory: &Path, run: &Run) -> Result<()> {
    // Remote logs stay on the host; do not let output exhaust the durable state journal.
    let mut durable = run.clone();
    for result in &mut durable.results {
        result.logs.clear();
        result.log_error.clear();
    }
    let bytes = serde_json::to_vec(&durable).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > LIMIT {
        return Err("Package results exceed the journal size limit.".into());
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
    let lock_path = directory.join("package-updates.lock");
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
        return Err("Package updates are managed by another Admin-Tower instance.".into());
    }
    let path = directory.join(JOURNAL);
    if path.try_exists().map_err(|e| e.to_string())? {
        let mut bytes = Vec::new();
        inventory::protected_file(&path, true)?
            .take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > LIMIT {
            return Err("Package journal is too large; preserved for recovery.".into());
        }
        let mut run: Run = serde_json::from_slice(&bytes)
            .map_err(|_| "Cannot read package journal; preserved for recovery.")?;
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
impl Packages {
    pub fn latest(&self, store: &Store) -> Result<Option<Run>> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| "Package updates unavailable.")?;
        initialize(&mut session, &store.directory)?;
        Ok(session.run.clone())
    }
    pub fn preview(
        &self,
        store: &Store,
        env: &Environment,
        targets: &AutomationTargets,
    ) -> Result<Run> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| "Package updates unavailable.")?;
        initialize(&mut session, &store.directory)?;
        if session.closing
            || session
                .run
                .as_ref()
                .is_some_and(|r| r.active || r.unresolved())
        {
            return Err("An update is active or unconfirmed. Refresh its status first.".into());
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
                    digest: String::new(),
                    reboot_required: false,
                    logs: String::new(),
                    log_error: String::new(),
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
        let mut session = self
            .session
            .lock()
            .map_err(|_| "Package updates unavailable.")?;
        initialize(&mut session, &store.directory)?;
        if session.closing {
            return Err("Application is closing.".into());
        }
        let run = session.run.as_mut().ok_or("Preview packages first.")?;
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
            let plan = result.plan.as_ref().ok_or("Missing package preview.")?;
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
        let mut session = self
            .session
            .lock()
            .map_err(|_| "Package updates unavailable.")?;
        initialize(&mut session, &store.directory)?;
        let run = session.run.as_mut().ok_or("No package run exists.")?;
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
        let mut session = self
            .session
            .lock()
            .map_err(|_| "Package updates unavailable.")?;
        initialize(&mut session, &store.directory)?;
        let run = session.run.as_mut().ok_or("No package run exists.")?;
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
            .name("ubuntu-packages".into())
            .spawn(move || {
                let execution = execute(&shared, &directory, &env, mode, |host, env, action, id, digest| {
                    remote_logged(&shared, host, env, action, id, digest)
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
                        log::error!("Could not persist package results: {error}");
                        session.persistence_error = Some(format!("Package journal could not be saved: {error}. Restart to recover before further updates."));
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
                "Cannot start package worker. Reopen Admin-Tower to recover its journal.".into(),
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
        let mut result = remote(&original.host, env, mode, &snapshot.id, &original.digest);
        let started = Instant::now();
        loop {
            let state = match &result {
                Ok(value) => value["state"].as_str().unwrap_or("unknown"),
                Err(_) => {
                    if mode == "preview" {
                        "failed"
                    } else {
                        "unknown"
                    }
                }
            };
            let mut session = shared.lock().map_err(|_| "Run unavailable.")?;
            let closing = session.closing;
            let run = session.run.as_mut().ok_or("No run.")?;
            update_result(&mut run.results[index], &result, mode)?;
            save(directory, run)?;
            let keep_polling = state == "running"
                && mode == "apply"
                && !closing
                && started.elapsed() < Duration::from_secs(7200);
            halt = !matches!(state, "successful" | "ready");
            if !keep_polling {
                break;
            }
            drop(session);
            thread::sleep(Duration::from_secs(3));
            result = remote(
                &original.host,
                env,
                "status",
                &snapshot.id,
                &original.digest,
            );
        }
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
                        .map_err(|_| "Invalid package plan.")?,
                );
                let digest = value["digest"].as_str().ok_or("Missing preview digest.")?;
                if digest.len() != 64 || !digest.bytes().all(|c| c.is_ascii_hexdigit()) {
                    return Err("Invalid preview digest.".into());
                }
                host.digest = digest.into();
            }
            host.state = state.into();
        }
    }
    Ok(())
}

// Log transport is independent of the update outcome. Losing it never cancels APT.
fn remote_logged(
    shared: &Arc<Mutex<Session>>,
    host: &Host,
    env: &Environment,
    action: &str,
    id: &str,
    digest: &str,
) -> Result<Value> {
    use std::sync::atomic::{AtomicBool, Ordering};
    inventory::validate_id(id)?;
    let done = AtomicBool::new(false);
    thread::scope(|scope| {
        scope.spawn(|| loop {
            let final_read = done.load(Ordering::SeqCst);
            let logs = remote_log(host, env, id);
            if let Ok(mut session) = shared.lock() {
                if let Some(run) = &mut session.run {
                    if run.id == id {
                        if let Some(result) = run.results.iter_mut().find(|r| r.host.id == host.id)
                        {
                            match logs {
                                Ok(logs) => {
                                    result.logs = logs;
                                    result.log_error.clear();
                                }
                                Err(error) => result.log_error = error,
                            }
                        }
                    }
                }
            }
            if final_read {
                break;
            }
            for _ in 0..10 {
                if done.load(Ordering::SeqCst) {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
        });
        struct Finish<'a>(&'a AtomicBool);
        impl Drop for Finish<'_> {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let _finish = Finish(&done);
        remote(host, env, action, id, digest)
    })
}

pub(crate) fn remote_log(host: &Host, env: &Environment, id: &str) -> Result<String> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    inventory::validate_id(id)?;
    let root = automation::private_root()?;
    let prepared = ssh::prepare(host, env, root.path())?;
    let output = tempfile::tempfile().map_err(|e| e.to_string())?;
    let errors = tempfile::tempfile().map_err(|e| e.to_string())?;
    // UUID validation above keeps this fixed remote command free of shell input.
    let tail = format!(
        "/usr/bin/tail -c 65536 -- /var/lib/admin-tower/package-updates/{id}/operation.log"
    );
    let remote = if host.settings.username == "root" {
        tail
    } else {
        format!("/usr/bin/sudo -n -- {tail}")
    };
    let mut child = automation::Process(
        Command::new("/usr/bin/ssh")
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("SSH_ASKPASS_REQUIRE", "never")
            .args(["-o", "BatchMode=yes"])
            .args(&prepared.arguments)
            .arg(remote)
            .stdin(Stdio::null())
            .stdout(output.try_clone().map_err(|e| e.to_string())?)
            .stderr(errors.try_clone().map_err(|e| e.to_string())?)
            .process_group(0)
            .spawn()
            .map_err(|e| e.to_string())?,
    );
    let started = Instant::now();
    loop {
        if let Some(status) = child.0.try_wait().map_err(|e| e.to_string())? {
            return if status.success() {
                automation::log_tail(&output)
            } else {
                Err(format!(
                    "Live logs unavailable: {}",
                    automation::log_tail(&errors)?
                        .chars()
                        .take(1000)
                        .collect::<String>()
                ))
            };
        }
        if started.elapsed() > Duration::from_secs(5) {
            return Err("Live log connection timed out; task monitoring continues.".into());
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn remote(host: &Host, env: &Environment, action: &str, id: &str, digest: &str) -> Result<Value> {
    inventory::validate_id(id)?;
    if !matches!(action, "preview" | "apply" | "status")
        || (!digest.is_empty()
            && (digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit())))
    {
        return Err("Invalid package action.".into());
    }
    let root = automation::private_root()?;
    let prepared = ssh::prepare(host, env, root.path())?;
    let mut variables = automation::host_variables(host, &prepared);
    variables["ansible_become"] = json!(true);
    variables["ansible_become_method"] = json!("sudo");
    variables["ansible_become_user"] = json!("root");
    variables["ansible_become_flags"] = json!("-H -S -n");
    invoke_script(root.path(), variables, action, id, digest)
}

fn invoke_script(
    root: &Path,
    variables: Value,
    action: &str,
    id: &str,
    digest: &str,
) -> Result<Value> {
    fs::write(
        root.join("inventory.json"),
        serde_json::to_vec(&json!({"all":{"hosts":{"target":variables}}})).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    let script = root.join("ubuntu_packages.py");
    fs::write(&script, HELPER).map_err(|e| e.to_string())?;
    let tree = root.join("results");
    inventory::private_dir(&tree)?;
    let output = tempfile::tempfile().map_err(|e| e.to_string())?;
    let args = json!({"cmd": format!("{} {action} {id} {digest}", script.display()), "executable":"/usr/bin/python3"});
    let mut command = automation::context(root)?;
    let mut child = automation::Process(
        command
            .args([
                "target",
                "-i",
                "inventory.json",
                "-m",
                "ansible.builtin.script",
                "-a",
                &args.to_string(),
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
    loop {
        if child.0.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if started.elapsed() > Duration::from_secs(if action == "preview" { 300 } else { 60 }) {
            return Err("Ansible response timed out. An already launched server update may still be running.".into());
        }
        thread::sleep(Duration::from_millis(100));
    }
    let path = tree.join("target");
    let mut bytes = Vec::new();
    if let Ok(file) = File::open(path) {
        file.take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
    }
    if bytes.len() > 1024 * 1024 {
        return Err("Oversized Ansible result.".into());
    }
    if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
        if let Some(stdout) = value["stdout"].as_str() {
            for line in stdout.lines().rev() {
                if let Ok(result) = serde_json::from_str::<Value>(line) {
                    if let Some(state) = result["state"].as_str() {
                        if matches!(state, "failed" | "unknown")
                            || (value["rc"].as_i64() == Some(0)
                                && value["failed"].as_bool() != Some(true)
                                && value["unreachable"].as_bool() != Some(true))
                        {
                            return Ok(result);
                        }
                    }
                }
            }
        }
        if let Some(message) = value["msg"].as_str() {
            return Err(message.chars().take(8000).collect());
        }
    }
    Err(automation::read_output(output)?
        .chars()
        .take(8000)
        .collect())
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
                    digest: "a".repeat(64),
                    reboot_required: false,
                    logs: String::new(),
                    log_error: String::new(),
                    plan: Some(Plan {
                        packages: vec![],
                        os: "Ubuntu".into(),
                        created_at: 0,
                        failed_services: vec![],
                        deferred: vec![],
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
    fn preview_cannot_overwrite_an_unconfirmed_installation() {
        let directory = test_directory();
        let store = Store {
            directory: directory.path().to_owned(),
        };
        let mut run = fixture();
        run.results[0].state = "running".into();
        save(directory.path(), &run).unwrap();
        let packages = Packages::default();
        let env = Environment {
            home: directory.path().to_owned(),
            agent_socket: None,
        };
        assert!(packages
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
        let recovered = packages.latest(&store).unwrap().unwrap();
        assert_eq!(recovered.id, run.id);
        assert!(recovered.unresolved());
    }
    #[test]
    fn separate_instances_cannot_dispatch_concurrent_updates() {
        let directory = test_directory();
        let store = Store {
            directory: directory.path().to_owned(),
        };
        let first = Packages::default();
        let second = Packages::default();
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
        assert!(Packages::default()
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
    fn stop_after_current_host_does_not_cancel_the_current_transaction() {
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
        let packages = Packages::default();
        let env = Environment {
            home: directory.path().to_owned(),
            agent_socket: None,
        };
        assert!(packages.apply(&store, &env, "anything").is_err());
        let mut run = fixture();
        run.phase = "review".into();
        run.active = false;
        for result in &mut run.results {
            result.host = store.save(None, result.host.settings.clone()).unwrap();
        }
        let id = run.id.clone();
        packages.session.lock().unwrap().run = Some(run);
        assert!(packages
            .apply(&store, &env, &id)
            .unwrap_err()
            .contains("expired"));
        assert!(!packages.latest(&store).unwrap().unwrap().active);
    }
    #[test]
    fn package_helper_regressions() {
        let status = std::process::Command::new("/usr/bin/python3")
            .args([
                "-B",
                "-m",
                "unittest",
                "discover",
                "-s",
                "tests",
                "-p",
                "test_ubuntu_packages.py",
            ])
            .status()
            .unwrap();
        assert!(status.success());
    }
    #[test]
    #[ignore = "requires /usr/bin/ansible; uses only an unprivileged local connection"]
    fn live_package_ansible_protocol_refuses_unprivileged_updates() {
        assert_ne!(inventory::uid(), 0, "Never run this fixture as root");
        for action in ["preview", "apply", "status"] {
            let root = automation::private_root().unwrap();
            let result = invoke_script(
                root.path(),
                json!({"ansible_connection":"ansible.builtin.local", "ansible_become":false,
                "ansible_remote_tmp":root.path().join("remote").to_string_lossy()}),
                action,
                &uuid::Uuid::new_v4().to_string(),
                "",
            )
            .unwrap();
            assert_eq!(
                result["state"],
                if action == "preview" {
                    "failed"
                } else {
                    "unknown"
                }
            );
            assert_eq!(result["message"], "Root or passwordless sudo is required.");
        }
    }
}
