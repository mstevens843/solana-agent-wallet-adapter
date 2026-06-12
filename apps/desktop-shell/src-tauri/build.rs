fn main() {
    // Register every app-defined command so Tauri generates `allow-$command`
    // permissions for them. This is REQUIRED for the commands to be callable
    // from the remote origin (https://agentic-signer.com) the release shell
    // live-loads: Tauri 2 rejects any command with no resolved ACL from a
    // non-local origin (webview/mod.rs). The matching grants live in
    // `capabilities/app-commands.json`. Keep this list in sync with the
    // `generate_handler!` list in `src/lib.rs`.
    let app = tauri_build::AppManifest::new().commands(&[
        // top-level (lib.rs)
        "read_config",
        "save_config",
        "read_runtime_setup",
        "save_runtime_setup",
        "bridge_status",
        "start_bridge",
        "stop_bridge",
        "restart_bridge",
        "read_logs",
        "secure_get",
        "secure_set",
        "secure_delete",
        "read_env_keys",
        "write_env_keys",
        "open_external_url",
        // wallet (wallet/mod.rs)
        "wallet_status",
        "wallet_create",
        "wallet_import",
        "wallet_unlock",
        "wallet_lock",
        "wallet_change_password",
        "wallet_sign_message",
        "wallet_sign_transaction",
        "wallet_set_auto_lock",
        "wallet_export_for_backup",
        "wallet_delete",
        // ledger (ledger/mod.rs)
        "ledger_list_devices",
        "ledger_connect",
        "ledger_get_address",
        "ledger_get_addresses",
        "ledger_sign_transaction",
        "ledger_sign_message",
        "ledger_disconnect",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(app))
        .expect("failed to run tauri-build");
}
