# @solana-agent-wallet-adapter/ap2-adapter

Dev-only library for parsing, verifying, mapping, and receipting Google AP2
(Agent Payments Protocol) inbound mandates inside the Agentic Cloud
wallet-adapter monorepo.

This package is the foundation for the dev-gated AP2 inbound flow shipped in
`apps/render-web/src/cloud/ap2Routes.ts` and surfaced in the browser demo's
"External Agents" tab.

## What it does

1. **Parse** an AP2 IntentMandate or PaymentMandate from JSON (`parseAp2Mandate`).
2. **Verify** the mandate's ed25519 signature, expiry, and recipient/cluster
   binding (`verifyAp2Mandate`).
3. **Map** a verified mandate into a `workflowService.createApproval` payload
   that materializes a normal Approval Inbox card (`mandateToApprovalParams`).
4. **Build** an AP2-spec attestation receipt after the user signs and the
   payment settles on-chain (`buildAp2InboundReceipt`).
5. **Re-parse + tamper-check** a persisted receipt
   (`parseAp2InboundReceipt`, `verifyAp2InboundReceiptHash`).

## Security model

- **Forbidden-secret guard.** Every parsed payload is recursively scanned for
  `privateKey`, `seedPhrase`, `mnemonic`, `delegatedSigner`,
  `unlimitedApproval`, and related keys. The route layer additionally calls
  `assertNoForbiddenWorkflowSecrets` for defense-in-depth.
- **Signed-field mirror check.** The parser asserts that
  `mandate.signedFields.intent` (or `.payment`) is deeply equal to the raw
  top-level subtree. An attacker cannot sign `amount: "1"` and present
  `amount: "1000"`.
- **Recipient binding.** Callers MUST pass
  `verifyAp2Mandate(mandate, { expectedRecipient: session.walletAddress })`
  so a mandate addressed to another wallet is rejected.
- **Cluster binding.** Optional `expectedCluster` rejects cross-cluster replay.
- **Clock skew.** 60 seconds by default; configurable via `clockSkewMs`.
- **Size cap.** Raw JSON input is capped at 64 KiB.
- **Canonical-JSON signing.** RFC 8785 JCS subset: lexicographic key sort, no
  whitespace, deterministic number serialization.
- **No auto-signing.** Every inbound mandate materializes as a normal Approval
  Inbox card; the user signs in their wallet.

## Route-layer contract (MUST / SHOULD)

The route handler in `apps/render-web/src/cloud/ap2Routes.ts`:

- **MUST** call `verifyAp2Mandate` with
  `expectedRecipient = session.walletAddress` before creating the approval.
- **MUST** persist the receipt via `EvidenceService.createReceipt` with
  `kind: 'intent_receipt'` and the AP2 attestation JSON as the payload.
- **MUST** write `audit_events` rows for `ap2.inbound.created` and
  `ap2.inbound.receipt`.
- **SHOULD** trust the mapper's `metadata.ap2VerifiedAgent` as-is; the mapper
  emits `{ agentId, agentLabel, publicKey, verified: true }`, which is what the
  Agent 9 verified-agent badge matches on.
- **SHOULD NOT** extend `WORKFLOW_ACTION_KINDS` for AP2; the approval `kind`
  reuses `transfer_spl` / `transfer_sol` so the existing wallet UX applies.
- **MUST NOT** auto-sign or auto-execute. The wallet decides.

## Usage

```ts
import {
  buildAp2InboundReceipt,
  mandateToApprovalParams,
  parseAp2Mandate,
  verifyAp2Mandate,
} from '@solana-agent-wallet-adapter/ap2-adapter';

const mandate = parseAp2Mandate(rawJsonBody);
const { agent } = verifyAp2Mandate(mandate, {
  expectedRecipient: session.walletAddress,
  expectedCluster: 'mainnet-beta',
});
const approvalParams = mandateToApprovalParams(mandate, agent, session.walletAddress);
const approval = await workflowService.createApproval(session, approvalParams);

// ...later, after the user signs and the tx confirms...
const receipt = buildAp2InboundReceipt({
  mandate, agent,
  approval: { id: approval.id, kind: approvalParams.kind },
  txid, walletAddress: session.walletAddress, cluster: 'mainnet-beta',
});
await evidenceService.createReceipt(session, {
  kind: 'intent_receipt',
  payload: receipt as unknown as JsonObject,
  // ...
});
```

## Errors

- `Ap2ParseError` — structural / forbidden-secret / receipt-shape failures.
  `code` is stable (e.g., `missing_field`, `invalid_field`, `forbidden_secret`,
  `mandate_too_large`, `signed_fields_mismatch`, `invalid_receipt:bad_hash`).
- `Ap2VerifyError` — signature / expiry / binding failures. `code` is one of:
  `expired`, `invalid_expiry`, `invalid_public_key`, `invalid_signature`,
  `bad_signature`, `recipient_mismatch`, `cluster_mismatch`.

## Out of scope

- **Replay protection.** The route layer SHOULD dedup on `mandateId`; this
  package does not maintain state.
- **MCP server tools.** Deferred per the Layer-1 parent plan.
- **Public launch.** All AP2 surfaces are dev-gated by wallet pubkey.
- **Outbound payments / ACP carts.** See `packages/acp-adapter`.

## Dev workflow

```bash
pnpm -F @solana-agent-wallet-adapter/ap2-adapter typecheck
pnpm -F @solana-agent-wallet-adapter/ap2-adapter test
pnpm -F @solana-agent-wallet-adapter/ap2-adapter build
```
