# MPP Session Payments Plan

## Product Boundary

MPP session payments live in `More -> Agent Payments -> Incoming Requests`.
Do not add a new top-level tab. The Sessions tab remains the bounded-spend
control panel and voucher ledger.

This is not Stripe Checkout Sessions, Stripe PaymentIntents, or ACP checkout.
It is a Solana-native bounded SPL-token session used as the payment rail for
eligible MPP challenges.

## Implemented Phase 0

- `GET /api/mpp/inbound` lists MPP approvals with active-session eligibility.
- `POST /api/mpp/session-pay` matches an active streaming session, issues a
  signed voucher, records the MPP -> session -> voucher link, and returns a
  receipt for default `voucher_accepted` finality.
- `metadata.requiredFinality = "settlement_confirmed"` keeps the MPP approval
  pending until streaming settlement confirms on chain.
- Streaming voucher records now persist metadata so voucher settlement can
  update the linked MPP approval and receipt.
- Agent Payments -> Incoming Requests now shows AP2 and MPP requests together
  and exposes `Pay with Session` for eligible MPP rows.
- Local Vite dev API loads MPP and streaming routes against the same in-memory
  store, so `/app` can test the complete flow.

## Test Flow

1. Create a streaming session in `More -> Sessions`.
2. Sign/activate the session grant.
3. Create or receive an MPP challenge for the same wallet, cluster, SPL mint,
   recipient, and amount within the remaining cap. For local testing, use
   `More -> Agent Payments -> Incoming Requests -> Create MPP challenge`.
4. Open `More -> Agent Payments -> Incoming Requests`.
5. Click `Pay with Session`.
6. Confirm the Sessions tab shows one accepted voucher and reduced remaining
   cap.
7. For strict challenges, force or wait for session settlement and verify the
   MPP request moves from `approval_pending` to `approved`.

## Implemented Follow-Up Phases

Phase 1: MCP Tooling

- Added `solana_mpp_pay_with_session`, which calls `/api/mpp/session-pay`
  with `approvalId` and optional `sessionId`.
- The tool returns the backend session-payment response, including finality,
  voucher, remaining cap, receipt, and idempotent status.

Phase 2: Product UX Hardening

- Incoming Requests now shows all eligible sessions and renders a selector
  when more than one can pay the challenge.
- Rows show remaining cap, expiry, recipient, finality, and a warning when
  payment consumes at least 50% of the selected remaining cap.

Phase 3: Operations And Receipts

- Strict settlement finalization now detects duplicate MPP session-payment
  evidence by approval id, voucher hash, receipt hash, and settlement txid.
- MPP session-payment settlement evidence and audits carry searchable metadata:
  `mppSessionPayment`, `linkType`, `settlementTxid`, session id, voucher hash,
  approval id, challenge hash, and merchant fields where available.

Phase 4: Policy Surface

- `mpp-config.sessionPolicy` supports merchant ids, merchant/resource URLs,
  merchant/resource origins, shared origins, recipients, max amount, and
  `requireSettlementConfirmed`.
- Policy results are stored as metadata on eligibility, vouchers, and the
  MPP session-payment link. Voucher signatures are unchanged.

Phase 5: Production Hardening

- Session-pay re-checks challenge expiry, current wallet MPP config, terminal
  approval state, and supported rails/mints at execution time.
- Android-native streaming sessions are shown as ineligible for the web
  session-pay route because their delegate key is not held by the server.
- Multiple eligible sessions are selected deterministically: recipient
  allowlist match, soonest expiry, smallest sufficient remaining cap, then
  newest creation time.
- Voucher issuance is idempotent by MPP approval id, including a Postgres
  uniqueness guard for concurrent duplicate attempts.
- `mpp-config` is now exposed through the generic cloud preferences API and
  the Payment Profile tab has an MPP policy editor with separate merchant,
  resource, shared-origin, recipient, mint, and settlement-finality controls.
- Immediate `voucher_accepted` receipts now carry the same searchable
  MPP/session/voucher metadata as settlement-confirmed receipts.
- Session-pay retries recover full receipt/evidence metadata when a prior
  attempt accepted the voucher but failed before saving the approval link.
- The MPP demo challenge prefers an active server-owned USDC streaming session
  recipient when one exists, which makes the local `Create MPP challenge` test
  path line up with the current session allowlist.
- MCP exposes both `solana_mpp_list_inbound_requests` and
  `solana_mpp_pay_with_session` for read-before-pay agent flows.

## Troubleshooting

- If `Pay with Session` is missing, check that the active session is
  server-owned, SPL-token based, on the same cluster, unexpired, and has enough
  remaining cap for the challenge amount.
- If a challenge says `recipient_not_allowed`, create the session with the MPP
  recipient in the recipient allowlist or leave the allowlist empty.
- If a challenge says `origin_not_allowed`, the shared-origin policy requires
  every present merchant/resource origin to be listed. Use the merchant-origin
  and resource-origin fields when those should be constrained separately.
- If strict settlement is enabled, the row stays pending until the streaming
  settlement job confirms on chain and writes the settlement receipt.

## Verification

- `pnpm --filter @solana-agent-wallet-adapter/render-web exec tsc -p tsconfig.json`
- `pnpm --filter @solana-agent-wallet-adapter/browser-demo exec tsc -p tsconfig.json`
- `pnpm --filter @solana-agent-wallet-adapter/render-web exec vitest run src/__tests__/mpp-api.test.ts --no-cache --reporter=verbose`
- `pnpm --filter @solana-agent-wallet-adapter/render-web exec vitest run src/__tests__/server.test.ts --no-cache --reporter=verbose`
- `pnpm --filter @solana-agent-wallet-adapter/browser-demo exec vitest run src/__tests__/mppClient.test.ts src/devTabs/__tests__/externalAgents.test.ts src/devTabs/__tests__/agentCard.test.ts --no-cache --reporter=verbose`
- `pnpm --filter @solana-agent-wallet-adapter/mcp-server exec vitest run src/__tests__/server.test.ts --no-cache --reporter=verbose`
- `pnpm --filter @solana-agent-wallet-adapter/mcp-server build`
- `pnpm --filter @solana-agent-wallet-adapter/browser-demo build`
- `pnpm --filter @solana-agent-wallet-adapter/render-web build`
