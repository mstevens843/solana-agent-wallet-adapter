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
    ap2VerifiedAgent: { agentId: agent.agentId, agentLabel: agent.agentLabel },
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
