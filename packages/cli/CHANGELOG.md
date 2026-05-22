# Changelog

## v1.0.0 — final sweep — 2026-05-21

This pass closes the remaining bugs + completeness gaps found in three deep-review rounds. Endpoint parity with the cloud + bridge is now complete.

### Critical bug fixes

- **`profile publish` payload byte preservation.** `runSignedRequest` now accepts pre-serialized JSON bytes (`bodyJson` / `bodyFragments`) so the payload bytes the server hashed at intent time are byte-identical at finalize time. Previously, JSON.stringify could re-order keys and the server would 401 with "Signed message does not match the profile publish intent."
- **Nonce callback race / idempotency.** The loopback callback receiver now reads the live `settled` flag via a mutable ref at response-write time (not a snapshot at handler entry), so concurrent requests can no longer both write "Signed" pages or resolve the outer promise twice.
- **`mpp pay` help text** corrected to match the dispatcher (`--amount` / `--recipient` removed; only `--session-id` is accepted).
- **`signatureEncoding` plumbed end-to-end.** `WalletProofSignature` now exposes `signatureEncoding`; the wallet host passes it through unchanged instead of hardcoding `'base58'`. Future wallets returning base64 work without silent server rejection.

### Wallet-host UX

- **Listener deduplication on `/agentic-login`.** Each render of the page clones the sign button before re-attaching the click listener, preventing duplicate POSTs when the user navigates away and back.
- **Auto-refresh when wallet connects.** `wireAgenticLoginAutoRefresh` watches `state.address` on the login route and triggers `render()` when the user connects a wallet in another tab — the disabled sign button enables without a manual reload.

### Doctor

- `doctor --strict` exits code `6` if any probe reports `reachable: false`.
- `doctor --section <name>` returns just one section (great for `... --section renderWeb --json` in CI).
- Human-readable rendering now covers all new sections (`Connector registry`, `Bridge AI`, `Device Agent`, `Render-web`, `CLI session`) with provider/model details and stale-session hint.

### New commands (full endpoint coverage)

- **`birdeye`** group — 15 subcommands covering every Birdeye endpoint (`price-multi`, `price-volume`, `history-price`, `ohlcv`, `search`, `token-meta`, `token-security`, `token-holders`, `token-creation-info`, `exit-liquidity-multi`, `trending`, `new-listings`, `token-list-v3`, `wallet-token-list`, `ws-snapshot`). Bridge-first, render-web fallback.
- **`coingecko`** group — `endpoints | global | read | token-evidence`.
- **`helius`** group — `cloud-transfers <wallet>` (the legacy bridge-routed `helius-history` top-level command stays as-is).
- **`solana`** group — RPC proxies: `blockhash | send-tx <base64> | tx-status <sig> | account-info <addr>`. `account-info` is cloud-only (no bridge equivalent).
- **`approvals`** group — cloud-side approval + finalization flow: `list | prepare-tx | execute | finalize prepare|submit|confirm|fail|status | cleanup-recurring`.
- **`completed list [--limit N] [--since ISO]`** — completed approvals history.
- **`plans list`** — saved cloud plans (distinct from `ai plan generate`).
- **`evidence list [--connector] [--limit]`** — evidence facts collected by agents.
- **`research artifacts list | save | delete`** — local bridge lab-artifact CRUD.
- **`bridge-agents list | register | issue | delete`** — local bridge agent token management (separate from cloud A2A `profile publish`).
- **`schedule occurrences | notifications | rotate-notifications`** — cloud-side recurring metadata.
- **`swap order|execute --cloud`** — route Jupiter swap through render-web for headless CI without a local bridge.

### UX flags

- **`inbox approve <id> --wait [--wait-timeout-ms N]`** — polls `/bridge/prepared-actions/tx-status` until `confirmed` or `failed` (60s default).
- **`audit tail --follow [--poll-interval-ms N]`** — `tail -f` style streaming of new audit events. Ctrl+C exits cleanly.

### Tests

- New: tx-memo-proof full E2E roundtrip (Android wallet path).
- New: profile-publish payload byte-preservation regression (exact bytes in BOTH intent + finalize bodies).
- New: `doctor --strict` exits 6 when bridge offline.
- New: `doctor --section` filters output.
- New: shape tests for `birdeye search`, `solana account-info`, `approvals list`.
- All 31 CLI tests pass + 32 render-web auth tests + 642 full render-web tests.

### Migration

No breaking changes from the earlier v1.0 surface. Existing scripts continue to work.

---

## v1.0.0 — 2026-05-21

Full parity with the agentic-signer.com web surface. v0.2.x commands continue to work unchanged.

### Added

**Generic connector dispatch**
- `prepare connector <kind> --param key=value` — wraps `/bridge/connector/prepare-transaction` to unlock every connector write action (Drift, Kamino, Marinade, Jito, Orca, Raydium, Meteora, MarginFi, Save, Project0, Sanctum, Wormhole, Magic Eden, Tensor, Phoenix, Realms, Squads, Pyth, Lulo, Jupiter Lend/Trigger/Recurring/Predictions/Perps).
- 20 friendly aliases: `prepare marinade-stake`, `prepare jito-stake`, `prepare kamino-deposit`, `prepare drift-vault-deposit`, `prepare jupiter-lend-deposit`, `prepare jupiter-trigger`, `prepare jupiter-recurring`, `prepare wormhole-transfer`, `prepare magiceden-buy`, `prepare squads-propose-transfer`, etc.
- `connector list | info <id> | read <id> <capability>` — capability registry + generic read facts.
- `read <connector> [capability]` — shorthand for `connector read`.

**Market + history**
- `market <mint>` — price/metadata/OHLCV via `/bridge/action/market-data`.
- `tokens search <query>` and `tokens safety <mint>` — token-list and safety evidence.
- `helius-history <wallet>` — recent transfer history.

**Device Agent + AI plan**
- `device-agent status | configure | start | stop | generate-plan | review-plan | ask`.
- `plan status | generate | review | ask` and `swap quote | order | execute` as first-class subcommands.

**SIWS auth + identity**
- `auth login | logout | status | nonce | session` — bearer-mode SIWS that opens the wallet host with a loopback callback and persists the token at `~/.solana-agent-wallet/session.json` (mode 0600).
- `profile show | publish <agent-card.json> | delete` for A2A AgentCard.
- `prefs show | set <k=v>`, `prefs agent-policies show|set`, `prefs connector-keys list|set|remove|test` (BYO Magic Eden, Tensor, Sanctum keys via `--from-env <VAR>`).
- `spend-limits get | set --token <mint> --daily <amt>`.

**Payments**
- `session voucher sign | verify` (the missing voucher commands).
- `mpp inbound list` and `mpp pay <session-id>`.
- `bridge-router quote <usd> <recipient>` — fiat → cheapest Solana settlement route.
- `cloud-workspace delete --confirm` — Play Store data-deletion flow.
- `schedule create` (recurring payments).

**Skills, Signals, AP2/ACP, Audit**
- `skills init | test | publish` — proxies to `agentic-skill` (skills-cli authoring).
- `skills list | install | run | earnings | manifests` — hosted skill registry.
- `signals list | subscribe | unsubscribe | feed | webhook test`.
- `ap2 inspect | list`, `acp inspect | list` — mandate / cart inspectors.
- `audit tail [--limit] [--since] [--type]`, `audit export [--format json|csv]`.

**Doctor**
- Parallelizes all probes via `Promise.all`. New sections: `connectorRegistry`, `ai`, `deviceAgent`, `renderWeb` (incl. SIWS session state).

**Plumbing**
- New `src/http/index.ts` unified render-web client with bearer-token + cookie fallback.
- New `src/auth/{sessionStore,nonceFlow}.ts` SIWS session management.
- Build-time `scripts/validate-aliases.mjs` fails the build if a `prepare-alias` references an unknown bridge `kind`.
- Build-time `scripts/bundle-size-report.mjs` guards `dist/index.js` ≤ 40 MB (override via `AGENTIC_CLI_BUNDLE_BUDGET_MB`). The CLI bundles the full MCP server with 20 protocol SDKs, so the budget reflects that baseline.

### Changed

- `prepare` recognizes `connector` and all 20 friendly aliases.
- `session` recognizes `voucher`.
- `mpp` recognizes `inbound` and `pay`.
- `schedule` recognizes `create`.
- `doctor` output gains five new sections; existing fields are preserved.
- Help text expanded; `--version` / `version` / `-v` print the CLI version.

### Backwards compatibility

- Zero v0.2 commands removed or renamed. The four existing `prepare` subcommands (`transfer-sol`, `transfer-spl`, `swap`, `blink`) keep their exact shape.
- The existing local helpers in `src/index.ts` (`bridgeRequest`, `streamingRenderWebRequest`, `mppRenderWebRequest`) still exist and route the legacy commands unchanged. New commands use the unified client in `src/http/`.
- Existing env vars (`AGENT_WALLET_BRIDGE_URL`, `BRIDGE_TOKEN`, `AGENTIC_RENDER_WEB_URL`, `AGENTIC_SESSION_COOKIE`, …) keep working. New: `AGENTIC_SESSION_TOKEN` / `AGENTIC_BEARER_TOKEN` override the on-disk session for CI.

### Migration notes

- After upgrade, run `solana-agent-wallet doctor` once to see the new sections and verify reachability.
- For hosted features (skills, signals, profile, prefs, audit), run `solana-agent-wallet auth login --wallet <addr>` once. The session persists at `~/.solana-agent-wallet/session.json` (mode 0600 on POSIX). For CI, set `AGENTIC_SESSION_TOKEN` to override the on-disk session.
- `auth login` now requires `--wallet <address>` (or `AGENTIC_WALLET_ADDRESS` env) — the server's nonce endpoint expects the wallet up front. The CLI opens the wallet host at `/agentic-login` (a new SPA route), waits for the user to sign the message there, then completes the SIWS round-trip.
- `profile publish` / `profile delete` now drive the same wallet-host signing flow (they fetch an intent, ask the wallet host to sign, then POST/DELETE the signed envelope) — these were broken in earlier v1.0 drafts.
- `cloud-workspace delete --confirm` now goes through the same signed-request flow with full SIWS envelope (was previously sending an incomplete body the server always 400'd).
- `prefs connector-keys set` now sends `{apiKey, label?}` on `POST /api/connector-secrets/<connector>` (was previously sending `{value}` on PUT `/api/connector-secrets` which the server rejected). Inline `--value` is rejected — use `--from-env <VAR>`.
- `audit tail` flags renamed: `--type` → `--record-type`, added `--record-id`. The server has no `--since` filter (use `jq` post-process). No CSV export endpoint exists.
- `spend-limits` is read-only (`list`/`get` only). The server has no POST endpoint; envelopes are derived from approvals + recurring + streaming state. Configure via the wallet host UI under Settings → Spend Limits.
- `mpp pay <approval-id>` no longer accepts `--amount`/`--recipient` — those are derived from the approval the server already tracks.
- `device-agent set-key` now requires `--from-env <VAR>` (inline `--key` is rejected to keep secrets out of shell history).
- `skills install <id>` now requires `--manifest-version <vN>` and `--caps <caps.json>` — the server rejects partial installs.
- BYO connector API keys (Magic Eden, Tensor, Sanctum) are server-encrypted; manage them via `prefs connector-keys set <connector> --from-env <VAR>`.

## v0.2.1

(See git history.)
