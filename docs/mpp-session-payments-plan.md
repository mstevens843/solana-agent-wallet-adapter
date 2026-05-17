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

## Parallel Follow-Up Work

Agent 1: MCP Tooling

- Files: `packages/mcp-server/**`
- Add a tool/action that calls `/api/mpp/session-pay` for an eligible approval.
- Do not edit render-web route internals.

Agent 2: Product UX Hardening

- Files: `apps/browser-demo/src/devTabs/externalAgents.*`,
  `apps/browser-demo/src/devTabs/__tests__/externalAgents.test.ts`
- Add session selection when multiple sessions are eligible.
- Add cap-consumption warning copy for large payments.

Agent 3: Operations And Receipts

- Files: `apps/render-web/src/cloud/settlementService.ts`,
  `apps/render-web/src/__tests__/mpp-api.test.ts`
- Add duplicate receipt detection for manually replayed settlement callbacks.
- Add operator-facing audit filters for MPP session-payment links.

Agent 4: Policy Surface

- Files: `packages/workflow/src/**`, `apps/render-web/src/cloud/mppRoutes.ts`
- Add configurable merchant/recipient allowlist policy for MPP session use.
- Keep policy outputs as metadata only; do not change voucher signatures.
