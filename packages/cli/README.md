# @solana-agent-wallet-adapter/cli

Terminal control surface for Agentic, the Solana Agent Wallet Adapter local runtime. It starts a local wallet bridge, serves the browser wallet host, and lets agents request wallet-held approvals without receiving custody of a private key.

## Install from npm

```sh
npm install -g @solana-agent-wallet-adapter/cli
solana-agent-wallet app
```

One-shot usage without a global install:

```sh
npm exec @solana-agent-wallet-adapter/cli -- app
```

`solana-agent-wallet app` starts the local bridge at `http://127.0.0.1:8787`, starts the wallet host at `http://127.0.0.1:5174`, opens the wallet host in your browser, and launches the terminal control center.

## Standalone Downloads

Download the asset for your platform from the latest GitHub Release:

- `solana-agent-wallet-macos-arm64.tar.gz`
- `solana-agent-wallet-macos-x64.tar.gz`
- `solana-agent-wallet-linux-x64.tar.gz`
- `solana-agent-wallet-windows-x64.zip`

Release URL pattern:

```text
https://github.com/mstevens843/solana-agent-wallet-adapter/releases/latest/download/<asset>
```

After extracting the archive, run:

```sh
./solana-agent-wallet app
```

On Windows, run `solana-agent-wallet.exe app`.

## Commands

```sh
solana-agent-wallet app
solana-agent-wallet doctor
solana-agent-wallet bridge serve
solana-agent-wallet bridge start
solana-agent-wallet wallet-host serve
solana-agent-wallet status
solana-agent-wallet balances
solana-agent-wallet connect
solana-agent-wallet inbox list
solana-agent-wallet inbox inspect <action-id>
solana-agent-wallet inbox approve <action-id>
solana-agent-wallet prepare transfer-sol <recipient> 0.01
solana-agent-wallet receipts
```

Use `--json` for scriptable output.

## Runtime Files

Installed mode uses a user-local runtime directory:

- macOS/Linux: `~/.solana-agent-wallet`
- Windows: `%APPDATA%\solana-agent-wallet`

The CLI creates `agent-wallet.config.json` and the prepared-action data directory when they are absent. Override paths with:

```sh
solana-agent-wallet --runtime-dir <path> doctor
solana-agent-wallet --config <path> --prepared-actions <path> bridge serve
```

## Local Repo Development

From a cloned repo:

```sh
pnpm install
pnpm -F @solana-agent-wallet-adapter/cli build
pnpm cli -- app
```

Repo mode keeps the development fallback for `apps/browser-demo` and repo-local config files. Public users should use npm, `npm exec`, or a release binary instead.

## Troubleshooting

- Run `solana-agent-wallet doctor --json` to inspect runtime paths, bridge reachability, wallet-host assets, and local health.
- If port `8787` or `5174` is busy, stop the old process or pass `--bridge-url` / `--wallet-host-url` with another localhost port.
- If no browser wallet is connected, keep the wallet host tab open, connect Phantom, Backpack, Solflare, or another Wallet Standard wallet, then click Connect bridge if prompted.
- If `wallet-host serve` reports missing assets, reinstall the npm package or rebuild locally with `pnpm -F @solana-agent-wallet-adapter/cli build`.
- Mainnet actions remain capped by `agent-wallet.config.json`; set `mainnet.enabled=true` only when you intend to allow real mainnet actions.
