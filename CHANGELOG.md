# Changelog

All notable changes to this project. Dates are in YYYY-MM-DD.

## [Unreleased] — Phase 5 hardening

In flight. See [`/Users/devlegacy/.claude/plans/set-effort-delightful-prism.md`](./README.md) Phase 5 for the cleanup matrix.

- **CI**: apps tests now run on every push (`pnpm -r test` already covered packages and apps via workspace recursion; the root `test` script now matches CI semantics). Nightly Android instrumented-test workflow added (`agentic/android-instrumented`) that boots an emulator and runs `StreamingSessionControllerInstrumentedTest` (1000 voucher signs + <50ms latency assertion).
- **Security gates** (closed pre-mainnet):
  - `STREAMING_SESSION_ENCRYPTION_KEY` refuses short passphrases that would silently SHA-256-downgrade entropy (was accepted; now requires raw base64-32 OR a passphrase ≥32 chars + logs a one-time entropy-downgrade warning).
  - `STREAMING_SETTLEMENT_FEE_PAYER_SECRET_KEY` strict per-byte uint8 validation + 64-byte length check (was permissive `Number(entry)` coercion).
  - `STREAMING_TEST_RECENT_BLOCKHASH` and `STREAMING_TEST_SETTLEMENT_TXID` now refuse to fake their respective values outside `NODE_ENV=test` (operator footgun guard).
  - Settlement cron persists `metadata.lastSettlementAttempt = { txid, voucherHashes, submittedAt }` before each submit and reconciles via `Connection.getSignatureStatus()` on the next tick — no more double-submission of the same vouchers when confirmation times out.
  - Settlement lock now heartbeats between batches (extends `expiresAt`) so long settlements don't lose their lock to a second worker mid-flight.
- **Defense in depth**:
  - Streaming voucher signatures are re-verified at settlement time, not only at acceptance. Forged vouchers are quarantined with a `streaming.voucher.quarantined` audit event instead of building a tx that would fail on-chain.
  - Every MPP / streaming / settlement error message is now wrapped with `redactSecrets()` before reaching logs or HTTP responses.
- **Receipts**: streaming-settlement receipt previously stored the Solana txid in the `signature` field (misleading — verifiers expected ed25519). Now `signature: ''`, txid surfaced as `metadata.settlementTxid`, summary mentions recipients and the on-chain proof.
- **Migrations**: `PostgresMigration` now supports `down?: string`; migrations 013–015 ship reversal SQL; `pnpm -F render-web db:rollback <id>` rolls back the latest applied migration under the same advisory lock.
- **Type safety**: 9 `as unknown as JsonValue` / `as unknown as JsonObject` casts on the MPP canonical-JSON hash path replaced with an explicit `toJsonValue` / `toJsonObject` helper that drops `undefined` and rejects non-JSON values.
- **Config**: dead `mpp` and `streaming` top-level blocks removed from `agent-wallet.config.example.json` (those policies are managed by render-web wallet preferences + env vars, not the MCP config).

## [2026-05-16] — Phase 1 + 2 + 3: MPP + Streaming Sessions + Spend Envelopes

### Added

- **MPP adapter** (`@solana-agent-wallet-adapter/mpp-adapter`) — Machine Payments Protocol (HTTP 402, co-authored by Stripe + Tempo) inbound challenge parsing, verification, mapping to the universal `SigningRequest`, and signed evidence receipts. Inbound MPP challenges land in the Approval Inbox alongside AP2 and ACP with a distinct `MPP` badge.
- **Streaming sessions** (`@solana-agent-wallet-adapter/streaming-sessions`) — non-custodial streaming payments via SPL Token delegate authority. User signs one `Approve` granting a bounded session-scoped delegate; agent signs off-chain ed25519 vouchers up to the cap; render-web batch-settles via the delegate; user can `Revoke` on-chain any time. Sessions are USDC-first (native SOL is explicitly rejected; wrap to wSOL or use any SPL token).
- **Sessions browser tab** — two-pane UI (list + detail), live spent/cap progress, time-to-expiry countdown, recipient allowlist chips, paginated vouchers, revoke button, settlement-receipt link. Create modal validates token mint, cap, expiry, and allowlist.
- **Spend Envelopes** tab — unified view of one-time approvals + recurring schedules + streaming sessions with filter chips. The legacy three-tab layout stays available behind `?legacy-tabs=1` for rollback (see `apps/browser-demo/src/legacyTabs.ts` JSDoc for the design call).
- **Android device-agent voucher signing** — `StreamingSessionController` (Kotlin, 949 lines) signs vouchers locally against an Android Keystore-backed ephemeral signer, achieving <50ms per voucher with no WebView roundtrip and no per-voucher MWA approval. Falls back to cloud-relay signing in browser-only runtimes.
- **MCP server tools** — `solana_mpp_challenge_handler`, `solana_streaming_session_{create,list,revoke,settle}`, `solana_streaming_voucher_{sign,verify}`.
- **CLI commands** — `session create / list / spend / revoke / history / settle`, `mpp challenge / config`.
- **render-web routes** — `/api/mpp/{challenge,settle,config}` and `/api/streaming/sessions/*`, all gated by the dev-layer-1 + allowlisted-wallet pattern that AP2 and ACP use.
- **Settlement cron** — `agentic-streaming-settlement` (every minute) materializes settlements: candidates = sessions with unsettled vouchers AND (expired OR revoked OR spent ≥ 90% of cap). Per-session lock + chunked SPL Token transferChecked via the delegate, settlement evidence receipt per chunk.
- **Database migrations** 013 (`streaming_sessions`), 014 (`streaming_vouchers`), 015 (`mpp-config` namespace doc).

### Plan reference

The detailed plan, sub-agent assignment matrix, and pre-mainnet release gate live at `/Users/devlegacy/.claude/plans/set-effort-delightful-prism.md` (Phases 0–5).
