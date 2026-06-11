use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::{BufRead, BufReader, Read},
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use url::Url;

pub mod ledger;
pub mod wallet;

/// Shared handles passed to every Tauri command. `state` is the mutable
/// runtime data behind a single mutex; `restart_in_progress` is a separate
/// atomic flag that serializes `restart_bridge` re-entries and signals
/// transient "restarting" state to consumers without taking the main lock.
#[derive(Clone)]
struct SharedRuntime {
    state: Arc<Mutex<RuntimeState>>,
    restart_in_progress: Arc<AtomicBool>,
}

impl SharedRuntime {
    fn new(state: RuntimeState) -> Self {
        Self {
            state: Arc::new(Mutex::new(state)),
            restart_in_progress: Arc::new(AtomicBool::new(false)),
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, RuntimeState>, std::sync::PoisonError<std::sync::MutexGuard<'_, RuntimeState>>> {
        self.state.lock()
    }
}

const DEFAULT_BRIDGE_URL: &str = "http://127.0.0.1:8787";
const LEGACY_BRIDGE_TOKEN: &str = "local-agent-wallet";
const SIDECAR_BASENAME: &str = "agentic-cli-sidecar";
const MAX_LOG_LINES: usize = 600;
const DEFAULT_JUPITER_ULTRA_BASE: &str = "https://api.jup.ag/swap/v2";
const DEFAULT_JUPITER_API_URL: &str = "https://quote-api.jup.ag";
const DEFAULT_BIRDEYE_REST_BASE: &str = "https://public-api.birdeye.so";
const DEFAULT_AI_PROVIDER: &str = "openai";
const DEFAULT_AI_API_FORMAT: &str = "openai-compatible";
const DEFAULT_AI_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_AI_MODEL: &str = "gpt-5";
const SETUP_ENV_KEYS: [&str; 17] = [
    "SOLANA_RPC_URL",
    "HELIUS_RPC_URL",
    "JUPITER_API_KEY",
    "JUP_API_KEY",
    "JUPITER_SWAP_BASE_URL",
    "JUP_ULTRA_BASE",
    "JUPITER_API_URL",
    "BIRDEYE_API_KEY",
    "BIRDEYE_REST_BASE",
    "AGENTIC_AI_PROVIDER",
    "AGENTIC_AI_API_FORMAT",
    "AGENTIC_AI_API_KEY",
    "AGENTIC_AI_MODEL",
    "AGENTIC_AI_BASE_URL",
    // Agent Connector engine: use a local subscription-authed CLI instead of an API key.
    "AGENTIC_AI_ENGINE",
    "AGENTIC_AI_CONNECTOR",
    "AGENTIC_AI_CONNECTOR_PATH",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopConfig {
    repo_root: String,
    /// Secret. The webview uses this to authenticate against the local bridge HTTP API.
    /// Do not log this field; treat as a credential and only include it in IPC payloads.
    bridge_url: String,
    bridge_token: String,
    env_path: String,
    action_config_path: String,
    prepared_actions_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSetupInput {
    rpc_url: Option<String>,
    jupiter_api_key: Option<String>,
    jupiter_ultra_base: Option<String>,
    jupiter_api_url: Option<String>,
    birdeye_api_key: Option<String>,
    birdeye_rest_base: Option<String>,
    ai_provider: Option<String>,
    ai_api_format: Option<String>,
    ai_api_key: Option<String>,
    ai_model: Option<String>,
    ai_base_url: Option<String>,
    // Agent Connector engine: use a local subscription-authed CLI instead of an API key.
    ai_engine: Option<String>,
    ai_connector: Option<String>,
    ai_connector_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSetup {
    env_path: String,
    env_found: bool,
    rpc_url_configured: bool,
    rpc_url_redacted: Option<String>,
    jupiter_api_key_configured: bool,
    jupiter_api_key_redacted: Option<String>,
    jupiter_ultra_base: String,
    jupiter_api_url: String,
    birdeye_api_key_configured: bool,
    birdeye_api_key_redacted: Option<String>,
    birdeye_rest_base: String,
    ai_provider: String,
    ai_api_format: String,
    ai_api_key_configured: bool,
    ai_api_key_redacted: Option<String>,
    ai_model: String,
    ai_base_url: String,
    ai_engine: String,
    ai_connector: Option<String>,
    ai_connector_path: Option<String>,
    ai_ready: bool,
    sol_transfers_ready: bool,
    token_transfers_ready: bool,
    swaps_ready: bool,
    market_data_ready: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeStatus {
    running: bool,
    pid: Option<u32>,
    started_at: Option<String>,
    bridge_reachable: bool,
    /// True between the stop and (re)start phases of `restart_bridge`. Lets the
    /// webview show a "Restarting…" indicator and skip duplicate restart taps
    /// instead of treating the transient stopped state as a crash.
    restarting: bool,
    bridge_url: String,
    /// Secret — see DesktopConfig::bridge_token. The webview needs this to call
    /// the local bridge; do not log or expose to untrusted code.
    bridge_token: String,
    repo_root: String,
    env_path: String,
    action_config_path: String,
    prepared_actions_path: String,
    runtime_mode: String,
    sidecar_path: Option<String>,
    desktop_config_path: String,
    runtime_data_path: String,
    release_version: String,
    diagnostics: Vec<Diagnostic>,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostic {
    level: String,
    label: String,
    message: String,
}

struct ManagedProcess {
    child: Child,
    pid: u32,
    started_at: String,
}

struct RuntimeState {
    config: DesktopConfig,
    bridge: Option<ManagedProcess>,
    logs: VecDeque<String>,
    last_error: Option<String>,
}

struct RuntimeContext {
    sidecar_path: Option<PathBuf>,
    sidecar_candidates: Vec<PathBuf>,
    repo_bridge_script: Option<PathBuf>,
    desktop_config_path: PathBuf,
    runtime_data_path: PathBuf,
}

struct ProcessEvent {
    log: String,
    error: Option<String>,
}

enum LaunchCommand {
    Sidecar {
        executable: PathBuf,
        args: Vec<String>,
    },
    RepoDev {
        executable: String,
        args: Vec<String>,
        cwd: PathBuf,
    },
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let runtime = SharedRuntime::new(RuntimeState {
        config: load_config().unwrap_or_else(|_| default_config()),
        bridge: None,
        logs: VecDeque::new(),
        last_error: None,
    });

    let cleanup_runtime = runtime.clone();
    let wallet_state = wallet::build_production_state(desktop_wallet_path());
    let wallet_handle = wallet::WalletStateHandle::new(wallet_state);
    // Independent watcher thread: ticks every 10 s so the embedded wallet
    // auto-locks on its configured timeout even if the UI stops polling
    // `wallet_status`. We keep the join handle around so it isn't dropped
    // (which would not actually kill the thread, but JoinHandle is `Send`
    // and cheap to hold). Stop the watcher on app exit via the cloned
    // `watcher_stop_handle` below.
    let _wallet_auto_lock_watcher = wallet_handle.spawn_auto_lock_watcher();
    let wallet_watcher_stop = wallet_handle.watcher_stop_handle();
    let ledger_handle = ledger::LedgerStateHandle::new();
    let app = tauri::Builder::default()
        // single-instance must initialize first so a duplicate launch is intercepted
        // before any other plugin runs setup side effects.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // macOS: the AppHandle needs to be brought to the foreground in addition
            // to focusing the window — `set_focus` alone won't activate the app process.
            #[cfg(target_os = "macos")]
            {
                let _ = app.show();
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            use tauri::Emitter;
            use tauri_plugin_deep_link::DeepLinkExt;
            let app_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
                let _ = app_handle.emit("agentic://deep-link", urls);
            });
            Ok(())
        })
        .manage(runtime)
        .manage(wallet_handle)
        .manage(ledger_handle)
        .invoke_handler(tauri::generate_handler![
            read_config,
            save_config,
            read_runtime_setup,
            save_runtime_setup,
            bridge_status,
            start_bridge,
            stop_bridge,
            restart_bridge,
            read_logs,
            secure_get,
            secure_set,
            secure_delete,
            read_env_keys,
            write_env_keys,
            open_external_url,
            wallet::wallet_status,
            wallet::wallet_create,
            wallet::wallet_import,
            wallet::wallet_unlock,
            wallet::wallet_lock,
            wallet::wallet_change_password,
            wallet::wallet_sign_message,
            wallet::wallet_sign_transaction,
            wallet::wallet_set_auto_lock,
            wallet::wallet_export_for_backup,
            wallet::wallet_delete,
            ledger::ledger_list_devices,
            ledger::ledger_connect,
            ledger::ledger_get_address,
            ledger::ledger_get_addresses,
            ledger::ledger_sign_transaction,
            ledger::ledger_sign_message,
            ledger::ledger_disconnect,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Agentic desktop shell");

    app.run(move |_app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            cleanup_managed_processes(&cleanup_runtime);
            // Ask the wallet auto-lock watcher thread to exit on its next
            // wake. The OS would reap the thread on process exit anyway,
            // but explicit teardown keeps the shutdown sequence honest.
            wallet_watcher_stop.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    });
}

#[tauri::command]
fn read_config(state: tauri::State<'_, SharedRuntime>) -> Result<DesktopConfig, String> {
    let runtime = state.lock().map_err(lock_error)?;
    Ok(runtime.config.clone())
}

#[tauri::command]
fn save_config(
    config: DesktopConfig,
    state: tauri::State<'_, SharedRuntime>,
) -> Result<DesktopConfig, String> {
    let normalized = normalize_config(config);
    save_config_to_disk(&normalized)?;
    let mut runtime = state.lock().map_err(lock_error)?;
    runtime.config = normalized.clone();
    runtime.logs.push_back(format!(
        "[desktop] saved config at {}",
        desktop_config_path().display()
    ));
    trim_logs(&mut runtime.logs);
    Ok(normalized)
}

#[tauri::command]
fn read_runtime_setup(state: tauri::State<'_, SharedRuntime>) -> Result<RuntimeSetup, String> {
    let runtime = state.lock().map_err(lock_error)?;
    runtime_setup_for_config(&runtime.config)
}

#[tauri::command]
fn save_runtime_setup(
    input: RuntimeSetupInput,
    state: tauri::State<'_, SharedRuntime>,
) -> Result<RuntimeSetup, String> {
    let config = {
        let runtime = state.lock().map_err(lock_error)?;
        runtime.config.clone()
    };
    save_runtime_setup_to_env(&config, input)?;
    let setup = runtime_setup_for_config(&config)?;
    let mut runtime = state.lock().map_err(lock_error)?;
    runtime.logs.push_back(format!(
        "[desktop] saved runtime setup at {}",
        config.env_path
    ));
    trim_logs(&mut runtime.logs);
    Ok(setup)
}

#[tauri::command]
fn bridge_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedRuntime>,
) -> Result<BridgeStatus, String> {
    let restarting = state.restart_in_progress.load(Ordering::Acquire);
    let mut runtime = state.lock().map_err(lock_error)?;
    refresh_child_state(&mut runtime);
    Ok(status_from_runtime(&app, &runtime, restarting))
}

#[tauri::command]
fn start_bridge(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedRuntime>,
) -> Result<BridgeStatus, String> {
    let shared = state.inner().clone();
    if ensure_bridge_reachable(&app, &shared).is_ok() {
        clear_runtime_error_if_ready(&shared)?;
    }

    let restarting = shared.restart_in_progress.load(Ordering::Acquire);
    let mut runtime = shared.lock().map_err(lock_error)?;
    refresh_child_state(&mut runtime);
    Ok(status_from_runtime(&app, &runtime, restarting))
}

#[tauri::command]
fn stop_bridge(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedRuntime>,
) -> Result<BridgeStatus, String> {
    let restarting = state.restart_in_progress.load(Ordering::Acquire);
    let mut runtime = state.lock().map_err(lock_error)?;
    stop_bridge_child(&mut runtime);
    trim_logs(&mut runtime.logs);
    Ok(status_from_runtime(&app, &runtime, restarting))
}

#[tauri::command]
fn restart_bridge(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedRuntime>,
) -> Result<BridgeStatus, String> {
    // Serialize concurrent restart_bridge invocations with an atomic flag.
    // The first caller atomically sets the flag; subsequent callers see it
    // already set and short-circuit to return the current status rather than
    // racing with a spawn-in-flight. The flag is also exposed in BridgeStatus
    // so the webview can render "Restarting…" UX and skip duplicate clicks.
    if state
        .restart_in_progress
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        let mut runtime = state.lock().map_err(lock_error)?;
        refresh_child_state(&mut runtime);
        return Ok(status_from_runtime(&app, &runtime, true));
    }

    // Stop and start within the flag window. Use a scope guard so the flag
    // clears even on early returns / panics in the spawn path. Clone the
    // Arc<AtomicBool> so the guard's lifetime is independent of `state`,
    // which gets moved into the inner start_bridge call below.
    struct RestartGuard(Arc<AtomicBool>);
    impl Drop for RestartGuard {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Release);
        }
    }
    let _guard = RestartGuard(state.restart_in_progress.clone());

    {
        let mut runtime = state.lock().map_err(lock_error)?;
        stop_bridge_child(&mut runtime);
        trim_logs(&mut runtime.logs);
    }
    start_bridge(app, state)
}

#[tauri::command]
fn read_logs(state: tauri::State<'_, SharedRuntime>) -> Result<Vec<String>, String> {
    let runtime = state.lock().map_err(lock_error)?;
    Ok(runtime.logs.iter().cloned().collect())
}

#[tauri::command]
fn secure_get(key: String) -> Result<Option<String>, String> {
    if key.trim().is_empty() {
        return Err("secure_get requires a non-empty key.".into());
    }
    let store = load_secure_store();
    Ok(store.get(&key).cloned())
}

#[tauri::command]
fn secure_set(key: String, value: String) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("secure_set requires a non-empty key.".into());
    }
    let mut store = load_secure_store();
    if value.is_empty() {
        store.remove(&key);
    } else {
        store.insert(key, value);
    }
    save_secure_store(&store)
}

#[tauri::command]
fn secure_delete(key: String) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("secure_delete requires a non-empty key.".into());
    }
    let mut store = load_secure_store();
    store.remove(&key);
    save_secure_store(&store)
}

#[tauri::command]
fn read_env_keys(
    state: tauri::State<'_, SharedRuntime>,
    keys: Vec<String>,
) -> Result<HashMap<String, Option<String>>, String> {
    let path = {
        let runtime = state.lock().map_err(lock_error)?;
        runtime.config.env_path.clone()
    };
    let raw = match fs::read_to_string(Path::new(&path)) {
        Ok(value) => value,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(err) => return Err(format!("Failed to read {}: {err}", path)),
    };
    let values = parse_env_values(&raw);
    let mut result = HashMap::new();
    for key in keys {
        let trimmed = key.trim();
        if trimmed.is_empty() {
            continue;
        }
        result.insert(trimmed.to_string(), values.get(trimmed).cloned());
    }
    Ok(result)
}

#[tauri::command]
fn write_env_keys(
    state: tauri::State<'_, SharedRuntime>,
    updates: HashMap<String, String>,
) -> Result<(), String> {
    let path = {
        let runtime = state.lock().map_err(lock_error)?;
        runtime.config.env_path.clone()
    };
    let raw = match fs::read_to_string(Path::new(&path)) {
        Ok(value) => value,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(err) => return Err(format!("Failed to read {}: {err}", path)),
    };
    let next = apply_env_updates_general(&raw, &updates)?;
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create {}: {err}", parent.display()))?;
    }
    fs::write(&path, next).map_err(|err| format!("Failed to write {}: {err}", path))?;
    Ok(())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = validate_open_url(&url)?.to_string();
    let status = if cfg!(target_os = "macos") {
        Command::new("open").arg(&trimmed).status()
    } else if cfg!(target_os = "windows") {
        Command::new("cmd").args(["/C", "start", "", &trimmed]).status()
    } else {
        Command::new("xdg-open").arg(&trimmed).status()
    }
    .map_err(|err| format!("Failed to open URL externally: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Open external URL exited with status {status}"))
    }
}

/// Validate and normalize an external URL. Returns the trimmed input on
/// success. Refuses dangerous schemes (file://, javascript:, data:, etc.) and
/// empty URLs. Pure function — safe to unit-test without spawning processes.
fn validate_open_url(url: &str) -> Result<&str, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("open_external_url requires a non-empty URL.".into());
    }
    let parsed = Url::parse(trimmed)
        .map_err(|err| format!("open_external_url: invalid URL ({err})"))?;
    match parsed.scheme() {
        "http" | "https" | "agentic" | "phantom" | "solflare" | "backpack" | "jupiter"
        | "magiceden" => Ok(trimmed),
        other => Err(format!("open_external_url: refusing to open {other}:// URL.")),
    }
}

fn ensure_bridge_reachable(app: &tauri::AppHandle, shared: &SharedRuntime) -> Result<(), String> {
    let bridge_url = {
        let mut runtime = shared.lock().map_err(lock_error)?;
        refresh_child_state(&mut runtime);

        if runtime.bridge.is_none() {
            // Always own our bridge: never trust an external process on the
            // configured port. A CLI bridge, an orphaned tauri:dev, or anything
            // else there will be using a different token, and the webview will
            // hit 401 on every /bridge/* request. Scan for a free port instead
            // and spawn next to whatever is there.
            let (host, configured_port) =
                host_port_or_default(&runtime.config.bridge_url, 8787);
            let chosen_port = find_available_port(&host, configured_port, 100)
                .ok_or_else(|| {
                    format!(
                        "No free port near {configured_port} for the bridge (scanned 100)."
                    )
                })?;
            if chosen_port != configured_port {
                runtime.config.bridge_url = format!("http://{host}:{chosen_port}");
                runtime.logs.push_back(format!(
                    "[desktop] port {configured_port} busy — bridge will use {chosen_port}"
                ));
                trim_logs(&mut runtime.logs);
            }

            match ensure_bridge_runtime_files(&runtime.config) {
                Ok(messages) => {
                    for message in messages {
                        runtime.logs.push_back(message);
                    }
                    trim_logs(&mut runtime.logs);
                }
                Err(err) => {
                    runtime.last_error = Some(err.clone());
                    runtime.logs.push_back(format!("[desktop] {err}"));
                    trim_logs(&mut runtime.logs);
                    return Err(err);
                }
            }

            match bridge_launch_command(app, &runtime.config) {
                Ok(command) => {
                    match spawn_managed_process(shared, &mut runtime, "bridge", command) {
                        Ok(process) => {
                            runtime
                                .logs
                                .push_back(format!("[desktop] bridge started pid={}", process.pid));
                            runtime.bridge = Some(process);
                            runtime.last_error = None;
                            trim_logs(&mut runtime.logs);
                        }
                        Err(err) => {
                            runtime.last_error = Some(err.clone());
                            runtime.logs.push_back(format!("[desktop] {err}"));
                            trim_logs(&mut runtime.logs);
                            return Err(err);
                        }
                    }
                }
                Err(err) => {
                    runtime.last_error = Some(err.clone());
                    runtime.logs.push_back(format!("[desktop] {err}"));
                    trim_logs(&mut runtime.logs);
                    return Err(err);
                }
            }
        }

        runtime.config.bridge_url.clone()
    };

    if wait_for_bridge_endpoint(&bridge_url, Duration::from_secs(8)) {
        Ok(())
    } else {
        let err = format!("Bridge did not become reachable at {bridge_url}.");
        record_runtime_error(shared, err.clone())?;
        Err(err)
    }
}

fn record_runtime_error(shared: &SharedRuntime, err: String) -> Result<(), String> {
    let mut runtime = shared.lock().map_err(lock_error)?;
    runtime.last_error = Some(err.clone());
    runtime.logs.push_back(format!("[desktop] {err}"));
    trim_logs(&mut runtime.logs);
    Ok(())
}

fn clear_runtime_error_if_ready(shared: &SharedRuntime) -> Result<(), String> {
    let bridge_url = {
        let runtime = shared.lock().map_err(lock_error)?;
        runtime.config.bridge_url.clone()
    };
    if bridge_endpoint_reachable(&bridge_url) {
        let mut runtime = shared.lock().map_err(lock_error)?;
        runtime.last_error = None;
    }
    Ok(())
}

fn status_from_runtime(
    app: &tauri::AppHandle,
    runtime: &RuntimeState,
    restarting: bool,
) -> BridgeStatus {
    let context = runtime_context(app, &runtime.config);
    let bridge_reachable = bridge_endpoint_reachable(&runtime.config.bridge_url);
    BridgeStatus {
        running: runtime.bridge.is_some(),
        pid: runtime.bridge.as_ref().map(|process| process.pid),
        started_at: runtime
            .bridge
            .as_ref()
            .map(|process| process.started_at.clone()),
        bridge_reachable,
        restarting,
        bridge_url: runtime.config.bridge_url.clone(),
        bridge_token: runtime.config.bridge_token.clone(),
        repo_root: runtime.config.repo_root.clone(),
        env_path: runtime.config.env_path.clone(),
        action_config_path: runtime.config.action_config_path.clone(),
        prepared_actions_path: runtime.config.prepared_actions_path.clone(),
        runtime_mode: runtime_mode(&context).into(),
        sidecar_path: context.sidecar_path.as_ref().map(|path| display_path(path)),
        desktop_config_path: display_path(&context.desktop_config_path),
        runtime_data_path: display_path(&context.runtime_data_path),
        release_version: env!("CARGO_PKG_VERSION").into(),
        diagnostics: diagnostics_for(
            &runtime.config,
            &context,
            runtime.bridge.is_some(),
            bridge_reachable,
            runtime.last_error.as_deref(),
        ),
        last_error: runtime.last_error.clone(),
    }
}

fn refresh_child_state(runtime: &mut RuntimeState) {
    refresh_bridge_child(runtime);
    trim_logs(&mut runtime.logs);
}

fn refresh_bridge_child(runtime: &mut RuntimeState) {
    if let Some(event) = refresh_process_slot(&mut runtime.bridge, "bridge") {
        record_process_event(runtime, event);
    }
}

fn refresh_process_slot(
    process_slot: &mut Option<ManagedProcess>,
    label: &str,
) -> Option<ProcessEvent> {
    let process = process_slot.as_mut()?;
    match process.child.try_wait() {
        Ok(Some(status)) => {
            *process_slot = None;
            Some(ProcessEvent {
                log: format!("[desktop] {label} exited with status {status}"),
                error: Some(format!("{label} exited with status {status}")),
            })
        }
        Ok(None) => None,
        Err(err) => {
            *process_slot = None;
            Some(ProcessEvent {
                log: format!("[desktop] failed to inspect {label}: {err}"),
                error: Some(format!("Failed to inspect {label} process: {err}")),
            })
        }
    }
}

fn spawn_managed_process(
    shared: &SharedRuntime,
    runtime: &mut RuntimeState,
    label: &'static str,
    launch: LaunchCommand,
) -> Result<ManagedProcess, String> {
    let mut command = match launch {
        LaunchCommand::Sidecar { executable, args } => {
            let mut command = Command::new(executable);
            command.args(args);
            command.current_dir(runtime_data_dir());
            command
        }
        LaunchCommand::RepoDev {
            executable,
            args,
            cwd,
        } => {
            let mut command = Command::new(executable);
            command.args(args).current_dir(cwd);
            command
        }
    };
    // Finder/Dock-launched builds inherit a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) that omits
    // Homebrew / npm / pnpm dirs, so the bridge can't resolve the codex/claude/gemini connector
    // binaries (it scans PATH). Augment PATH with the common install locations. No-op on Windows (GUI
    // launches inherit the user PATH there). A terminal-launched `tauri:dev` already has the full
    // shell PATH, so this only ever adds missing dirs.
    #[cfg(not(target_os = "windows"))]
    {
        let path = augmented_path();
        runtime.logs.push_back(format!("[desktop] {label} PATH={path}"));
        command.env("PATH", path);
    }
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    let mut child = command
        .spawn()
        .map_err(|err| format!("Failed to start {label}: {err}"))?;
    let pid = child.id();
    let started_at = now_isoish();

    if let Some(stdout) = child.stdout.take() {
        spawn_log_reader(shared.clone(), label, stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_log_reader(shared.clone(), label, stderr);
    }

    trim_logs(&mut runtime.logs);
    Ok(ManagedProcess {
        child,
        pid,
        started_at,
    })
}

fn stop_bridge_child(runtime: &mut RuntimeState) {
    if let Some(event) = stop_process_slot(&mut runtime.bridge, "bridge") {
        record_process_event(runtime, event);
    }
}

fn cleanup_managed_processes(shared: &SharedRuntime) {
    if let Ok(mut runtime) = shared.lock() {
        stop_bridge_child(&mut runtime);
        trim_logs(&mut runtime.logs);
    }
}

fn stop_process_slot(
    process_slot: &mut Option<ManagedProcess>,
    label: &str,
) -> Option<ProcessEvent> {
    if let Some(mut process) = process_slot.take() {
        let pid = process.pid;
        let mut error = None;
        // Prefer a graceful SIGTERM (Unix) so the bridge runs its shutdown hook — which revokes any
        // active phone pairing via /unpair. `Child::kill()` is SIGKILL (uncatchable), so on its own
        // the unpair never fires on a normal desktop quit. Fall back to SIGKILL if it doesn't exit.
        #[cfg(unix)]
        {
            let _ = std::process::Command::new("kill")
                .arg("-TERM")
                .arg(pid.to_string())
                .status();
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(2000);
            loop {
                match process.child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => {
                        if std::time::Instant::now() >= deadline {
                            if let Err(err) = process.child.kill() {
                                error = Some(format!("Failed to stop {label} pid={pid}: {err}"));
                            }
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    Err(err) => {
                        error = Some(format!("Failed to wait for {label} pid={pid}: {err}"));
                        break;
                    }
                }
            }
        }
        #[cfg(not(unix))]
        {
            if let Err(err) = process.child.kill() {
                error = Some(format!("Failed to stop {label} pid={pid}: {err}"));
            }
        }
        let _ = process.child.wait();
        return Some(ProcessEvent {
            log: format!("[desktop] {label} stopped pid={pid}"),
            error,
        });
    }
    None
}

fn record_process_event(runtime: &mut RuntimeState, event: ProcessEvent) {
    if let Some(error) = event.error {
        runtime.last_error = Some(error);
    }
    runtime.logs.push_back(event.log);
}

fn bridge_launch_command(
    app: &tauri::AppHandle,
    config: &DesktopConfig,
) -> Result<LaunchCommand, String> {
    let context = runtime_context(app, config);
    if let Some(sidecar) = context.sidecar_path {
        let args = sidecar_command_args(["bridge", "serve"], config);
        return Ok(LaunchCommand::Sidecar {
            executable: sidecar,
            args,
        });
    }

    if let Some(script) = context.repo_bridge_script {
        let (host, port) = host_port_or_default(&config.bridge_url, 8787);
        return Ok(LaunchCommand::RepoDev {
            executable: "node".into(),
            args: vec![
                display_path(&script),
                "--token".into(),
                config.bridge_token.clone(),
                "--env".into(),
                config.env_path.clone(),
                "--config".into(),
                config.action_config_path.clone(),
                "--prepared-actions".into(),
                config.prepared_actions_path.clone(),
                "--host".into(),
                host,
                "--port".into(),
                port.to_string(),
            ],
            cwd: PathBuf::from(&config.repo_root),
        });
    }

    Err(missing_sidecar_message(&context))
}

fn sidecar_command_args<const N: usize>(command: [&str; N], config: &DesktopConfig) -> Vec<String> {
    let mut args = command
        .iter()
        .map(|part| (*part).to_string())
        .collect::<Vec<_>>();
    args.extend(sidecar_global_args(config));
    args
}

fn sidecar_global_args(config: &DesktopConfig) -> Vec<String> {
    vec![
        "--bridge-url".into(),
        config.bridge_url.clone(),
        "--token".into(),
        config.bridge_token.clone(),
        "--runtime-dir".into(),
        display_path(&runtime_data_dir()),
        "--env".into(),
        config.env_path.clone(),
        "--config".into(),
        config.action_config_path.clone(),
        "--prepared-actions".into(),
        config.prepared_actions_path.clone(),
    ]
}

fn diagnostics_for(
    config: &DesktopConfig,
    context: &RuntimeContext,
    bridge_running: bool,
    bridge_reachable: bool,
    last_error: Option<&str>,
) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    diagnostics.push(Diagnostic {
        level: "ok".into(),
        label: "Version".into(),
        message: env!("CARGO_PKG_VERSION").into(),
    });
    diagnostics.push(Diagnostic {
        level: "ok".into(),
        label: "Desktop config".into(),
        message: display_path(&context.desktop_config_path),
    });

    if context.runtime_data_path.is_dir() {
        diagnostics.push(Diagnostic {
            level: "ok".into(),
            label: "Runtime data".into(),
            message: display_path(&context.runtime_data_path),
        });
    } else {
        diagnostics.push(Diagnostic {
            level: "info".into(),
            label: "Runtime data".into(),
            message: format!(
                "{} will be created on first start.",
                context.runtime_data_path.display()
            ),
        });
    }

    if let Some(sidecar) = &context.sidecar_path {
        diagnostics.push(Diagnostic {
            level: "ok".into(),
            label: "CLI sidecar".into(),
            message: display_path(sidecar),
        });
    } else if context.repo_bridge_script.is_some() {
        diagnostics.push(Diagnostic {
            level: "warning".into(),
            label: "CLI sidecar".into(),
            message: format!(
                "Bundled sidecar is missing. Agentic is using repo-dev fallback at {}.",
                config.repo_root
            ),
        });
    } else {
        diagnostics.push(Diagnostic {
            level: "error".into(),
            label: "CLI sidecar".into(),
            message: missing_sidecar_message(context),
        });
    }

    if let Some(last_error) = last_error {
        diagnostics.push(Diagnostic {
            level: "error".into(),
            label: "Last error".into(),
            message: last_error.into(),
        });
    }

    push_endpoint_diagnostic(
        &mut diagnostics,
        "Bridge",
        &config.bridge_url,
        bridge_running,
        bridge_reachable,
        "managed by Agentic",
        "Start runtime to serve the local bridge.",
    );

    if context.sidecar_path.is_none() {
        if let Some(script) = &context.repo_bridge_script {
            diagnostics.push(Diagnostic {
                level: "ok".into(),
                label: "Dev bridge".into(),
                message: display_path(script),
            });
        } else if !config.repo_root.trim().is_empty() {
            diagnostics.push(Diagnostic {
                level: "warning".into(),
                label: "Dev bridge".into(),
                message: format!(
                    "Missing repo bridge build artifact under {}.",
                    config.repo_root
                ),
            });
        }
    }

    diagnostics
}

fn push_endpoint_diagnostic(
    diagnostics: &mut Vec<Diagnostic>,
    label: &str,
    url: &str,
    managed_running: bool,
    reachable: bool,
    managed_message: &str,
    missing_message: &str,
) {
    if managed_running && reachable {
        diagnostics.push(Diagnostic {
            level: "ok".into(),
            label: label.into(),
            message: format!("{url} is {managed_message}."),
        });
        return;
    }
    if managed_running {
        diagnostics.push(Diagnostic {
            level: "warning".into(),
            label: label.into(),
            message: format!("{url} has a managed process but is not reachable yet."),
        });
        return;
    }
    if reachable {
        diagnostics.push(Diagnostic {
            level: "ok".into(),
            label: label.into(),
            message: format!("{url} is reachable."),
        });
    } else {
        diagnostics.push(Diagnostic {
            level: "info".into(),
            label: label.into(),
            message: format!("{url} is not reachable. {missing_message}"),
        });
    }
}

fn runtime_context(app: &tauri::AppHandle, config: &DesktopConfig) -> RuntimeContext {
    let sidecar_candidates = sidecar_candidates(app);
    let sidecar_path = sidecar_candidates
        .iter()
        .find(|path| path.is_file())
        .cloned();
    let repo_root = PathBuf::from(config.repo_root.trim());
    let repo_bridge_script = if !repo_root.as_os_str().is_empty() {
        let path = repo_root.join("packages/mcp-server/dist/bin/bridge.js");
        path.is_file().then_some(path)
    } else {
        None
    };
    RuntimeContext {
        sidecar_path,
        sidecar_candidates,
        repo_bridge_script,
        desktop_config_path: desktop_config_path(),
        runtime_data_path: runtime_data_dir(),
    }
}

fn sidecar_candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let target_triple = option_env!("TAURI_ENV_TARGET_TRIPLE").unwrap_or(current_target_triple());
    if let Ok(path) = std::env::var("AGENTIC_CLI_SIDECAR") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(sidecar_target_filename(target_triple)));
        candidates.push(resource_dir.join(sidecar_filename()));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join(sidecar_target_filename(target_triple)));
            candidates.push(exe_dir.join(sidecar_filename()));
        }
    }
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    candidates.push(
        manifest_dir
            .join("target/sidecars")
            .join(sidecar_target_filename(target_triple)),
    );
    candidates.push(
        manifest_dir
            .join("target/sidecars")
            .join(sidecar_filename()),
    );
    dedupe_paths(candidates)
}

fn runtime_mode(context: &RuntimeContext) -> &'static str {
    if context.sidecar_path.is_some() {
        "installed-sidecar"
    } else if context.repo_bridge_script.is_some() {
        "repo-dev-fallback"
    } else {
        "missing-sidecar"
    }
}

fn missing_sidecar_message(context: &RuntimeContext) -> String {
    let checked = context
        .sidecar_candidates
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    format!("Missing Agentic CLI sidecar. Reinstall Agentic or stage the sidecar for development. Checked: {checked}")
}

fn ensure_runtime_dirs(config: &DesktopConfig) -> Result<(), String> {
    fs::create_dir_all(runtime_data_dir())
        .map_err(|err| format!("Failed to create runtime data directory: {err}"))?;
    if let Some(parent) = Path::new(&config.env_path).parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create {}: {err}", parent.display()))?;
    }
    if let Some(parent) = Path::new(&config.action_config_path).parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create {}: {err}", parent.display()))?;
    }
    if let Some(parent) = Path::new(&config.prepared_actions_path).parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create {}: {err}", parent.display()))?;
    }
    Ok(())
}

fn spawn_log_reader<R>(state: SharedRuntime, label: &'static str, reader: R)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let buffered = BufReader::new(reader);
        for line in buffered.lines().map_while(Result::ok) {
            if let Ok(mut runtime) = state.lock() {
                runtime.logs.push_back(format!("[{label}] {line}"));
                trim_logs(&mut runtime.logs);
            }
        }
    });
}

fn trim_logs(logs: &mut VecDeque<String>) {
    while logs.len() > MAX_LOG_LINES {
        logs.pop_front();
    }
}

fn load_config() -> Result<DesktopConfig, String> {
    let path = desktop_config_path();
    if !path.is_file() {
        return Ok(default_config());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("Failed to read {}: {err}", path.display()))?;
    serde_json::from_str::<DesktopConfig>(&raw)
        .map(normalize_config)
        .map_err(|err| format!("Failed to parse {}: {err}", path.display()))
}

fn save_config_to_disk(config: &DesktopConfig) -> Result<(), String> {
    let path = desktop_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create {}: {err}", parent.display()))?;
    }
    let raw = serde_json::to_string_pretty(config)
        .map_err(|err| format!("Failed to encode config: {err}"))?;
    fs::write(&path, format!("{raw}\n"))
        .map_err(|err| format!("Failed to write {}: {err}", path.display()))
}

fn allow_public_bridge() -> bool {
    std::env::var("AGENTIC_DESKTOP_ALLOW_PUBLIC_BRIDGE")
        .map(|v| v == "1")
        .unwrap_or(false)
}

/// True if the bridge URL's host is a loopback address. Hand-parsed (no `url`
/// crate dependency): scheme://[userinfo@]host[:port]/...
fn bridge_url_host_is_loopback(url: &str) -> bool {
    let after_scheme = url.split("://").nth(1).unwrap_or(url);
    let authority = after_scheme.split('/').next().unwrap_or("");
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let host = if let Some(rest) = host_port.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        host_port.split(':').next().unwrap_or("")
    };
    let host = host.trim().to_ascii_lowercase();
    host == "localhost" || host == "127.0.0.1" || host == "::1" || host.starts_with("127.")
}

fn normalize_config(mut config: DesktopConfig) -> DesktopConfig {
    let defaults = default_config();
    if config.repo_root.trim().is_empty() {
        config.repo_root = defaults.repo_root;
    }
    if config.bridge_url.trim().is_empty() {
        config.bridge_url = DEFAULT_BRIDGE_URL.into();
    } else if !bridge_url_host_is_loopback(&config.bridge_url) && !allow_public_bridge() {
        // The managed bridge holds a token-gated wallet API; never let a config
        // (or a compromised webview via save_config) point it at a non-loopback
        // interface unless the operator explicitly opts in.
        config.bridge_url = DEFAULT_BRIDGE_URL.into();
    }
    if config.bridge_token.trim().is_empty() || config.bridge_token == LEGACY_BRIDGE_TOKEN {
        config.bridge_token = generated_bridge_token();
    }
    if config.env_path.trim().is_empty() {
        config.env_path = defaults.env_path;
    }
    if config.action_config_path.trim().is_empty() {
        config.action_config_path = defaults.action_config_path;
    }
    if config.prepared_actions_path.trim().is_empty() {
        config.prepared_actions_path = defaults.prepared_actions_path;
    }
    config
}

/// The desktop is a consumer **mainnet** wallet. The bundled local bridge derives its cluster
/// solely from the action-config file (see packages/mcp-server `loadConfig`/`DEFAULT_CONFIG`);
/// when that file has no `cluster`, the loader defaults to **devnet**, which silently shows a
/// devnet balance with USD pricing disabled ("USD unavailable"). Pin the desktop to mainnet-beta.
const DESKTOP_ACTION_CONFIG_CLUSTER: &str = "mainnet-beta";

fn ensure_bridge_runtime_files(config: &DesktopConfig) -> Result<Vec<String>, String> {
    ensure_runtime_dirs(config)?;
    ensure_mainnet_action_config(Path::new(&config.action_config_path))
}

fn default_mainnet_action_config_json() -> String {
    serde_json::json!({
        "cluster": DESKTOP_ACTION_CONFIG_CLUSTER,
        "mainnet": { "enabled": true }
    })
    .to_string()
}

/// Seed a new action config on mainnet-beta, or migrate an existing cluster-less config (e.g.
/// the legacy empty `{}`) up to mainnet-beta. An explicit `cluster` (mainnet-beta OR a
/// developer's devnet) is always preserved, and any explicit `mainnet.enabled` is respected.
fn ensure_mainnet_action_config(path: &Path) -> Result<Vec<String>, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create {}: {err}", parent.display()))?;
    }
    if !path.is_file() {
        fs::write(path, format!("{}\n", default_mainnet_action_config_json()))
            .map_err(|err| format!("Failed to write {}: {err}", path.display()))?;
        return Ok(vec![format!(
            "[desktop] created default action config (mainnet-beta) at {}",
            path.display()
        )]);
    }
    let raw = fs::read_to_string(path)
        .map_err(|err| format!("Failed to read {}: {err}", path.display()))?;
    let mut value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|err| format!("Failed to parse {}: {err}", path.display()))?;
    let object = match value.as_object_mut() {
        Some(object) => object,
        // Not a JSON object — leave the file untouched rather than clobber it.
        None => return Ok(Vec::new()),
    };
    if object.contains_key("cluster") {
        // A cluster was chosen explicitly (e.g. a developer on devnet) — respect it.
        return Ok(Vec::new());
    }
    object.insert(
        "cluster".into(),
        serde_json::Value::String(DESKTOP_ACTION_CONFIG_CLUSTER.into()),
    );
    match object.get_mut("mainnet") {
        Some(serde_json::Value::Object(mainnet)) => {
            if !mainnet.contains_key("enabled") {
                mainnet.insert("enabled".into(), serde_json::Value::Bool(true));
            }
        }
        _ => {
            object.insert("mainnet".into(), serde_json::json!({ "enabled": true }));
        }
    }
    let serialized = serde_json::to_string_pretty(&value)
        .map_err(|err| format!("Failed to serialize {}: {err}", path.display()))?;
    fs::write(path, format!("{serialized}\n"))
        .map_err(|err| format!("Failed to write {}: {err}", path.display()))?;
    Ok(vec![format!(
        "[desktop] migrated action config to mainnet-beta at {}",
        path.display()
    )])
}

fn runtime_setup_for_config(config: &DesktopConfig) -> Result<RuntimeSetup, String> {
    let path = Path::new(&config.env_path);
    let (env_found, values) = read_env_values(path)?;
    let rpc_url = first_env_value(&values, &["SOLANA_RPC_URL", "HELIUS_RPC_URL"]);
    let jupiter_api_key = first_env_value(&values, &["JUPITER_API_KEY", "JUP_API_KEY"]);
    let jupiter_ultra_base = first_env_value(&values, &["JUPITER_SWAP_BASE_URL", "JUP_ULTRA_BASE"])
        .unwrap_or_else(|| DEFAULT_JUPITER_ULTRA_BASE.into());
    let jupiter_api_url = values
        .get("JUPITER_API_URL")
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| DEFAULT_JUPITER_API_URL.into());
    let birdeye_api_key = values
        .get("BIRDEYE_API_KEY")
        .filter(|value| !value.trim().is_empty())
        .cloned();
    let birdeye_rest_base = values
        .get("BIRDEYE_REST_BASE")
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| DEFAULT_BIRDEYE_REST_BASE.into());
    let ai_provider = values
        .get("AGENTIC_AI_PROVIDER")
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| DEFAULT_AI_PROVIDER.into());
    let ai_api_format = values
        .get("AGENTIC_AI_API_FORMAT")
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| DEFAULT_AI_API_FORMAT.into());
    let ai_api_key = values
        .get("AGENTIC_AI_API_KEY")
        .filter(|value| !value.trim().is_empty())
        .cloned();
    let ai_model = values
        .get("AGENTIC_AI_MODEL")
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| DEFAULT_AI_MODEL.into());
    let ai_base_url = values
        .get("AGENTIC_AI_BASE_URL")
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| DEFAULT_AI_BASE_URL.into());
    let ai_engine = values
        .get("AGENTIC_AI_ENGINE")
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| "api-key".into());
    let ai_connector = values
        .get("AGENTIC_AI_CONNECTOR")
        .filter(|value| !value.trim().is_empty())
        .cloned();
    let ai_connector_path = values
        .get("AGENTIC_AI_CONNECTOR_PATH")
        .filter(|value| !value.trim().is_empty())
        .cloned();
    let connector_mode = ai_engine.eq_ignore_ascii_case("connector") && ai_connector.is_some();
    let rpc_url_configured = rpc_url.is_some();
    let jupiter_api_key_configured = jupiter_api_key.is_some();
    let birdeye_api_key_configured = birdeye_api_key.is_some();
    let ai_api_key_configured = ai_api_key.is_some();
    Ok(RuntimeSetup {
        env_path: config.env_path.clone(),
        env_found,
        rpc_url_configured,
        rpc_url_redacted: rpc_url.as_deref().map(redact_url_secret),
        jupiter_api_key_configured,
        jupiter_api_key_redacted: jupiter_api_key.as_deref().map(redact_secret),
        jupiter_ultra_base,
        jupiter_api_url,
        birdeye_api_key_configured,
        birdeye_api_key_redacted: birdeye_api_key.as_deref().map(redact_secret),
        birdeye_rest_base,
        ai_provider,
        ai_api_format,
        ai_api_key_configured,
        ai_api_key_redacted: ai_api_key.as_deref().map(redact_secret),
        ai_model,
        ai_base_url,
        ai_engine,
        ai_connector,
        ai_connector_path,
        ai_ready: ai_api_key_configured || connector_mode,
        sol_transfers_ready: rpc_url_configured,
        token_transfers_ready: rpc_url_configured,
        swaps_ready: rpc_url_configured && jupiter_api_key_configured,
        market_data_ready: birdeye_api_key_configured,
    })
}

fn save_runtime_setup_to_env(
    config: &DesktopConfig,
    input: RuntimeSetupInput,
) -> Result<(), String> {
    let path = Path::new(&config.env_path);
    let raw = match fs::read_to_string(path) {
        Ok(value) => value,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(err) => return Err(format!("Failed to read {}: {err}", path.display())),
    };
    let values = parse_env_values(&raw);
    let mut updates = HashMap::new();

    if let Some(rpc_url) = input.rpc_url.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        let normalized = normalize_setup_url(rpc_url, "Solana RPC URL")?;
        updates.insert("SOLANA_RPC_URL".into(), normalized.clone());
        updates.insert("HELIUS_RPC_URL".into(), normalized);
    }

    if let Some(api_key) = input
        .jupiter_api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        updates.insert("JUPITER_API_KEY".into(), api_key.into());
        updates.insert("JUP_API_KEY".into(), api_key.into());
    }

    let jupiter_ultra_base = input
        .jupiter_ultra_base
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| values.get("JUPITER_SWAP_BASE_URL").cloned())
        .or_else(|| values.get("JUP_ULTRA_BASE").cloned())
        .unwrap_or_else(|| DEFAULT_JUPITER_ULTRA_BASE.into());
    let normalized_jupiter_swap_base =
        normalize_setup_url(&jupiter_ultra_base, "Jupiter Swap API v2 base URL")?;
    updates.insert(
        "JUPITER_SWAP_BASE_URL".into(),
        normalized_jupiter_swap_base.clone(),
    );
    updates.insert(
        "JUP_ULTRA_BASE".into(),
        normalized_jupiter_swap_base,
    );

    let jupiter_api_url = input
        .jupiter_api_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| values.get("JUPITER_API_URL").cloned())
        .unwrap_or_else(|| DEFAULT_JUPITER_API_URL.into());
    updates.insert(
        "JUPITER_API_URL".into(),
        normalize_setup_url(&jupiter_api_url, "Legacy Jupiter API URL")?,
    );

    if let Some(api_key) = input
        .birdeye_api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        updates.insert("BIRDEYE_API_KEY".into(), api_key.into());
    }

    let birdeye_rest_base = input
        .birdeye_rest_base
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| values.get("BIRDEYE_REST_BASE").cloned())
        .unwrap_or_else(|| DEFAULT_BIRDEYE_REST_BASE.into());
    updates.insert(
        "BIRDEYE_REST_BASE".into(),
        normalize_setup_url(&birdeye_rest_base, "BirdEye REST base URL")?,
    );

    let ai_provider = input
        .ai_provider
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| values.get("AGENTIC_AI_PROVIDER").cloned())
        .unwrap_or_else(|| DEFAULT_AI_PROVIDER.into());
    updates.insert("AGENTIC_AI_PROVIDER".into(), ai_provider);

    let ai_api_format = input
        .ai_api_format
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| values.get("AGENTIC_AI_API_FORMAT").cloned())
        .unwrap_or_else(|| DEFAULT_AI_API_FORMAT.into());
    updates.insert("AGENTIC_AI_API_FORMAT".into(), ai_api_format);

    if let Some(api_key) = input
        .ai_api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        updates.insert("AGENTIC_AI_API_KEY".into(), api_key.into());
    }

    let ai_model = input
        .ai_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| values.get("AGENTIC_AI_MODEL").cloned())
        .unwrap_or_else(|| DEFAULT_AI_MODEL.into());
    updates.insert("AGENTIC_AI_MODEL".into(), ai_model);

    let ai_base_url = input
        .ai_base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| values.get("AGENTIC_AI_BASE_URL").cloned())
        .unwrap_or_else(|| DEFAULT_AI_BASE_URL.into());
    updates.insert(
        "AGENTIC_AI_BASE_URL".into(),
        normalize_setup_url(&ai_base_url, "AI base URL")?,
    );

    // Agent Connector engine: persist engine/connector when set to 'connector'; clear them when the
    // user explicitly switches back to an API key (so the bridge stops shelling out to the CLI).
    let ai_engine = input
        .ai_engine
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase);
    if ai_engine.as_deref() == Some("connector") {
        updates.insert("AGENTIC_AI_ENGINE".into(), "connector".into());
        if let Some(connector) = input
            .ai_connector
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            updates.insert("AGENTIC_AI_CONNECTOR".into(), connector.into());
        }
        if let Some(connector_path) = input
            .ai_connector_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            updates.insert("AGENTIC_AI_CONNECTOR_PATH".into(), connector_path.into());
        }
    } else if ai_engine.is_some() {
        updates.insert("AGENTIC_AI_ENGINE".into(), String::new());
        updates.insert("AGENTIC_AI_CONNECTOR".into(), String::new());
        updates.insert("AGENTIC_AI_CONNECTOR_PATH".into(), String::new());
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create {}: {err}", parent.display()))?;
    }
    let next = apply_env_updates(&raw, &updates)?;
    let temp_path = temp_env_path(path);
    fs::write(&temp_path, next)
        .map_err(|err| format!("Failed to write {}: {err}", temp_path.display()))?;
    fs::rename(&temp_path, path).map_err(|err| {
        format!(
            "Failed to replace {} with {}: {err}",
            path.display(),
            temp_path.display()
        )
    })?;
    set_private_file_permissions(path);
    Ok(())
}

fn read_env_values(path: &Path) -> Result<(bool, HashMap<String, String>), String> {
    match fs::read_to_string(path) {
        Ok(raw) => Ok((true, parse_env_values(&raw))),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok((false, HashMap::new())),
        Err(err) => Err(format!("Failed to read {}: {err}", path.display())),
    }
}

fn parse_env_values(raw: &str) -> HashMap<String, String> {
    let mut values = HashMap::new();
    for line in raw.lines() {
        let Some(key) = env_key_from_line(line) else {
            continue;
        };
        let Some((_, value)) = line.split_once('=') else {
            continue;
        };
        values.insert(key, unquote_env(value.trim()));
    }
    values
}

fn apply_env_updates_general(raw: &str, updates: &HashMap<String, String>) -> Result<String, String> {
    let normalized = raw.replace("\r\n", "\n");
    let mut lines = if normalized.is_empty() {
        vec!["# Solana Agent Wallet local runtime setup".to_string()]
    } else {
        normalized.split('\n').map(str::to_string).collect::<Vec<_>>()
    };
    let mut seen = HashSet::new();
    for line in &mut lines {
        let Some(key) = env_key_from_line(line) else {
            continue;
        };
        let Some(value) = updates.get(&key) else {
            continue;
        };
        *line = format!("{key}={}", format_env_value(value)?);
        seen.insert(key);
    }
    let missing = updates
        .keys()
        .filter(|key| !seen.contains(*key))
        .cloned()
        .collect::<Vec<_>>();
    if !missing.is_empty() && lines.last().map(|line| !line.is_empty()).unwrap_or(false) {
        lines.push(String::new());
    }
    for key in missing {
        let value = updates.get(&key).map(String::as_str).unwrap_or("");
        lines.push(format!("{key}={}", format_env_value(value)?));
    }
    Ok(format!("{}\n", lines.join("\n").trim_end_matches('\n')))
}

fn apply_env_updates(raw: &str, updates: &HashMap<String, String>) -> Result<String, String> {
    let normalized = raw.replace("\r\n", "\n");
    let mut lines = if normalized.is_empty() {
        vec!["# Solana Agent Wallet local runtime setup".to_string()]
    } else {
        normalized.split('\n').map(str::to_string).collect::<Vec<_>>()
    };
    let mut seen = HashSet::new();
    for line in &mut lines {
        let Some(key) = env_key_from_line(line) else {
            continue;
        };
        let Some(value) = updates.get(&key) else {
            continue;
        };
        *line = format!("{key}={}", format_env_value(value)?);
        seen.insert(key);
    }
    let missing = SETUP_ENV_KEYS
        .iter()
        .filter(|key| updates.contains_key(**key) && !seen.contains(**key))
        .copied()
        .collect::<Vec<_>>();
    if !missing.is_empty() && lines.last().map(|line| !line.is_empty()).unwrap_or(false) {
        lines.push(String::new());
    }
    for key in missing {
        let value = updates.get(key).map(String::as_str).unwrap_or("");
        lines.push(format!("{key}={}", format_env_value(value)?));
    }
    Ok(format!("{}\n", lines.join("\n").trim_end_matches('\n')))
}

fn env_key_from_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let (key, _) = trimmed.split_once('=')?;
    let key = key.trim();
    let mut chars = key.chars();
    let first = chars.next()?;
    if !(first == '_' || first.is_ascii_alphabetic()) {
        return None;
    }
    if !chars.all(|char| char == '_' || char.is_ascii_alphanumeric()) {
        return None;
    }
    Some(key.into())
}

fn unquote_env(value: &str) -> String {
    if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
    {
        return value[1..value.len() - 1].into();
    }
    value.into()
}

fn first_env_value(values: &HashMap<String, String>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        values
            .get(*key)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn normalize_setup_url(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let parsed = Url::parse(trimmed).map_err(|_| format!("{label} must be a valid URL."))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(format!("{label} must use http or https."));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        Ok(trimmed.into())
    } else {
        Ok(trimmed.trim_end_matches('/').into())
    }
}

fn format_env_value(value: &str) -> Result<&str, String> {
    if value.contains('\n') || value.contains('\r') {
        return Err("Environment values cannot contain newlines.".into());
    }
    Ok(value)
}

fn redact_secret(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() <= 8 {
        return "configured".into();
    }
    format!("{}...{}", &trimmed[..4], &trimmed[trimmed.len() - 4..])
}

fn redact_url_secret(value: &str) -> String {
    let Ok(mut url) = Url::parse(value) else {
        return redact_secret(value);
    };
    let pairs = url
        .query_pairs()
        .map(|(key, value)| {
            let key_string = key.to_string();
            let value_string = value.to_string();
            if is_secret_query_key(&key_string) {
                let suffix_start = value_string.len().saturating_sub(4);
                (key_string, format!("...{}", &value_string[suffix_start..]))
            } else {
                (key_string, value_string)
            }
        })
        .collect::<Vec<_>>();
    if !pairs.is_empty() {
        let mut query = url.query_pairs_mut();
        query.clear();
        for (key, value) in pairs {
            query.append_pair(&key, &value);
        }
    }
    let _ = url.set_username(if url.username().is_empty() { "" } else { "..." });
    let _ = url.set_password(url.password().map(|_| "..."));
    url.to_string()
}

fn is_secret_query_key(key: &str) -> bool {
    let normalized = key.replace(['-', '_'], "").to_ascii_lowercase();
    matches!(normalized.as_str(), "apikey" | "key" | "token")
}

fn temp_env_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(".env");
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    path.with_file_name(format!("{file_name}.{}.{}.tmp", std::process::id(), millis))
}

fn set_private_file_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = fs::metadata(path) {
            let mut permissions = metadata.permissions();
            permissions.set_mode(0o600);
            let _ = fs::set_permissions(path, permissions);
        }
    }
}

fn default_config() -> DesktopConfig {
    let repo_root = default_repo_root();
    let data_dir = runtime_data_dir();
    DesktopConfig {
        repo_root: display_path(&repo_root),
        bridge_url: DEFAULT_BRIDGE_URL.into(),
        bridge_token: generated_bridge_token(),
        env_path: data_dir.join(".env").display().to_string(),
        action_config_path: data_dir
            .join("agent-wallet.config.json")
            .display()
            .to_string(),
        prepared_actions_path: data_dir.join("prepared-actions.json").display().to_string(),
    }
}

fn default_repo_root() -> PathBuf {
    let candidate = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")))
        .to_path_buf();
    if candidate.join("package.json").is_file() {
        candidate
    } else {
        PathBuf::new()
    }
}

fn desktop_config_path() -> PathBuf {
    desktop_config_dir().join("desktop-config.json")
}

fn secure_store_path() -> PathBuf {
    desktop_config_dir().join("desktop-secure.json")
}

fn desktop_wallet_path() -> PathBuf {
    desktop_config_dir().join("desktop-wallet.json")
}

fn load_secure_store() -> HashMap<String, String> {
    load_secure_store_at(&secure_store_path())
}

fn save_secure_store(store: &HashMap<String, String>) -> Result<(), String> {
    save_secure_store_at(store, &secure_store_path())
}

fn load_secure_store_at(path: &Path) -> HashMap<String, String> {
    if !path.is_file() {
        return HashMap::new();
    }
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str::<HashMap<String, String>>(&raw).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

fn save_secure_store_at(store: &HashMap<String, String>, path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create {}: {err}", parent.display()))?;
    }
    let raw = serde_json::to_string(store)
        .map_err(|err| format!("Failed to encode secure store: {err}"))?;
    fs::write(path, raw)
        .map_err(|err| format!("Failed to write {}: {err}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path)
            .map_err(|err| format!("Failed to stat {}: {err}", path.display()))?
            .permissions();
        perms.set_mode(0o600);
        let _ = fs::set_permissions(path, perms);
    }
    Ok(())
}

fn desktop_config_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        return PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
            .join("Library/Application Support/Agentic");
    }
    if cfg!(target_os = "windows") {
        return PathBuf::from(std::env::var("APPDATA").unwrap_or_else(|_| ".".into()))
            .join("Agentic");
    }
    let base = std::env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join(".config")
        });
    base.join("agentic")
}

fn runtime_data_dir() -> PathBuf {
    if cfg!(target_os = "windows") {
        return PathBuf::from(std::env::var("APPDATA").unwrap_or_else(|_| ".".into()))
            .join("Solana Agent Wallet");
    }
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join(".solana-agent-wallet")
}

/// Build a PATH for the bridge subprocess that includes the user's common CLI install dirs, so the
/// connector binaries (codex/claude/gemini) resolve even when the app is launched from Finder/Dock
/// (which gives a minimal PATH). Inherited entries keep highest precedence; the well-known install
/// dirs are appended after, de-duplicated and order-preserving. macOS/Linux only.
#[cfg(not(target_os = "windows"))]
fn augmented_path() -> String {
    augment_path_with(
        std::env::var("PATH").unwrap_or_default(),
        std::env::var("HOME").ok().as_deref(),
    )
}

// Pure core of augmented_path() (no env reads), so it can be unit-tested deterministically.
#[cfg(not(target_os = "windows"))]
fn augment_path_with(existing: String, home: Option<&str>) -> String {
    let mut all: Vec<String> = existing.split(':').map(|s| s.to_string()).collect();
    all.extend([
        "/opt/homebrew/bin".to_string(),
        "/opt/homebrew/sbin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/local/sbin".to_string(),
    ]);
    if let Some(home) = home.filter(|h| !h.is_empty()) {
        all.extend([
            format!("{home}/.local/bin"),
            format!("{home}/.cargo/bin"),
            format!("{home}/.npm-global/bin"),
            format!("{home}/.local/share/pnpm"),
            format!("{home}/.bun/bin"),
            format!("{home}/.deno/bin"),
        ]);
    }
    let mut seen: HashSet<String> = HashSet::new();
    let mut ordered: Vec<String> = Vec::new();
    for dir in all {
        if !dir.is_empty() && seen.insert(dir.clone()) {
            ordered.push(dir);
        }
    }
    ordered.join(":")
}

fn bridge_endpoint_reachable(url: &str) -> bool {
    endpoint_reachable(url, 8787, Duration::from_millis(150))
}

fn endpoint_reachable(url: &str, default_port: u16, timeout: Duration) -> bool {
    let Some((host, port)) = host_port(url, default_port) else {
        return false;
    };
    let Ok(mut addrs) = (host.as_str(), port).to_socket_addrs() else {
        return false;
    };
    let Some(addr) = addrs.next() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, timeout).is_ok()
}

fn wait_for_bridge_endpoint(url: &str, timeout: Duration) -> bool {
    wait_for_endpoint(url, 8787, timeout)
}

fn wait_for_endpoint(url: &str, default_port: u16, timeout: Duration) -> bool {
    let start = SystemTime::now();
    loop {
        if endpoint_reachable(url, default_port, Duration::from_millis(150)) {
            return true;
        }
        if start.elapsed().unwrap_or_default() >= timeout {
            return false;
        }
        thread::sleep(Duration::from_millis(150));
    }
}

fn host_port(url: &str, default_port: u16) -> Option<(String, u16)> {
    let parsed = Url::parse(url).ok()?;
    let host = parsed
        .host_str()?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let port = parsed.port().unwrap_or(default_port);
    Some((host, port))
}

fn host_port_or_default(url: &str, default_port: u16) -> (String, u16) {
    host_port(url, default_port).unwrap_or_else(|| ("127.0.0.1".into(), default_port))
}

/// Scan upward from `start` for a port that `host` can bind right now. The
/// desktop must own its bridge process — port-reachability alone doesn't prove
/// identity (a CLI bridge, an orphaned tauri:dev, etc. could be holding the
/// configured port with a different token, causing every /bridge/* request to
/// return 401). Picking a free port lets us spawn our own next to any stale
/// listener instead of fighting it. Bind-and-drop is a momentary "free now?"
/// probe — a small TOCTOU window remains before the bridge re-binds, which is
/// acceptable for local dev.
fn find_available_port(host: &str, start: u16, max_attempts: u16) -> Option<u16> {
    let addr_host = if host == "localhost" { "127.0.0.1" } else { host };
    for offset in 0..max_attempts {
        let port = start.checked_add(offset)?;
        if std::net::TcpListener::bind((addr_host, port)).is_ok() {
            return Some(port);
        }
    }
    None
}

fn now_isoish() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{seconds}")
}

fn generated_bridge_token() -> String {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).expect("OS randomness is required for the bridge token");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sidecar_filename() -> &'static str {
    if cfg!(target_os = "windows") {
        "agentic-cli-sidecar.exe"
    } else {
        SIDECAR_BASENAME
    }
}

fn sidecar_target_filename(target_triple: &str) -> String {
    let extension = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };
    format!("{SIDECAR_BASENAME}-{target_triple}{extension}")
}

fn current_target_triple() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else {
        "x86_64-unknown-linux-gnu"
    }
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut deduped = Vec::new();
    for path in paths {
        if !deduped.iter().any(|existing| existing == &path) {
            deduped.push(path);
        }
    }
    deduped
}

fn display_path(path: &Path) -> String {
    path.display().to_string()
}

fn lock_error<T>(err: std::sync::PoisonError<T>) -> String {
    format!("Desktop runtime lock poisoned: {err}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_config() -> DesktopConfig {
        DesktopConfig {
            repo_root: "/repo".into(),
            bridge_url: "http://127.0.0.1:8787".into(),
            bridge_token: "test-token".into(),
            env_path: "/runtime/.env".into(),
            action_config_path: "/runtime/agent-wallet.config.json".into(),
            prepared_actions_path: "/runtime/prepared-actions.json".into(),
        }
    }

    fn fixture_config_in(dir: &Path) -> DesktopConfig {
        DesktopConfig {
            repo_root: "/repo".into(),
            bridge_url: "http://127.0.0.1:8787".into(),
            bridge_token: "test-token".into(),
            env_path: dir.join("env/.env").display().to_string(),
            action_config_path: dir
                .join("config/agent-wallet.config.json")
                .display()
                .to_string(),
            prepared_actions_path: dir
                .join("actions/prepared-actions.json")
                .display()
                .to_string(),
        }
    }

    fn has_arg_pair(args: &[String], key: &str, value: &str) -> bool {
        args.windows(2)
            .any(|pair| pair[0] == key && pair[1] == value)
    }

    #[test]
    fn default_config_generates_private_bridge_token() {
        let config = default_config();
        assert_ne!(config.bridge_token, LEGACY_BRIDGE_TOKEN);
        assert_eq!(config.bridge_token.len(), 48);
    }

    #[test]
    fn normalize_config_rotates_legacy_bridge_token() {
        let mut config = fixture_config();
        config.bridge_token = LEGACY_BRIDGE_TOKEN.into();

        let normalized = normalize_config(config);

        assert_ne!(normalized.bridge_token, LEGACY_BRIDGE_TOKEN);
        assert_eq!(normalized.bridge_token.len(), 48);
    }

    #[test]
    fn parses_endpoint_urls_with_default_ports_and_ipv6() {
        assert_eq!(
            host_port_or_default("http://127.0.0.1", 8787),
            ("127.0.0.1".into(), 8787)
        );
        assert_eq!(
            host_port_or_default("http://[::1]:5174/wallet", 8787),
            ("::1".into(), 5174)
        );
        assert_eq!(
            host_port_or_default("not a url", 8787),
            ("127.0.0.1".into(), 8787)
        );
    }

    #[test]
    fn find_available_port_skips_a_busy_port() {
        // Hold a port to simulate a stale bridge / CLI on the configured port.
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
            .expect("OS should grant a free loopback port for the test");
        let busy_port = listener.local_addr().unwrap().port();

        let chosen = find_available_port("127.0.0.1", busy_port, 50)
            .expect("a free port should exist within 50 of the busy one");
        assert_ne!(chosen, busy_port);
        assert!(chosen > busy_port);
        assert!(chosen <= busy_port.saturating_add(50));

        drop(listener);
    }

    #[test]
    fn find_available_port_normalizes_localhost_to_loopback() {
        let chosen = find_available_port("localhost", 0, 1)
            .expect("binding to port 0 should always succeed");
        // Port 0 makes the OS pick an available ephemeral port; we just care
        // the alias didn't break the bind call.
        assert!(chosen == 0 || chosen > 0);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn augment_path_appends_common_dirs_without_duplicates() {
        // A Finder-launched minimal PATH that already happens to include one of the dirs we append.
        let path = augment_path_with("/usr/bin:/opt/homebrew/bin".to_string(), Some("/home/u"));
        let entries: Vec<&str> = path.split(':').collect();
        // Inherited entries stay first and keep precedence.
        assert_eq!(entries[0], "/usr/bin");
        // Common install dirs (Homebrew, /usr/local) are present.
        assert!(entries.contains(&"/opt/homebrew/bin"));
        assert!(entries.contains(&"/usr/local/bin"));
        // The home-relative dirs are expanded from HOME.
        assert!(entries.contains(&"/home/u/.local/bin"));
        assert!(entries.contains(&"/home/u/.local/share/pnpm"));
        // The already-present /opt/homebrew/bin is not duplicated.
        assert_eq!(entries.iter().filter(|e| **e == "/opt/homebrew/bin").count(), 1);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn augment_path_skips_home_dirs_when_home_is_absent() {
        let path = augment_path_with("/usr/bin".to_string(), None);
        assert!(path.split(':').all(|entry| !entry.contains("/.local/bin")));
        assert!(path.split(':').any(|entry| entry == "/usr/local/bin"));
    }

    #[test]
    fn sidecar_args_match_cli_sidecar_contract() {
        let args = sidecar_command_args(["bridge", "serve"], &fixture_config());
        assert_eq!(args[0], "bridge");
        assert_eq!(args[1], "serve");
        assert!(has_arg_pair(
            &args,
            "--runtime-dir",
            &display_path(&runtime_data_dir())
        ));
        assert!(has_arg_pair(&args, "--bridge-url", "http://127.0.0.1:8787"));
        assert!(has_arg_pair(&args, "--token", "test-token"));
        assert!(!args.iter().any(|arg| arg == "--wallet-host-dir"));
    }

    #[test]
    fn bridge_runtime_files_create_missing_dirs_and_default_config() {
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let config = fixture_config_in(dir.path());
        let action_config_path = Path::new(&config.action_config_path);
        let env_parent = Path::new(&config.env_path).parent().unwrap();
        let prepared_parent = Path::new(&config.prepared_actions_path).parent().unwrap();

        let messages = ensure_bridge_runtime_files(&config)
            .expect("runtime files should be prepared");

        assert!(env_parent.is_dir());
        assert!(prepared_parent.is_dir());
        let raw = fs::read_to_string(action_config_path).expect("action config should exist");
        let value: serde_json::Value =
            serde_json::from_str(&raw).expect("action config should be valid JSON");
        assert_eq!(value["cluster"], "mainnet-beta");
        assert_eq!(value["mainnet"]["enabled"], true);
        assert_eq!(messages.len(), 1);
        assert!(messages[0].contains("created default action config"));
        assert!(messages[0].contains(&config.action_config_path));
    }

    #[test]
    fn bridge_runtime_files_migrate_clusterless_action_config() {
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let config = fixture_config_in(dir.path());
        let action_config_path = Path::new(&config.action_config_path);
        fs::create_dir_all(action_config_path.parent().unwrap())
            .expect("config parent should be created");
        fs::write(action_config_path, "{}\n").expect("legacy empty config should be written");

        let messages = ensure_bridge_runtime_files(&config)
            .expect("runtime files should be prepared");

        let raw = fs::read_to_string(action_config_path).expect("action config should exist");
        let value: serde_json::Value =
            serde_json::from_str(&raw).expect("action config should be valid JSON");
        assert_eq!(value["cluster"], "mainnet-beta");
        assert_eq!(value["mainnet"]["enabled"], true);
        assert_eq!(messages.len(), 1);
        assert!(messages[0].contains("migrated action config to mainnet-beta"));
    }

    #[test]
    fn bridge_runtime_files_preserve_existing_action_config() {
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let config = fixture_config_in(dir.path());
        let action_config_path = Path::new(&config.action_config_path);
        fs::create_dir_all(action_config_path.parent().unwrap())
            .expect("config parent should be created");
        fs::write(action_config_path, "{\"cluster\":\"devnet\"}\n")
            .expect("existing config should be written");

        let messages = ensure_bridge_runtime_files(&config)
            .expect("runtime files should be prepared");

        assert!(messages.is_empty());
        assert_eq!(
            fs::read_to_string(action_config_path).expect("action config should remain"),
            "{\"cluster\":\"devnet\"}\n"
        );
    }

    #[test]
    fn bridge_runtime_files_report_unwritable_action_config() {
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let mut config = fixture_config_in(dir.path());
        let directory_path = dir.path().join("config-directory");
        fs::create_dir_all(&directory_path).expect("directory path should be created");
        config.action_config_path = directory_path.display().to_string();

        let err = ensure_bridge_runtime_files(&config)
            .expect_err("directory action config path should fail");

        assert!(err.contains("Failed to write"));
        assert!(err.contains(&config.action_config_path));
    }

    #[test]
    fn env_updates_preserve_unrelated_values_and_write_aliases() {
        let raw = "CUSTOM_VALUE=kept\nJUPITER_API_KEY=old\n";
        let mut updates = HashMap::new();
        updates.insert(
            "SOLANA_RPC_URL".into(),
            "https://mainnet.helius-rpc.com/?api-key=rpc-secret".into(),
        );
        updates.insert(
            "HELIUS_RPC_URL".into(),
            "https://mainnet.helius-rpc.com/?api-key=rpc-secret".into(),
        );
        updates.insert("JUPITER_API_KEY".into(), "jupiter-secret".into());
        updates.insert("JUP_API_KEY".into(), "jupiter-secret".into());
        updates.insert("JUPITER_SWAP_BASE_URL".into(), DEFAULT_JUPITER_ULTRA_BASE.into());
        updates.insert("JUP_ULTRA_BASE".into(), DEFAULT_JUPITER_ULTRA_BASE.into());
        updates.insert("JUPITER_API_URL".into(), DEFAULT_JUPITER_API_URL.into());
        updates.insert("AGENTIC_AI_PROVIDER".into(), "openai".into());
        updates.insert("AGENTIC_AI_API_FORMAT".into(), "openai-compatible".into());
        updates.insert("AGENTIC_AI_API_KEY".into(), "ai-secret".into());
        updates.insert("AGENTIC_AI_MODEL".into(), "gpt-5".into());
        updates.insert("AGENTIC_AI_BASE_URL".into(), DEFAULT_AI_BASE_URL.into());

        let next = apply_env_updates(raw, &updates).expect("env update should succeed");

        assert!(next.contains("CUSTOM_VALUE=kept"));
        assert!(next.contains("JUPITER_API_KEY=jupiter-secret"));
        assert!(next.contains("JUP_API_KEY=jupiter-secret"));
        assert!(next.contains("SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=rpc-secret"));
        assert!(next.contains("HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=rpc-secret"));
        assert!(next.contains("AGENTIC_AI_API_KEY=ai-secret"));
        assert!(next.contains("AGENTIC_AI_MODEL=gpt-5"));
        assert!(next.contains("AGENTIC_AI_BASE_URL=https://api.openai.com/v1"));
    }

    #[test]
    fn setup_redaction_hides_keys() {
        let rpc = redact_url_secret("https://mainnet.helius-rpc.com/?api-key=rpc-secret-value");
        let key = redact_secret("jupiter-secret-value");

        assert!(!rpc.contains("rpc-secret-value"));
        assert!(!key.contains("secret-value"));
    }

    #[test]
    fn validate_open_url_accepts_allowed_schemes() {
        assert!(validate_open_url("https://agentic-signer.com/app").is_ok());
        assert!(validate_open_url("http://localhost:1234").is_ok());
        assert!(validate_open_url("agentic://callback?session=abc").is_ok());
        assert!(validate_open_url("phantom://browse?url=https%3A%2F%2Fexample.com").is_ok());
        assert!(validate_open_url("solflare://example").is_ok());
        // Slice F.1: per-brand WalletConnect deep-link buttons launch the
        // respective mobile apps via their custom URL schemes.
        assert!(validate_open_url("backpack://wc?uri=wc%3Atopic").is_ok());
        assert!(validate_open_url("jupiter://wc?uri=wc%3Atopic").is_ok());
        assert!(validate_open_url("magiceden://wc?uri=wc%3Atopic").is_ok());
        // Trimming preserves the URL.
        assert_eq!(validate_open_url("  https://example.com/  ").unwrap(), "https://example.com/");
    }

    #[test]
    fn validate_open_url_refuses_dangerous_schemes() {
        assert!(validate_open_url("file:///etc/passwd").is_err());
        assert!(validate_open_url("javascript:alert(1)").is_err());
        assert!(validate_open_url("data:text/html,<script>alert(1)</script>").is_err());
        assert!(validate_open_url("ftp://example.com").is_err());
        assert!(validate_open_url("ssh://user@host").is_err());
        assert!(validate_open_url("").is_err());
        assert!(validate_open_url("   ").is_err());
        assert!(validate_open_url("not a url").is_err());
    }

    #[test]
    fn secure_store_round_trip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("secure.json");
        let mut store = load_secure_store_at(&path);
        assert!(store.is_empty());
        store.insert("alpha".into(), "AAA".into());
        store.insert("beta".into(), "BBB".into());
        save_secure_store_at(&store, &path).expect("save");
        let reloaded = load_secure_store_at(&path);
        assert_eq!(reloaded.get("alpha"), Some(&"AAA".into()));
        assert_eq!(reloaded.get("beta"), Some(&"BBB".into()));
    }

    #[cfg(unix)]
    #[test]
    fn secure_store_writes_restricted_permissions_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("secure.json");
        let mut store = HashMap::new();
        store.insert("k".into(), "v".into());
        save_secure_store_at(&store, &path).expect("save");
        let mode = fs::metadata(&path).expect("stat").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "secure store must be readable only by owner");
    }

    #[test]
    fn apply_env_updates_general_appends_arbitrary_keys() {
        let raw = "CUSTOM=kept\n";
        let mut updates = HashMap::new();
        updates.insert("HELIUS_API_KEY".into(), "helius-secret".into());
        updates.insert("COINGECKO_API_KEY".into(), "cg-secret".into());
        updates.insert("MAGICEDEN_API_KEY".into(), "me-secret".into());
        let next = apply_env_updates_general(raw, &updates).expect("update");
        assert!(next.contains("CUSTOM=kept"));
        assert!(next.contains("HELIUS_API_KEY=helius-secret"));
        assert!(next.contains("COINGECKO_API_KEY=cg-secret"));
        assert!(next.contains("MAGICEDEN_API_KEY=me-secret"));
    }

    #[test]
    fn apply_env_updates_general_preserves_unrelated_lines_and_comments() {
        let raw = "# header comment\nKEEP_ME=preserved\n\nANOTHER=also-kept\n";
        let mut updates = HashMap::new();
        updates.insert("NEW_KEY".into(), "new-value".into());
        let next = apply_env_updates_general(raw, &updates).expect("update");
        assert!(next.contains("# header comment"));
        assert!(next.contains("KEEP_ME=preserved"));
        assert!(next.contains("ANOTHER=also-kept"));
        assert!(next.contains("NEW_KEY=new-value"));
    }

    #[test]
    fn apply_env_updates_general_overwrites_existing_keys() {
        let raw = "HELIUS_API_KEY=old\nKEEP=preserved\n";
        let mut updates = HashMap::new();
        updates.insert("HELIUS_API_KEY".into(), "new".into());
        let next = apply_env_updates_general(raw, &updates).expect("update");
        assert!(next.contains("HELIUS_API_KEY=new"));
        assert!(!next.contains("HELIUS_API_KEY=old"));
        assert!(next.contains("KEEP=preserved"));
    }
}
