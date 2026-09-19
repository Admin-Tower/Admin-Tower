fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "list_hosts",
            "save_host",
            "delete_host",
            "list_identities",
            "list_terminals",
            "connect_host",
            "inspect_host",
            "review_host_action",
            "start_host_action",
            "get_host_operation",
        ]),
    ))
    .expect("failed to build desktop permissions")
}
