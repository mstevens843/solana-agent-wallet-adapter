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
   recipient, and amount within the remaining cap.
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

## Verification

- `pnpm --filter @solana-agent-wallet-adapter/render-web exec tsc -p tsconfig.json`
- `pnpm --filter @solana-agent-wallet-adapter/render-web exec vitest run src/__tests__/mpp-api.test.ts --no-cache --reporter=verbose`
- `pnpm --filter @solana-agent-wallet-adapter/browser-demo test -- mppClient externalAgents`
- `pnpm --filter @solana-agent-wallet-adapter/mcp-server exec vitest run src/__tests__/server.test.ts --no-cache --reporter=verbose`
- `pnpm --filter @solana-agent-wallet-adapter/mcp-server build`
- `pnpm --filter @solana-agent-wallet-adapter/browser-demo build`
- `pnpm --filter @solana-agent-wallet-adapter/render-web build`
