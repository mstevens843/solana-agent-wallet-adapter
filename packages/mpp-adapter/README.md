# @solana-agent-wallet-adapter/mpp-adapter

Phase 0 scaffolding for the Machine Payments Protocol (MPP) adapter. MPP is an
HTTP-402-based open standard for agent payments co-authored by Stripe + Tempo
([mpp.dev](https://mpp.dev/)). This package mirrors the structure of
`packages/ap2-adapter` and will, in Phase 1, ship:

- `parseMppChallenge()` — JSON parse with forbidden-secret scan + size cap.
- `verifyMppChallenge()` — expiry/nonce/payment-method validation, canonical hash.
- `challengeToApprovalParams()` — translate to the universal `SigningRequest` shape
  with `metadata.connectorId = 'mpp'`.
- `buildMppPaymentReceipt()` — deterministic, signable evidence receipt.

All Phase 0 entry points throw `not_implemented` errors so Phase 1 can be picked
up by a single sub-agent without merge conflicts.
