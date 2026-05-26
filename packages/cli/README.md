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

Optional AI planning is BYOK and local-first:

```sh
export AGENTIC_AI_API_KEY=...
export AGENTIC_AI_MODEL=gpt-5
export AGENTIC_AI_BASE_URL=https://api.openai.com/v1
solana-agent-wallet app
```

The key stays in the local bridge process or your shell environment. The hosted app can draft plans through the bridge,
but wallet approval remains separate.

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

**v1.0** brings full parity with the agentic-signer.com web surface — device-agent control, generic connector dispatch, SIWS auth, agent profile (A2A), preferences, skills, signals, AP2/ACP, bridge router, audit. Below is a categorised reference; every command supports `--json` for scriptable output.

### Core (local bridge)

```sh
solana-agent-wallet app                       # Terminal control center
solana-agent-wallet doctor                    # All-in-one health probe (bridge, wallet-host, render-web, device-agent, connector registry)
solana-agent-wallet setup                     # Configure local RPC + Jupiter + BirdEye keys
solana-agent-wallet bridge serve              # Start MCP-aware HTTP bridge
solana-agent-wallet wallet-host serve         # Serve browser wallet host
solana-agent-wallet status | balances | portfolio | health
solana-agent-wallet connect                   # Open browser, wait for wallet
solana-agent-wallet version
```

### Approvals + receipts

```sh
solana-agent-wallet inbox list | inspect <id> | approve <id> | reject <id> | archive <id>
solana-agent-wallet receipts
solana-agent-wallet research list | sign <number|id> [input]
```

### Preparing actions (transfers, Jupiter swaps, Solana Actions / Blinks)

```sh
solana-agent-wallet prepare transfer-sol <recipient> <amount-sol>
solana-agent-wallet prepare transfer-spl <token> <recipient> <amount>
solana-agent-wallet prepare swap <amount> [input-token] [output-token]
solana-agent-wallet prepare blink --url <url> [--connector <id>] [--operation <label>]
```

### v1.0 — Generic connector dispatch (all 20 protocols)

```sh
solana-agent-wallet prepare connector <kind> --param key=value ... --wallet <addr> --cluster mainnet-beta
solana-agent-wallet connector list                 # Capability registry (all connectors + capabilities)
solana-agent-wallet connector info <connectorId>
solana-agent-wallet connector read <connectorId> <capability> [--param k=v]
solana-agent-wallet read <connectorId> [capability] [--param k=v]
```

### v1.0 — Friendly prepare aliases (top 20)

Sugar over `prepare connector <kind>` for high-volume flows:

```sh
solana-agent-wallet prepare marinade-stake          --param solAmount=0.01    --wallet <addr>
solana-agent-wallet prepare marinade-unstake        --param mSolAmount=0.005  --wallet <addr>
solana-agent-wallet prepare jito-stake              --param solAmount=0.01    --wallet <addr>
solana-agent-wallet prepare jito-unstake            --param jitoSolAmount=0.005 --wallet <addr>
solana-agent-wallet prepare kamino-deposit          --param reserveMint=...
solana-agent-wallet prepare kamino-withdraw         --param reserveMint=...
solana-agent-wallet prepare jupiter-lend-deposit    --param token=USDC --param amount=10
solana-agent-wallet prepare jupiter-lend-withdraw   --param token=USDC --param amount=5
solana-agent-wallet prepare jupiter-trigger         --param inputToken=SOL --param outputToken=USDC --param amount=0.1 --param trigger=...
solana-agent-wallet prepare jupiter-recurring       --param inputToken=USDC --param outputToken=SOL --param totalAmount=100 --param numberOfOrders=10
solana-agent-wallet prepare drift-vault-deposit     --param vaultAddress=... --param amount=5
solana-agent-wallet prepare drift-vault-withdraw    --param vaultAddress=... --param shares=...
solana-agent-wallet prepare marginfi-deposit        --param bankMint=USDC --param amount=10
solana-agent-wallet prepare marginfi-borrow         --param bankMint=USDC --param amount=2
solana-agent-wallet prepare meteora-add-liquidity   --param poolAddress=... --param amount=...
solana-agent-wallet prepare orca-add-liquidity      --param positionMint=... --param amount=...
solana-agent-wallet prepare raydium-add-liquidity   --param poolId=... --param amount=...
solana-agent-wallet prepare wormhole-transfer       --param targetChain=... --param token=... --param amount=...
solana-agent-wallet prepare magiceden-buy           --param mintAddress=...
solana-agent-wallet prepare squads-propose-transfer --param multisig=... --param recipient=... --param amount=...
```

### v1.0 — Market data + history

```sh
solana-agent-wallet market <mint> [--with-metadata] [--with-ohlcv]
solana-agent-wallet tokens search <query>
solana-agent-wallet tokens safety <mint>
solana-agent-wallet helius-history <wallet> [--limit 25] [--type transfer]
```

### v1.0 — Device Agent + Plan AI

```sh
solana-agent-wallet device-agent status
solana-agent-wallet device-agent configure --provider openai --model gpt-5 --from-env AGENTIC_AI_API_KEY
solana-agent-wallet device-agent start | stop
solana-agent-wallet device-agent generate-plan "swap 0.05 SOL to USDC"
solana-agent-wallet device-agent review-plan <action-id>
solana-agent-wallet device-agent ask <action-id> "What does this approval reveal?"
solana-agent-wallet plan status | generate "intent" | review <id> | ask <id> "q"
solana-agent-wallet swap quote <amount> [--input-token SOL] [--output-token USDC] [--slippage-bps 50]
solana-agent-wallet swap order <amount> [...]
solana-agent-wallet swap execute <amount> [...]
```

### v1.0 — Identity (SIWS) + Profile + Preferences

```sh
solana-agent-wallet auth login --wallet <addr> [--no-open]
solana-agent-wallet auth status | logout | nonce | session
solana-agent-wallet profile show | publish <agent-card.json> | delete  # delete opens wallet host to sign takedown
solana-agent-wallet prefs show                                    # list all preference namespaces
solana-agent-wallet prefs get <namespace>                         # one of: agent-policies, ai-settings, mpp-config, ...
solana-agent-wallet prefs set <namespace> --file <payload.json>   # PUT replaces the whole namespace
solana-agent-wallet prefs agent-policies show
solana-agent-wallet prefs agent-policies set --file policies.json
solana-agent-wallet prefs connector-keys list
solana-agent-wallet prefs connector-keys set magiceden --from-env MAGICEDEN_API_KEY
solana-agent-wallet prefs connector-keys remove tensor
solana-agent-wallet prefs connector-keys test sanctum --wallet <addr> --capability markets
solana-agent-wallet spend-limits list    # read-only; configure via wallet host UI (Settings → Spend Limits)
```

After `auth login` the session token is stored at `~/.solana-agent-wallet/session.json` (mode 0600). Override with `AGENTIC_SESSION_TOKEN` for CI/headless contexts.

### v1.0 — Streaming sessions + MPP + bridge router

```sh
solana-agent-wallet session list [--wallet <addr>]
solana-agent-wallet session create <token-mint> <cap-amount> <expires-in-seconds> [--allowlist <addr,addr>]
solana-agent-wallet session spend <session-id> <amount> <recipient>
solana-agent-wallet session voucher sign <session-id> --amount <amt> --recipient <addr>
solana-agent-wallet session voucher verify <voucher.json>
solana-agent-wallet session revoke | history | settle <session-id>
solana-agent-wallet mpp config | challenge <file.json>
solana-agent-wallet mpp inbound list
solana-agent-wallet mpp pay <approval-id> [--session-id <id>] [--amount <amt>] [--recipient <addr>]
solana-agent-wallet bridge-router quote <amount-usd> <recipient> [--target-mint <mint>]
solana-agent-wallet schedule list | create <token> <recipient> <amount> <cadence> [options] | pause <id> | resume <id> | delete <id>
```

### v1.0 — Skills, Signals, AP2 / ACP, Audit

```sh
solana-agent-wallet skills init | test | publish         # Authoring — proxies to agentic-skill
solana-agent-wallet skills list | detail <id> | installs
solana-agent-wallet skills install <id> --manifest-version v1 --caps caps.json [--accept-monetization]
solana-agent-wallet skills pause/resume/uninstall <install-id> | earnings [author]
solana-agent-wallet signals list | feed <id> | subscriptions | subscribe <feed-id> [--caps caps.json] | pause/resume/revoke <subscription-id>
solana-agent-wallet ap2 list | inspect <mandate-id> | receipt <mandate-id>
solana-agent-wallet acp preview <cart.json> | approve <cart.json>
solana-agent-wallet audit tail [--limit N] [--record-type T] [--record-id ID]
solana-agent-wallet cloud-workspace delete [--confirm]
```

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

## Environment Variables

| Variable | Purpose |
|---|---|
| `AGENTIC_SESSION_TOKEN` / `AGENTIC_BEARER_TOKEN` | Overrides the on-disk session at `~/.solana-agent-wallet/session.json`. Use for CI/headless contexts. |
| `AGENTIC_SESSION_WALLET` | Wallet address to associate with `AGENTIC_SESSION_TOKEN` when no on-disk session exists. |
| `AGENTIC_WALLET_ADDRESS` | Default wallet for commands that accept `--wallet` (auth login, prepare connector, etc.). |
| `AGENTIC_RENDER_WEB_URL` / `AGENTIC_PUBLIC_ORIGIN` / `RENDER_WEB_URL` | Render-web (Agentic cloud) base URL. Default `https://agentic-signer.com`; set to `http://127.0.0.1:3000` for local render-web development. |
| `AGENT_WALLET_BRIDGE_URL` / `BRIDGE_URL` | Local bridge HTTP base URL. Default `http://127.0.0.1:8787`. |
| `BRIDGE_TOKEN` | Bridge access token. Default: per-run random token. |
| `AGENT_WALLET_WALLET_HOST_URL` | Browser wallet host base URL. Default `http://127.0.0.1:5174`. |
| `AGENT_WALLET_HOME` | Runtime dir override (where `session.json`, `prepared-actions.json`, etc. live). Default `~/.solana-agent-wallet`. |
| `AGENT_WALLET_SKIP_OPEN` | When `1`, suppresses `open`/`xdg-open` calls (useful in containers + tests). |
| `AGENTIC_AI_API_KEY` / `AGENTIC_AI_MODEL` / `AGENTIC_AI_BASE_URL` | Optional local/BYOK AI override for bridge development. Normal CLI users use Agentic hosted AI after sign-in. |
| `AGENTIC_RENDER_WEB_COOKIE` / `AGENTIC_CLOUD_COOKIE` / `AGENTIC_SESSION_COOKIE` | Legacy cookie-based auth for render-web (pre-bearer). Bearer takes precedence. |
| `AGENTIC_CLI_BUNDLE_BUDGET_MB` | Build-time bundle size budget (default 40). Used by `scripts/bundle-size-report.mjs`. |
| `NO_COLOR` | Disables ANSI colours (also see `--no-color`). |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Generic error (uncaught throw) |
| `2` | Usage error (missing argument, bad flag) |
| `3` | Bridge unreachable |
| `4` | Render-web unreachable |
| `5` | Wallet not connected |
| `6` | `doctor --strict` found one or more unreachable probes |
