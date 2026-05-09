# Project Progress

Last updated: 2026-05-09

## Current working state

The real-wallet MCP bridge is now working end to end on `mainnet-beta` with a browser wallet approval flow.

Confirmed capabilities:

- The MCP client can read wallet status through `solana_wallet_status`.
- The MCP client can read balances through `solana_get_balances`.
- The MCP client can request a capped SOL transfer through `solana_transfer_sol`.
- The browser bridge opens the connected Wallet Standard wallet for approval.
- The wallet signs and broadcasts the transaction without exposing the private key to the agent.
- The agent receives the mainnet transaction id and Solscan URL after approval.

## Verified mainnet transfers

Source wallet:

```text
Z8MBJ7wbVu68dFa2LKFkTLkqZNfpCgYYDp2Bz4b9iaC
```

Recipient wallet:

```text
6QcqZJBYZQWfGThBPaGGU3Y67XebbjxBeo2wxuwu1i6A
```

Confirmed transfers:

| Date | Amount | Cluster | Transaction |
| --- | ---: | --- | --- |
| 2026-05-04 | 0.03 SOL | mainnet-beta | [`gHv9TGWxKHVR7EDY6rdcRctrJViiRYqUchTgeos6zfz64eBb7TmoQ6mKad4noF2og1YCgVqMSUKNEnLjTdZiMHp`](https://solscan.io/tx/gHv9TGWxKHVR7EDY6rdcRctrJViiRYqUchTgeos6zfz64eBb7TmoQ6mKad4noF2og1YCgVqMSUKNEnLjTdZiMHp) |
| 2026-05-05 | 0.01 SOL | mainnet-beta | [`3GbBfjZkxBinhaNQrqmQ5LRzyF5WEA4xfFKcMUfZBXkG8Rve6BtV3vwRhAjiQSRyEgZKHBrtmZDea1ojiovQBDAo`](https://solscan.io/tx/3GbBfjZkxBinhaNQrqmQ5LRzyF5WEA4xfFKcMUfZBXkG8Rve6BtV3vwRhAjiQSRyEgZKHBrtmZDea1ojiovQBDAo) |

## Working local flow

Start the local bridge and browser demo:

```bash
pnpm dev
```

Then:

1. Open `http://127.0.0.1:5174`.
2. Discover wallets.
3. Select and connect the browser wallet.
4. Connect the local bridge.
5. Use Claude Code or Codex to call `solana-agent-wallet`.

Known working prompt:

```text
Use solana-agent-wallet to show my wallet status.
```

Known working transfer prompt:

```text
Use solana-agent-wallet to send 0.01 SOL to 6QcqZJBYZQWfGThBPaGGU3Y67XebbjxBeo2wxuwu1i6A.
```

## Safety controls currently active

The mainnet action tools are guarded by `agent-wallet.config.json`.

Current intended caps:

- Max SOL transfer: `0.05 SOL`
- Max swap input: `0.05 SOL`
- Max slippage: `100 bps`
- Arbitrary transactions: disabled
- USDC allowlist max transfer: `25 USDC`

The model cannot access the wallet private key. Every real signing or send action still requires the user to approve in the browser wallet.

## Fixes completed during mainnet testing

- Added `.env` support for `SOLANA_RPC_URL`, `JUPITER_API_KEY`, and `BRIDGE_TOKEN`.
- Added `.gitignore` coverage so local `.env` secrets are not committed.
- Added `pnpm dev` to start both the local bridge and browser demo.
- Added Codex MCP registration scripts:
  - `npm run mcp:codex:add`
  - `npm run mcp:codex:remove`
- Added a durable Approval Inbox for prepared and recurring actions.
- Wired `pnpm dev` and Codex registration to the same repo-local `.agent-wallet/prepared-actions.json` store.
- Hardened prepared-action execution so scheduled, approved, rejected, blocked, and pending actions cannot be executed from the bridge endpoint.
- Fixed the browser RPC split so the browser send path uses the same bridge RPC config as the MCP server.
- Added `/bridge/config` so the browser can load the bridge cluster and RPC URL.
- Fixed duplicate wallet prompts by claiming each pending bridge request once before handing it to the browser.
- Added a shared bridge action service for status, balances, portfolio, prepared actions, capped direct transfers, SPL transfers, and Jupiter swap actions.
- Added `@solana-agent-wallet-adapter/cli` with a standalone terminal app for bridge health, wallet-host launch, prepared inbox, recurring schedules, agent plans, signed research artifacts, receipts, direct transfers, and swaps.
- Hardened the terminal app UX with `/connect`, full-detail inbox rendering, `/inspect`, guarded approve/reject status checks, and all 15 research labs.
- Added a Tauri `apps/desktop-shell` bridge orchestrator for bridge lifecycle, diagnostics, logs, health, wallet-host launch, Approval Inbox, and receipts.
- The Browser Demo Agent Plan tab can now queue a capped SOL-to-USDC prepared action into the Approval Inbox when the bridge is connected.
- Added prepared-action normalization for older SOL recurring inbox records that used `amount` instead of `amountSol`.
- Added direct SOL/SPL balance preflight before opening wallet approval.
- Added current competitive positioning in `STANDOUT_FEATURES.MD`.
- Began a builder-first documentation cleanup so public docs reflect the current proof, bridge flow, and competitor landscape.

## Still to verify

Detailed scenario prompts and expected trace events are tracked in [`docs/SCENARIO_TESTS.md`](./docs/SCENARIO_TESTS.md).

- SPL token transfer through `solana_transfer_spl`.
- Jupiter quote through `solana_get_swap_quote`.
- Jupiter swap through `solana_swap`.
- CLI transaction end-to-end against a running bridge, including `prepare transfer-sol`, `inbox approve`, and `receipts`.
- Tauri native packaging after installing the Tauri CLI.
- Codex mainnet transfer flow after restart, using the same bridge.
- Longer-running bridge stability with multiple sequential requests.

## Phase 6: Cloud Evidence Receipt Archive (2026-05-08)

Cloud-backed archive for the five public evidence receipt kinds (Intent, Policy, Risk Review, Rejection, Tool Trace) is live behind wallet sign-in:

- New endpoints on `apps/render-web`: `POST /api/evidence`, `GET /api/evidence`, `DELETE /api/evidence/:id`. Wallet-scoped and reject sessions without a verified wallet.
- Validation reuses the Phase 1 contract `validateCreateEvidenceReceiptRequest` from `@solana-agent-wallet-adapter/workflow` — strict cluster enum, evidence kind/status enums, signing-message and signature length caps, secret/forbidden-key rejection.
- Storage: `MemoryEvidenceStore` for dev/test. `PostgresWorkflowStore` (Phase 8) implements `EvidenceStore` directly when `DATABASE_URL` is set, so receipts persist across restarts. Router auto-detects which one to wire.
- Browser-demo `/app` now mirrors archived receipts to Agentic Cloud when the active workflow mode is `agentic-cloud`. Browser-only fallback remains when signed-out. Private local mode (`local-bridge`) keeps receipts off the cloud.
- Per-receipt storage badges (`Browser` / `Cloud` / `Bridge`) with `aria-label`s, an "Exact signed text" block visible in receipt details, an "Evidence receipts only sign a record — they do not queue, approve, submit, or move funds" disclaimer in the panel intro, and a multi-destination delete confirm.
- Cloud delete failure surfaces a follow-up toast so receipts never silently orphan in the cloud. Receipt round-trips preserve the exact `input`, `verified`, and `cloudReceiptId` through cloud → browser refresh.
- Tests: `apps/render-web/src/__tests__/evidence-api.test.ts` (14 cases incl. cluster enum, missing-cluster, malformed JSON, body-too-large, metadata round-trip, listReceipts ordering, audit recordType + recordId).

Eager evidence sync is throttled to a 60s window inside `refreshCloudWorkspaceData` so frequent cloud refreshes (post-decision, post-recurring) do not re-fetch the entire receipts list.

## Phase 9: End-To-End QA And Release Hardening (2026-05-09)

The local Phase 9 gate is passing for the hosted Agentic Cloud, browser fallback, and mocked private local bridge paths:

- `scripts/smoke-render-web.mjs --workflow` now covers signed-out browser fallback approve/reject, completed history refresh, browser recurring fallback, browser/local recurring isolation, signed-in cloud one-time approve/deny, signed-in recurring materialization into Approval Inbox, evidence archive/delete, hosted BYOK success and redaction, browser AI template fallback, mocked private local bridge approval, and API JSON vs SPA shell routing.
- Recurring materialization is duplicate-safe across race windows: active approvals are unique by plan draft or recurring occurrence, interrupted stale ready occurrences can be repaired once, and existing approval-backed occurrences are not re-registered.
- BYOK and server error paths use shared secret redaction for exact provider keys, bearer tokens, OpenAI-style keys, JWT-like tokens, and generic `api-key`/`token`/`secret` fields.
- Terminal approval states now consistently leave active inbox views and move into completed history.
- Cloud approve/deny decisions now require a wallet-verifiable decision proof bound to the exact approval request; cancel remains proofless.
- Cloud evidence receipts now verify the submitted signed message against the signed-in wallet before storing the receipt as verified.
- Postgres migrations now use a transaction-scoped advisory lock to prevent concurrent deployment races.

Remaining release-only checks require external services: run render-web tests with `TEST_DATABASE_URL`, then re-run `pnpm smoke:render-web:live` after deployment. The live link verifier passes, but the current live smoke still fails because `https://agentic-signer.com/api/session` returns 404. Also run the real local bridge workflow smoke with `--require-local-bridge` before marking the public deployment fully released.

## Recurring Production Upgrade (2026-05-09)

- `plan.md` and `RECURRING_PLANS_PRODUCTION_PLAN.md` now track the production-grade recurring plan.
- Cloud occurrence history now exposes plain-English status labels plus linked approval and completed receipt summaries.
- Browser recurring setup supports expiry, webhook URL input, next-run previews, next-5 upcoming runs, lifetime or rate spend estimates, one-tap pause/resume, and loadable occurrence history.
- Cloud recurring spend caps are wired through the public router and recurring cron path using `agent-wallet.config.json` recurring policy fields when present.
- Webhook reminder delivery has a Postgres-backed delivery queue, HMAC signature header, retry worker command, and Render cron.
- Smoke guide: [`docs/smoke/recurring-production.md`](docs/smoke/recurring-production.md).

## Current product milestone

The project has crossed the main proof point:

> An AI agent can request a real mainnet SOL transfer, the user approves in their existing browser wallet, the private key never leaves the wallet, and the agent receives the confirmed transaction id.
