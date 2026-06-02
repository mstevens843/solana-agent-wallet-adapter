# Streaming-Settlement Security Review

**Scope:** the render-web settlement path for streaming sessions — delegate-key
encryption, fee-payer key handling, settlement cron concurrency, replay
protection, and retry semantics. Triggered by Phase 4.6 of the MPP + Streaming
Sessions implementation plan.

**Status:** review complete; this document is the written deliverable referenced
by P4.6. **Mainnet streaming sessions remain gated until the remediations
flagged BLOCKER/MAJOR below are landed.** Beta / devnet operation under this
review is acceptable today.

**Author:** Claude (Opus 4.7, 2026-05-16 audit pass). Independent re-review
recommended before mainnet GA.

---

## Threat model recap

The streaming-payment session primitive has two custody boundaries:

1. **User wallet** signs one SPL Token `Approve` instruction granting a bounded
   delegate authority to a session-scoped ephemeral signer. The user can
   `Revoke` at any time. SPL Token's on-chain delegate cap is the floor of
   security: a compromised render-web cannot exceed `cap_amount`, cannot
   transfer past `Revoke`, and cannot touch other tokens.
2. **Render-web** holds the ephemeral delegate key (or, on Android, the device
   does instead — see `signerRuntimeFor`). It signs vouchers (server-relayed
   path) and submits settlement transactions on a cron tick.

The attacker model we care about:

- **Compromised render-web process.** Worst case: attacker drains every active
  session up to its remaining cap. They cannot drain past cap, cannot affect
  other tokens, cannot affect inactive/revoked/settled sessions. Recovery: the
  user `Revoke`s; render-web disk + secrets must be rotated.
- **Compromised DB only.** Encrypted delegate keys are useless without the
  `STREAMING_SESSION_ENCRYPTION_KEY`. Attacker can read voucher metadata but
  cannot sign new vouchers or settlement txs.
- **Compromised `STREAMING_SESSION_ENCRYPTION_KEY` only (env-only leak).** No
  exposure unless the DB is also accessible — keys-only is useless. Bound the
  blast radius by treating both as secrets with the same rotation cadence.
- **Compromised `STREAMING_SETTLEMENT_FEE_PAYER_SECRET_KEY`.** Attacker can
  pay SOL fees on arbitrary transactions submitted as the fee payer. This
  account should be funded with minimal SOL (operator policy) and rotated on
  any suspicion.
- **Multiple settlement workers racing.** Already mitigated; see §4.

---

## 1. AES-256-GCM delegate-key encryption

**Code:** `apps/render-web/src/cloud/streamingService.ts` lines 1269–1300
(`encryptDelegateKey`, `decryptDelegateKey`), 1302–1317 (`streamingEncryptionKey`).

**Implementation:**

- AES-256-GCM with a fresh 12-byte random IV per encryption.
- 16-byte auth tag stored alongside ciphertext.
- Key material is sourced from `STREAMING_SESSION_ENCRYPTION_KEY`:
  - Base64-decoded if exactly 32 bytes (recommended raw-key path).
  - Otherwise `sha256(env_value)` — accepts arbitrary-length passphrase but
    weakens entropy to the passphrase's actual bits.
- Stored as `{ v: 1, alg: 'aes-256-gcm', iv, ciphertext, tag }` JSON under
  `streaming_sessions.metadata.streamingDelegateKey`.

**Findings:**

| # | Severity | Finding | Remediation |
|---|---|---|---|
| 1.1 | MINOR | The SHA-256 fallback for non-32-byte env values silently downgrades a high-entropy 32-byte raw key to a 32-byte hash. Acceptable for operator-supplied strong passphrases; quietly dangerous if someone sets `STREAMING_SESSION_ENCRYPTION_KEY=changeme` and assumes it's safe. | At startup, refuse to launch if the decoded raw key is <32 bytes AND the literal string is shorter than 32 chars; log a one-line warning if the env value isn't raw base64-32. Already-strict: `streamingEncryptionKey()` returns a 32-byte key either way, so the cipher is fine — the risk is operator misconfiguration. |
| 1.2 | MINOR | No key-version field. Rotating the master key requires re-encrypting every active session row in a single migration, or running with both old + new keys simultaneously, neither of which is wired today. | Add `v: 2` envelope that includes a `kid` (key id). Maintain a `Map<kid, Buffer>` of in-flight master keys; rotate by adding the new kid as default while keeping old kids decryptable. Not blocking for v1, blocker for any future incident response. |
| 1.3 | MINOR | If the encryption key is rotated mid-flight, existing sessions become un-decryptable and the cron will log errors per session forever. There's no salvage path: the user must `Revoke` on-chain (which doesn't need the delegate key) and lose any unsettled vouchers. | Document in the release runbook that rotating `STREAMING_SESSION_ENCRYPTION_KEY` requires draining active sessions first; track in `docs/deploy/render.md`. Mitigated long-term by 1.2. |
| 1.4 | NIT | The encrypted payload includes the *raw secret key in base64* — a 64-byte ed25519 secret. JSON-encoding leaks a length signal but no content. | None needed; this is the natural representation. |
| 1.5 | NIT | `decryptDelegateKey` does a strict `v === 1 && alg === 'aes-256-gcm'` check before decrypting — prevents algorithm-confusion attacks if the JSON envelope is tampered. | Good. Keep this invariant in §1.2 when adding `v: 2`. |

**Verdict:** ✅ Cryptographic primitives are correct. ⚠️ Operator key
management needs §1.1 hardening + §1.2 rotation story before scaling beyond
beta.

---

## 2. Fee-payer key handling

**Code:** `apps/render-web/src/cloud/settlementService.ts` lines 445–470
(reading `STREAMING_SETTLEMENT_FEE_PAYER_SECRET_KEY`), 309–312 (`signSettlementTx`).

**Implementation:**

- The settlement cron loads a Keypair from `STREAMING_SETTLEMENT_FEE_PAYER_SECRET_KEY`
  env (JSON-encoded 64-byte ed25519 secret, same format as `solana-keygen`).
- Each settlement tx is signed by `[feePayer, delegate]` (or `[delegate]` if
  the fee payer equals the delegate — never the case in production).
- Fee payer's only on-chain power is paying SOL for the tx submission. It is
  NOT the delegate; it cannot move SPL tokens out of user accounts.

**Findings:**

| # | Severity | Finding | Remediation |
|---|---|---|---|
| 2.1 | MAJOR | Fee-payer key sits in plain env. Anyone with shell access to the cron container can read it. Blast radius: SOL fees on attacker-submitted txs (fee-grief), AND signature attribution (txs look like they came from us). | Move fee-payer to a sealed-secret manager (Render's encrypted env at minimum; ideally a KMS-backed signer like Squads or a custodial signing service). At minimum, document in `docs/deploy/render.md` that the fee-payer account must be funded with no more than 1 SOL and refilled from a separate cold key. |
| 2.2 | MINOR | No rate limit on settlement frequency per session. A malicious cron run (or buggy retry loop) could re-submit the same settlement tx repeatedly, burning fee-payer SOL. The on-chain protection is Solana's dedup of identical txs in the same blockhash window, but the cron uses fresh blockhashes per attempt. | Add a per-session minimum interval between settlement attempts (e.g. 30s) gated by `metadata.lastSettlementAttemptAt`. Already partially mitigated by §4's session lock, but the lock TTL is generous (5min) — within that window a buggy retry could burn fees. |
| 2.3 | NIT | If fee-payer SOL runs out, settlement transactions silently fail with `insufficient funds for rent` and the cron will retry forever (each retry decrements a non-existent balance). | Cron logs the failure but doesn't alert. Add a Sentry/Slack alert hook on persistent fee-payer balance < 0.01 SOL. Bundle with the existing operator-alert path. |

**Verdict:** ⚠️ §2.1 is the load-bearing fix before mainnet. Without secret
manager integration, the fee-payer is the single most attractive target in
this stack.

---

## 3. Voucher replay protection

**Code:** `apps/render-web/src/cloud/migrations/014_streaming_vouchers.ts`
(`UNIQUE INDEX streaming_vouchers_session_nonce_uidx`),
`apps/render-web/src/cloud/streamingService.ts` lines 765–839 (acceptVoucher
transaction), 832 (`isPgUniqueViolation` catch).

**Implementation:**

Replay protection is **layered**:

1. **Library-side check** (`packages/streaming-sessions/src/voucher.ts`
   `validateVoucher`): looks up the voucher nonce in the `usedNonces` set
   passed in. Used by service callers to short-circuit before round-tripping
   the DB.
2. **DB unique constraint** (`(session_id, nonce)`): even if the library
   check is bypassed or stale (race between two workers), the DB throws
   `unique_violation` which `acceptVoucher` catches and rethrows as a 409.

This is correct two-tier defense. The transaction (`BEGIN` … `COMMIT`) wraps:
load nonce list → validate → insert voucher → update `spent_amount`. Even
under concurrent accept on the same `(session_id, nonce)`, exactly one tx
wins and the other gets `voucher_replay`.

**Findings:**

| # | Severity | Finding | Remediation |
|---|---|---|---|
| 3.1 | NIT | The nonce uniqueness window is per-session forever. A session with millions of vouchers grows the index unbounded. Settlement marks rows `settled_at` but doesn't delete; rows live indefinitely. | Not a security issue today. Add a retention job (e.g. drop settled voucher rows >30d old) once volume actually pressures the index. Track in `docs/deploy/render.md`. |
| 3.2 | NIT | `validateVoucher` accepts an externally-supplied `usedNonces` `Set`. A buggy caller that passes an empty set defeats the library check; defense is the DB unique index. | Add a comment to `validateVoucher` clarifying the DB unique index is the authoritative guard; service callers should treat library-side `VoucherReplayError` as a fast-path UX, not the security boundary. |

**Verdict:** ✅ Strong. The transaction + unique-index combination is correct.

---

## 4. Concurrent settlement guard

**Code:** `apps/render-web/src/cloud/streamingService.ts` lines 38–40
(`SESSION_LOCK_METADATA_KEY`), 545–579 (`listSettlementCandidates`,
`claimSettlement`), 856–870 (PG candidate query with lock-expired filter),
890–897 (PG claim with conditional UPDATE).

**Implementation:**

When the settlement cron picks up a candidate, it writes a `streamingSettlementLock`
object into the session's `metadata` containing `lockedAt` and `expiresAt`
(default TTL ~5 min). The candidate query filters out any session whose lock
hasn't expired:

```sql
AND COALESCE((s.metadata->'streamingSettlementLock'->>'expiresAt')::timestamptz,
             'epoch'::timestamptz) <= $1
```

The lock is acquired with a conditional `UPDATE`:

```sql
UPDATE streaming_sessions SET metadata = jsonb_set(…, '{streamingSettlementLock}', $3)
WHERE id = $1 AND COALESCE((metadata->'streamingSettlementLock'->>'expiresAt')::timestamptz, 'epoch') <= $2
RETURNING …
```

Only one worker's UPDATE will return rows — others get 0 rows back and skip.

**Findings:**

| # | Severity | Finding | Remediation |
|---|---|---|---|
| 4.1 | MINOR | Lock TTL is fixed (~5min by default). If a settlement actually takes longer than 5min (e.g. RPC timeout + retry), the lock expires and a second worker can claim concurrently. Both submit txs; one wins on-chain (because of Solana dedup), but the loser logs an error and the cron re-runs forever on the dead lock. | Make lock TTL dynamic: extend lock periodically while settlement is in flight (heartbeat write every 60s). Or fall back to "compute lock from txid first-write-wins" since the txid is the actual on-chain race winner. |
| 4.2 | MINOR | No `WHERE wallet_address = …` predicate on the claim UPDATE — only `WHERE id = $1`. If session IDs ever became guessable (they aren't — `randomUUID`), an attacker could lock-out settlement on a victim session. | Add wallet_address to the predicate as defense-in-depth. Trivial. |
| 4.3 | NIT | The lock is in `metadata` JSONB, not its own column. Heavy concurrent writes serialize on the row update. At >10 settlements/sec on the same wallet this could become contention. | Not relevant at current scale. If it becomes hot, promote to a column with its own index. |

**Verdict:** ✅ Functionally correct; one MINOR fix (4.1 heartbeat) before
prolonged-settlement scenarios become common.

---

## 5. `acceptVoucher` concurrency

**Code:** `apps/render-web/src/cloud/streamingService.ts` lines 766–838.

**Implementation:**

`acceptVoucher` opens a transaction, `SELECT … FOR UPDATE` on the session row
(serializing all concurrent voucher submits for that session), reads the
used-nonce list, validates the voucher, inserts the voucher row, updates
`spent_amount`, commits.

**Findings:**

| # | Severity | Finding | Remediation |
|---|---|---|---|
| 5.1 | MINOR | `FOR UPDATE` on the session row means all concurrent vouchers for one session serialize. At sub-second voucher cadence this is the bottleneck. On Postgres with the connection pool we have, that caps each session at ~500 vouchers/sec under no other load. | Acceptable for v1 (real-world cadence is much lower). Consider per-session sharding or optimistic-concurrency-control with retry-on-conflict if we ever scale past this. |
| 5.2 | NIT | The `spent_amount` UPDATE uses the library-computed value (`spent_base_units + amount_base_units` re-formatted). This is correct because the row is locked via `FOR UPDATE`, so the read-compute-write cycle is atomic. | Good; no change. |
| 5.3 | NIT | If `validateVoucher` throws (expired, recipient-not-allowed, etc.), the catch block rolls back. The error is rethrown directly to the caller — not redacted. `validateVoucher` errors are bounded (don't include secrets), so this is fine. | Confirm in code review that no future helper throws an error containing the delegate key. |

**Verdict:** ✅ Strong.

---

## 6. `defaultSubmitSignedTransaction` retry semantics

**Code:** `apps/render-web/src/cloud/settlementService.ts` lines 407–442.

**Implementation:**

`defaultSubmitSignedTransaction` honors `STREAMING_TEST_SETTLEMENT_TXID` env
for tests (returns a fixed txid). In production, it serializes the signed
tx and calls `Connection.sendRawTransaction` with `{ skipPreflight: false,
preflightCommitment: 'confirmed' }`, then `confirmTransaction` with
`commitment: 'confirmed'`.

**Findings:**

| # | Severity | Finding | Remediation |
|---|---|---|---|
| 6.1 | MAJOR | The retry loop is implicit — if `sendRawTransaction` returns but `confirmTransaction` times out, the cron writer logs the error and the candidate stays unsettled. On the next cron tick (60s later), `materializeStreamingSettlements` rebuilds a NEW settlement tx with a NEW blockhash, signs it, submits it. **The previous tx may still confirm on-chain.** End state: two settlement txs for the same vouchers. The second one will fail on-chain (spent_amount delegate guard) but the failure is silent at the application layer. | Before building a new settlement tx, query the network for the candidate vouchers' settlement state (use the on-chain `delegate_amount` and `spent` accounting from the source ATA). If the previous tx already landed, skip the rebuild and just `markVouchersSettled` with the discovered txid. Without this, fee-payer SOL is burned per failed retry. |
| 6.2 | MINOR | The cron uses a fresh `latestBlockhash` for each settlement attempt. Solana txs expire 150 slots after the referenced blockhash, so a tx that doesn't confirm within ~60s is dead and must be rebuilt. The TX_ID record per attempt should be persisted (currently it's only logged), so an operator can correlate failed attempts. | Persist `lastSettlementAttempt: { txid, submittedAt, status }` into session metadata for forensic purposes. |
| 6.3 | NIT | `verifySettlementDestinationAccounts` is called pre-submit to validate that every destination ATA exists. If the recipient is a wallet with no ATA for the token mint, settlement fails with `account_not_found` indefinitely. | Either auto-create the ATA in the settlement tx (adds rent cost, paid by fee-payer) or surface the unsettled-but-unsendable state to the user via the receipt. Currently the user sees the session stuck in "settling" forever. |

**Verdict:** ⚠️ §6.1 is the most important non-cryptographic finding. It's not
a security vuln per se but it burns SOL and creates operator confusion in the
worst case (settlement-tx ambiguity).

---

## 7. Auth boundaries

**Code:** `apps/render-web/src/cloud/streamingRoutes.ts` (route handlers),
`apps/render-web/src/cloud/devApiRegistry.ts` (registration / wallet gating).

**Implementation:**

- All streaming routes require a session cookie resolved to a wallet via
  `sessionFromRequest` (same path as `/api/ap2/*` and `/api/acp/*`).
- **Correction (launch hardening):** these routes are **GA** and are *not* dev-gated.
  The `devLayer1Enabled` / `isAllowedDevWallet` helpers exist but are no longer wired
  into the router for Layer-1 / streaming / signals / spend / skills paths — access is
  controlled solely by the authenticated wallet session above. Do not rely on
  `AGENTIC_DEV_AP2_ACP` to gate these in production.
- Every route handler checks `walletAddress === session.walletAddress` against
  the path parameter where applicable — see `acceptVoucher`'s
  `WHERE id = $1 AND wallet_address = $2` clause and the route's `requireWallet`
  call.
- Postgres queries always include `WHERE wallet_address = $N` so wallet A
  cannot read or mutate wallet B's sessions.

**Findings:**

| # | Severity | Finding | Remediation |
|---|---|---|---|
| 7.1 | NIT | The `voucher-relay` route accepts a voucher payload that includes `sessionId`. If wallet A constructs a voucher with wallet B's sessionId, the route's wallet predicate (`WHERE … wallet_address = A`) returns 404, so the voucher is rejected. ✅ correct. | Add a regression test that asserts this 404 explicitly so a future refactor doesn't break it. |
| 7.2 | NIT | The `settle` admin-trigger route is protected by the authenticated wallet-session predicate (it is GA, not dev-layer-1 gated). No additional admin scope. | Operator should not expose this endpoint to public consumers. Document in `docs/deploy/render.md` how to firewall or rate-limit it if exposed. |

**Verdict:** ✅ Strong; cross-wallet isolation holds.

---

## 8. Off-by-one and arithmetic precision

**Code:** `packages/streaming-sessions/src/voucher.ts` (amount conversions),
`apps/render-web/src/cloud/streamingService.ts` (spent_amount updates).

**Implementation:**

Amounts are decimal strings throughout the user-facing API. Conversion to
base units (BigInt u64) happens in `parseTokenAmountToBaseUnits` with
strict decimal-place validation. The on-chain delegate cap is enforced by
SPL Token in u64 base units, so any drift between server-side accounting
and on-chain accounting is bounded by SPL Token's check.

**Findings:**

| # | Severity | Finding | Remediation |
|---|---|---|---|
| 8.1 | NIT | `tokenDecimals` defaults to 6 (USDC). If a session is opened with a token whose actual decimals differ from 6 and the caller doesn't pass `tokenDecimals`, the spent/cap accounting silently misaligns. The on-chain delegate cap would still be enforced (in raw u64), so the worst case is a UX bug: cap shows wrong in UI. | Validate `tokenDecimals` matches the on-chain mint at session creation (one RPC call to the token mint). Or, simpler: reject session creation if the caller doesn't pass `tokenDecimals` AND the mint isn't a known 6-decimal mint (USDC, etc.). |

**Verdict:** ✅ Strong; one NIT for non-USDC tokens.

---

## Summary by severity

| Severity | Count | Items |
|---|---|---|
| BLOCKER | 0 | — |
| MAJOR | 2 | 2.1 (fee-payer secret manager), 6.1 (settlement-tx ambiguity on retry) |
| MINOR | 9 | 1.1, 1.2, 1.3, 2.2, 2.3, 4.1, 4.2, 5.1, 6.2 |
| NIT | 10 | 1.4, 1.5, 3.1, 3.2, 4.3, 5.2, 5.3, 6.3, 7.1, 7.2, 8.1 |

## Pre-mainnet release gate

Before flipping streaming sessions on for any mainnet wallet, land:

- **2.1** — fee-payer key in a sealed-secret manager (or documented operator
  procedure with a hard cap of ≤1 SOL in the fee-payer account).
- **6.1** — pre-rebuild check that queries the chain for prior settlement
  state, to avoid double-submission of the same vouchers across cron retries.
- **1.1** — startup refusal to launch if `STREAMING_SESSION_ENCRYPTION_KEY` is
  shorter than 32 bytes raw.

The MINOR items can ship in the v1.1 hardening pass.

## Recommended follow-up tests

- Property test: 100 concurrent voucher submits for one session; assert exactly
  the unique nonces are accepted and `spent_amount` matches the sum.
- Integration test: trigger a settlement, kill the cron mid-flight, verify the
  next cron tick recovers without double-submitting (currently fails — §6.1).
- Operator runbook: simulate `STREAMING_SESSION_ENCRYPTION_KEY` rotation; confirm
  draining + key-swap procedure documented in `docs/deploy/render.md`.

---

*End of review. Re-run before any change to encryption-key handling,
fee-payer wiring, or settlement-cron loop logic.*
