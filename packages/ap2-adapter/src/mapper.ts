import { paymentDetailsFor } from './verifier.js';
import {
  SOL_NATIVE_MINT,
  type Ap2ApprovalKind,
  type Ap2InboundApprovalParams,
  type Ap2Mandate,
  type Ap2VerifiedAgent,
  type JsonObject,
  type JsonValue,
} from './types.js';

/**
 * Map a verified AP2 mandate into shape consumable by `workflowService.createApproval`.
 *
 * Approval kind reuses the existing `transfer_spl` / `transfer_sol` enum so the
 * default wallet approval UX renders unchanged. AP2 origin is carried in
 * `metadata` — never in `kind` — to avoid coupling to `WORKFLOW_ACTION_KINDS`.
 *
 * Metadata contract (route layer and Agent 9 badge depend on these exact keys):
 *   - `connectorId: 'ap2'`, `actionSource: 'ap2_inbound'` — origin tag.
 *   - `ap2VerifiedAgent: { agentId, agentLabel, publicKey, verified: true }` —
 *     the verified-agent badge in `apps/browser-demo/src/devBadges/ap2Verified.ts`
 *     matches on `verified === true`. The route layer SHOULD pass this object
 *     through unmodified.
 *   - `actionProposal: <the full mandate>` — preserved for replay/audit.
 *
 * Caller MUST have already verified the mandate signature via `verifyAp2Mandate`
 * before invoking this; setting `verified: true` here is the post-verify signal,
 * not a claim by the mapper itself.
 */
export function mandateToApprovalParams(
  mandate: Ap2Mandate,
  agent: Ap2VerifiedAgent,
  walletAddress: string,
): Ap2InboundApprovalParams {
  const payment = paymentDetailsFor(mandate);
  const kind: Ap2ApprovalKind = isSolPayment(payment.tokenMint, payment.tokenSymbol) ? 'transfer_sol' : 'transfer_spl';
  const summary = `AP2 inbound: ${agent.agentLabel} requests ${payment.amount} ${payment.tokenSymbol} to ${payment.recipient}`;
  const params: JsonObject = {
    fromAddress: walletAddress,
    toAddress: payment.recipient,
    amount: payment.amount,
    tokenMint: payment.tokenMint,
    tokenSymbol: payment.tokenSymbol,
    ...(payment.memo === undefined ? {} : { memo: payment.memo }),
  };
  const metadata: JsonObject = {
    connectorId: 'ap2',
    connectorName: 'Google AP2',
    capability: 'inbound_payment',
    operation: 'inbound_payment',
    actionSource: 'ap2_inbound',
    approvalBoundary: 'per_run',
    ap2VerifiedAgent: {
      agentId: agent.agentId,
      agentLabel: agent.agentLabel,
      publicKey: agent.publicKey,
      verified: true,
    },
    ap2MandateId: mandate.mandateId,
    ap2MandateType: mandate.mandateType,
    ap2ProtocolVersion: mandate.protocolVersion,
    ...(mandate.mandateType === 'payment_mandate' ? { ap2IntentMandateId: mandate.intentMandateId } : {}),
    actionProposal: mandate as unknown as JsonValue,
  };
  return {
    kind,
    summary,
    cluster: payment.cluster,
    amount: payment.amount,
    token: payment.tokenSymbol,
    recipient: payment.recipient,
    params,
    metadata,
  };
}

function isSolPayment(tokenMint: string, tokenSymbol: string): boolean {
  return tokenMint === SOL_NATIVE_MINT || tokenSymbol.toUpperCase() === 'SOL';
}
