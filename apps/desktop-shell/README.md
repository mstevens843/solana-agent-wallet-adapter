# Agentic Desktop

Agentic is the desktop runtime for Solana Agent Wallet Adapter. It manages the local bridge and browser wallet host on your machine, while browser extension wallets such as Phantom, Solflare, and Backpack still handle the actual approval popups in the external browser.

## Install

Download the installer for your platform from GitHub Releases:

- macOS Apple Silicon: `agentic-desktop-macos-arm64.dmg`
- macOS Intel: `agentic-desktop-macos-x64.dmg`
- Windows x64: `agentic-desktop-windows-x64.msi`
- Linux x64: `agentic-desktop-linux-x64.AppImage`

The desktop installer includes a bundled CLI sidecar. The app uses that sidecar to run:

```sh
solana-agent-wallet bridge serve
solana-agent-wallet wallet-host serve
```

## First Run

1. Open Agentic.
2. Click `Start runtime`.
3. Click `Open browser wallet host`.
4. Connect your browser wallet in the external browser tab.
5. Return to Agentic to monitor health, approval inbox items, receipts, and runtime logs.

The Tauri window is not a replacement for a wallet approval surface. It starts and monitors the local services; signatures and transactions are still approved by your installed browser wallet.

## Runtime Files

Agentic stores its desktop settings in the platform app config directory and uses the CLI-compatible runtime data directory for Solana Agent Wallet Adapter files:

- Unix runtime data: `~/.solana-agent-wallet`
- Windows runtime data: `%APPDATA%\Solana Agent Wallet`

On first start, the bundled CLI sidecar creates a conservative default `agent-wallet.config.json` if one does not exist. Mainnet actions remain disabled by default in that generated config.

## Development

Run the web shell:

```sh
pnpm -F @solana-agent-wallet-adapter/desktop-shell dev
```

Run the native shell when the Tauri CLI is installed:

```sh
cargo install tauri-cli --version '^2'
pnpm -F @solana-agent-wallet-adapter/desktop-shell tauri:dev
```

Development builds do not require a bundled sidecar. If the sidecar is missing, Agentic shows a diagnostic and falls back to repo-local bridge and wallet-host commands when the monorepo build artifacts are present.

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

1. Publish the CLI release assets for the tag first:
   `solana-agent-wallet-macos-arm64.tar.gz`, `solana-agent-wallet-macos-x64.tar.gz`, `solana-agent-wallet-windows-x64.zip`, and `solana-agent-wallet-linux-x64.tar.gz`.
2. Run the desktop release workflow for the same tag.
3. Confirm the release contains exactly these desktop installers:
   `agentic-desktop-macos-arm64.dmg`, `agentic-desktop-macos-x64.dmg`, `agentic-desktop-windows-x64.msi`, and `agentic-desktop-linux-x64.AppImage`.
