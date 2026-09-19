#[cfg(target_os = "linux")]
mod admin;
#[cfg(target_os = "linux")]
mod commands;
#[cfg(target_os = "linux")]
mod inventory;
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
        commands::list_hosts,
        commands::save_host,
        commands::delete_host,
        commands::list_identities,
        commands::list_terminals,
        commands::connect_host,
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
                app.manage(std::sync::Arc::new(commands::Backend {
                    store: inventory::Store {
                        directory: app.path().app_data_dir()?,
                    },
                    environment: ssh::Environment::current().map_err(std::io::Error::other)?,
                    operations: std::sync::Mutex::new(()),
                }));
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
