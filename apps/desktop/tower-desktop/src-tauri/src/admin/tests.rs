use super::*;
use crate::inventory::{Authentication, HostInput};
use std::os::unix::fs::PermissionsExt;

fn fixture() -> (tempfile::TempDir, Store, Host) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store {
        directory: dir.path().join("app"),
    };
    let host = store
        .save(
            None,
            HostInput {
                name: "Test".into(),
                address: "example.com".into(),
                username: "admin".into(),
                port: 22,
                authentication: Authentication::KeyFile {
                    filename: "id_ed25519".into(),
                },
            },
        )
        .unwrap();
    (dir, store, host)
}
fn snapshot() -> Vec<u8> {
    let mut text = "AT1\tprotocol\t0\tMQ==\n".to_owned();
    for id in SECTION_IDS {
        let (code, output) = match *id {
            "system" => (0, "ID=debian\nHostname: fixture"),
            "nftables" => (1, "Operation not permitted"),
            "ufw" => (127, "not installed"),
            "logs" => (124, ""),
            _ => (0, "fixture"),
        };
        text.push_str(&format!("AT1\t{id}\t{code}\t{}\n", STANDARD.encode(output)));
    }
    text.push_str("AT1\tcomplete\t0\tMQ==\n");
    text.into_bytes()
}
#[test]
fn parses_partial_visibility_without_claiming_firewall_success() {
    let value = parse_overview(&snapshot(), false).unwrap();
    assert!(value.supported);
    assert_eq!(
        value
            .sections
            .iter()
            .find(|s| s.id == "nftables")
            .unwrap()
            .status,
        "denied"
    );
    assert_eq!(
        value
            .sections
            .iter()
            .find(|s| s.id == "ufw")
            .unwrap()
            .status,
        "unavailable"
    );
    assert_eq!(
        value
            .sections
            .iter()
            .find(|s| s.id == "logs")
            .unwrap()
            .status,
        "timeout"
    );
    let mut incomplete = snapshot();
    incomplete.truncate(incomplete.len() - 24);
    assert!(parse_overview(&incomplete, false).is_err());
    let mut duplicate = snapshot();
    duplicate.extend_from_slice(b"AT1\tcpu\t0\tMQ==\n");
    assert!(parse_overview(&duplicate, false).is_err());
}
#[test]
fn rejects_shell_and_option_injection_and_unknown_actions() {
    for value in [
        "-root", "user;id", "$(id)", "a b", "a\nb", "../root", "a'", "ROOT",
    ] {
        assert!(action_details(&Action::CreateUser {
            username: value.into()
        })
        .is_err());
    }
    for value in [
        "-a.service",
        "x.service;id",
        "../x.service",
        "x$(id).service",
    ] {
        assert!(action_details(&Action::Service {
            unit: value.into(),
            verb: ServiceVerb::Restart
        })
        .is_err());
    }
    assert!(serde_json::from_str::<Action>(r#"{"kind":"shell","command":"id"}"#).is_err());
    assert!(serde_json::from_str::<Action>(
        r#"{"kind":"inspect","elevated":false,"command":"id"}"#
    )
    .is_err());
    let script = remote_command(&Action::Service {
        unit: "ssh.service".into(),
        verb: ServiceVerb::Disable,
    })
    .unwrap();
    assert!(script.contains("sudo -S"));
    assert!(!script.contains("--now"));
    assert!(script.contains("Only Ubuntu and Debian"));
}
#[test]
fn shell_quoting_round_trips_without_execution() {
    let value = "quote' and $(id); `id`\nnext";
    let output = Command::new("/bin/sh")
        .args(["-c", &format!("printf %s {}", quote(value))])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8(output.stdout).unwrap(), value);
    for action in [
        Action::Inspect { elevated: true },
        Action::CreateUser {
            username: "test_user".into(),
        },
        Action::CreateGroup {
            group: "test_group".into(),
        },
        Action::Membership {
            username: "test_user".into(),
            group: "test_group".into(),
            add: false,
        },
    ] {
        assert!(Command::new("/bin/sh")
            .args(["-n", "-c", &remote_command(&action).unwrap()])
            .status()
            .unwrap()
            .success());
    }
}
#[test]
fn reviews_expire_and_are_bound_to_host_settings() {
    let (_dir, store, host) = fixture();
    let review = review(
        &store,
        &host.id,
        Action::CreateGroup {
            group: "ops".into(),
        },
    )
    .unwrap();
    let mut request = request(&store, &review.id).unwrap();
    assert!(ensure_current(&store, &request).is_ok());
    request.created_at = now() - REVIEW_TTL - 1;
    assert!(ensure_current(&store, &request)
        .unwrap_err()
        .contains("expired"));
    request.created_at = now();
    let mut settings = host.settings;
    settings.port = 2222;
    store.save(Some(host.id), settings).unwrap();
    assert!(ensure_current(&store, &request)
        .unwrap_err()
        .contains("changed"));
    assert_eq!(
        fs::metadata(jobs_dir(&store).unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(
            jobs_dir(&store)
                .unwrap()
                .join(format!("{}.request", review.id))
        )
        .unwrap()
        .permissions()
        .mode()
            & 0o777,
        0o600
    );
}
#[test]
fn claims_and_host_locks_prevent_duplicate_execution() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("claim");
    claim(&path).unwrap();
    assert!(claim(&path).is_err());
    let path = dir.path().join("host.lock");
    let guard = HostLock::acquire(&path).unwrap();
    assert!(HostLock::acquire(&path).is_err());
    drop(guard);
    assert!(HostLock::acquire(&path).is_ok());
}
#[test]
fn local_read_only_collector_produces_complete_snapshot() {
    let output = Command::new("/bin/sh")
        .args(["-c", COLLECTOR])
        .output()
        .unwrap();
    assert!(output.status.success());
    let snapshot = parse_overview(&output.stdout, false).unwrap();
    assert_eq!(snapshot.sections.len(), SECTION_IDS.len());
    assert!(!COLLECTOR.contains("/etc/shadow"));
    assert!(!COLLECTOR.contains("ps aux"));
}

#[test]
fn terminal_input_disables_echo_and_restores_original_state() {
    use std::os::fd::FromRawFd;
    let mut master = -1;
    let mut slave = -1;
    // SAFETY: openpty initializes two descriptors and the remaining pointers are optional.
    assert_eq!(
        unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
            )
        },
        0
    );
    // SAFETY: openpty succeeded and each descriptor is transferred exactly once.
    let _master = unsafe { File::from_raw_fd(master) };
    let slave = unsafe { File::from_raw_fd(slave) };
    let flags = || {
        let mut settings = std::mem::MaybeUninit::uninit();
        // SAFETY: settings is writable and the slave descriptor is live.
        assert_eq!(
            unsafe { libc::tcgetattr(slave.as_raw_fd(), settings.as_mut_ptr()) },
            0
        );
        unsafe { settings.assume_init() }.c_lflag
    };
    let original = flags();
    assert_ne!(original & libc::ECHO, 0);
    let guard = HiddenInput::from_terminal(slave.try_clone().unwrap()).unwrap();
    assert_eq!(flags() & libc::ECHO, 0);
    drop(guard);
    assert_eq!(flags(), original);
}

#[test]
fn hostname_validation_and_ansible_only_dispatch() {
    for hostname in [
        "",
        "-option",
        "a..b",
        "a;id",
        "$(id)",
        "a b",
        "a\nb",
        "a_",
        "a.",
        "UPPER",
        &"a".repeat(65),
    ] {
        assert!(action_details(&Action::SetHostname {
            hostname: hostname.into()
        })
        .is_err());
    }
    let action = Action::SetHostname {
        hostname: "web-01.example.com".into(),
    };
    assert!(action_details(&action)
        .unwrap()
        .1
        .contains("ansible.builtin.hostname"));
    assert!(remote_command(&action).unwrap_err().contains("Ansible"));
}

#[test]
fn hostname_preflight_dispatch_and_verification() {
    let (_dir, _store, host) = fixture();
    let mut dispatched = false;
    let mut calls = Vec::new();
    let overview = execute_hostname(&host, "web-01", &mut dispatched, &mut |module, args| {
        calls.push((module.to_owned(), args));
        Ok(match module {
            "ansible.builtin.setup" => {
                serde_json::json!({"ansible_facts": {"ansible_distribution": "Ubuntu"}})
            }
            "ansible.builtin.hostname" => serde_json::json!({"changed": true}),
            "ansible.builtin.command" => serde_json::json!({"stdout": "web-01\n"}),
            _ => panic!("unexpected module"),
        })
    })
    .unwrap();
    assert!(dispatched);
    assert_eq!(calls.len(), 3);
    assert_eq!(
        calls[1].1,
        serde_json::json!({"name": "web-01", "use": "systemd"})
    );
    assert_eq!(overview.sections[0].output, "Hostname: web-01");
    let mut dispatched = false;
    assert!(
        execute_hostname(&host, "web-01", &mut dispatched, &mut |module, _| {
            assert_eq!(module, "ansible.builtin.setup");
            Ok(serde_json::json!({"ansible_facts": {"ansible_distribution": "Other"}}))
        })
        .is_err()
    );
    assert!(!dispatched);
    assert!(
        execute_hostname(&host, "web-01", &mut dispatched, &mut |module, _| {
            Ok(if module == "ansible.builtin.setup" {
                serde_json::json!({"ansible_facts": {"ansible_distribution": "Ubuntu"}})
            } else {
                serde_json::json!({"stdout": "old-name"})
            })
        })
        .unwrap_err()
        .contains("verified")
    );
    assert!(dispatched);
}
