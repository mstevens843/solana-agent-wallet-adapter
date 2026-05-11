use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::{BufRead, BufReader, Read},
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use url::Url;

type SharedRuntime = Arc<Mutex<RuntimeState>>;

const DEFAULT_BRIDGE_URL: &str = "http://127.0.0.1:8787";
const LEGACY_BRIDGE_TOKEN: &str = "local-agent-wallet";
const DEFAULT_WALLET_HOST_URL: &str = "http://127.0.0.1:5174";
const SIDECAR_BASENAME: &str = "agentic-cli-sidecar";
const MAX_LOG_LINES: usize = 600;
const DEFAULT_JUPITER_ULTRA_BASE: &str = "https://api.jup.ag/ultra/v1";
const DEFAULT_JUPITER_API_URL: &str = "https://quote-api.jup.ag";
const DEFAULT_BIRDEYE_REST_BASE: &str = "https://public-api.birdeye.so";
const SETUP_ENV_KEYS: [&str; 8] = [
    "SOLANA_RPC_URL",
    "HELIUS_RPC_URL",
    "JUPITER_API_KEY",
    "JUP_API_KEY",
    "JUP_ULTRA_BASE",
    "JUPITER_API_URL",
    "BIRDEYE_API_KEY",
    "BIRDEYE_REST_BASE",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopConfig {
    repo_root: String,
    bridge_url: String,
    bridge_token: String,
    env_path: String,
    action_config_path: String,
    prepared_actions_path: String,
    wallet_host_url: String,
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
    wallet_host_running: bool,
    wallet_host_pid: Option<u32>,
    wallet_host_started_at: Option<String>,
    wallet_host_reachable: bool,
    bridge_url: String,
    bridge_token: String,
    wallet_host_url: String,
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
    wallet_host: Option<ManagedProcess>,
    logs: VecDeque<String>,
    last_error: Option<String>,
}

struct RuntimeContext {
    sidecar_path: Option<PathBuf>,
    sidecar_candidates: Vec<PathBuf>,
    repo_bridge_script: Option<PathBuf>,
    repo_wallet_host_dir: Option<PathBuf>,
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
    let runtime = Arc::new(Mutex::new(RuntimeState {
        config: load_config().unwrap_or_else(|_| default_config()),
        bridge: None,
        wallet_host: None,
        logs: VecDeque::new(),
        last_error: None,
    }));

    let cleanup_runtime = runtime.clone();
    let app = tauri::Builder::default()
        .manage(runtime)
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
            open_wallet_host,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Agentic desktop shell");

    app.run(move |_app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            cleanup_managed_processes(&cleanup_runtime);
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
    let mut runtime = state.lock().map_err(lock_error)?;
    refresh_child_state(&mut runtime);
    Ok(status_from_runtime(&app, &runtime))
}

#[tauri::command]
fn start_bridge(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedRuntime>,
) -> Result<BridgeStatus, String> {
    let shared = state.inner().clone();
    if ensure_bridge_reachable(&app, &shared).is_ok()
        && start_wallet_host_process(&app, &shared).is_ok()
    {
        clear_runtime_error_if_ready(&shared)?;
    }

    let mut runtime = shared.lock().map_err(lock_error)?;
    refresh_child_state(&mut runtime);
    Ok(status_from_runtime(&app, &runtime))
}

#[tauri::command]
fn stop_bridge(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedRuntime>,
) -> Result<BridgeStatus, String> {
    let mut runtime = state.lock().map_err(lock_error)?;
    stop_wallet_host_child(&mut runtime);
    stop_bridge_child(&mut runtime);
    trim_logs(&mut runtime.logs);
    Ok(status_from_runtime(&app, &runtime))
}

#[tauri::command]
fn restart_bridge(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedRuntime>,
) -> Result<BridgeStatus, String> {
    {
        let mut runtime = state.lock().map_err(lock_error)?;
        stop_wallet_host_child(&mut runtime);
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
fn open_wallet_host(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedRuntime>,
) -> Result<(), String> {
    let shared = state.inner().clone();
    ensure_bridge_reachable(&app, &shared)?;
    let launch_url = {
        let runtime = shared.lock().map_err(lock_error)?;
        wallet_host_launch_url(&runtime.config)
    };

    start_wallet_host_process(&app, &shared)?;
    clear_runtime_error_if_ready(&shared)?;
    open_url(&launch_url)
}

fn ensure_bridge_reachable(app: &tauri::AppHandle, shared: &SharedRuntime) -> Result<(), String> {
    let bridge_url = {
        let mut runtime = shared.lock().map_err(lock_error)?;
        refresh_child_state(&mut runtime);
        let bridge_url = runtime.config.bridge_url.clone();

        if runtime.bridge.is_none() && !bridge_endpoint_reachable(&bridge_url) {
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

        bridge_url
    };

    if wait_for_bridge_endpoint(&bridge_url, Duration::from_secs(8)) {
        Ok(())
    } else {
        let err = format!("Bridge did not become reachable at {bridge_url}.");
        record_runtime_error(shared, err.clone())?;
        Err(err)
    }
}

fn start_wallet_host_process(app: &tauri::AppHandle, shared: &SharedRuntime) -> Result<(), String> {
    let wallet_host_url = {
        let mut runtime = shared.lock().map_err(lock_error)?;
        refresh_child_state(&mut runtime);
        if runtime.wallet_host.is_some()
            || wallet_host_endpoint_reachable(&runtime.config.wallet_host_url)
        {
            return Ok(());
        }

        match wallet_host_launch_command(app, &runtime.config) {
            Ok(command) => {
                match spawn_managed_process(shared, &mut runtime, "wallet-host", command) {
                    Ok(process) => {
                        runtime.logs.push_back(format!(
                            "[desktop] wallet host started pid={}",
                            process.pid
                        ));
                        runtime.wallet_host = Some(process);
                        runtime.last_error = None;
                        trim_logs(&mut runtime.logs);
                        runtime.config.wallet_host_url.clone()
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
    };

    if wait_for_wallet_host_endpoint(&wallet_host_url, Duration::from_secs(6)) {
        Ok(())
    } else {
        let err = format!("Wallet host did not become reachable at {wallet_host_url}.");
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
    let (bridge_url, wallet_host_url) = {
        let runtime = shared.lock().map_err(lock_error)?;
        (
            runtime.config.bridge_url.clone(),
            runtime.config.wallet_host_url.clone(),
        )
    };
    if bridge_endpoint_reachable(&bridge_url) && wallet_host_endpoint_reachable(&wallet_host_url) {
        let mut runtime = shared.lock().map_err(lock_error)?;
        runtime.last_error = None;
    }
    Ok(())
}

fn status_from_runtime(app: &tauri::AppHandle, runtime: &RuntimeState) -> BridgeStatus {
    let context = runtime_context(app, &runtime.config);
    let bridge_reachable = bridge_endpoint_reachable(&runtime.config.bridge_url);
    let wallet_host_reachable = wallet_host_endpoint_reachable(&runtime.config.wallet_host_url);
    BridgeStatus {
        running: runtime.bridge.is_some(),
        pid: runtime.bridge.as_ref().map(|process| process.pid),
        started_at: runtime
            .bridge
            .as_ref()
            .map(|process| process.started_at.clone()),
        bridge_reachable,
        wallet_host_running: runtime.wallet_host.is_some(),
        wallet_host_pid: runtime.wallet_host.as_ref().map(|process| process.pid),
        wallet_host_started_at: runtime
            .wallet_host
            .as_ref()
            .map(|process| process.started_at.clone()),
        wallet_host_reachable,
        bridge_url: runtime.config.bridge_url.clone(),
        bridge_token: runtime.config.bridge_token.clone(),
        wallet_host_url: runtime.config.wallet_host_url.clone(),
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
            runtime.wallet_host.is_some(),
            bridge_reachable,
            wallet_host_reachable,
            runtime.last_error.as_deref(),
        ),
        last_error: runtime.last_error.clone(),
    }
}

fn refresh_child_state(runtime: &mut RuntimeState) {
    refresh_bridge_child(runtime);
    refresh_wallet_host_child(runtime);
    trim_logs(&mut runtime.logs);
}

fn refresh_bridge_child(runtime: &mut RuntimeState) {
    if let Some(event) = refresh_process_slot(&mut runtime.bridge, "bridge") {
        record_process_event(runtime, event);
    }
}

fn refresh_wallet_host_child(runtime: &mut RuntimeState) {
    if let Some(event) = refresh_process_slot(&mut runtime.wallet_host, "wallet host") {
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
            ensure_runtime_dirs(&runtime.config)?;
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

fn stop_wallet_host_child(runtime: &mut RuntimeState) {
    if let Some(event) = stop_process_slot(&mut runtime.wallet_host, "wallet host") {
        record_process_event(runtime, event);
    }
}

fn cleanup_managed_processes(shared: &SharedRuntime) {
    if let Ok(mut runtime) = shared.lock() {
        stop_wallet_host_child(&mut runtime);
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
        if let Err(err) = process.child.kill() {
            error = Some(format!("Failed to stop {label} pid={pid}: {err}"));
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

fn wallet_host_launch_command(
    app: &tauri::AppHandle,
    config: &DesktopConfig,
) -> Result<LaunchCommand, String> {
    let context = runtime_context(app, config);
    if let Some(sidecar) = context.sidecar_path {
        let args = sidecar_command_args(["wallet-host", "serve"], config);
        return Ok(LaunchCommand::Sidecar {
            executable: sidecar,
            args,
        });
    }

    if let Some(wallet_host_dir) = context.repo_wallet_host_dir {
        let (host, port) = host_port_or_default(&config.wallet_host_url, 5174);
        return Ok(LaunchCommand::RepoDev {
            executable: "pnpm".into(),
            args: vec![
                "-F".into(),
                "@solana-agent-wallet-adapter/browser-demo".into(),
                "exec".into(),
                "vite".into(),
                "--host".into(),
                host,
                "--port".into(),
                port.to_string(),
                "--strictPort".into(),
            ],
            cwd: wallet_host_dir
                .ancestors()
                .nth(2)
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from(&config.repo_root)),
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
        "--wallet-host-url".into(),
        config.wallet_host_url.clone(),
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
    wallet_host_running: bool,
    bridge_reachable: bool,
    wallet_host_reachable: bool,
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
    } else if context.repo_bridge_script.is_some() || context.repo_wallet_host_dir.is_some() {
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
    push_endpoint_diagnostic(
        &mut diagnostics,
        "Wallet host",
        &config.wallet_host_url,
        wallet_host_running,
        wallet_host_reachable,
        "managed by Agentic",
        "Open the browser wallet host before connecting an extension wallet.",
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
    let repo_wallet_host_dir = if !repo_root.as_os_str().is_empty() {
        let path = repo_root.join("apps/browser-demo");
        path.join("package.json").is_file().then_some(path)
    } else {
        None
    };

    RuntimeContext {
        sidecar_path,
        sidecar_candidates,
        repo_bridge_script,
        repo_wallet_host_dir,
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
    } else if context.repo_bridge_script.is_some() || context.repo_wallet_host_dir.is_some() {
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

fn normalize_config(mut config: DesktopConfig) -> DesktopConfig {
    let defaults = default_config();
    if config.repo_root.trim().is_empty() {
        config.repo_root = defaults.repo_root;
    }
    if config.bridge_url.trim().is_empty() {
        config.bridge_url = DEFAULT_BRIDGE_URL.into();
    }
    if config.bridge_token.trim().is_empty() || config.bridge_token == LEGACY_BRIDGE_TOKEN {
        config.bridge_token = generated_bridge_token();
    }
    if config.wallet_host_url.trim().is_empty() {
        config.wallet_host_url = DEFAULT_WALLET_HOST_URL.into();
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

fn runtime_setup_for_config(config: &DesktopConfig) -> Result<RuntimeSetup, String> {
    let path = Path::new(&config.env_path);
    let (env_found, values) = read_env_values(path)?;
    let rpc_url = first_env_value(&values, &["SOLANA_RPC_URL", "HELIUS_RPC_URL"]);
    let jupiter_api_key = first_env_value(&values, &["JUPITER_API_KEY", "JUP_API_KEY"]);
    let jupiter_ultra_base = values
        .get("JUP_ULTRA_BASE")
        .filter(|value| !value.trim().is_empty())
        .cloned()
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
    let rpc_url_configured = rpc_url.is_some();
    let jupiter_api_key_configured = jupiter_api_key.is_some();
    let birdeye_api_key_configured = birdeye_api_key.is_some();
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
        .or_else(|| values.get("JUP_ULTRA_BASE").cloned())
        .unwrap_or_else(|| DEFAULT_JUPITER_ULTRA_BASE.into());
    updates.insert(
        "JUP_ULTRA_BASE".into(),
        normalize_setup_url(&jupiter_ultra_base, "Jupiter Ultra base URL")?,
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
        wallet_host_url: DEFAULT_WALLET_HOST_URL.into(),
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

fn wallet_host_launch_url(config: &DesktopConfig) -> String {
    let separator = if config.wallet_host_url.contains('?') {
        '&'
    } else {
        '?'
    };
    format!(
        "{}{}bridgeUrl={}&token={}",
        config.wallet_host_url,
        separator,
        url_encode(&config.bridge_url),
        url_encode(&config.bridge_token),
    )
}

fn bridge_endpoint_reachable(url: &str) -> bool {
    endpoint_reachable(url, 8787, Duration::from_millis(150))
}

fn wallet_host_endpoint_reachable(url: &str) -> bool {
    endpoint_reachable(url, 5174, Duration::from_millis(150))
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

fn wait_for_wallet_host_endpoint(url: &str, timeout: Duration) -> bool {
    wait_for_endpoint(url, 5174, timeout)
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

fn open_url(url: &str) -> Result<(), String> {
    let status = if cfg!(target_os = "macos") {
        Command::new("open").arg(url).status()
    } else if cfg!(target_os = "windows") {
        Command::new("cmd").args(["/C", "start", "", url]).status()
    } else {
        Command::new("xdg-open").arg(url).status()
    }
    .map_err(|err| format!("Failed to open wallet host in the external browser: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Open wallet host exited with status {status}"))
    }
}

fn url_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
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
            wallet_host_url: "http://127.0.0.1:5174".into(),
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
    fn wallet_host_launch_url_preserves_external_approval_query() {
        let mut config = fixture_config();
        config.wallet_host_url = "http://127.0.0.1:5174/?screen=connect".into();

        let url = wallet_host_launch_url(&config);
        assert!(url.starts_with("http://127.0.0.1:5174/?screen=connect&"));
        assert!(url.contains("bridgeUrl=http%3A%2F%2F127.0.0.1%3A8787"));
        assert!(url.contains("token=test-token"));
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
        updates.insert("JUP_ULTRA_BASE".into(), DEFAULT_JUPITER_ULTRA_BASE.into());
        updates.insert("JUPITER_API_URL".into(), DEFAULT_JUPITER_API_URL.into());

        let next = apply_env_updates(raw, &updates).expect("env update should succeed");

        assert!(next.contains("CUSTOM_VALUE=kept"));
        assert!(next.contains("JUPITER_API_KEY=jupiter-secret"));
        assert!(next.contains("JUP_API_KEY=jupiter-secret"));
        assert!(next.contains("SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=rpc-secret"));
        assert!(next.contains("HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=rpc-secret"));
    }

    #[test]
    fn setup_redaction_hides_keys() {
        let rpc = redact_url_secret("https://mainnet.helius-rpc.com/?api-key=rpc-secret-value");
        let key = redact_secret("jupiter-secret-value");

        assert!(!rpc.contains("rpc-secret-value"));
        assert!(!key.contains("secret-value"));
    }
}
