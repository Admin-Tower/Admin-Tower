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
            }))
            .invoke_handler(tauri::generate_handler![list_hosts])
            .build(tauri::generate_context!())
            .unwrap();
        let main = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let other = WebviewWindowBuilder::new(&app, "other", Default::default())
            .build()
            .unwrap();
        let request = |url: &str| InvokeRequest {
            cmd: "list_hosts".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: url.parse().unwrap(),
            body: tauri::ipc::InvokeBody::default(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        };
        let local = if cfg!(debug_assertions) {
            "http://localhost:4200"
        } else {
            "tauri://localhost"
        };
        assert!(get_ipc_response(&main, request(local)).is_ok());
        assert!(get_ipc_response(&other, request(local)).is_err());
        assert!(get_ipc_response(&main, request("https://untrusted.example")).is_err());
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
