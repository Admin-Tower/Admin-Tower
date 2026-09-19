use crate::inventory::{self, Authentication, Host, Result, Store};
use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    Engine,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    ffi::{CStr, OsString},
    fs,
    io::{Read, Write},
    os::unix::fs::{FileTypeExt, MetadataExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[derive(Clone)]
pub struct Environment {
    pub home: PathBuf,
    pub agent_socket: Option<PathBuf>,
}

impl Environment {
    pub fn current() -> Result<Self> {
        if inventory::uid() == 0 {
            return Err("Run Admin-Tower as your normal desktop user, not root.".into());
        }
        // Resolve the actual account home, rather than trusting a caller-supplied HOME.
        let mut buffer = vec![0u8; 65536];
        let mut record = std::mem::MaybeUninit::<libc::passwd>::uninit();
        let mut result = std::ptr::null_mut();
        // SAFETY: record, result and buffer are valid writable allocations. The returned
        // string remains in buffer and is copied before that allocation is dropped.
        let home = unsafe {
            if libc::getpwuid_r(
                inventory::uid(),
                record.as_mut_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            ) != 0
                || result.is_null()
            {
                return Err("Cannot resolve the current user's home directory.".into());
            }
            CStr::from_ptr((*result).pw_dir)
                .to_str()
                .map_err(|_| "Home path must be UTF-8.")?
                .to_owned()
        };
        Ok(Self {
            home: PathBuf::from(home),
            agent_socket: std::env::var_os("SSH_AUTH_SOCK").map(PathBuf::from),
        })
    }

    fn ssh_dir(&self) -> Result<PathBuf> {
        inventory::no_symlinks(&self.home)?;
        let home_meta = fs::metadata(&self.home).map_err(|_| "Cannot inspect home directory.")?;
        if home_meta.uid() != inventory::uid() || home_meta.mode() & 0o022 != 0 {
            return Err(
                "Home directory must be owned by you and not writable by other users.".into(),
            );
        }
        let directory = self.home.join(".ssh");
        inventory::no_symlinks(&directory)?;
        let meta = fs::metadata(&directory)
            .map_err(|_| "Create a private ~/.ssh directory before selecting a key.")?;
        if !meta.is_dir() || meta.uid() != inventory::uid() || meta.mode() & 0o077 != 0 {
            return Err("~/.ssh must be owned by you with mode 0700. Permissions are never changed automatically.".into());
        }
        Ok(directory)
    }

    pub fn key_file(&self, filename: &str) -> Result<PathBuf> {
        inventory::validate_filename(filename)?;
        let path = self.ssh_dir()?.join(filename);
        // Only metadata is inspected: no private key bytes are read by Admin-Tower.
        inventory::protected_file(&path, true)?;
        literal_path(&path)?;
        Ok(path)
    }

    fn socket(&self) -> Result<PathBuf> {
        let path = self.agent_socket.as_ref().ok_or("No SSH agent is available. Start an agent and load a key before launching Admin-Tower.")?;
        inventory::no_symlinks(path)?;
        let meta = fs::symlink_metadata(path).map_err(|_| "SSH agent socket is unavailable.")?;
        if !meta.file_type().is_socket()
            || meta.uid() != inventory::uid()
            || meta.mode() & 0o077 != 0
        {
            return Err("SSH agent socket has unsafe ownership, permissions, or type.".into());
        }
        literal_path(path)?;
        Ok(path.clone())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityOptions {
    pub agent_identities: Vec<AgentIdentity>,
    pub key_files: Vec<String>,
    pub agent_error: Option<String>,
    pub key_error: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct AgentIdentity {
    pub fingerprint: String,
    pub algorithm: String,
    #[serde(skip)]
    public_key: String,
}

fn parse_agent_keys(output: &str) -> Result<Vec<AgentIdentity>> {
    let mut identities = vec![];
    for line in output.lines() {
        let mut parts = line.split_whitespace();
        let algorithm = parts
            .next()
            .ok_or("Malformed public identity from SSH agent.")?;
        let encoded = parts
            .next()
            .ok_or("Malformed public identity from SSH agent.")?;
        if !algorithm
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-@.".contains(&b))
        {
            return Err("Malformed public identity algorithm.".into());
        }
        let key = STANDARD
            .decode(encoded)
            .map_err(|_| "Malformed public identity encoding.")?;
        if key.len() < 4 {
            return Err("Malformed public identity.".into());
        }
        let length = u32::from_be_bytes(key[..4].try_into().unwrap()) as usize;
        if key.get(4..4usize.saturating_add(length)) != Some(algorithm.as_bytes()) {
            return Err("Public identity algorithm does not match its key.".into());
        }
        let fingerprint = format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(&key)));
        if !identities
            .iter()
            .any(|identity: &AgentIdentity| identity.fingerprint == fingerprint)
        {
            identities.push(AgentIdentity {
                fingerprint,
                algorithm: algorithm.to_owned(),
                public_key: format!("{algorithm} {encoded}\n"),
            });
        }
    }
    Ok(identities)
}

fn agent_identities(environment: &Environment) -> Result<Vec<AgentIdentity>> {
    let socket = environment.socket()?;
    // A file prevents pipe deadlock. The timeout and file-size limit bound a broken agent.
    let mut output = tempfile::tempfile().map_err(|_| "Cannot allocate public identity output.")?;
    let mut child = Command::new("/usr/bin/ssh-add")
        .arg("-L")
        .env_clear()
        .env("SSH_AUTH_SOCK", socket)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(
            output
                .try_clone()
                .map_err(|_| "Cannot capture public identities.")?,
        )
        .spawn()
        .map_err(|_| "Cannot run /usr/bin/ssh-add.")?;
    let deadline = Instant::now() + Duration::from_secs(3);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None)
                if Instant::now() < deadline
                    && output
                        .metadata()
                        .map(|m| m.len() <= 1024 * 1024)
                        .unwrap_or(false) =>
            {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(
                    "SSH agent did not return identities within the allowed limits.".into(),
                );
            }
        }
    };
    if !status.success() {
        return Err("SSH agent is unavailable or has no loaded identities.".into());
    }
    use std::io::{Seek, SeekFrom};
    output
        .seek(SeekFrom::Start(0))
        .map_err(|_| "Cannot read public identities.")?;
    let mut text = String::new();
    output
        .take(1024 * 1024 + 1)
        .read_to_string(&mut text)
        .map_err(|_| "Cannot read public identities.")?;
    if text.len() > 1024 * 1024 {
        return Err("SSH agent identity response is too large.".into());
    }
    parse_agent_keys(&text)
}

pub fn identities(environment: &Environment) -> IdentityOptions {
    let agent = agent_identities(environment);
    let files = (|| -> Result<Vec<String>> {
        let mut files = Vec::new();
        for entry in fs::read_dir(environment.ssh_dir()?).map_err(|_| "Cannot list ~/.ssh.")? {
            let entry = entry.map_err(|_| "Cannot inspect ~/.ssh entry.")?;
            if let Some(name) = entry.file_name().to_str() {
                if environment.key_file(name).is_ok() {
                    files.push(name.to_owned());
                }
            }
        }
        files.sort();
        Ok(files)
    })();
    IdentityOptions {
        agent_error: agent.as_ref().err().cloned(),
        key_error: files.as_ref().err().cloned(),
        agent_identities: agent.unwrap_or_default(),
        key_files: files.unwrap_or_default(),
    }
}

/// OpenSSH expands percent/environment tokens even in argv path values.
fn literal_path(path: &Path) -> Result<String> {
    let value = path.to_str().ok_or("SSH paths must be UTF-8.")?;
    if !path.is_absolute()
        || value
            .chars()
            .any(|c| c.is_control() || "%$\"'\\".contains(c))
    {
        return Err("SSH paths cannot contain control characters, quotes, backslashes, or expansion tokens.".into());
    }
    Ok(value.to_owned())
}

pub struct Prepared {
    pub arguments: Vec<OsString>,
    // Keep the public identity file alive for the complete SSH process lifetime.
    _public_identity: Option<tempfile::NamedTempFile>,
}

pub fn prepare(host: &Host, environment: &Environment, directory: &Path) -> Result<Prepared> {
    inventory::validate_host(&host.settings)?;
    let known_hosts = environment.ssh_dir()?.join("known_hosts");
    inventory::protected_file(&known_hosts, false)
        .map_err(|_| "A safe ~/.ssh/known_hosts is required. Verify and establish host trust outside Admin-Tower first.")?;
    inventory::private_dir(directory)?;
    let (identity, agent, public) = match &host.settings.authentication {
        Authentication::KeyFile { filename } => {
            (environment.key_file(filename)?, "none".to_owned(), None)
        }
        Authentication::Agent { fingerprint } => {
            let key = agent_identities(environment)?
                .into_iter()
                .find(|key| &key.fingerprint == fingerprint)
                .ok_or("The selected agent identity is no longer loaded. Load it and retry.")?;
            let mut public = tempfile::Builder::new()
                .prefix("agent-")
                .suffix(".pub")
                .tempfile_in(directory)
                .map_err(|_| "Cannot create public identity reference.")?;
            public
                .write_all(key.public_key.as_bytes())
                .map_err(|_| "Cannot write public identity reference.")?;
            (
                public.path().to_path_buf(),
                literal_path(&environment.socket()?)?,
                Some(public),
            )
        }
    };
    Ok(Prepared {
        arguments: ssh_arguments(host, &identity, &known_hosts, &agent)?,
        _public_identity: public,
    })
}

fn ssh_arguments(
    host: &Host,
    identity: &Path,
    known_hosts: &Path,
    agent: &str,
) -> Result<Vec<OsString>> {
    let mut args: Vec<OsString> = ["-F", "/dev/null"].into_iter().map(Into::into).collect();
    for option in [
        "StrictHostKeyChecking=yes",
        "GlobalKnownHostsFile=/dev/null",
        "UpdateHostKeys=no",
        "VerifyHostKeyDNS=no",
        "CheckHostIP=no",
        "IdentitiesOnly=yes",
        "IdentityFile=none",
        "CertificateFile=none",
        "PreferredAuthentications=publickey",
        "PasswordAuthentication=no",
        "KbdInteractiveAuthentication=no",
        "AddKeysToAgent=no",
        "ForwardAgent=no",
        "ForwardX11=no",
        "ForwardX11Trusted=no",
        "ClearAllForwardings=yes",
        "Tunnel=no",
        "PermitLocalCommand=no",
        "ControlMaster=no",
        "ControlPath=none",
        "ControlPersist=no",
        "ProxyCommand=none",
        "ProxyJump=none",
        "KnownHostsCommand=none",
        "EscapeChar=none",
        "ConnectTimeout=15",
        "ConnectionAttempts=1",
        "ServerAliveInterval=30",
        "ServerAliveCountMax=3",
    ] {
        args.extend(["-o".into(), option.into()]);
    }
    // -o values have their own parser; quote paths that may contain spaces.
    args.extend([
        "-o".into(),
        format!("UserKnownHostsFile=\"{}\"", literal_path(known_hosts)?).into(),
    ]);
    args.extend(["-o".into(), format!("IdentityAgent=\"{agent}\"").into()]);
    args.extend(["-i".into(), literal_path(identity)?.into()]);
    args.extend([
        "-p".into(),
        host.settings.port.to_string().into(),
        "-l".into(),
        host.settings.username.clone().into(),
        "--".into(),
        host.settings.address.clone().into(),
    ]);
    Ok(args)
}

#[derive(Clone, Copy, Serialize)]
pub struct Terminal {
    pub id: &'static str,
    pub label: &'static str,
}
const TERMINALS: [Terminal; 3] = [
    Terminal {
        id: "gnome-terminal",
        label: "GNOME Terminal",
    },
    Terminal {
        id: "konsole",
        label: "Konsole",
    },
    Terminal {
        id: "xterm",
        label: "xterm",
    },
];

pub fn terminals() -> Vec<Terminal> {
    TERMINALS
        .into_iter()
        .filter(|t| Path::new("/usr/bin").join(t.id).is_file())
        .collect()
}

fn terminal_arguments(
    terminal: &str,
    executable: &Path,
    directory: &Path,
    id: &str,
    socket: Option<&Path>,
) -> Result<Vec<OsString>> {
    let mut args: Vec<OsString> = match terminal {
        // --wait keeps the launcher process available for reaping; no command strings.
        "gnome-terminal" => vec!["--wait".into(), "--".into()],
        "konsole" => vec!["--nofork".into(), "-e".into()],
        "xterm" => vec!["-e".into()],
        _ => return Err("Select a supported installed terminal.".into()),
    };
    args.extend([
        executable.as_os_str().to_owned(),
        "--ssh-session".into(),
        directory.as_os_str().to_owned(),
        id.into(),
        socket
            .map(|p| p.as_os_str().to_owned())
            .unwrap_or_else(|| "-".into()),
    ]);
    Ok(args)
}

pub fn connect(store: &Store, environment: &Environment, id: &str, terminal: &str) -> Result<()> {
    let host = store.get(id)?;
    let _checked = prepare(&host, environment, &store.directory)?;
    launch_helper(
        terminal,
        "--ssh-session",
        &store.directory,
        id,
        environment.agent_socket.as_deref(),
    )
}

pub fn launch_helper(
    terminal: &str,
    flag: &str,
    directory: &Path,
    id: &str,
    socket: Option<&Path>,
) -> Result<()> {
    if !matches!(flag, "--ssh-session" | "--admin-session") {
        return Err("Invalid session helper.".into());
    }
    if !Path::new("/usr/bin/ssh").is_file() {
        return Err("Install system OpenSSH (/usr/bin/ssh) first.".into());
    }
    if !terminals().iter().any(|t| t.id == terminal) {
        return Err("Selected terminal is not installed.".into());
    }
    let executable =
        std::env::current_exe().map_err(|_| "Cannot locate the desktop session helper.")?;
    let mut args = terminal_arguments(terminal, &executable, directory, id, socket)?;
    let position = args
        .iter()
        .position(|a| a == "--ssh-session")
        .ok_or("Missing helper argument.")?;
    args[position] = flag.into();
    let mut child = Command::new(Path::new("/usr/bin").join(terminal))
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Could not launch the selected terminal.")?;
    // Detect immediate launcher failures, without waiting for the interactive session.
    std::thread::sleep(Duration::from_millis(150));
    if let Some(status) = child
        .try_wait()
        .map_err(|_| "Cannot inspect terminal launcher.")?
    {
        if !status.success() {
            return Err("The terminal could not start. Check your desktop session.".into());
        }
    } else {
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    Ok(())
}

/// Runs before Tauri/GTK initialization, inside the user's external terminal.
pub fn session_helper(args: &[OsString]) -> i32 {
    let result = (|| -> Result<i32> {
        if args.len() != 5 {
            return Err("Invalid SSH session arguments.".into());
        }
        let store = Store {
            directory: PathBuf::from(&args[2]),
        };
        let id = args[3].to_str().ok_or("Invalid host ID.")?;
        let mut environment = Environment::current()?;
        environment.agent_socket = if args[4] == "-" {
            None
        } else {
            Some(PathBuf::from(&args[4]))
        };
        let host = store.get(id)?;
        let prepared = prepare(&host, &environment, &store.directory)?;
        println!(
            "Connecting to {}@{}:{}\n",
            host.settings.username, host.settings.address, host.settings.port
        );
        let status = Command::new("/usr/bin/ssh")
            .args(&prepared.arguments)
            .env_remove("SSH_ASKPASS")
            .env("SSH_ASKPASS_REQUIRE", "never")
            .env_remove("SSH_SK_PROVIDER")
            .env_remove("LD_PRELOAD")
            .env_remove("LD_LIBRARY_PATH")
            .status()
            .map_err(|_| "Could not start system OpenSSH.")?;
        Ok(status.code().unwrap_or(1))
    })();
    let code = match result {
        Ok(code) => code,
        Err(error) => {
            eprintln!("Admin-Tower: {error}");
            1
        }
    };
    if code != 0 {
        eprintln!("\nSSH did not complete successfully. Unknown or changed host keys must be verified outside Admin-Tower.\nPress Enter to close.");
        let _ = std::io::stdin().read_line(&mut String::new());
    }
    code
}

#[cfg(test)]
mod tests;
