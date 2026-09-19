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
    for bytes in [b"{bad json".as_slice(), b"{\"version\":2,\"hosts\":[]}"] {
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
    fs::write(root.path().join("snapshot"), b"incomplete snapshot").unwrap();
    assert!(crate::admin::inspect(&store, &environment, &host.id)
        .unwrap_err()
        .contains("incomplete"));
    write_private(&environment.home.join(".ssh/known_hosts"), b"");
    assert!(crate::admin::inspect(&store, &environment, &host.id).is_err());
}
