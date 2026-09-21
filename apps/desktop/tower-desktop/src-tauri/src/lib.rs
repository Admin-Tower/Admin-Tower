#[cfg(target_os = "linux")]
mod admin;
#[cfg(target_os = "linux")]
mod automation;
#[cfg(target_os = "linux")]
mod commands;
#[cfg(target_os = "linux")]
mod htop;
#[cfg(target_os = "linux")]
mod inventory;
#[cfg(target_os = "linux")]
mod packages;
#[cfg(target_os = "linux")]
mod reboots;
#[cfg(target_os = "linux")]
mod ansible;
#[cfg(target_os = "linux")]
mod ssh;

/// Return before initializing the webview when launched by a terminal adapter.
pub fn run_ssh_session() -> Option<i32> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).is_some_and(|arg| arg == "--ssh-session") {
        #[cfg(target_os = "linux")]
        return Some(ssh::session_helper(&args));
        #[cfg(not(target_os = "linux"))]
        return Some(1);
    }
    if args.get(1).is_some_and(|arg| arg == "--admin-session") {
        #[cfg(target_os = "linux")]
        return Some(admin::session_helper(&args));
        #[cfg(not(target_os = "linux"))]
        return Some(1);
    }
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "linux")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::list_host_groups,
        commands::save_host_group,
        commands::delete_host_group,
        commands::ansible_availability,
        commands::start_quick_ping,
        commands::latest_quick_ping,
        commands::start_ping,
        commands::latest_ping,
        commands::cancel_ping,
        commands::preview_packages,
        commands::latest_packages,
        commands::apply_packages,
        commands::refresh_packages,
        commands::stop_packages,
        commands::preview_reboots,
        commands::latest_reboots,
        commands::apply_reboots,
        commands::refresh_reboots,
        commands::stop_reboots,
        commands::start_htop,
        commands::poll_htop,
        commands::input_htop,
        commands::resize_htop,
        commands::stop_htop,
        commands::list_hosts,
        commands::save_host,
        commands::delete_host,
        commands::list_identities,
        commands::list_terminals,
        commands::connect_host,
        commands::host_system_info,
        commands::inspect_host,
        commands::review_host_action,
        commands::start_host_action,
        commands::get_host_operation,
    ]);
    builder
        .setup(|app| {
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                let backend = std::sync::Arc::new(commands::Backend {
                    store: inventory::Store {
                        directory: app.path().app_data_dir()?,
                    },
                    environment: ssh::Environment::current().map_err(std::io::Error::other)?,
                    operations: std::sync::Mutex::new(()),
                    htop: Default::default(),
                    automation: Default::default(),
                    packages: Default::default(),
                    reboots: Default::default(),
                });
                // The runner spawns its worker immediately; SSH never blocks app setup.
                if let Err(error) = backend
                    .automation
                    .startup(&backend.store, &backend.environment)
                {
                    log::warn!("Startup connectivity check could not start: {error}");
                }
                app.manage(backend);
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "linux")]
            if matches!(event, tauri::RunEvent::Exit) {
                use tauri::Manager;
                app.state::<std::sync::Arc<commands::Backend>>()
                    .reboots
                    .shutdown();
                app.state::<std::sync::Arc<commands::Backend>>()
                    .packages
                    .shutdown();
                app.state::<std::sync::Arc<commands::Backend>>()
                    .automation
                    .shutdown();
                app.state::<std::sync::Arc<commands::Backend>>()
                    .htop
                    .stop_all();
            }
        });
}
