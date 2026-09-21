use crate::{
    inventory::{Host, HostInput, Result, Store},
    ssh::{self, Environment, IdentityOptions, Terminal},
};
use std::sync::{Arc, Mutex};
use tauri::State;

pub struct Backend {
    pub store: Store,
    pub environment: Environment,
    pub operations: Mutex<()>,
    pub htop: crate::htop::Sessions,
    pub automation: crate::automation::Automation,
    pub packages: crate::packages::Packages,
    pub reboots: crate::reboots::Reboots,
}

async fn blocking<T: Send + 'static>(
    backend: Arc<Backend>,
    operation: impl FnOnce(&Backend) -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = backend
            .operations
            .lock()
            .map_err(|_| "Inventory is unavailable. Restart Admin-Tower.")?;
        operation(&backend)
    })
    .await
    .map_err(|_| "Native operation did not complete.".to_owned())?
}

#[tauri::command]
pub async fn list_hosts(state: State<'_, Arc<Backend>>) -> Result<Vec<Host>> {
    blocking(state.inner().clone(), |b| b.store.list()).await
}

#[tauri::command]
pub async fn save_host(
    state: State<'_, Arc<Backend>>,
    id: Option<String>,
    settings: HostInput,
) -> Result<Host> {
    blocking(state.inner().clone(), move |b| {
        // Existing hosts can retain temporarily unavailable identities; connect always revalidates.
        b.store.save(id, settings)
    })
    .await
}

#[tauri::command]
pub async fn delete_host(state: State<'_, Arc<Backend>>, id: String) -> Result<()> {
    blocking(state.inner().clone(), move |b| b.store.delete(&id)).await
}

#[tauri::command]
pub async fn list_identities(state: State<'_, Arc<Backend>>) -> Result<IdentityOptions> {
    blocking(state.inner().clone(), |b| {
        Ok(ssh::identities(&b.environment))
    })
    .await
}

#[tauri::command]
pub fn list_terminals() -> Vec<Terminal> {
    ssh::terminals()
}

#[tauri::command]
pub async fn connect_host(
    state: State<'_, Arc<Backend>>,
    id: String,
    terminal: String,
) -> Result<()> {
    blocking(state.inner().clone(), move |b| {
        ssh::connect(&b.store, &b.environment, &id, &terminal)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::{
        test::{get_ipc_response, mock_builder, INVOKE_KEY},
        webview::InvokeRequest,
        WebviewWindowBuilder,
    };

    #[test]
    fn inventory_ipc_is_restricted_to_local_main_window() {
        let directory = tempfile::tempdir().unwrap();
        let app = mock_builder()
            .manage(Arc::new(Backend {
                store: Store {
                    directory: directory.path().join("inventory"),
                },
                environment: Environment {
                    home: directory.path().to_path_buf(),
                    agent_socket: None,
                },
                operations: Mutex::new(()),
                htop: Default::default(),
                automation: Default::default(),
                packages: Default::default(),
                reboots: Default::default(),
            }))
            .invoke_handler(tauri::generate_handler![
                list_hosts,
                stop_htop,
                list_host_groups,
                latest_ping,
                latest_packages,
                latest_reboots
            ])
            .build(tauri::generate_context!())
            .unwrap();
        let main = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let other = WebviewWindowBuilder::new(&app, "other", Default::default())
            .build()
            .unwrap();
        let request = |url: &str, cmd: &str| InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: url.parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(serde_json::json!({ "sessionId": "missing" })),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        };
        let local = if cfg!(debug_assertions) {
            "http://localhost:4200"
        } else {
            "tauri://localhost"
        };
        for cmd in [
            "list_hosts",
            "stop_htop",
            "list_host_groups",
            "latest_ping",
            "latest_packages",
            "latest_reboots",
        ] {
            assert!(get_ipc_response(&main, request(local, cmd)).is_ok());
            assert!(get_ipc_response(&other, request(local, cmd)).is_err());
            assert!(get_ipc_response(&main, request("https://untrusted.example", cmd)).is_err());
        }
    }
}

#[tauri::command]
pub async fn host_system_info(
    state: State<'_, Arc<Backend>>,
    id: String,
) -> Result<crate::admin::Overview> {
    let backend = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::admin::system_info(&backend.store, &backend.environment, &id)
    })
    .await
    .map_err(|_| "OS query did not complete.".to_owned())?
}

#[tauri::command]
pub async fn inspect_host(
    state: State<'_, Arc<Backend>>,
    id: String,
) -> Result<crate::admin::Overview> {
    let backend = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::admin::inspect(&backend.store, &backend.environment, &id)
    })
    .await
    .map_err(|_| "Inspection did not complete.".to_owned())?
}
#[tauri::command]
pub async fn review_host_action(
    state: State<'_, Arc<Backend>>,
    id: String,
    action: crate::admin::Action,
) -> Result<crate::admin::Review> {
    blocking(state.inner().clone(), move |b| {
        crate::admin::review(&b.store, &id, action)
    })
    .await
}
#[tauri::command]
pub async fn start_host_action(
    state: State<'_, Arc<Backend>>,
    review_id: String,
    terminal: String,
) -> Result<crate::admin::Job> {
    blocking(state.inner().clone(), move |b| {
        crate::admin::start(&b.store, &b.environment, &review_id, &terminal)
    })
    .await
}
#[tauri::command]
pub async fn get_host_operation(
    state: State<'_, Arc<Backend>>,
    id: String,
    operation_id: String,
) -> Result<crate::admin::Job> {
    blocking(state.inner().clone(), move |b| {
        crate::admin::status(&b.store, &id, &operation_id)
    })
    .await
}

#[tauri::command]
pub async fn start_htop(
    state: State<'_, Arc<Backend>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<String> {
    blocking(state.inner().clone(), move |b| {
        b.htop.start(&b.store, &b.environment, &id, cols, rows)
    })
    .await
}
#[tauri::command]
pub fn poll_htop(state: State<'_, Arc<Backend>>, session_id: String) -> Result<crate::htop::Frame> {
    state.htop.poll(&session_id)
}
#[tauri::command]
pub fn input_htop(state: State<'_, Arc<Backend>>, session_id: String, data: String) -> Result<()> {
    state.htop.input(&session_id, data)
}
#[tauri::command]
pub fn resize_htop(
    state: State<'_, Arc<Backend>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<()> {
    state.htop.resize(&session_id, cols, rows)
}
#[tauri::command]
pub fn stop_htop(state: State<'_, Arc<Backend>>, session_id: String) -> Result<()> {
    state.htop.stop(&session_id)
}

#[tauri::command]
pub async fn list_host_groups(
    state: State<'_, Arc<Backend>>,
) -> Result<Vec<crate::inventory::Group>> {
    blocking(state.inner().clone(), |b| b.store.groups()).await
}
#[tauri::command]
pub async fn save_host_group(
    state: State<'_, Arc<Backend>>,
    id: Option<String>,
    name: String,
    member_ids: Vec<String>,
) -> Result<crate::inventory::Group> {
    blocking(state.inner().clone(), move |b| {
        b.store.save_group(id, name, member_ids)
    })
    .await
}
#[tauri::command]
pub async fn delete_host_group(state: State<'_, Arc<Backend>>, id: String) -> Result<()> {
    blocking(state.inner().clone(), move |b| b.store.delete_group(&id)).await
}
#[tauri::command]
pub async fn ansible_availability() -> Result<String> {
    tauri::async_runtime::spawn_blocking(crate::automation::availability)
        .await
        .map_err(|_| "Availability check failed.")?
}
#[tauri::command]
pub async fn start_quick_ping(
    state: State<'_, Arc<Backend>>,
    host_id: String,
) -> Result<crate::automation::Run> {
    blocking(state.inner().clone(), move |b| {
        b.automation.start_quick(&b.store, &b.environment, host_id)
    })
    .await
}
#[tauri::command]
pub fn latest_quick_ping(
    state: State<'_, Arc<Backend>>,
    host_id: String,
) -> Result<Option<crate::automation::Run>> {
    state.automation.latest_quick(&host_id)
}

#[tauri::command]
pub async fn start_ping(
    state: State<'_, Arc<Backend>>,
    targets: crate::inventory::AutomationTargets,
) -> Result<crate::automation::Run> {
    blocking(state.inner().clone(), move |b| {
        b.automation.start(&b.store, &b.environment, &targets)
    })
    .await
}
#[tauri::command]
pub fn latest_ping(state: State<'_, Arc<Backend>>) -> Result<Option<crate::automation::Run>> {
    state.automation.latest()
}
#[tauri::command]
pub fn cancel_ping(state: State<'_, Arc<Backend>>, run_id: String) -> Result<()> {
    state.automation.cancel(&run_id)
}

#[tauri::command]
pub async fn preview_packages(
    state: State<'_, Arc<Backend>>,
    targets: crate::inventory::AutomationTargets,
) -> Result<crate::packages::Run> {
    blocking(state.inner().clone(), move |b| {
        b.ensure_reboots_idle()?;
        b.packages.preview(&b.store, &b.environment, &targets)
    })
    .await
}
#[tauri::command]
pub async fn latest_packages(
    state: State<'_, Arc<Backend>>,
) -> Result<Option<crate::packages::Run>> {
    blocking(state.inner().clone(), |b| b.packages.latest(&b.store)).await
}
#[tauri::command]
pub async fn apply_packages(
    state: State<'_, Arc<Backend>>,
    run_id: String,
) -> Result<crate::packages::Run> {
    blocking(state.inner().clone(), move |b| {
        b.ensure_reboots_idle()?;
        b.packages.apply(&b.store, &b.environment, &run_id)
    })
    .await
}
#[tauri::command]
pub async fn refresh_packages(
    state: State<'_, Arc<Backend>>,
    run_id: String,
) -> Result<crate::packages::Run> {
    blocking(state.inner().clone(), move |b| {
        b.packages.refresh(&b.store, &b.environment, &run_id)
    })
    .await
}
#[tauri::command]
pub async fn stop_packages(state: State<'_, Arc<Backend>>, run_id: String) -> Result<()> {
    blocking(state.inner().clone(), move |b| {
        b.packages.stop(&b.store, &run_id)
    })
    .await
}

impl Backend {
    fn ensure_reboots_idle(&self) -> Result<()> {
        if self
            .reboots
            .latest(&self.store)?
            .is_some_and(|run| run.active || run.unresolved())
        {
            return Err("A reboot is active or unconfirmed. Refresh reboot status before package maintenance.".into());
        }
        Ok(())
    }
    fn ensure_packages_idle(&self) -> Result<()> {
        if self
            .packages
            .latest(&self.store)?
            .is_some_and(|run| run.active || run.unresolved())
        {
            return Err(
                "Package maintenance is active or unconfirmed. Resolve it before rebooting.".into(),
            );
        }
        Ok(())
    }
}
#[tauri::command]
pub async fn preview_reboots(
    state: State<'_, Arc<Backend>>,
    targets: crate::inventory::AutomationTargets,
) -> Result<crate::reboots::Run> {
    blocking(state.inner().clone(), move |b| {
        b.ensure_packages_idle()?;
        b.reboots.preview(&b.store, &b.environment, &targets)
    })
    .await
}
#[tauri::command]
pub async fn latest_reboots(state: State<'_, Arc<Backend>>) -> Result<Option<crate::reboots::Run>> {
    blocking(state.inner().clone(), |b| b.reboots.latest(&b.store)).await
}
#[tauri::command]
pub async fn apply_reboots(
    state: State<'_, Arc<Backend>>,
    run_id: String,
) -> Result<crate::reboots::Run> {
    blocking(state.inner().clone(), move |b| {
        b.ensure_packages_idle()?;
        b.reboots.apply(&b.store, &b.environment, &run_id)
    })
    .await
}
#[tauri::command]
pub async fn refresh_reboots(
    state: State<'_, Arc<Backend>>,
    run_id: String,
) -> Result<crate::reboots::Run> {
    blocking(state.inner().clone(), move |b| {
        b.reboots.refresh(&b.store, &b.environment, &run_id)
    })
    .await
}
#[tauri::command]
pub async fn stop_reboots(state: State<'_, Arc<Backend>>, run_id: String) -> Result<()> {
    blocking(state.inner().clone(), move |b| {
        b.reboots.stop(&b.store, &run_id)
    })
    .await
}

#[cfg(test)]
mod maintenance_tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn unresolved_maintenance_blocks_the_other_action_in_both_directions() {
        for journal in ["package-updates.json", "reboots.json"] {
            for (state, active) in [("unknown", false), ("launching", false), ("running", true)] {
                let directory = tempfile::tempdir().unwrap();
                let store = Store {
                    directory: directory.path().join("data"),
                };
                let host = store
                    .save(
                        None,
                        HostInput {
                            name: "Ubuntu".into(),
                            address: "192.0.2.1".into(),
                            username: "root".into(),
                            port: 22,
                            authentication: crate::inventory::Authentication::KeyFile {
                                filename: "key".into(),
                            },
                        },
                    )
                    .unwrap();
                let mut file = tempfile::NamedTempFile::new_in(&store.directory).unwrap();
                file.write_all(&serde_json::to_vec(&serde_json::json!({
                    "id": uuid::Uuid::new_v4().to_string(), "targetLabel":"Ubuntu", "phase":"apply", "active":active, "stopRequested":false,
                    "results":[{"host":host,"state":state,"message":"","plan":null,"digest":"","bootId":"","rebootRequired":false}]
                })).unwrap()).unwrap();
                file.persist(store.directory.join(journal)).unwrap();
                let backend = Backend {
                    store,
                    environment: Environment {
                        home: directory.path().to_owned(),
                        agent_socket: None,
                    },
                    operations: Mutex::new(()),
                    htop: Default::default(),
                    automation: Default::default(),
                    packages: Default::default(),
                    reboots: Default::default(),
                };
                let error = if journal == "package-updates.json" {
                    backend.ensure_packages_idle()
                } else {
                    backend.ensure_reboots_idle()
                }
                .unwrap_err();
                assert!(error.contains("active or unconfirmed"), "{error}");
            }
        }
    }
}
