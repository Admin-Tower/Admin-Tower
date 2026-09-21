//! Agentless administration. The webview can request only typed, reviewed operations.
use crate::{
    inventory::{self, Host, Result, Store},
    ssh::{self, Environment},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::Read,
    os::{fd::AsRawFd, unix::fs::OpenOptionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const COLLECTOR: &str = include_str!("host-overview.sh");
const MAX_OUTPUT: usize = 4 * 1024 * 1024;
// Decoded invalid UTF-8 and JSON escaping can expand bounded SSH output.
const MAX_METADATA: usize = 16 * 1024 * 1024;
const REVIEW_TTL: u64 = 300;
const RUN_TTL: u64 = 240;
const PREFIX: &str = "export LC_ALL=C PATH=/usr/sbin:/usr/bin:/sbin:/bin; set -f; ";
const CHECK_OS: &str = "distro=$(sed -n 's/^ID=//p' /etc/os-release | tr -d '\"'); case \"$distro\" in ubuntu|debian) ;; *) echo 'Only Ubuntu and Debian are supported for administration.' >&2; exit 64;; esac; ";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    SetHostname {
        hostname: String,
    },
    CreateUser {
        username: String,
    },
    CreateGroup {
        group: String,
    },
    Membership {
        username: String,
        group: String,
        add: bool,
    },
    Service {
        unit: String,
        verb: ServiceVerb,
    },
    Inspect {
        elevated: bool,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceVerb {
    Start,
    Stop,
    Restart,
    Reload,
    Enable,
    Disable,
}

impl ServiceVerb {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
            Self::Reload => "reload",
            Self::Enable => "enable",
            Self::Disable => "disable",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub id: String,
    pub status: String,
    pub output: String,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub target: Option<Host>,
    pub collected_at: u64,
    pub elevated: bool,
    pub supported: bool,
    pub sections: Vec<Section>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    id: String,
    host: Host,
    action: Action,
    created_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub id: String,
    pub host: Host,
    pub summary: String,
    pub command: String,
    pub warning: String,
    pub expires_at: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub host_id: String,
    pub state: String,
    pub message: String,
    pub overview: Option<Overview>,
    #[serde(default)]
    pub logs: String,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn name(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 32
        || !value
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b == b'_')
        || !value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-".contains(&b))
    {
        return Err("Use a Linux account/group name of 1–32 lowercase letters, digits, underscores or hyphens, starting with a letter or underscore.".into());
    }
    Ok(())
}

fn unit_name(unit: &str) -> Result<()> {
    if !unit.ends_with(".service")
        || unit.len() > 200
        || unit.starts_with('-')
        || unit.starts_with('.')
        || !unit
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.@:-".contains(&b))
    {
        return Err("Select a .service unit using letters, numbers, dots, @, colons, underscores or hyphens.".into());
    }
    Ok(())
}

/// SSH remote commands are shell strings even when local spawning uses argv.
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn action_details(action: &Action) -> Result<(String, String, String)> {
    Ok(match action {
        Action::SetHostname { hostname } => {
            if hostname.is_empty() || hostname.len() > 64 || !hostname.split('.').all(|label| {
                !label.is_empty() && label.len() <= 63
                    && label.as_bytes()[0].is_ascii_alphanumeric()
                    && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                    && label.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            }) {
                return Err("Use a hostname of up to 64 lowercase letters, digits, hyphens or dots, with each label starting and ending with a letter or digit.".into());
            }
            (format!("Set hostname to {hostname}"),
             format!("ansible.builtin.hostname {}", serde_json::json!({"name": hostname, "use": "systemd"})),
             "Changes the remote system hostname now and across reboots. DNS, /etc/hosts, cloud-init configuration and the inventory connection address are not changed.".into())
        }
        Action::CreateUser { username } => {
            name(username)?;
            (format!("Create user {username}"), format!("/usr/sbin/useradd -m -U -s /bin/bash -- {}", quote(username)),
             "Creates a home directory and private primary group. The password is locked; this does not grant SSH access or sudo privileges.".into())
        }
        Action::CreateGroup { group } => {
            name(group)?;
            (format!("Create group {group}"), format!("/usr/sbin/groupadd -- {}", quote(group)), "Creates a local group without changing existing memberships.".into())
        }
        Action::Membership { username, group, add } => {
            name(username)?; name(group)?;
            (format!("{} {username} {} {group}", if *add { "Add" } else { "Remove" }, if *add { "to" } else { "from" }),
             format!("/usr/bin/gpasswd {} {} {}", if *add { "-a" } else { "-d" }, quote(username), quote(group)),
             "Changes supplementary membership only. Groups such as sudo, docker, disk or lxd can grant administrator-level access. Existing sessions may retain their old groups.".into())
        }
        Action::Service { unit, verb } => {
            unit_name(unit)?;
            (format!("{} {unit}", verb.as_str()), format!("/usr/bin/systemctl --no-ask-password {} -- {}", verb.as_str(), quote(unit)),
             "Service changes can interrupt workloads or SSH/network access. Enable/disable changes boot behavior only; it does not start/stop the service. An interrupted connection can leave the outcome unknown.".into())
        }
        Action::Inspect { elevated } => (
            if *elevated { "Inspect host with sudo" } else { "Inspect host in terminal" }.into(),
            "Read system/resources, storage, networking, accounts, services, journal and firewall rules.".into(),
            "Read-only snapshot. Journal and firewall information may contain sensitive administration data. No firewall rules are changed.".into()),
    })
}

fn remote_script(action: &Action) -> Result<String> {
    if matches!(action, Action::SetHostname { .. }) {
        return Err("Hostname changes must run through Ansible.".into());
    }
    let (_, command, _) = action_details(action)?;
    let mut script = PREFIX.to_owned();
    if !matches!(action, Action::Inspect { .. }) {
        script.push_str(CHECK_OS);
        match action {
            Action::CreateUser { username } => script.push_str(&format!("if getent passwd {u} >/dev/null || getent group {u} >/dev/null; then echo 'User or private group already exists.' >&2; exit 65; fi; ", u=quote(username))),
            Action::CreateGroup { group } => script.push_str(&format!("if getent group {} >/dev/null; then echo 'Group already exists.' >&2; exit 65; fi; ", quote(group))),
            Action::Membership { username, group, add } => {
                script.push_str(&format!("getent passwd {u} >/dev/null && getent group {g} >/dev/null || exit 65; ", u=quote(username), g=quote(group)));
                if !add { script.push_str(&format!("if [ \"$(id -gn -- {})\" = {} ]; then echo 'Cannot remove the primary group.' >&2; exit 65; fi; ", quote(username), quote(group))); }
            }
            Action::Service { unit, .. } => script.push_str(&format!("[ \"$(systemctl show -p LoadState --value -- {})\" = loaded ] || {{ echo 'Service is not loaded or does not exist.' >&2; exit 65; }}; ", quote(unit))),
            _ => {},
        }
        script.push_str(&format!("{command} >&2 || exit $?; "));
    }
    // Closed stdin prevents inspection commands from consuming terminal input after sudo.
    script.push_str("exec </dev/null; ");
    script.push_str(COLLECTOR);
    Ok(script)
}

fn remote_command(action: &Action) -> Result<String> {
    let shell = format!("/bin/sh -c {}", quote(&remote_script(action)?));
    Ok(if matches!(action, Action::Inspect { elevated: false }) {
        shell
    } else {
        // Sudo reads directly from SSH's terminal stdin. Rust never reads password input.
        format!("if [ \"$(/usr/bin/id -u)\" = 0 ]; then {shell}; else /usr/bin/sudo -S -p '[Admin-Tower sudo] Password: ' -- {shell}; fi")
    })
}

fn parse_overview(bytes: &[u8], elevated: bool) -> Result<Overview> {
    let text = std::str::from_utf8(bytes).map_err(|_| "Invalid host snapshot encoding.")?;
    let mut sections = Vec::new();
    let mut complete = false;
    let mut protocol = false;
    for line in text.lines() {
        if !line.starts_with("AT1\t") {
            continue;
        } // SSH login banners are not snapshot data.
        let parts: Vec<_> = line.splitn(4, '\t').collect();
        if parts.len() != 4 {
            return Err("Incomplete host snapshot.".into());
        }
        if parts[1] == "protocol" {
            protocol = parts[3] == "MQ==";
            continue;
        }
        if parts[1] == "complete" {
            complete = parts[3] == "MQ==";
            continue;
        }
        if !SECTION_IDS.contains(&parts[1]) || sections.iter().any(|s: &Section| s.id == parts[1]) {
            return Err("Unexpected or duplicate snapshot section.".into());
        }
        let code: i32 = parts[2].parse().map_err(|_| "Invalid snapshot status.")?;
        let raw = STANDARD
            .decode(parts[3])
            .map_err(|_| "Invalid snapshot section encoding.")?;
        let truncated = raw.len() >= 131072;
        let output: String = String::from_utf8_lossy(&raw)
            .chars()
            .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
            .collect();
        let status = if code == 0 {
            "ok"
        } else if code == 124 {
            "timeout"
        } else if code == 127 {
            "unavailable"
        } else if output.to_lowercase().contains("permission")
            || output.to_lowercase().contains("not permitted")
            || output.to_lowercase().contains("must be root")
        {
            "denied"
        } else {
            "error"
        };
        sections.push(Section {
            id: parts[1].into(),
            status: status.into(),
            output,
            truncated,
        });
    }
    if !protocol || !complete || sections.len() != SECTION_IDS.len() {
        return Err("Host returned an incomplete snapshot; previous data was retained.".into());
    }
    let supported = sections.iter().find(|s| s.id == "system").is_some_and(|s| {
        s.output
            .lines()
            .any(|l| ["ID=ubuntu", "ID=debian", "ID=\"ubuntu\"", "ID=\"debian\""].contains(&l))
    });
    Ok(Overview {
        target: None,
        collected_at: now(),
        elevated,
        supported,
        sections,
    })
}

const SECTION_IDS: &[&str] = &[
    "system",
    "cpu",
    "storage",
    "disks",
    "interfaces",
    "routes",
    "routes6",
    "ports",
    "processes",
    "users",
    "groups",
    "services",
    "serviceFiles",
    "failedServices",
    "logs",
    "nftables",
    "iptables",
    "ip6tables",
    "ufw",
    "firewalld",
];

struct RemoteOutput {
    code: Option<i32>,
    output: Vec<u8>,
    limited: bool,
}

fn run_remote(
    host: &Host,
    environment: &Environment,
    directory: &Path,
    action: &Action,
    interactive: bool,
) -> Result<RemoteOutput> {
    run_remote_command(
        host,
        environment,
        directory,
        remote_command(action)?,
        interactive,
        90,
    )
}

fn run_remote_command(
    host: &Host,
    environment: &Environment,
    directory: &Path,
    remote: String,
    interactive: bool,
    timeout_seconds: u64,
) -> Result<RemoteOutput> {
    let prepared = ssh::prepare(host, environment, directory)?;
    let mut command = Command::new("/usr/bin/ssh");
    command.arg("-T");
    if !interactive {
        command.args(["-o", "BatchMode=yes"]);
    }
    command
        .args(&prepared.arguments)
        .arg(remote)
        .env_remove("SSH_ASKPASS")
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env_remove("SSH_SK_PROVIDER")
        .env_remove("LD_PRELOAD")
        .env_remove("LD_LIBRARY_PATH")
        .stdin(if interactive {
            Stdio::inherit()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(if interactive {
            Stdio::inherit()
        } else {
            Stdio::null()
        });
    let mut child = command
        .spawn()
        .map_err(|_| "Cannot start system OpenSSH.")?;
    let mut stdout = child.stdout.take().ok_or("Cannot capture host snapshot.")?;
    let overflow = Arc::new(AtomicBool::new(false));
    let flag = overflow.clone();
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 8192];
        while let Ok(count) = stdout.read(&mut buffer) {
            if count == 0 {
                break;
            }
            if bytes.len() + count > MAX_OUTPUT {
                flag.store(true, Ordering::Relaxed);
                break;
            }
            bytes.extend_from_slice(&buffer[..count]);
        }
        bytes
    });
    let deadline = Instant::now()
        + Duration::from_secs(if interactive {
            RUN_TTL - 15
        } else {
            timeout_seconds
        });
    let (code, limited) = loop {
        if overflow.load(Ordering::Relaxed) || Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break (None, true);
        }
        match child.try_wait() {
            Ok(Some(status)) => break (status.code(), false),
            Ok(None) => std::thread::sleep(Duration::from_millis(30)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break (None, true);
            }
        }
    };
    let output = reader.join().unwrap_or_default();
    Ok(RemoteOutput {
        code,
        output,
        limited: limited || overflow.load(Ordering::Relaxed),
    })
}

/// Inventory metadata must not wait for services, firewall, journal, or disk inspection.
pub fn system_info(store: &Store, environment: &Environment, id: &str) -> Result<Overview> {
    let host = store.get(id)?;
    let script = "export LC_ALL=C PATH=/usr/sbin:/usr/bin:/sbin:/bin; cat /etc/os-release || exit; printf '\nHostname: '; hostname; printf 'Kernel: '; uname -srmo";
    let output = run_remote_command(
        &host,
        environment,
        &store.directory,
        format!("/bin/sh -c {}", quote(script)),
        false,
        20,
    )?;
    if output.limited || output.code != Some(0) {
        return Err(
            "Could not refresh OS information over SSH. Last known information was retained."
                .into(),
        );
    }
    Ok(Overview {
        target: Some(host),
        collected_at: now(),
        elevated: false,
        supported: true,
        sections: vec![Section {
            id: "system".into(),
            status: "ok".into(),
            output: String::from_utf8_lossy(&output.output).into_owned(),
            truncated: false,
        }],
    })
}

pub fn inspect(store: &Store, environment: &Environment, id: &str) -> Result<Overview> {
    let host = store.get(id)?;
    let output = run_remote(
        &host,
        environment,
        &store.directory,
        &Action::Inspect { elevated: false },
        false,
    )?;
    if output.limited {
        return Err("Inspection exceeded its time/output limit. Try a terminal refresh; previous data was retained.".into());
    }
    if output.code != Some(0) {
        return Err("SSH inspection failed. Use Refresh in terminal to handle authentication and see connection diagnostics. Existing key and host-trust requirements still apply.".into());
    }
    let mut overview = parse_overview(&output.output, false)?;
    overview.target = Some(host);
    Ok(overview)
}

fn jobs_dir(store: &Store) -> Result<PathBuf> {
    inventory::private_dir(&store.directory)?;
    let path = store.directory.join("operations");
    inventory::private_dir(&path)?;
    // Expire only this module's UUID-named, regular files after one day.
    for entry in fs::read_dir(&path)
        .map_err(|_| "Cannot inspect operation directory.")?
        .take(4096)
    {
        let entry = entry.map_err(|_| "Cannot inspect operation metadata.")?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some((id, suffix)) = name.split_once('.') else {
            continue;
        };
        if inventory::validate_id(id).is_err()
            || !["request", "result", "claimed", "started"].contains(&suffix)
        {
            continue;
        }
        if let Ok(file) = inventory::protected_file(&entry.path(), true) {
            if file
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > Duration::from_secs(86400))
            {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    Ok(path)
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let mut bytes = Vec::new();
    inventory::protected_file(path, true)?
        .take((MAX_METADATA + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read operation metadata.")?;
    if bytes.len() > MAX_METADATA {
        return Err("Operation metadata exceeds the limit.".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Invalid operation metadata.".into())
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("Invalid operation path.")?)
        .map_err(|_| "Cannot prepare operation metadata.")?;
    serde_json::to_writer(&mut file, value).map_err(|_| "Cannot serialize operation metadata.")?;
    file.as_file()
        .sync_all()
        .map_err(|_| "Cannot persist operation metadata.")?;
    file.persist(path)
        .map_err(|_| "Cannot save operation metadata.")?;
    Ok(())
}

pub fn review(store: &Store, host_id: &str, action: Action) -> Result<Review> {
    let host = store.get(host_id)?;
    let (summary, command, warning) = action_details(&action)?;
    let id = uuid::Uuid::new_v4().to_string();
    let created_at = now();
    let request = Request {
        id: id.clone(),
        host: host.clone(),
        action,
        created_at,
    };
    write_json(&jobs_dir(store)?.join(format!("{id}.request")), &request)?;
    Ok(Review {
        id,
        host,
        summary,
        command,
        warning,
        expires_at: created_at + REVIEW_TTL,
    })
}

fn request(store: &Store, id: &str) -> Result<Request> {
    inventory::validate_id(id)?;
    let request: Request = read_json(&jobs_dir(store)?.join(format!("{id}.request")))?;
    if request.id != id {
        return Err("Operation ID does not match its review.".into());
    }
    action_details(&request.action)?;
    Ok(request)
}

fn ensure_current(store: &Store, request: &Request) -> Result<()> {
    if now() > request.created_at + REVIEW_TTL {
        return Err("Review expired. Review the action again.".into());
    }
    let current = store.get(&request.host.id)?;
    if serde_json::to_value(current).ok() != serde_json::to_value(&request.host).ok() {
        return Err("Host settings changed after review. Review the action again.".into());
    }
    Ok(())
}

fn claim(path: &Path) -> Result<()> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map(|_| ())
        .map_err(|_| "This operation has already been submitted. It will not be run again.".into())
}

pub fn start(store: &Store, environment: &Environment, id: &str, terminal: &str) -> Result<Job> {
    let request = request(store, id)?;
    ensure_current(store, &request)?;
    if matches!(request.action, Action::SetHostname { .. }) {
        return start_hostname(store, environment, request);
    }
    let _checked = ssh::prepare(&request.host, environment, &store.directory)?;
    let directory = jobs_dir(store)?;
    claim(&directory.join(format!("{id}.started")))?;
    let job = Job {
        id: id.into(),
        host_id: request.host.id.clone(),
        state: "running".into(),
        message: "Complete authentication in the external terminal.".into(),
        overview: None,
        logs: String::new(),
    };
    let result_path = directory.join(format!("{id}.result"));
    write_json(&result_path, &job)?;
    if let Err(error) = ssh::launch_helper(
        terminal,
        "--admin-session",
        &store.directory,
        id,
        environment.agent_socket.as_deref(),
    ) {
        let failed = Job {
            state: "failed".into(),
            message: error.clone(),
            ..job
        };
        write_json(&result_path, &failed)?;
        return Err(error);
    }
    Ok(job)
}

fn execute_hostname(
    host: &Host,
    hostname: &str,
    dispatched: &mut bool,
    invoke: &mut impl FnMut(&str, serde_json::Value) -> Result<serde_json::Value>,
) -> Result<Overview> {
    let facts = invoke(
        "ansible.builtin.setup",
        serde_json::json!({"gather_subset": ["!all", "!min", "distribution"], "filter": "ansible_distribution"}),
    )?;
    if facts["ansible_facts"]["ansible_distribution"] != "Ubuntu" {
        return Err("Hostname editing currently supports Ubuntu servers.".into());
    }
    *dispatched = true;
    invoke(
        "ansible.builtin.hostname",
        serde_json::json!({"name": hostname, "use": "systemd"}),
    )?;
    let verified = invoke(
        "ansible.builtin.command",
        serde_json::json!({"argv": ["/usr/bin/hostname"]}),
    )?;
    if verified["stdout"].as_str().map(str::trim) != Some(hostname) {
        return Err("Hostname change could not be verified.".into());
    }
    Ok(Overview {
        target: Some(host.clone()),
        collected_at: now(),
        elevated: true,
        supported: true,
        sections: vec![Section {
            id: "system".into(),
            status: "ok".into(),
            output: format!("Hostname: {hostname}"),
            truncated: false,
        }],
    })
}

/// Hostname changes share reviewed, single-use operation IDs, but execute via Ansible.
fn start_hostname(store: &Store, environment: &Environment, request: Request) -> Result<Job> {
    let directory = jobs_dir(store)?;
    let lock = HostLock::acquire(&directory.join(format!("{}.lock", request.host.id)))?;
    let root = crate::automation::private_root()?;
    let prepared = ssh::prepare(&request.host, environment, root.path())?;
    let mut variables = crate::automation::host_variables(&request.host, &prepared);
    variables["ansible_become"] = serde_json::json!(true);
    variables["ansible_become_method"] = serde_json::json!("sudo");
    variables["ansible_become_user"] = serde_json::json!("root");
    variables["ansible_become_flags"] = serde_json::json!("-H -S -n");
    claim(&directory.join(format!("{}.started", request.id)))?;
    let job = Job {
        id: request.id.clone(),
        host_id: request.host.id.clone(),
        state: "running".into(),
        message: "Changing hostname through Ansible.".into(),
        overview: None,
        logs: String::new(),
    };
    let path = directory.join(format!("{}.result", request.id));
    write_json(&path, &job)?;
    let accepted = job.clone();
    let failed_path = path.clone();
    std::thread::Builder::new().name("ansible-hostname".into()).spawn(move || {
        let _lock = lock;
        let _prepared = prepared;
        let mut job = job;
        let mut dispatched = false;
        let result = (|| -> Result<Overview> {
            let Action::SetHostname { hostname } = &request.action else { return Err("Invalid hostname action.".into()); };
            let mut invoke = |module: &str, args: serde_json::Value| {
                let previous = job.logs.clone();
                crate::ansible::invoke(root.path(), variables.clone(), module, args, Duration::from_secs(60), &mut |output| {
                    let combined = format!("{previous}\n{module}\n{output}");
                    let tail: String = combined.chars().rev().take(65536).collect::<String>().chars().rev().collect();
                    if job.logs != tail { job.logs = tail; let _ = write_json(&path, &job); }
                })
            };
            execute_hostname(&request.host, hostname, &mut dispatched, &mut invoke)
        })();
        match result {
            Ok(overview) => { job.state = "succeeded".into(); job.message = "Hostname changed and verified.".into(); job.overview = Some(overview); }
            Err(error) => { job.state = if dispatched { "unknown" } else { "failed" }.into(); job.message = if dispatched { format!("{error} Refresh the host before retrying; the change may have applied.") } else { error }; }
        }
        if let Err(error) = write_json(&path, &job) { log::error!("Could not persist hostname result: {error}"); }
    }).map_err(|_| {
        let failed = Job { state: "failed".into(), message: "Cannot start hostname worker.".into(), ..accepted.clone() };
        let _ = write_json(&failed_path, &failed);
        "Cannot start hostname worker.".to_owned()
    })?;
    Ok(accepted)
}

pub fn status(store: &Store, host_id: &str, id: &str) -> Result<Job> {
    let request = request(store, id)?;
    if request.host.id != host_id {
        return Err("Operation belongs to a different host.".into());
    }
    let path = jobs_dir(store)?.join(format!("{id}.result"));
    let mut job: Job = read_json(&path)?;
    if job.id != id || job.host_id != host_id {
        return Err("Invalid operation result.".into());
    }
    let started_at =
        inventory::protected_file(&jobs_dir(store)?.join(format!("{id}.started")), true)?
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(request.created_at);
    if job.state == "running" && now() > started_at.saturating_add(RUN_TTL) {
        job.state = "unknown".into();
        job.message = "The terminal closed or the operation timed out. Refresh the host before deciding whether another action is needed; do not blindly retry.".into();
    }
    Ok(job)
}

struct HostLock(File);
impl HostLock {
    fn acquire(path: &Path) -> Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(|_| "Cannot lock host operation.")?;
        inventory::protected_file(path, true)?;
        // SAFETY: flock operates on the live descriptor owned by this guard.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("Another terminal operation is running for this host.".into());
        }
        Ok(Self(file))
    }
}
impl Drop for HostLock {
    fn drop(&mut self) {
        // SAFETY: descriptor remains live until after unlocking.
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

struct HiddenInput {
    terminal: File,
    original: libc::termios,
}
impl HiddenInput {
    fn new() -> Result<Self> {
        let terminal = OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/tty")
            .map_err(|_| "An external terminal is required for authentication.")?;
        Self::from_terminal(terminal)
    }

    fn from_terminal(terminal: File) -> Result<Self> {
        let mut original = std::mem::MaybeUninit::uninit();
        // SAFETY: tcgetattr initializes the supplied termios on success; fd is live.
        if unsafe { libc::tcgetattr(terminal.as_raw_fd(), original.as_mut_ptr()) } != 0 {
            return Err("Cannot protect terminal password input.".into());
        }
        let original = unsafe { original.assume_init() };
        let mut hidden = original;
        hidden.c_lflag &= !libc::ECHO;
        // SAFETY: both the descriptor and termios are valid.
        if unsafe { libc::tcsetattr(terminal.as_raw_fd(), libc::TCSAFLUSH, &hidden) } != 0 {
            return Err("Cannot hide terminal password input.".into());
        }
        Ok(Self { terminal, original })
    }
}
impl Drop for HiddenInput {
    fn drop(&mut self) {
        // SAFETY: restore the original state on this still-owned terminal descriptor.
        unsafe {
            libc::tcsetattr(self.terminal.as_raw_fd(), libc::TCSAFLUSH, &self.original);
        }
    }
}

pub fn session_helper(args: &[OsString]) -> i32 {
    let result = (|| -> Result<()> {
        if args.len() != 5 {
            return Err("Invalid administration session arguments.".into());
        }
        let store = Store {
            directory: PathBuf::from(&args[2]),
        };
        let id = args[3].to_str().ok_or("Invalid operation ID.")?;
        let request = request(&store, id)?;
        let directory = jobs_dir(&store)?;
        inventory::protected_file(&directory.join(format!("{id}.started")), true)?;
        claim(&directory.join(format!("{id}.claimed")))?;
        let job_result = (|| -> Result<Overview> {
            ensure_current(&store, &request)?;
            let _host_lock =
                HostLock::acquire(&directory.join(format!("{}.lock", request.host.id)))?;
            let mut environment = Environment::current()?;
            environment.agent_socket = if args[4] == "-" {
                None
            } else {
                Some(PathBuf::from(&args[4]))
            };
            let (summary, command, _) = action_details(&request.action)?;
            println!("Admin-Tower: {summary}\nHost: {}@{}:{}\n{command}\nAuthentication input is hidden and is never stored.\n", request.host.settings.username, request.host.settings.address, request.host.settings.port);
            let _hidden = HiddenInput::new()?;
            let output = run_remote(
                &request.host,
                &environment,
                &store.directory,
                &request.action,
                true,
            )?;
            if output.limited || output.code == Some(255) || output.code.is_none() {
                return Err("Outcome unknown: connection interrupted or time/output limit reached. Refresh before considering another action.".into());
            }
            if output.code != Some(0) {
                return Err("Operation failed or was partially applied. Check the terminal diagnostics and refresh the host before retrying.".into());
            }
            let mut overview = parse_overview(
                &output.output,
                !matches!(request.action, Action::Inspect { elevated: false }),
            )
            .map_err(|e| format!("Outcome unknown: command completed but snapshot failed: {e}"))?;
            overview.target = Some(request.host.clone());
            Ok(overview)
        })();
        let job = match job_result {
            Ok(overview) => Job {
                id: id.into(),
                host_id: request.host.id,
                state: "succeeded".into(),
                message: "Operation completed; host information refreshed.".into(),
                overview: Some(overview),
                logs: String::new(),
            },
            Err(error) => Job {
                id: id.into(),
                host_id: request.host.id,
                state: if error.starts_with("Outcome unknown") {
                    "unknown"
                } else {
                    "failed"
                }
                .into(),
                message: error,
                overview: None,
                logs: String::new(),
            },
        };
        write_json(&directory.join(format!("{id}.result")), &job)?;
        println!("\n{}", job.message);
        if job.state != "succeeded" {
            return Err("Review the result in Admin-Tower. No automatic retry will occur.".into());
        }
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("\n{error}\nPress Enter to close.");
        let _ = std::io::stdin().read_line(&mut String::new());
        return 1;
    }
    0
}

#[cfg(test)]
mod tests;
