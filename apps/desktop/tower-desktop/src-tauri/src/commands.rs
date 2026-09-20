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
            }))
            .invoke_handler(tauri::generate_handler![
                list_hosts,
                stop_htop,
                list_host_groups,
                latest_ping
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
        for cmd in ["list_hosts", "stop_htop", "list_host_groups", "latest_ping"] {
            assert!(get_ipc_response(&main, request(local, cmd)).is_ok());
            assert!(get_ipc_response(&other, request(local, cmd)).is_err());
            assert!(get_ipc_response(&main, request("https://untrusted.example", cmd)).is_err());
        }
    }
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
