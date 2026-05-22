# Agentic Desktop

Agentic Desktop is the native runtime for the Solana Agent Wallet Adapter. It embeds the full Agentic workspace (browser-demo) inside a Tauri 2 window and adds desktop-only capabilities — system-managed cloud session storage, OS notifications, single-instance focus, and the `agentic://` deep-link scheme. Bridge/MCP services run as a sidecar Node process; wallets are connected via Wallet Standard providers that inject into the Tauri webview.

## Install

Download the installer for your platform from GitHub Releases:

- macOS Apple Silicon: `agentic-desktop-macos-arm64.dmg`
- macOS Intel: `agentic-desktop-macos-x64.dmg`
- Windows x64: `agentic-desktop-windows-x64.msi`
- Linux x64: `agentic-desktop-linux-x64.AppImage`

The installer bundles a CLI sidecar (`solana-agent-wallet`) used to run the local MCP bridge at `http://127.0.0.1:8787`.

## First Run

1. Launch Agentic.
2. Sign in to Agentic Cloud from **Preferences → Workspace** (recommended). The cloud session unlocks Skills, Streaming Sessions, Recurring schedules with auto-execute, agent profiles, and webhook notifications. You can skip this and operate against the local bridge only.
3. Connect a wallet from the wallet picker. **Wallet support today**: only Wallet Standard desktop wallets that inject globally (Backpack Desktop, Glow Desktop) work inside the Tauri webview. Browser-extension wallets (Phantom, Solflare extensions) do **not** inject into Tauri webviews — for those, the wallet picker's "Open agentic-signer.com in browser" button takes you to the cloud app where extensions work normally. A full deep-link relay so Phantom/Solflare extension users can sign from inside the Tauri window is planned for a follow-up release (it requires the matching `/api/desktop-bridge` endpoint on render-web).
4. Approve actions from the **Inbox** tab. Recurring, streaming sessions, skills, and prepared connector actions all flow through the same approval surface.

For local-only operation (no cloud session), the **Preferences → Access → Local runtime** panel lets you write BYO API keys (RPC, Helius, Birdeye, CoinGecko, Jupiter, Magic Eden, Tensor, Sanctum) directly to the bridge's `.env` file. Keys saved here never leave your machine.

## What's inside

The Tauri window loads the same UI that ships at https://agentic-signer.com — every connector tab (Jupiter, Drift, Kamino, Lulo, MarginFi, Save, Project0, Marinade, Jito, Sanctum, Magic Eden, Tensor, Raydium, Orca, Meteora, Realms, Squads, Phoenix, Pyth, Wormhole), Skills marketplace, Recurring schedules, Streaming Sessions, Agent Protocols (AP2/ACP/MPP), Preferences, and the on-device AI runtime.

Desktop-specific extensions:

- **Encrypted local storage** for the cloud session token (`desktop-secure.json` in your platform app data directory, file mode `0600` on Unix).
- **`agentic://` URL scheme** registered with the OS for future wallet-return relays.
- **OS notifications** when an approval is ready or a recurring/streaming/skill event fires.
- **Single-instance** — a second launch focuses the existing window instead of opening a new one.
- **Generic env writer** — `read_env_keys`/`write_env_keys` IPC commands let the Preferences UI manage any local `.env` value (Helius, CoinGecko, Magic Eden, Tensor, Sanctum, etc.) without code changes.

## Runtime files

Agentic Desktop writes to two locations:

- **Desktop config** (per-user app config):
  - macOS: `~/Library/Application Support/Agentic/`
  - Windows: `%APPDATA%\Agentic\`
  - Linux: `$XDG_CONFIG_HOME/agentic` (or `~/.config/agentic`)
  - Files: `desktop-config.json`, `desktop-secure.json`
- **Bridge runtime data** (CLI-compatible):
  - Unix: `~/.solana-agent-wallet/`
  - Windows: `%APPDATA%\Solana Agent Wallet\`
  - Files: `agent-wallet.config.json`, `.env`, `prepared-actions/`, `lab-artifacts/`

The bundled CLI sidecar generates a conservative default `agent-wallet.config.json` on first run; mainnet actions remain disabled by default.

## Development

```sh
# In the repo root
pnpm install

# Run the Tauri shell against the browser-demo dev server (port 5174)
pnpm -F @solana-agent-wallet-adapter/desktop-shell tauri:dev

# Or run browser-demo standalone in a plain browser
pnpm -F @solana-agent-wallet-adapter/desktop-shell dev
```

The Rust crate (`src-tauri/`) needs the Tauri CLI:

```sh
cargo install tauri-cli --version '^2'
```

For a release-style local build, stage a platform sidecar at:

```text
apps/desktop-shell/src-tauri/target/sidecars/agentic-cli-sidecar-<target-triple>
```

Use `.exe` for the Windows target. Then build with the release overlay:

```sh
pnpm -F @solana-agent-wallet-adapter/desktop-shell tauri:build -- --config src-tauri/tauri.release.conf.json
```

macOS DMG packaging uses `hdiutil`, so local release builds must run outside sandboxed shells that block the disk image helper. GitHub Actions runners satisfy this requirement.

## Release Checklist

1. Push a `v*` tag that matches the desktop package/Tauri/Cargo version.
2. Let `cli-release` publish the CLI npm package and standalone archives first. The desktop workflow waits for those archives and stages the matching CLI sidecar.
3. Confirm the release contains exactly these desktop installers:
   `agentic-desktop-macos-arm64.dmg`, `agentic-desktop-macos-x64.dmg`, `agentic-desktop-windows-x64.msi`, and `agentic-desktop-linux-x64.AppImage`.
4. Confirm `android release` finishes its live release verifier so every advertised download URL is reachable.

## Architecture notes

The Tauri webview (`frontendDist: "../../browser-demo/dist"`) loads the same Vite bundle the cloud serves. A small Rust surface in `src-tauri/src/lib.rs` exposes IPC commands for: bridge process lifecycle (`start_bridge`, `stop_bridge`, `restart_bridge`, `bridge_status`, `read_logs`), encrypted secure storage (`secure_get`, `secure_set`, `secure_delete`), local .env management (`read_env_keys`, `write_env_keys`), and external URL opening (`open_external_url`).

Browser-demo detects the Tauri host via `window.__TAURI_INTERNALS__` (see `apps/browser-demo/src/tauriNative.ts`) and routes cloud session storage and OS-level URL opens through these IPC commands. Cloud API calls go to `https://agentic-signer.com` (configurable via `VITE_AGENTIC_CLOUD_API_BASE_URL`); the fetch interceptor attaches the bearer token from secure storage.

### Native plugins

- `tauri-plugin-single-instance` — second launch focuses the existing window. Registered first so it intercepts before other plugins set up state.
- `tauri-plugin-deep-link` — `agentic://` URL scheme registered. A Rust-side listener (`setup` hook in `lib.rs`) forwards received URLs to the webview via the `agentic://deep-link` Tauri event.
- `tauri-plugin-notification` — webview-side `Notification` API.
- `tauri-plugin-shell` — webview can call `shell.open(url)` for `http(s)://`. The custom `open_external_url` Rust command additionally allows `agentic://`, `phantom://`, and `solflare://` deep links.

### Legacy files

`apps/desktop-shell/index.html`, `src/`, `vite.config.ts`, `tsconfig.json`, and `dist/` are unused after the Phase-1 architectural pivot (Tauri loads from `../../browser-demo/dist`). They are kept in the repository for future contributors to delete in a dedicated cleanup commit; no code path references them.

### Follow-ups

- `apps/render-web` should add `desktop-bundled` to its `shouldReturnBearerSession` client allowlist so the desktop bearer flow has full server-side parity. Today desktop relies on parsing `sessionToken` from the JSON response body (which already works).
- Full deep-link wallet relay for Phantom/Solflare extension users (`/api/desktop-bridge` endpoint).
- System tray with pending-approvals badge.
- Auto-updater wired to GitHub Releases.
- Native menu bar (File / Edit / View / Window / Help).
- Stronghold / OS keychain upgrade for `desktop-secure.json` (today's file-based store has 0600 permissions on Unix; Windows uses default user ACL).
