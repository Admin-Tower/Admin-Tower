use super::*;
use crate::inventory::{validate_host, HostInput};
use std::{
    fs::OpenOptions,
    os::{
        fd::AsRawFd,
        unix::fs::{symlink, PermissionsExt},
    },
};

fn fixture() -> (tempfile::TempDir, Environment, Store) {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    inventory::private_dir(&home).unwrap();
    inventory::private_dir(&home.join(".ssh")).unwrap();
    write_private(
        &home.join(".ssh/id_ed25519"),
        b"not a key; bytes must not be inspected",
    );
    write_private(&home.join(".ssh/known_hosts"), b"");
    let directory = root.path().join("inventory");
    inventory::private_dir(&directory).unwrap();
    (
        root,
        Environment {
            home,
            agent_socket: None,
        },
        Store { directory },
    )
}

fn write_private(path: &Path, contents: &[u8]) {
    fs::write(path, contents).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

fn settings() -> HostInput {
    HostInput {
        name: "Test server".into(),
        address: "server.example.com".into(),
        username: "admin".into(),
        port: 22,
        authentication: Authentication::KeyFile {
            filename: "id_ed25519".into(),
        },
    }
}

#[test]
fn inventory_roundtrip_preserves_identity_and_permissions() {
    let (_root, _env, store) = fixture();
    let host = store.save(None, settings()).unwrap();
    assert_eq!(store.list().unwrap().len(), 1);
    let mut edit = host.settings;
    edit.port = 2222;
    let updated = store.save(Some(host.id.clone()), edit).unwrap();
    assert_eq!(updated.id, host.id);
    assert_eq!(store.get(&host.id).unwrap().settings.port, 2222);
    let file = store.directory.join("hosts.json");
    assert_eq!(fs::metadata(file).unwrap().mode() & 0o777, 0o600);
    assert_eq!(
        fs::metadata(&store.directory).unwrap().mode() & 0o777,
        0o700
    );
    store.delete(&host.id).unwrap();
    assert!(store.list().unwrap().is_empty());
    assert!(store.delete(&host.id).is_err());
    assert!(store.save(Some(host.id), settings()).is_err());
}

#[test]
fn malformed_and_future_inventory_are_never_overwritten() {
    let (_root, _env, store) = fixture();
    for bytes in [b"{bad json".as_slice(), b"{\"version\":99,\"hosts\":[]}"] {
        write_private(&store.directory.join("hosts.json"), bytes);
        assert!(store.list().is_err());
        assert!(store.save(None, settings()).is_err());
        assert_eq!(fs::read(store.directory.join("hosts.json")).unwrap(), bytes);
    }
}

#[test]
fn independent_process_lock_prevents_lost_updates() {
    let (_root, _env, store) = fixture();
    store.list().unwrap();
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(store.directory.join("inventory.lock"))
        .unwrap();
    // SAFETY: the file descriptor remains live until after the assertion.
    assert_eq!(
        unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
    assert!(store.save(None, settings()).unwrap_err().contains("busy"));
    // SAFETY: release this live test lock explicitly, including any fork inheritance.
    assert_eq!(unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) }, 0);
    drop(file);
    store.save(None, settings()).unwrap();
}

#[test]
fn rejects_inventory_links_and_loose_permissions() {
    let (root, _env, store) = fixture();
    write_private(&root.path().join("outside"), b"sentinel");
    symlink(
        root.path().join("outside"),
        store.directory.join("hosts.json"),
    )
    .unwrap();
    assert!(store.save(None, settings()).is_err());
    assert_eq!(fs::read(root.path().join("outside")).unwrap(), b"sentinel");
    fs::remove_file(store.directory.join("hosts.json")).unwrap();
    store.save(None, settings()).unwrap();
    fs::set_permissions(
        store.directory.join("hosts.json"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert!(store.list().is_err());
}

#[test]
fn rejects_command_option_and_path_injection() {
    for address in [
        "-oProxyCommand=touch /tmp/bad",
        "host;id",
        "$(id)",
        "user@host",
        "host\n-oPort=1",
        "bad host",
        "[::1]",
        "",
        "host/path",
        "bad..host",
    ] {
        let mut input = settings();
        input.address = address.into();
        assert!(validate_host(&input).is_err(), "accepted {address}");
    }
    for name in [
        "../../secret",
        "/tmp/key",
        "id_%h",
        "id_${HOME}",
        "id\nkey",
        "id'key",
        "config",
        "known_hosts",
        "authorized_keys",
        "id.pub",
    ] {
        assert!(
            inventory::validate_filename(name).is_err(),
            "accepted {name}"
        );
    }
    for user in ["-oProxyCommand=bad", "admin@host", "a b", "$(id)", ""] {
        let mut input = settings();
        input.username = user.into();
        assert!(validate_host(&input).is_err());
    }
    for address in [
        "localhost",
        "server-1.example.com",
        "127.0.0.1",
        "2001:db8::1",
        "::1",
    ] {
        let mut input = settings();
        input.address = address.into();
        validate_host(&input).unwrap();
    }
    let mut input = settings();
    input.port = 0;
    assert!(validate_host(&input).is_err());
}

#[test]
fn key_candidates_require_safe_metadata_without_reading_contents() {
    let (_root, env, _store) = fixture();
    // Invalid key bytes are still candidates: only OpenSSH reads/validates the private key.
    assert_eq!(identities(&env).key_files, vec!["id_ed25519"]);
    let key = env.home.join(".ssh/id_ed25519");
    fs::set_permissions(&key, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(env.key_file("id_ed25519").is_err());
    fs::set_permissions(&key, fs::Permissions::from_mode(0o600)).unwrap();
    fs::hard_link(&key, env.home.join(".ssh/another")).unwrap();
    assert!(env.key_file("id_ed25519").is_err());
}

#[test]
fn key_and_directory_symlinks_are_rejected() {
    let (root, env, _store) = fixture();
    symlink(env.home.join(".ssh/id_ed25519"), env.home.join(".ssh/link")).unwrap();
    assert!(env.key_file("link").is_err());
    let linked_home = root.path().join("linked-home");
    symlink(&env.home, &linked_home).unwrap();
    let linked = Environment {
        home: linked_home,
        agent_socket: None,
    };
    assert!(linked.key_file("id_ed25519").is_err());
}

#[test]
fn unavailable_agent_never_falls_back_to_a_private_file() {
    let (_root, env, store) = fixture();
    let mut input = settings();
    input.authentication = Authentication::Agent {
        fingerprint: format!("SHA256:{}", "A".repeat(43)),
    };
    let host = store.save(None, input).unwrap();
    assert!(prepare(&host, &env, &store.directory)
        .err()
        .unwrap()
        .contains("No SSH agent"));
}

#[test]
fn safe_known_hosts_is_mandatory_and_never_created() {
    let (_root, env, store) = fixture();
    let host = store.save(None, settings()).unwrap();
    let known_hosts = env.home.join(".ssh/known_hosts");
    fs::remove_file(&known_hosts).unwrap();
    assert!(prepare(&host, &env, &store.directory).is_err());
    assert!(!known_hosts.exists());
}

#[test]
fn openssh_effective_configuration_is_isolated_and_restrictive() {
    let (_root, env, store) = fixture();
    let host = store.save(None, settings()).unwrap();
    write_private(
        &env.home.join(".ssh/config"),
        b"Host *\n  ForwardAgent yes\n  StrictHostKeyChecking no\n  ProxyCommand false\n",
    );
    let prepared = prepare(&host, &env, &store.directory).unwrap();
    let output = Command::new("/usr/bin/ssh")
        .arg("-G")
        .args(&prepared.arguments)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let config = String::from_utf8(output.stdout).unwrap();
    for expected in [
        "stricthostkeychecking true",
        "identityagent none",
        "identitiesonly yes",
        "forwardagent no",
        "forwardx11 no",
        "clearallforwardings yes",
        "passwordauthentication no",
        "kbdinteractiveauthentication no",
        "permitlocalcommand no",
        "updatehostkeys false",
        "preferredauthentications publickey",
        "controlmaster false",
        "checkhostip no",
        "verifyhostkeydns false",
    ] {
        assert!(
            config.lines().any(|line| line == expected),
            "missing {expected} in {config}"
        );
    }
    assert_eq!(
        config
            .lines()
            .filter(|l| l.starts_with("identityfile ") && *l != "identityfile none")
            .count(),
        1
    );
    assert!(!config.contains("proxycommand false"));
    assert_eq!(fs::read(env.home.join(".ssh/known_hosts")).unwrap(), b"");
}

#[test]
fn paths_with_spaces_are_literal_but_expansion_tokens_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("home with spaces");
    inventory::private_dir(&directory).unwrap();
    let identity = directory.join("my key");
    let known_hosts = directory.join("known_hosts");
    write_private(&identity, b"test key candidate");
    write_private(&known_hosts, b"");
    let mut host = Host {
        id: uuid::Uuid::new_v4().to_string(),
        settings: settings(),
    };
    host.settings.address = "::1".into();
    let args = ssh_arguments(&host, &identity, &known_hosts, "none").unwrap();
    let output = Command::new("/usr/bin/ssh")
        .arg("-G")
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success());
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(
        text.contains(&format!("identityfile {}\n", identity.display())),
        "{text}"
    );
    for path in [
        "/home/%h/key",
        "/home/${HOME}/key",
        "/home/quote\"/key",
        "/home/line\n/key",
    ] {
        assert!(literal_path(Path::new(path)).is_err());
    }
}

#[test]
fn terminal_adapters_use_argv_without_shell_interpretation() {
    for terminal in ["gnome-terminal", "konsole", "xterm"] {
        let args = terminal_arguments(
            terminal,
            Path::new("/opt/Admin Tower/app"),
            Path::new("/home/user/App data"),
            "host-id",
            None,
        )
        .unwrap();
        assert!(args.contains(&OsString::from("/opt/Admin Tower/app")));
        assert!(args.contains(&OsString::from("/home/user/App data")));
        assert!(!args.contains(&OsString::from("sh")));
    }
    assert!(
        terminal_arguments("sh -c", Path::new("/app"), Path::new("/data"), "id", None).is_err()
    );
}

#[test]
fn fingerprint_is_derived_from_public_blob_and_comments_are_discarded() {
    let mut blob = vec![];
    blob.extend((11u32).to_be_bytes());
    blob.extend(b"ssh-ed25519");
    blob.extend((32u32).to_be_bytes());
    blob.extend([1u8; 32]);
    let encoded = STANDARD.encode(&blob);
    let text = format!("ssh-ed25519 {encoded} comment with controls\n");
    let keys = parse_agent_keys(&text).unwrap();
    assert_eq!(
        keys[0].fingerprint,
        format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(&blob)))
    );
    assert_eq!(keys[0].public_key, format!("ssh-ed25519 {encoded}\n"));
    assert!(parse_agent_keys("ssh-rsa !!!").is_err());
    assert!(parse_agent_keys(&format!("ssh-rsa {encoded}")).is_err());
}

struct ChildGuard(std::process::Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
#[ignore = "requires a graphical desktop; opens and immediately closes harmless fixture terminals"]
fn live_terminal_adapters_pass_literal_arguments() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("data with spaces");
    inventory::private_dir(&directory).unwrap();
    let helper = root.path().join("helper with spaces");
    fs::write(&helper, b"#!/usr/bin/python3\nimport json, sys\nfrom pathlib import Path\np = Path(sys.argv[2], 'launched.tmp')\np.write_text(json.dumps(sys.argv[1:]))\np.rename(p.with_name('launched'))\n").unwrap();
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
    let terminals = terminals();
    assert!(
        !terminals.is_empty(),
        "Install a supported terminal to run this test"
    );
    let id = uuid::Uuid::new_v4().to_string();
    for terminal in terminals {
        let args = terminal_arguments(terminal.id, &helper, &directory, &id, None).unwrap();
        let mut child = ChildGuard(
            Command::new(Path::new("/usr/bin").join(terminal.id))
                .args(args)
                .spawn()
                .unwrap(),
        );
        let marker = directory.join("launched");
        wait_for(&marker, &mut child);
        let received: Vec<String> = serde_json::from_slice(&fs::read(&marker).unwrap()).unwrap();
        assert_eq!(
            received,
            vec![
                "--ssh-session".to_owned(),
                directory.to_str().unwrap().to_owned(),
                id.clone(),
                "-".to_owned()
            ]
        );
        fs::remove_file(marker).unwrap();
        println!("{} passed real terminal launch", terminal.label);
    }
}

fn wait_for(path: &Path, child: &mut ChildGuard) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !path.exists() {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "Fixture exited before creating {}",
            path.display()
        );
        assert!(Instant::now() < deadline, "Fixture startup timed out");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn generate_key(path: &Path, passphrase: &str) {
    let status = Command::new("/usr/bin/ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", passphrase, "-f"])
        .arg(path)
        .status()
        .unwrap();
    assert!(status.success());
}

#[test]
#[ignore = "requires loopback sockets, OpenSSH and Python Paramiko; run the test-ssh Nx target"]
fn live_ssh_enforces_host_trust_and_exact_identity_for_files_and_agents() {
    let (root, mut environment, store) = fixture();
    let key = environment.home.join(".ssh/id_ed25519");
    fs::remove_file(&key).unwrap();
    generate_key(&key, "");
    let other = environment.home.join(".ssh/other_key");
    generate_key(&other, "");
    let encrypted = environment.home.join(".ssh/encrypted_key");
    generate_key(&encrypted, "fixture-only-passphrase");
    fs::copy(key.with_extension("pub"), root.path().join("client.pub")).unwrap();
    let mut server = ChildGuard(
        Command::new("python3")
            .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/ssh_server.py"))
            .arg(root.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .spawn()
            .unwrap(),
    );
    wait_for(&root.path().join("ready.json"), &mut server);
    let ready: serde_json::Value =
        serde_json::from_slice(&fs::read(root.path().join("ready.json")).unwrap()).unwrap();
    let known_hosts = environment.home.join(".ssh/known_hosts");
    let trust = ready["knownHost"].as_str().unwrap();
    write_private(&known_hosts, trust.as_bytes());
    let mut input = settings();
    input.address = "127.0.0.1".into();
    input.username = "fixture".into();
    input.port = ready["port"].as_u64().unwrap() as u16;
    let mut host = store.save(None, input).unwrap();
    let run = |host: &Host, env: &Environment| {
        let prepared = prepare(host, env, &store.directory).unwrap();
        Command::new("/usr/bin/ssh")
            .args(["-o", "BatchMode=yes"])
            .args(&prepared.arguments)
            .arg("fixture-command")
            .stdin(Stdio::null())
            .env("SSH_ASKPASS_REQUIRE", "never")
            .output()
            .unwrap()
    };
    let output = run(&host, &environment);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"fixture-ok\n");
    assert_eq!(fs::read_to_string(&known_hosts).unwrap(), trust);

    // Unknown hosts cannot authenticate or silently add trust.
    write_private(&known_hosts, b"");
    let output = run(&host, &environment);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Host key verification failed"));
    assert!(fs::read(&known_hosts).unwrap().is_empty());

    // A different valid host key must not be replaced.
    let changed = format!(
        "[127.0.0.1]:{} {}",
        host.settings.port,
        fs::read_to_string(other.with_extension("pub")).unwrap()
    );
    write_private(&known_hosts, changed.as_bytes());
    let output = run(&host, &environment);
    assert!(!output.status.success());
    assert_eq!(fs::read_to_string(&known_hosts).unwrap(), changed);
    write_private(&known_hosts, trust.as_bytes());

    // Exercise non-default-port hashed known_hosts lookup through OpenSSH itself.
    assert!(Command::new("/usr/bin/ssh-keygen")
        .args(["-H", "-f"])
        .arg(&known_hosts)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success());
    assert!(run(&host, &environment).status.success());
    let hashed_trust = fs::read(&known_hosts).unwrap();

    let socket = root.path().join("agent.sock");
    let mut agent = ChildGuard(
        Command::new("/usr/bin/ssh-agent")
            .args(["-D", "-a"])
            .arg(&socket)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    wait_for(&socket, &mut agent);
    environment.agent_socket = Some(socket.clone());
    for path in [&other, &key] {
        assert!(Command::new("/usr/bin/ssh-add")
            .arg(path)
            .env("SSH_AUTH_SOCK", &socket)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success());
    }
    let key_fingerprint = parse_agent_keys(&fs::read_to_string(key.with_extension("pub")).unwrap())
        .unwrap()[0]
        .fingerprint
        .clone();
    let other_fingerprint =
        parse_agent_keys(&fs::read_to_string(other.with_extension("pub")).unwrap()).unwrap()[0]
            .fingerprint
            .clone();
    assert_eq!(agent_identities(&environment).unwrap().len(), 2);
    host.settings.authentication = Authentication::Agent {
        fingerprint: key_fingerprint,
    };
    write_private(&root.path().join("attempts"), b"");
    let output = run(&host, &environment);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let wanted = fs::read_to_string(key.with_extension("pub"))
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .to_owned();
    assert!(fs::read_to_string(root.path().join("attempts"))
        .unwrap()
        .lines()
        .all(|line| line == wanted));
    host.settings.authentication = Authentication::Agent {
        fingerprint: other_fingerprint,
    };
    assert!(
        !run(&host, &environment).status.success(),
        "must not fall back to another loaded agent identity"
    );

    // A matching agent identity must not rescue an explicitly selected wrong/encrypted file.
    for filename in ["other_key", "encrypted_key"] {
        host.settings.authentication = Authentication::KeyFile {
            filename: filename.into(),
        };
        assert!(!run(&host, &environment).status.success());
    }
    assert_eq!(fs::read(&known_hosts).unwrap(), hashed_trust);
    assert!(!fs::read_dir(&store.directory).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with("agent-")));
}

#[test]
#[ignore = "requires loopback sockets and Python Paramiko; run test-ssh"]
fn live_ssh_administration_snapshot_uses_hardened_transport() {
    let (root, environment, store) = fixture();
    let key = environment.home.join(".ssh/id_ed25519");
    fs::remove_file(&key).unwrap();
    generate_key(&key, "");
    fs::copy(key.with_extension("pub"), root.path().join("client.pub")).unwrap();
    let mut server = ChildGuard(
        Command::new("python3")
            .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/ssh_server.py"))
            .arg(root.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .spawn()
            .unwrap(),
    );
    wait_for(&root.path().join("ready.json"), &mut server);
    let ready: serde_json::Value =
        serde_json::from_slice(&fs::read(root.path().join("ready.json")).unwrap()).unwrap();
    write_private(
        &environment.home.join(".ssh/known_hosts"),
        ready["knownHost"].as_str().unwrap().as_bytes(),
    );
    let mut input = settings();
    input.address = "127.0.0.1".into();
    input.username = "fixture".into();
    input.port = ready["port"].as_u64().unwrap() as u16;
    let host = store.save(None, input).unwrap();
    // The server returns a fixture snapshot, never executes received administration commands.
    let output = Command::new("/bin/sh")
        .args(["-c", include_str!("../host-overview.sh")])
        .output()
        .unwrap();
    fs::write(root.path().join("snapshot"), output.stdout).unwrap();
    let overview = crate::admin::inspect(&store, &environment, &host.id).unwrap();
    assert_eq!(overview.sections.len(), 20);
    assert!(!overview.elevated);
    let command = fs::read_to_string(root.path().join("last-command")).unwrap();
    assert!(command.starts_with("/bin/sh -c "));
    assert!(!command.contains("sudo -S"));
    // Package log reads reuse this hardened SSH transport and only a fixed UUID path.
    let run_id = uuid::Uuid::new_v4().to_string();
    fs::write(
        root.path().join("snapshot"),
        b"$ apt-get update\nfirst output\n",
    )
    .unwrap();
    assert!(crate::packages::remote_log(&host, &environment, &run_id)
        .unwrap()
        .contains("first output"));
    let log_command = fs::read_to_string(root.path().join("last-command")).unwrap();
    assert_eq!(log_command, format!("/usr/bin/sudo -n -- /usr/bin/tail -c 65536 -- /var/lib/admin-tower/package-updates/{run_id}/operation.log"));
    fs::write(
        root.path().join("snapshot"),
        b"$ apt-get update\nfirst output\nnext output\n",
    )
    .unwrap();
    assert!(crate::packages::remote_log(&host, &environment, &run_id)
        .unwrap()
        .contains("next output"));
    assert!(crate::packages::remote_log(&host, &environment, "../unsafe;command").is_err());
    fs::write(root.path().join("snapshot"), b"incomplete snapshot").unwrap();
    assert!(crate::admin::inspect(&store, &environment, &host.id)
        .unwrap_err()
        .contains("incomplete"));
    write_private(&environment.home.join(".ssh/known_hosts"), b"");
    assert!(crate::admin::inspect(&store, &environment, &host.id).is_err());
    assert!(crate::packages::remote_log(&host, &environment, &run_id).is_err());
}

#[test]
#[ignore = "requires loopback sockets, Python Paramiko and local htop; run test-ssh"]
fn live_ssh_htop_streams_real_viewer_resizes_and_stops() {
    let (root, environment, store) = fixture();
    assert!(Path::new("/usr/bin/htop").is_file());
    let key = environment.home.join(".ssh/id_ed25519");
    fs::remove_file(&key).unwrap();
    generate_key(&key, "");
    fs::copy(key.with_extension("pub"), root.path().join("client.pub")).unwrap();
    fs::write(root.path().join("htop-mode"), b"").unwrap();
    let mut server = ChildGuard(
        Command::new("python3")
            .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/ssh_server.py"))
            .arg(root.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .spawn()
            .unwrap(),
    );
    wait_for(&root.path().join("ready.json"), &mut server);
    let ready: serde_json::Value =
        serde_json::from_slice(&fs::read(root.path().join("ready.json")).unwrap()).unwrap();
    write_private(
        &environment.home.join(".ssh/known_hosts"),
        ready["knownHost"].as_str().unwrap().as_bytes(),
    );
    let mut input = settings();
    input.address = "127.0.0.1".into();
    input.username = "fixture".into();
    input.port = ready["port"].as_u64().unwrap() as u16;
    let host = store.save(None, input).unwrap();
    let sessions = crate::htop::Sessions::default();
    let id = sessions
        .start(&store, &environment, &host.id, 100, 30)
        .unwrap();
    assert!(sessions
        .start(&store, &environment, &host.id, 100, 30)
        .is_err());
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut output = Vec::new();
    loop {
        let frame = sessions.poll(&id).unwrap();
        output.extend(STANDARD.decode(frame.data).unwrap());
        if String::from_utf8_lossy(&output).contains("Tasks:") {
            break;
        }
        assert!(
            !frame.ended,
            "{}: {}",
            frame.message,
            String::from_utf8_lossy(&output)
        );
        assert!(
            Instant::now() < deadline,
            "No real htop output: {}",
            String::from_utf8_lossy(&output)
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    let command = fs::read_to_string(root.path().join("last-command")).unwrap();
    assert!(command.contains("--readonly"));
    assert!(!command.contains("sudo"));
    sessions.resize(&id, 120, 35).unwrap();
    wait_for(&root.path().join("resize.json"), &mut server);
    let resized: serde_json::Value =
        serde_json::from_slice(&fs::read(root.path().join("resize.json")).unwrap()).unwrap();
    assert_eq!(resized["cols"], 120);
    assert_eq!(resized["rows"], 35);
    sessions.input(&id, "q".into()).unwrap();
    loop {
        let frame = sessions.poll(&id).unwrap();
        if frame.ended {
            break;
        }
        assert!(Instant::now() < deadline, "htop did not exit after q");
        std::thread::sleep(Duration::from_millis(50));
    }
    sessions.stop(&id).unwrap();
    assert!(sessions.poll(&id).is_err());
    let id = sessions
        .start(&store, &environment, &host.id, 100, 30)
        .unwrap();
    sessions.stop(&id).unwrap();
    assert!(sessions.poll(&id).is_err());
}

#[test]
fn groups_migrate_atomically_and_preserve_settings_and_memberships() {
    let (_root, _env, store) = fixture();
    let mut input = settings();
    input.port = 2222;
    input.address = "2001:db8::1".into();
    let host = store.save(None, input).unwrap();
    let path = store.directory.join("hosts.json");
    let legacy = serde_json::json!({"version": 1, "hosts": [host]});
    write_private(&path, &serde_json::to_vec(&legacy).unwrap());
    assert!(store.groups().unwrap().is_empty());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&fs::read(&path).unwrap()).unwrap()["version"],
        1
    );
    let a = store
        .save_group(None, "A".into(), vec![host.id.clone()])
        .unwrap();
    let b = store
        .save_group(None, "B".into(), vec![host.id.clone()])
        .unwrap();
    assert_eq!(store.groups().unwrap().len(), 2);
    assert_eq!(store.get(&host.id).unwrap().settings.port, 2222);
    assert_eq!(
        store.get(&host.id).unwrap().settings.authentication,
        host.settings.authentication
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&fs::read(&path).unwrap()).unwrap()["version"],
        2
    );
    assert!(store
        .save_group(None, "bad".into(), vec![host.id.clone(), host.id.clone()])
        .is_err());
    assert!(store
        .save_group(None, "bad".into(), vec![uuid::Uuid::new_v4().to_string()])
        .is_err());
    store
        .save_group(Some(a.id.clone()), "Renamed".into(), vec![host.id.clone()])
        .unwrap();
    let (_, snapshot) = store
        .automation_snapshot(&crate::inventory::AutomationTargets {
            host_ids: vec![],
            group_ids: vec![a.id.clone()],
        })
        .unwrap();
    store.delete_group(&a.id).unwrap();
    assert_eq!(store.list().unwrap().len(), 1);
    store.delete(&host.id).unwrap();
    assert!(store.groups().unwrap()[0].member_ids.is_empty());
    assert_eq!(store.groups().unwrap()[0].id, b.id);
    assert_eq!(snapshot[0].settings.address, "2001:db8::1");
}

#[test]
fn automation_targets_resolve_once_deduplicate_and_reject_stale_ids() {
    use crate::inventory::AutomationTargets;
    let (_root, _env, store) = fixture();
    let first = store.save(None, settings()).unwrap();
    let mut input = settings();
    input.port = 2222;
    input.address = "2001:db8::1".into();
    // Identical display names remain distinct saved hosts.
    let second = store.save(None, input).unwrap();
    let a = store
        .save_group(None, "A".into(), vec![first.id.clone()])
        .unwrap();
    let b = store
        .save_group(None, "B".into(), vec![first.id.clone(), second.id.clone()])
        .unwrap();
    let targets = AutomationTargets {
        host_ids: vec![first.id.clone(), first.id.clone()],
        group_ids: vec![a.id.clone(), b.id.clone(), a.id.clone()],
    };
    let (label, snapshot) = store.automation_snapshot(&targets).unwrap();
    assert_eq!(snapshot.len(), 2);
    assert!(label.starts_with("A, B, "));
    assert_eq!(snapshot[1].settings.port, 2222);
    let direct = AutomationTargets {
        host_ids: vec![second.id.clone()],
        group_ids: vec![],
    };
    assert_eq!(
        store.automation_snapshot(&direct).unwrap().1[0].id,
        second.id
    );
    assert!(store
        .automation_snapshot(&AutomationTargets::default())
        .is_err());
    let empty = store.save_group(None, "Empty".into(), vec![]).unwrap();
    assert!(store
        .automation_snapshot(&AutomationTargets {
            host_ids: vec![],
            group_ids: vec![empty.id]
        })
        .is_err());
    let missing = uuid::Uuid::new_v4().to_string();
    assert!(store
        .automation_snapshot(&AutomationTargets {
            host_ids: vec![missing.clone()],
            group_ids: vec![a.id.clone()]
        })
        .is_err());
    assert!(store
        .automation_snapshot(&AutomationTargets {
            host_ids: vec![first.id.clone()],
            group_ids: vec![missing]
        })
        .is_err());
    assert!(store
        .automation_snapshot(&AutomationTargets {
            host_ids: vec!["all".into()],
            group_ids: vec![]
        })
        .is_err());
    assert!(serde_json::from_value::<AutomationTargets>(
        serde_json::json!({"hostIds": [], "groupIds": [], "command": "sh"})
    )
    .is_err());
    store.delete_group(&a.id).unwrap();
    store.delete(&second.id).unwrap();
    assert!(store.automation_snapshot(&targets).is_err());
    assert!(store.automation_snapshot(&direct).is_err());
    assert_eq!(snapshot.len(), 2);
    assert_eq!(snapshot[1].settings.address, "2001:db8::1");
}

#[test]
#[ignore = "requires loopback sockets, /usr/bin/ansible and Python Paramiko; run test-ansible"]
fn live_ansible_ping_isolated_mixed_results_snapshot_cancel_and_timeout() {
    let (root, mut environment, store) = fixture();
    assert!(crate::automation::availability()
        .unwrap()
        .contains("ansible"));
    let key = environment.home.join(".ssh/key with spaces");
    generate_key(&key, "");
    let wrong = environment.home.join(".ssh/wrong");
    generate_key(&wrong, "");
    fs::copy(key.with_extension("pub"), root.path().join("client.pub")).unwrap();
    fs::write(root.path().join("ansible-mode"), b"").unwrap();
    let mut server = ChildGuard(
        Command::new("/usr/bin/python3")
            .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/ssh_server.py"))
            .arg(root.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .spawn()
            .unwrap(),
    );
    wait_for(&root.path().join("ready.json"), &mut server);
    let ready: serde_json::Value =
        serde_json::from_slice(&fs::read(root.path().join("ready.json")).unwrap()).unwrap();
    let known_hosts = environment.home.join(".ssh/known_hosts");
    write_private(
        &known_hosts,
        ready["knownHost"].as_str().unwrap().as_bytes(),
    );
    let socket = root.path().join("agent.sock");
    let mut agent = ChildGuard(
        Command::new("/usr/bin/ssh-agent")
            .args(["-D", "-a"])
            .arg(&socket)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    wait_for(&socket, &mut agent);
    for path in [&wrong, &key] {
        assert!(Command::new("/usr/bin/ssh-add")
            .arg(path)
            .env("SSH_AUTH_SOCK", &socket)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success());
    }
    environment.agent_socket = Some(socket);
    let fingerprint = parse_agent_keys(&fs::read_to_string(key.with_extension("pub")).unwrap())
        .unwrap()[0]
        .fingerprint
        .clone();
    let mut input = settings();
    input.address = "127.0.0.1".into();
    input.port = ready["port"].as_u64().unwrap() as u16;
    input.username = "fixture".into();
    input.authentication = Authentication::KeyFile {
        filename: "key with spaces".into(),
    };
    let good = store.save(None, input.clone()).unwrap();
    input.authentication = Authentication::Agent { fingerprint };
    let agent_host = store.save(None, input.clone()).unwrap();
    input.authentication = good.settings.authentication.clone();
    input.username = "missingpython".into();
    let no_python = store.save(None, input.clone()).unwrap();
    input.username = "fixture".into();
    input.authentication = Authentication::KeyFile {
        filename: "wrong".into(),
    };
    let bad_auth = store.save(None, input.clone()).unwrap();
    input.authentication = Authentication::KeyFile {
        filename: "absent".into(),
    };
    let absent = store.save(None, input).unwrap();
    let group = store
        .save_group(
            None,
            "Mixed".into(),
            vec![
                good.id.clone(),
                agent_host.id.clone(),
                no_python.id.clone(),
                bad_auth.id.clone(),
                absent.id.clone(),
            ],
        )
        .unwrap();
    let automation = crate::automation::Automation::default();
    let wait = |automation: &crate::automation::Automation| {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let run = automation.latest().unwrap().unwrap();
            if !run.active {
                return run;
            }
            assert!(Instant::now() < deadline, "Run did not finish");
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    let overlapping = store
        .save_group(None, "Overlap".into(), vec![good.id.clone()])
        .unwrap();
    let targets = crate::inventory::AutomationTargets {
        host_ids: vec![good.id.clone()],
        group_ids: vec![group.id.clone(), overlapping.id.clone()],
    };
    automation.start(&store, &environment, &targets).unwrap();
    assert!(automation.start(&store, &environment, &targets).is_err());
    // Once started, membership edits/deletions cannot alter targets or credentials.
    store.delete(&absent.id).unwrap();
    store
        .save_group(Some(group.id.clone()), "Changed".into(), vec![])
        .unwrap();
    let result = wait(&automation);
    assert_eq!(result.results.len(), 5);
    assert!(result.target_label.starts_with("Mixed, Overlap, "));
    let outcome = |id: &str| {
        result
            .results
            .iter()
            .find(|r| r.host.id == id)
            .unwrap()
            .outcome
            .as_str()
    };
    assert_eq!(
        outcome(&good.id),
        "successful",
        "{} / {}",
        result.message,
        result.results[0].diagnostics
    );
    assert_eq!(outcome(&agent_host.id), "successful", "{}", result.message);
    assert_eq!(outcome(&no_python.id), "failed");
    assert_eq!(outcome(&bad_auth.id), "unreachable");
    assert_eq!(outcome(&absent.id), "failed");
    // Scope cleanup checks to this test process, never other running applications.
    let assert_clean = || {
        let prefix = format!("admin-tower-ping-{}-", std::process::id());
        assert!(!fs::read_dir("/tmp").unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(&prefix)));
    };
    assert_clean();
    store
        .save(Some(good.id.clone()), good.settings.clone())
        .unwrap();
    store
        .save_group(
            Some(group.id.clone()),
            "Trust".into(),
            vec![good.id.clone()],
        )
        .unwrap();
    // A direct host target works without creating a one-member group.
    let targets = crate::inventory::AutomationTargets {
        host_ids: vec![good.id.clone()],
        group_ids: vec![],
    };
    automation.start(&store, &environment, &targets).unwrap();
    assert_eq!(wait(&automation).results[0].outcome, "successful");
    write_private(&known_hosts, b"");
    automation.start(&store, &environment, &targets).unwrap();
    assert_eq!(wait(&automation).results[0].outcome, "unreachable");
    assert!(fs::read(&known_hosts).unwrap().is_empty());
    write_private(
        &known_hosts,
        ready["knownHost"].as_str().unwrap().as_bytes(),
    );
    let mut slow = good.settings.clone();
    slow.username = "slow".into();
    store.save(Some(good.id.clone()), slow).unwrap();
    let run = automation.start(&store, &environment, &targets).unwrap();
    let log_deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let progress = automation.latest().unwrap().unwrap();
        assert!(
            progress.active,
            "Slow command finished before live output was observed"
        );
        if progress.logs.contains("SSH: EXEC") {
            break;
        }
        assert!(
            Instant::now() < log_deadline,
            "No command logs before completion: {}",
            progress.logs
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    automation.cancel(&run.id).unwrap();
    assert_eq!(wait(&automation).results[0].outcome, "cancelled");
    assert_clean();
    automation
        .start_with_limit(&store, &environment, &targets, Duration::from_secs(2))
        .unwrap();
    assert_eq!(wait(&automation).results[0].outcome, "timed-out");
    assert_clean();
    automation.start(&store, &environment, &targets).unwrap();
    std::thread::sleep(Duration::from_millis(1500));
    automation.shutdown();
    assert!(automation.latest().unwrap().is_none());
    assert_clean();
}

#[test]
#[ignore = "requires loopback SSH and real Ansible; reboot commands are simulated, never executed"]
fn live_reboot_ansible_verifies_new_boot_and_recovers_connection() {
    let (root, environment, store) = fixture();
    let key = environment.home.join(".ssh/id_ed25519");
    fs::remove_file(&key).unwrap();
    generate_key(&key, "");
    fs::copy(key.with_extension("pub"), root.path().join("client.pub")).unwrap();
    fs::write(root.path().join("ansible-mode"), b"").unwrap();
    fs::write(root.path().join("reboot-mode"), b"").unwrap();
    let mut server = ChildGuard(
        Command::new("/usr/bin/python3")
            .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/ssh_server.py"))
            .arg(root.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .spawn()
            .unwrap(),
    );
    wait_for(&root.path().join("ready.json"), &mut server);
    let ready: serde_json::Value =
        serde_json::from_slice(&fs::read(root.path().join("ready.json")).unwrap()).unwrap();
    write_private(
        &environment.home.join(".ssh/known_hosts"),
        ready["knownHost"].as_str().unwrap().as_bytes(),
    );
    let mut input = settings();
    input.address = "127.0.0.1".into();
    input.username = "fixture".into();
    input.port = ready["port"].as_u64().unwrap() as u16;
    let host = store.save(None, input).unwrap();
    let mut saw_live_command = false;
    let result = crate::reboots::exercise_reboot_transport(&host, &environment, &mut |text| {
        if text.contains("SSH: EXEC") {
            saw_live_command = true;
        }
    })
    .unwrap();
    assert_eq!(result["rebooted"], true);
    assert!(saw_live_command);
    assert!(root.path().join("reboot-retry").exists());
    assert_eq!(
        fs::read_to_string(root.path().join("reboot-count")).unwrap(),
        "submitted\n"
    );
}
