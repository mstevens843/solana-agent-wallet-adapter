# @solana-agent-wallet-adapter/mpp-adapter

Machine Payments Protocol (MPP) adapter for HTTP-402 agent payments. MPP is an
open standard for agent payments co-authored by Stripe + Tempo
([mpp.dev](https://mpp.dev/)). This package mirrors the structure of
`packages/ap2-adapter` and ships:

- `parseMppChallenge()` — JSON parse with forbidden-secret scan + size cap.
- `verifyMppChallenge()` — expiry/nonce/payment-method validation, rail and mint policy, canonical hash.
- `challengeToApprovalParams()` — translate to the universal `SigningRequest` shape
  with `metadata.connectorId = 'mpp'`.
- `buildMppPaymentReceipt()` — deterministic, signable evidence receipt.
