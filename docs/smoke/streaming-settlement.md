# Streaming Settlement Smoke Test

**Phase 5.11 deliverable.** Pre-mainnet release-gate procedure for the
streaming-payment session primitive. Must pass cleanly on devnet before any
mainnet wallet has the streaming feature flag flipped on.

The driver script is `scripts/smoke-streaming-settlement.mjs`; this doc is the
runbook companion that explains the operator setup the script can't automate
(funded keys, devnet airdrops, USDC source).

## Prerequisites

| What | Where | Notes |
|---|---|---|
| Local render-web | `apps/render-web/` | `pnpm -F render-web build && pnpm -F render-web start` |
| Wallet keypair (user) | `STREAMING_SMOKE_WALLET_SECRET_KEY` | JSON array of 64 uint8s; the "user" of the session |
| Encryption master key | `STREAMING_SESSION_ENCRYPTION_KEY` | `openssl rand -base64 32` |
| USDC source ATA on devnet | derived from wallet keypair + devnet USDC mint | Must hold at least the session cap |
| Recipient pubkey | `STREAMING_SMOKE_RECIPIENT_PUBKEY` | Any devnet wallet; the session sends vouchers here |
| Authorized session cookie | `AGENTIC_SMOKE_COOKIE` | `agentic_session=<token>`; obtained via `/api/auth/*` after the wallet signs the login challenge |
| Devnet RPC URL | `AGENTIC_RPC_URL` | Default `https://api.devnet.solana.com` |

## Funding the wallet with devnet USDC

The script will refuse to run if the wallet's USDC ATA holds less than the
session cap. To fund:

```bash
# 1. Airdrop devnet SOL to pay for the ATA creation + the session's
#    delegate prefund (~0.005 SOL per session by default).
solana airdrop 1 <wallet-pubkey> --url devnet

# 2. Create the USDC ATA if it doesn't exist (devnet test mint).
spl-token create-account 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU --url devnet

# 3. Mint test USDC from a devnet faucet (https://spl-token-faucet.com,
#    https://faucet.solana.com, etc.) or transfer from another devnet wallet.
```

Note: the wallet must hold enough SOL to cover both the `Approve` tx fee AND
the per-session delegate prefund (`STREAMING_DELEGATE_PREFUND_LAMPORTS`).
The cron sweeps the leftover prefund back after settlement, but the wallet
still needs to front it at session-open time.

## End-to-end procedure

1. **Precheck.** Run `node scripts/smoke-streaming-settlement.mjs --help` to
   confirm all required env vars are set and the wallet has enough USDC.

2. **Create session.** With your authorized cookie:
   ```bash
   curl -X POST http://127.0.0.1:3000/api/streaming/sessions \
     -H "cookie: $AGENTIC_SMOKE_COOKIE" \
     -H "content-type: application/json" \
     -d '{"tokenMint":"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU","capAmount":"0.30","expiresAt":"<+10min ISO>","cluster":"devnet"}'
   ```
   Expect `{ sessionId, approveTx, ephemeralSignerPubkey }`. The session
   starts in `pending` status.

3. **Sign + submit approveTx.** Deserialize `approveTx` (base64), sign with
   the wallet keypair, submit via RPC. Then POST the resulting signature back:
   ```bash
   curl -X POST http://127.0.0.1:3000/api/streaming/sessions/<id>/grant-signed \
     -H "cookie: $AGENTIC_SMOKE_COOKIE" \
     -H "content-type: application/json" \
     -d '{"approveTxid":"<signature-base58>"}'
   ```
   Session should now be `active`.

4. **Spend vouchers.** Issue `voucher-relay` requests (server-relayed
   signing; cleaner for the smoke than wiring Android device-agent):
   ```bash
   for nonce in n1 n2 n3; do
     curl -X POST http://127.0.0.1:3000/api/streaming/sessions/<id>/voucher-relay \
       -H "cookie: $AGENTIC_SMOKE_COOKIE" \
       -H "content-type: application/json" \
       -d "{\"amount\":\"0.10\",\"recipient\":\"$STREAMING_SMOKE_RECIPIENT_PUBKEY\",\"nonce\":\"$nonce\"}"
   done
   ```
   Each call returns `{ accepted: true, remaining: "..." }`. After the 3rd
   voucher, `remaining` should be `"0.00"`.

5. **Materialize settlement.** Either let the cron tick (`agentic-streaming-settlement`
   every minute) or trigger manually:
   ```bash
   pnpm -F @solana-agent-wallet-adapter/render-web streaming:settle
   ```
   Output: `Agentic streaming settlement settled=1 failed=0 skipped=0`.

6. **Verify on-chain.** Fetch the receipt:
   ```bash
   curl -H "cookie: $AGENTIC_SMOKE_COOKIE" \
     http://127.0.0.1:3000/api/streaming/sessions/<id>/receipt
   ```
   The receipt's `metadata.settlementTxid` should appear on the devnet
   explorer as a `transferChecked` from `sourceAta` → recipient ATA, signed
   by the session delegate keypair, fee-payer is your env-configured account.

7. **Revoke.** Build the revoke tx and submit:
   ```bash
   curl -X POST http://127.0.0.1:3000/api/streaming/sessions/<id>/revoke \
     -H "cookie: $AGENTIC_SMOKE_COOKIE" \
     -H "content-type: application/json" \
     -d '{}'
   # ⇒ { revokeTx: "<base64>", session: {...} }
   ```
   Deserialize, sign with wallet, submit via RPC, then POST:
   ```bash
   curl -X POST http://127.0.0.1:3000/api/streaming/sessions/<id>/revoke-signed \
     -H "cookie: $AGENTIC_SMOKE_COOKIE" \
     -H "content-type: application/json" \
     -d '{"revokeTxid":"<signature>"}'
   ```
   Session moves to `revoked`. Any subsequent voucher-relay attempt should
   return `409 session_revoked`.

## Pass criteria

- [ ] Create session returns a valid base64 `approveTx` and `ephemeralSignerPubkey`.
- [ ] Approve tx confirms on devnet within ~30s.
- [ ] Each voucher-relay accepts and decrements `remaining` correctly.
- [ ] Settlement tx confirms within ~60s of the cron tick.
- [ ] Settlement receipt has `signature: ''` (P5.9) and the txid in `metadata.settlementTxid`.
- [ ] Settlement receipt summary mentions the recipient.
- [ ] Revoke tx confirms; subsequent voucher returns 409.
- [ ] Session delegate balance decreases by ~0.000005 SOL per settlement tx.
- [ ] After the session reaches a terminal state, `maybeSweepDelegate` sweeps
      the leftover prefund back to the wallet (verify wallet balance ticks up).

## Negative paths

- **Replay**: re-POST the same voucher (same `nonce`). Expect 409 `voucher_replay`.
- **Cap exceeded**: POST a voucher that pushes spent past cap. Expect 400 `voucher_exceeds_remaining`.
- **Expired session**: wait past `expiresAt`, then POST. Expect 410 `session_expired`.
- **Wrong wallet cookie**: POST with a different session cookie. Expect 404 `session_not_found`.

## Reconcile after a failed settlement (P5.4 verification)

To exercise the reconcile-on-retry path:

1. Run the cron once, then kill the process mid-confirmation (Ctrl-C while
   the settlement tx is in flight). The session's `metadata.lastSettlementAttempt`
   will hold the txid.
2. The on-chain tx may still confirm.
3. Run the cron again. It should detect the confirmed prior tx, mark
   vouchers settled with the discovered txid, and skip submitting a fresh
   transaction. Fee-payer balance only decreases once.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `streaming_encryption_key_too_short` | `STREAMING_SESSION_ENCRYPTION_KEY` is <32 bytes. Regenerate with `openssl rand -base64 32`. |
| `insufficient funds for rent` in settlement log | Session delegate ran dry. Top up by sending SOL to the session's `delegate_pubkey`, or raise `STREAMING_DELEGATE_PREFUND_LAMPORTS` for new sessions. |
| `voucher_invalid_signature` on a voucher you just signed | Wallet keypair doesn't match `ephemeralSignerPubkey`. Re-check the session detail endpoint to confirm. |
| Settlement cron logs settle=0 with vouchers waiting | Threshold not yet reached. Spend closer to cap, wait for expiry, or set `STREAMING_SETTLEMENT_THRESHOLD_BPS=1000` for a low-threshold run. |
