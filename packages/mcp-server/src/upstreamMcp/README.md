# Vulcan upstream MCP bridge

This directory wires [Vulcan](https://github.com/Ellipsis-Labs/vulcan-cli) — Ellipsis Labs' official Phoenix Perpetuals CLI ("Phoenix CLI for humans and agents") — as an upstream MCP server. Agentic spawns `vulcan mcp` as a subprocess, lists its tools, and re-exposes them on the Agentic MCP surface as `solana_vulcan_*` tools.

It's an **alternative live-execution bridge** for Phoenix Perpetuals. As of 2026-05-19 the native Phoenix adapter (`../adapters/phoenix/`, backed by `@ellipsis-labs/rise@0.4.9`) is also live; this bridge remains supported for operators who prefer subprocess isolation or want to leverage Vulcan's existing wallet infrastructure.

## Files

| File | Purpose |
|---|---|
| `vulcanClient.ts` | `VulcanUpstreamClient`: wraps `Client` + `StdioClientTransport` from `@modelcontextprotocol/sdk`. Lifecycle (`start`, `listTools`, `callTool`, `stop`), crash detection via `onclose`/`onerror`, ENOENT wrap. Exports `extractVulcanTxid` + `extractVulcanErrorMessage` helpers. |
| `vulcanConfig`-driven (in `../config.ts`) | `PhoenixVulcanPolicyConfig` + `getPhoenixVulcanPolicy(config)` resolver (env override: `PHOENIX_VULCAN_ENABLED`, `PHOENIX_VULCAN_ALLOW_DANGEROUS`, `PHOENIX_VULCAN_BINARY`, `VULCAN_WALLET_NAME`). |
| `vulcanPolicy.ts` | `isDangerousTool`, `assertVulcanDangerousCallAllowed` (Phoenix policy gate for signing tools), `sanitizeVulcanToolName`, `describeVulcanTool`. |
| `vulcanTools.ts` | `registerVulcanTools(opts)`: enumerates upstream tools, classifies as read-only vs dangerous, registers each as `solana_vulcan_*`. Collision detection. Dangerous calls queue prepared-action cards (`kind: 'phoenix_vulcan_call'`); reads forward directly. `VULCAN_TRACE` event taxonomy. |
| `vulcanStatus.ts` | `VulcanStatusHolder` — mutable snapshot for the `solana_vulcan_status` MCP tool (debug surface). |
| `index.ts` | Public re-exports. |

## Wallet model — read before deploying

⚠️ **Vulcan uses its OWN wallet, stored in `~/.vulcan/wallets`. It is NOT the same wallet as Agentic's Privy / MWA / Phantom.**

When a user approves a Vulcan action in the Spend tab, they are approving Agentic to instruct Vulcan to sign with **Vulcan's** stored wallet — not the user's Agentic wallet. The two wallets are unrelated by default; the user (or operator) must manually transfer SOL/USDC into the Vulcan wallet before signing tools work.

Common confusion patterns:
- **"I approved the trade but my Phantom balance didn't change."** → Correct. The trade settles via Vulcan's wallet. Check `vulcan wallet show` or the Solana explorer for the Vulcan wallet address.
- **"Why does Agentic ask me to paste a Phoenix access code, but the trade fails?"** → The access code in Agentic's Preferences is for the NATIVE Phoenix adapter (read tools). The Vulcan bridge requires a separate setup — run `vulcan auth activate <code>` on the host.

If unified wallets are desired, the operator must export the Privy/MWA keypair into Vulcan's wallet store, OR migrate to the native Rise SDK adapter once it lands on npm.

## Setup prerequisite

Before enabling the bridge in production:

```bash
# 1. Install vulcan-cli (Rust toolchain required).
cargo install --git https://github.com/Ellipsis-Labs/vulcan-cli --rev <pinned-commit-sha>

# 2. Configure Vulcan with a wallet + Phoenix activation. Interactive setup:
vulcan setup

# 3. (Optional) Activate Phoenix waitlist code into Vulcan.
vulcan auth activate <invite-code>

# 4. Verify it works standalone before wiring into Agentic.
vulcan market list
vulcan position list
```

If `vulcan setup` is skipped, Vulcan will start but `listTools()` returns an empty array. The bridge surfaces this via:
- A `console.warn` line at MCP-server startup: `[vulcan-upstream] Vulcan connected but reported no tools. Run vulcan setup ...`
- The `solana_vulcan_status` MCP tool reports `hints: [...]` with the same message.

## Env vars

| Variable | Default | Purpose |
|---|---|---|
| `PHOENIX_VULCAN_ENABLED` | `false` | Master switch. Config also accepts `connectors.phoenix.vulcan.enabled`. |
| `PHOENIX_VULCAN_ALLOW_DANGEROUS` | `false` | Spawns `vulcan mcp --allow-dangerous` so signing tools appear. Requires `VULCAN_WALLET_PASSWORD`. |
| `PHOENIX_VULCAN_BINARY` | `vulcan` | Absolute path to the vulcan binary. Falls back to `$PATH` lookup. |
| `PHOENIX_VULCAN_AUTO_RESTART` | `false` | D1: enable backoff-based restart after subprocess crashes. Config also accepts `connectors.phoenix.vulcan.autoRestart`. |
| `PHOENIX_VULCAN_REQUIRED_VERSION` | (none) | D2: pin the upstream Vulcan binary version. Exact match against `serverInfo.version`; rejects start() on mismatch. |
| `VULCAN_WALLET_NAME` | (none) | Selects which stored Vulcan wallet to use. Defaults to Vulcan's default if unset. |
| `VULCAN_WALLET_PASSWORD` | (none) | Required when `allowDangerous=true` in single-wallet mode. Bridge warns + refuses to start Vulcan if missing. |
| `VULCAN_LOG_LEVEL` | (none) | Set to `silent` in CI/tests to suppress `console.info` / `console.warn` startup lines. |

## D1 — Auto-restart on subprocess crash

Vulcan is beta; subprocess crashes happen. When `autoRestart` is enabled, the client detects transport `onclose` / `onerror` events and schedules a restart with exponential backoff. Default schedule: `[1000, 2000, 5000, 10000, 30000]` ms over five attempts. After exhaustion, the `onRestartGaveUp` event hook fires and subsequent calls throw `Vulcan auto-restart gave up after N attempts...`.

Config knobs:
- `connectors.phoenix.vulcan.autoRestart: true` — opt in.
- `connectors.phoenix.vulcan.restartBackoffMs: [...]` — customize the schedule. `[]` disables restarts entirely.

Observability:
- Trace event `vulcan.upstream.crashed` on every crash.
- `solana_vulcan_status` snapshot's `running` flag reflects the live state; `lastError` carries the latest cause.
- Manual `start()` during a pending restart cancels the timer and supersedes the auto-restart attempt.

When NOT to use: deployments where you want loud failure to alert ops. Auto-restart papers over crash loops that might indicate a config problem; pair it with monitoring on `vulcan.upstream.crashed` event rate.

## D2 — Version pinning

The MCP `initialize` handshake captures `serverInfo: { name, version }` from upstream. `requiredServerName` and `requiredServerVersion` options enforce exact matches; mismatch → `start()` rejects with a clear "does not match required X" message.

Use case: you tested Agentic against Vulcan `0.1.5`; pin it so an unreviewed `0.2.0` upgrade can't silently break protocol assumptions. Combine with `PHOENIX_VULCAN_REQUIRED_VERSION` env override for deploy-time pinning without touching code.

For fuzzier needs (semver ranges), call `client.getServerInfo()` after `start()` and validate manually — the MCP server doesn't bake in a semver library.

## D3 — Telemetry counters

Every Vulcan tool call (read or dangerous-execute) is timed and recorded in a `VulcanMetricsRegistry`. Surfaced via the `metrics` field of the `solana_vulcan_status` snapshot:

```json
{
  "metrics": {
    "market.snapshot": {
      "toolName": "market.snapshot",
      "totalCalls": 1247,
      "errorCount": 3,
      "totalLatencyMs": 87412,
      "maxLatencyMs": 1208,
      "latencyBuckets": { "lt100ms": 1180, "lt500ms": 63, "lt1000ms": 3, "lt5000ms": 1, "gte5000ms": 0 },
      "lastSuccessAt": "2026-05-20T10:42:11Z",
      "lastErrorAt": "2026-05-20T09:14:55Z",
      "lastErrorMessage": "oracle stale"
    }
  }
}
```

Five fixed latency buckets (lt100 / lt500 / lt1000 / lt5000 / gte5000 ms) give triage-quality breakdowns without unbounded memory. Per-tool entries persist for the process lifetime; restart wipes them.

**Multi-wallet keying** (T2.1): when running with `VulcanWalletRegistry`, metric keys become `${walletName}::${toolName}`. Each tenant's tool calls are tracked independently — wallet A's slow calls don't pollute wallet B's p95. Single-wallet mode stays keyed by `${toolName}` (no breakdown).

## D4 — Multi-wallet registry

Vulcan binds one wallet per subprocess via env vars. To serve multiple wallets from one Agentic process, `VulcanWalletRegistry` lazily spawns a separate subprocess per wallet name. Each is kept alive once started; `stopAll()` tears everything down on shutdown.

Activation: set `walletPasswordsByEnvVar` in config to a non-empty map. The bridge detects this and builds a registry instead of the single client:

```ts
// agent-wallet config
connectors: {
  phoenix: {
    vulcan: {
      enabled: true,
      allowDangerous: true,
      walletPasswordsByEnvVar: {
        alice: 'ALICE_VULCAN_PASSWORD',
        bob: 'BOB_VULCAN_PASSWORD',
      },
      allowedWallets: ['alice', 'bob'],
      defaultWalletName: 'alice',
    },
  },
},
```

Then deploy with both env vars set: `ALICE_VULCAN_PASSWORD=... BOB_VULCAN_PASSWORD=... pnpm start`.

Routing at execute time:
- Agent calls a dangerous tool with `vulcanWalletName: 'alice'` in args.
- `vulcanTools.handleCall` extracts the wallet name from args and queues a prepared action with `params.vulcanWalletName: 'alice'`.
- User approves in Spend tab → `executePreparedVulcanCall` reads `vulcanWalletName` and calls `registry.getOrStart('alice')`, which lazy-spawns or returns the existing subprocess for alice.
- The `acknowledged: true` flag is injected and the call forwards to alice's Vulcan process.

Safety:
- `allowedWallets` is an allowlist. Calls with `vulcanWalletName` outside the list are rejected at the registry layer ("not in the configured allowlist"). Use this for cloud multi-tenant — prevents an injected wallet name from spawning unconfigured subprocesses.
- `defaultWalletName` is used when no `vulcanWalletName` is supplied. Falls back to single-tenant ergonomics.

Per-wallet password rotation: changing the env var doesn't affect already-running subprocesses (Vulcan reads it at spawn). To rotate, restart the bridge — the registry's `stopAll()` cleans up the old subprocesses; new ones pick up the new env vars on next call.

Status surface:
- `solana_vulcan_status` snapshot's `wallets` field lists the active wallet names (those that have been lazily spawned this session).
- The `metrics` field's keys are `${wallet}::${tool}` in registry mode.

## Debugging

Three layers of visibility:

1. **`solana_vulcan_status` MCP tool** (always registered, even when policy disabled):
   ```jsonc
   {
     "enabled": true,
     "running": true,
     "binaryPath": "/usr/local/bin/vulcan",
     "allowDangerous": true,
     "registeredTools": {
       "readonly": ["solana_vulcan_market_snapshot", "solana_vulcan_position_list", ...],
       "dangerous": ["solana_vulcan_trade_place_market", ...],
       "skipped": []
     },
     "hints": []
   }
   ```
   Ask the agent: "What's the Vulcan upstream state?" → the agent will call this tool and explain.

2. **Trace events** (under `VULCAN_TRACE` constant):
   - `vulcan.upstream.*` — bridge / client lifecycle: `connected`, `tools_ready`, `start_failed`, `config_skipped`, `register_failed`, `crashed`.
   - `vulcan.tool.*` — per-call events: `queued`, `invoked`, `rejected`, `skipped`.

3. **Console logs** (suppressed under `VULCAN_LOG_LEVEL=silent`):
   - `[vulcan-upstream] connected; N readonly tools, M dangerous tools` on successful registration.
   - `[vulcan-upstream] PHOENIX_VULCAN_ALLOW_DANGEROUS=true but VULCAN_WALLET_PASSWORD is not set...` on misconfiguration.
   - `[vulcan-upstream] registration failed: <reason>` on hard failures.

## Lifecycle

1. **At bridge startup** (`bridgeServer.ts`):
   - If `getPhoenixVulcanPolicy(config).enabled === false` → no client built. `solana_vulcan_status` still registers and returns `{ enabled: false }`.
   - If `enabled === true` and `allowDangerous === true` but no `walletPassword` → bridge logs a warning and skips client construction.
   - Otherwise → constructs `VulcanUpstreamClient` and calls `.start()` (async, fire-and-forget with trace logging on failure).

2. **At MCP server startup** (`actionTools.ts:registerActionTools`):
   - Creates `VulcanStatusHolder`, sets the client reference.
   - If the client exists AND policy enabled → kicks off async `registerVulcanTools(...)`.
     - Lists upstream tools.
     - Classifies each as read-only or dangerous.
     - Registers as `solana_vulcan_*` MCP tools.
     - Captures the summary in the status holder.
   - Registers `solana_vulcan_status` unconditionally.

3. **Per tool call**:
   - Read tools → `client.callTool(name, args)` → forward result.
   - Dangerous tools → `assertVulcanDangerousCallAllowed(config, args)` → `store.addAction({ kind: 'phoenix_vulcan_call', ... })` → return `{ preparedAction }`. User approves in Spend tab.

4. **Per execute** (`actionService.executePreparedVulcanCall`):
   - Idempotency check: if `action.txid` already set → throw `'already_executed'`.
   - Inject `acknowledged: true` into args.
   - Call upstream via `vulcanUpstreamClient.callTool(...)`.
   - Extract Solana signature via `extractVulcanTxid(result)`.
   - Return `{ ..., txid: <signature> }` → outer `executePreparedAction` updates the prepared-action row + flips `txStatus: 'pending'` + lights the Solscan link in the Spend tab.

5. **Subprocess crash** (transport `onclose` or `onerror`):
   - `running` → `false`, `lastError` captured.
   - Next `callTool` throws `"Vulcan upstream client is not started. Last error: <reason>. Call start() first."`.
   - The bridge must be restarted to re-spawn Vulcan (no auto-restart in v1).

## Production deploy snippet

For render-web Dockerfile:

```dockerfile
# Rust toolchain for cargo install
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl build-essential pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Install Vulcan; pin the commit for reproducible deploys.
ARG VULCAN_COMMIT=<paste-sha-here>
RUN cargo install --git https://github.com/Ellipsis-Labs/vulcan-cli --rev "$VULCAN_COMMIT"

# Wallet setup is per-deploy. Either bake a wallet keystore into the image (NOT recommended for prod) or mount it
# via secret-management and run `vulcan setup` once at first deploy.
```

Then in the service config, set `PHOENIX_VULCAN_ENABLED=true`, `PHOENIX_VULCAN_ALLOW_DANGEROUS=true`, `VULCAN_WALLET_NAME=...`, `VULCAN_WALLET_PASSWORD=<from-secret-store>`.

## What's NOT in this bridge

- **Hot tool-list refresh.** If Vulcan adds new tools mid-process (unlikely), Agentic won't see them until restart.
- **Per-wallet password rotation without restart.** Changing the password env var doesn't affect a running subprocess; restart the bridge to pick up new credentials.
- **Semver-range version pinning.** Only exact-match `requiredServerVersion`. For range pinning, post-start your own check via `client.getServerInfo()`.
- **Pre-warm of wallet subprocesses.** Wallets are lazy-spawned on first use. For latency-sensitive deploys, you can pre-call the registry's `getOrStart(name)` at boot time.
- **Cross-process wallet sharing.** Each Agentic process has its own subprocess pool. To share a wallet across multiple Agentic processes, run them as separate Vulcan-wallet tenants.

**Shipped in D1-D4**: auto-restart on crash, version pinning, telemetry, multi-wallet via registry — see sections above.

The **native** Phoenix adapter (in `../adapters/phoenix/`) is now live as of 2026-05-19 — it uses `@ellipsis-labs/rise@0.4.9` for instruction building and is the recommended default for new deployments. This Vulcan bridge remains supported as an alternative execution path: same-host wallet isolation, Rust-grade signing, multi-wallet tenancy. Pick the path that matches operator constraints; both can coexist.

See `../adapters/phoenix/README.md` for the native path's setup + flag reference.
