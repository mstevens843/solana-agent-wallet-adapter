# @solana-agent-wallet-adapter/streaming-sessions

Shared primitives for the non-custodial streaming-payments primitive on Solana.

**Model:** the user signs one SPL Token `Approve` instruction granting a bounded
delegate authority to a session-scoped ephemeral signer. The agent then signs
off-chain vouchers (ed25519) against the cap; render-web verifies, batches, and
settles via the delegate. The user can `Revoke` any time. Time-expiry is
enforced off-chain by render-web; on-chain protection is the delegate cap.

This package ships:

- `types.ts` — the cross-stream CONTRACT (`SessionGrant`, `Voucher`,
  `SettlementBundle`, `StreamingSessionStatus`) imported by Phases 2B–2E.
- `voucher.ts` — ed25519 ephemeral keypair generation, canonical voucher
  hashing, signing, verification, amount conversion, and session validation.
- `delegateTx.ts` — unsigned SPL Token delegate `Approve`, `Revoke`, and
  batched `TransferChecked` settlement transaction builders.
- Error classes with stable `code` fields for route layers and clients.

Amounts are decimal token strings (for example, `"0.05"`). Transaction builders
convert to raw SPL Token u64 amounts at the boundary; USDC-style 6 decimals are
the default unless callers pass `tokenDecimals`.
