# Render Streaming Sessions — Disaster Recovery Runbook

**Phase 5.12 deliverable.** Operator-facing procedures for the failure modes
the streaming-payment session primitive can hit in production. Each section
documents: detection (how to spot it), immediate action (next 5 minutes),
recovery (back-to-normal), and prevention (so it doesn't recur).

The full mainnet release gate lives in
[`/Users/devlegacy/.claude/plans/set-effort-delightful-prism.md`](../../README.md)
Phase 5; this runbook is one of the load-bearing artifacts.

## 1. Encryption key lost

**Symptom.** Cron logs `streaming_encryption_key_missing` or
`delegate_key_invalid` for every active session. Sessions are stuck —
`acceptVoucher` may still succeed (vouchers are stored), but settlement
can't decrypt the delegate keypair so nothing ever lands on-chain.

**Detection.** Tail render logs:

```bash
grep -E 'streaming_encryption_key|delegate_key_(missing|invalid|mismatch)' <render-logs>
```

A persistent stream of these for >1 cron tick is the signal.

**Immediate action.**

1. Confirm the env var is actually unset / wrong:
   ```bash
   render dashboard → service → environment → STREAMING_SESSION_ENCRYPTION_KEY
   ```
   If it's `unset` or visibly truncated, the rotation/redeploy lost it.
2. If you have the prior value in a secret manager: restore it and redeploy.
   The cron picks it up on the next tick and resumes settlement.

**Recovery (key truly lost).**

- Old sessions encrypted with the lost key cannot be decrypted. The delegate
  authority on-chain is still active, but render-web can no longer sign
  settlement transactions for them.
- Communicate to affected wallet owners: they should `Revoke` the SPL Token
  approval on-chain themselves. Revoke doesn't need the delegate key — it
  only needs the wallet's own signature. Phantom / Solflare / etc. all
  surface the active approvals in their token-account view.
- Once revoked, the session can be marked `revoked` server-side (manual SQL
  if the revoke-signed callback can't run):
  ```sql
  UPDATE streaming_sessions
  SET status = 'revoked', updated_at = now(),
      revoke_txid = '<txid the user submitted>'
  WHERE id = '<session-id>';
  ```
- Generate a fresh `STREAMING_SESSION_ENCRYPTION_KEY` and redeploy:
  ```bash
  openssl rand -base64 32   # paste into Render env
  ```
- Affected users open new sessions with the new key; their old vouchers
  are effectively lost.

**Prevention.**

- Back up the encryption key in a SEPARATE secrets manager from Render's
  env (AWS Secrets Manager, HashiCorp Vault, 1Password Business).
- Test the restore procedure quarterly.
- Future v1.1: ship `metadata.streamingDelegateKey.v = 2` with a `kid` field
  so multiple keys can coexist during rotation. Tracked at P5 §1.2 in the
  security review.

## 2. Fee-payer account depleted

**Symptom.** Cron logs `insufficient funds for rent` or
`AccountNotFound: fee_payer_account` on every settlement attempt.

**Detection.**

```bash
grep -E 'session=stream_[a-z0-9-]+ failed.*insufficient' <render-logs>
```

The grep narrows to the specific session id whose delegate ran dry.

**Immediate action.**

1. Identify the affected session's delegate pubkey:
   ```sql
   SELECT id, delegate_pubkey FROM streaming_sessions WHERE id = '<session-id>';
   ```
2. Top up the delegate from an operator wallet (this is a rescue; the
   per-session prefund should normally cover hundreds of settlements):
   ```bash
   solana transfer <delegate-pubkey> 0.005 \
     --from /path/to/operator-wallet.json \
     --url mainnet-beta
   ```
3. The cron retries on the next tick and the session settles.

**Recovery.** None beyond the top-up. The P5.4 reconcile path ensures no
double-submit if a previous attempt did land.

**Prevention.**

- If many sessions hit this in production, raise
  `STREAMING_DELEGATE_PREFUND_LAMPORTS` for new sessions. Existing sessions
  keep their original prefund (it's locked at session-open time).
- Accept the trade-off: this architecture intentionally moves the blast
  radius from "platform wallet drained" to "one session at a time" —
  operators occasionally rescue individual sessions instead of running a
  shared honeypot.

## 3. Postgres restored from backup AFTER an encryption-key rotation

**Symptom.** After a Postgres point-in-time restore, sessions that were
created post-rotation but exist in the backup (pre-rotation) suddenly fail
to decrypt with `delegate_key_invalid`.

**Detection.** Same as §1, but the failures correlate with sessions whose
`created_at` is after your last known key rotation.

**Immediate action.**

1. Stop the cron temporarily (`Render dashboard → service → suspend`) to
   avoid burning fee-payer SOL on failed settlements.
2. Identify affected sessions:
   ```sql
   SELECT id, wallet_address, created_at FROM streaming_sessions
   WHERE created_at >= '<key-rotation-timestamp>' AND status = 'active';
   ```

**Recovery.**

- For each affected session, treat it as §1 (key lost): the owner must
  `Revoke` on-chain; mark the session `revoked` server-side; advise them to
  open a fresh session.
- Resume the cron.

**Prevention.**

- Snapshot the encryption key alongside every Postgres backup. Store the
  pair atomically in your secrets manager (e.g. one secret per `<date,
  region, db_snapshot_id>`).
- Document the relationship between backups and key rotations in your
  ops handbook.

## 4. Settlement stuck — same vouchers retried indefinitely

**Symptom.** A session's `unsettled_voucher_count > 0` for many ticks; cron
logs show repeated submission attempts but no `settled` count increment.

**Detection.**

```bash
grep '[streaming-settlement] session=<id>' <render-logs> | tail -50
```

If you see 10+ `failed` entries for the same session and the on-chain SPL
Token delegate state still shows non-zero remaining, settlement is stuck.

**Immediate action.**

1. Query the chain for the session's source ATA delegated amount:
   ```bash
   spl-token account-info $SOURCE_ATA --url mainnet-beta
   # Look for "Delegate" and "Delegated Amount" fields
   ```
2. If `Delegated Amount` shows the vouchers' total is still available, the
   delegate is intact — the issue is render-web-side (RPC errors, fee-payer
   depleted, encryption key issue). Apply §2 or §1 fix.
3. If `Delegated Amount` shows the vouchers were already debited (e.g. an
   earlier tx landed but render-web didn't reconcile), force a reconcile by
   triggering settlement manually:
   ```bash
   curl -X POST http://render-web/api/streaming/sessions/<id>/settle \
     -H "cookie: $OPERATOR_SESSION_COOKIE"
   ```
   The settleStreamingSession endpoint runs the same `reconcileLastSettlementAttempt`
   (P5.4) path that the cron does and will mark vouchers settled with the
   discovered txid.

**Recovery.** After the reconcile completes, the session should transition
to `settled` once `markSessionSettledIfTerminal` fires (either when all
vouchers are settled, or when `expires_at` is past).

**Prevention.**

- Make sure the cron's `lookupSignatureStatus` has `searchTransactionHistory: true`
  (already wired in `defaultLookupSignatureStatus`) so it can find txids
  past the current epoch's slot window.
- Don't rotate `STREAMING_TEST_*` env vars accidentally on production.

## 5. Migration apply failed mid-deploy

**Symptom.** `pnpm db:migrate` (pre-deploy hook) errors out partway
through. Schema is in a half-applied state.

**Immediate action.**

1. Identify the failing migration:
   ```bash
   psql $DATABASE_URL -c "SELECT id, applied_at FROM agentic_migrations ORDER BY applied_at DESC LIMIT 5;"
   ```
   The most-recent successful one is the floor; the failing one is the one
   that wasn't recorded.
2. Roll back to the floor:
   ```bash
   pnpm -F @solana-agent-wallet-adapter/render-web db:rollback <floor-id>
   ```
   (Each `down` SQL is idempotent — `DROP TABLE IF EXISTS`.)

**Recovery.**

- Investigate why the migration failed (likely a syntax issue or a missing
  prior table dep). Patch the migration file, push the fix, retry deploy.
- The runner uses an advisory lock so concurrent deploys can't race.

**Prevention.**

- Always test migration apply + rollback against a copy of production
  Postgres before deploying. The smoke procedure in
  [`render.md`](./render.md) covers this.

## 6. Cron worker crashes mid-settlement

**Symptom.** Render logs show the cron container exited with a non-zero
code. A settlement tx may or may not have landed on-chain. The session has a
stale `streamingSettlementLock` in its metadata.

**Immediate action.** Nothing required — Render's cron scheduler reruns at
the next minute boundary. The lock's TTL (default 55s) ensures the next
cron tick can claim the session normally.

**Recovery.** The next tick's `reconcileLastSettlementAttempt` will detect
any previously-submitted tx and either mark vouchers settled (if the tx
confirmed despite the crash) or clear the breadcrumb and submit fresh.

**Prevention.**

- The TTL heartbeat (P5.6) extends the lock between chunks during normal
  operation, so this stale-lock window only opens if the worker dies
  between chunks.
- For high-volume sessions, set `STREAMING_LOCK_TTL_MS=120000` to give
  longer settlements more headroom.

## On-call quick reference

| Symptom (one-liner) | Section |
|---|---|
| `streaming_encryption_key_missing` in logs | §1 |
| `insufficient funds for rent` in logs | §2 |
| `delegate_key_invalid` for new-ish sessions after a restore | §3 |
| Same session keeps failing settlement | §4 |
| Pre-deploy `db:migrate` errors | §5 |
| Cron container crashed mid-tick | §6 |

When in doubt: **pause the cron**, **read the most recent logs**, **don't
mass-mutate the database** (every failure mode here has a graceful recovery
that doesn't require dropping tables). Document the incident in the
ops-channel post-mortem template.
