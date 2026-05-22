// Embedded Agentic Wallet — Tauri IPC surface.
//
// All wallet state lives in `state::WalletState`, held behind a `Mutex` in
// the shared runtime. The Tauri commands here are thin: lock the mutex, call
// the state method, return the result. Argument validation happens inside
// `state` so it's the same whether called from IPC or Rust tests.
//
// Slice A surface — no TS adapter consumes these yet. The commands are
// registered with the invoke handler so a later Slice B can drive them.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;

pub mod crypto;
pub mod keychain;
pub mod signer;
pub mod state;
pub mod store;

use crate::wallet::keychain::DeviceKeySource;
use crate::wallet::state::{WalletCreated, WalletState, WalletStatus, DEFAULT_AUTO_LOCK_SECS};

/// How often the background auto-lock watcher ticks. The wallet's own
/// auto-lock timeout is in minutes; ticking every 10 s gives sub-second
/// granularity around the configured timeout without burning CPU.
const AUTO_LOCK_WATCHER_INTERVAL: Duration = Duration::from_secs(10);

/// Mutex-wrapped wallet state. Held by Tauri via `app.manage()` separately
/// from `SharedRuntime` to keep the locking surfaces independent: a
/// long-running `argon2` derivation inside an unlock call should never
/// block bridge/status reads.
///
/// The inner `Arc<Mutex<_>>` lets a background watcher thread hold its own
/// reference to the same state — it ticks `maybe_auto_lock` every 10 s so
/// idle wallets lock even if the UI stops polling `wallet_status`.
///
/// `watcher_stop` lets the runtime ask the watcher thread to exit cleanly
/// on app shutdown. The OS would reap the thread on process exit anyway,
/// but explicit teardown is safer if Tauri ever ships hot-reload and lets
/// future code re-spawn the watcher without leaking the previous one.
pub struct WalletStateHandle {
    pub state: Arc<Mutex<WalletState>>,
    watcher_stop: Arc<AtomicBool>,
}

impl WalletStateHandle {
    pub fn new(state: WalletState) -> Self {
        Self {
            state: Arc::new(Mutex::new(state)),
            watcher_stop: Arc::new(AtomicBool::new(false)),
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, WalletState>, String> {
        self.state.lock().map_err(|err| format!("wallet state poisoned: {err}"))
    }

    /// Spawn a background thread that polls the wallet's auto-lock timer.
    /// Returns the join handle for the caller to drop on shutdown (or leak
    /// — the OS reaps the thread on process exit). Production calls this
    /// exactly once from `lib.rs::run` after the handle is built.
    ///
    /// **Not idempotent**: calling this twice spawns two watcher threads,
    /// both holding clones of the state `Arc`. They would race on the
    /// mutex but otherwise act independently — the only safety net is the
    /// shared `watcher_stop` flag, which would shut BOTH down at once.
    /// Future refactors that need re-spawn (e.g., hot-reload) should add a
    /// `OnceLock` guard here.
    ///
    /// The thread checks `watcher_stop` on every tick; calling
    /// [`Self::stop_watcher`] flips the flag so the next wake exits the
    /// loop instead of locking the state.
    pub fn spawn_auto_lock_watcher(&self) -> thread::JoinHandle<()> {
        let state = Arc::clone(&self.state);
        let stop = Arc::clone(&self.watcher_stop);
        thread::Builder::new()
            .name("wallet-auto-lock-watcher".into())
            .spawn(move || loop {
                thread::sleep(AUTO_LOCK_WATCHER_INTERVAL);
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                let Ok(mut guard) = state.lock() else { return };
                // `status()` triggers `maybe_auto_lock` internally. We drop
                // the result; we only care about the side effect.
                let _ = guard.status();
            })
            .expect("wallet auto-lock watcher thread spawn failed")
    }

    /// Signal the watcher thread to exit on its next wake (at most one
    /// `AUTO_LOCK_WATCHER_INTERVAL` from now). Safe to call multiple times;
    /// idempotent. Does not block — callers that need to confirm shutdown
    /// should join the handle returned by `spawn_auto_lock_watcher`.
    pub fn stop_watcher(&self) {
        self.watcher_stop.store(true, Ordering::Relaxed);
    }

    /// Clone the stop flag so callers can signal shutdown after the handle
    /// itself has been moved into Tauri's managed state. Used by
    /// `lib.rs::run`'s `RunEvent::Exit` path.
    pub fn watcher_stop_handle(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.watcher_stop)
    }
}

/// Build the production wallet state, using the OS keychain for the
/// device key. Called from `lib.rs::run()` during Tauri setup.
pub fn build_production_state(file_path: std::path::PathBuf) -> WalletState {
    WalletState::new(
        file_path,
        DeviceKeySource::os_keychain(),
        DEFAULT_AUTO_LOCK_SECS,
    )
}

// ────────────────────────────────────────────────────────────────────────
// Tauri commands
// ────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn wallet_status(
    handle: tauri::State<'_, WalletStateHandle>,
) -> Result<WalletStatus, String> {
    let mut state = handle.lock()?;
    state.status()
}

#[tauri::command]
pub fn wallet_create(
    handle: tauri::State<'_, WalletStateHandle>,
    password: String,
) -> Result<WalletCreated, String> {
    let mut state = handle.lock()?;
    state.create(&password)
}

#[tauri::command]
pub fn wallet_import(
    handle: tauri::State<'_, WalletStateHandle>,
    password: String,
    mnemonic: String,
) -> Result<WalletCreated, String> {
    let mut state = handle.lock()?;
    state.import(&password, &mnemonic)
}

#[tauri::command]
pub fn wallet_unlock(
    handle: tauri::State<'_, WalletStateHandle>,
    password: String,
) -> Result<WalletStatus, String> {
    let mut state = handle.lock()?;
    state.unlock(&password)
}

#[tauri::command]
pub fn wallet_lock(
    handle: tauri::State<'_, WalletStateHandle>,
) -> Result<WalletStatus, String> {
    let mut state = handle.lock()?;
    state.lock()
}

#[tauri::command]
pub fn wallet_change_password(
    handle: tauri::State<'_, WalletStateHandle>,
    old_password: String,
    new_password: String,
) -> Result<WalletStatus, String> {
    let mut state = handle.lock()?;
    state.change_password(&old_password, &new_password)
}

#[tauri::command]
pub fn wallet_sign_message(
    handle: tauri::State<'_, WalletStateHandle>,
    address: String,
    message_b64: String,
) -> Result<String, String> {
    let message = B64
        .decode(&message_b64)
        .map_err(|err| format!("message_b64 invalid: {err}"))?;
    let mut state = handle.lock()?;
    let sig = state.sign_message(&address, &message)?;
    Ok(B64.encode(sig))
}

#[tauri::command]
pub fn wallet_sign_transaction(
    handle: tauri::State<'_, WalletStateHandle>,
    address: String,
    transaction_b64: String,
) -> Result<String, String> {
    let tx_bytes = B64
        .decode(&transaction_b64)
        .map_err(|err| format!("transaction_b64 invalid: {err}"))?;
    let mut state = handle.lock()?;
    let sig = state.sign_transaction(&address, &tx_bytes)?;
    Ok(B64.encode(sig))
}

#[tauri::command]
pub fn wallet_set_auto_lock(
    handle: tauri::State<'_, WalletStateHandle>,
    seconds: u32,
) -> Result<WalletStatus, String> {
    let mut state = handle.lock()?;
    state.set_auto_lock(seconds)?;
    state.status()
}

#[tauri::command]
pub fn wallet_export_for_backup(
    handle: tauri::State<'_, WalletStateHandle>,
    password: String,
) -> Result<String, String> {
    let mut state = handle.lock()?;
    state.export_mnemonic(&password)
}

#[tauri::command]
pub fn wallet_delete(
    handle: tauri::State<'_, WalletStateHandle>,
    password: String,
) -> Result<WalletStatus, String> {
    let mut state = handle.lock()?;
    state.delete_wallet(&password)?;
    state.status()
}
