# @solana-agent-wallet-adapter/streaming-sessions

Phase 0 scaffolding for the non-custodial streaming-payments primitive on Solana.

**Model:** the user signs one SPL Token `Approve` instruction granting a bounded
delegate authority to a session-scoped ephemeral signer. The agent then signs
off-chain vouchers (ed25519) against the cap; render-web verifies, batches, and
settles via the delegate. The user can `Revoke` any time. Time-expiry is
enforced off-chain by render-web; on-chain protection is the delegate cap.

Phase 0 ships:

- `types.ts` — the cross-stream CONTRACT (`SessionGrant`, `Voucher`,
  `SettlementBundle`, `StreamingSessionStatus`) imported by Phases 2B–2E.
- Error classes with stable `code` fields.
- `delegateTx.ts` / `voucher.ts` entry points stubbed to throw
  `StreamingNotImplementedError`.

Phase 2A implements the real bodies. No external Solana dependencies are pulled
in at Phase 0 to keep `pnpm install` fast.
