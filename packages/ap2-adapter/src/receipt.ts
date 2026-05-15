import { createHash } from 'node:crypto';

import { canonicalize, paymentDetailsFor } from './verifier.js';
import {
  AP2_INBOUND_RECEIPT_SCHEMA,
  type Ap2ApprovalKind,
  type Ap2Cluster,
  type Ap2InboundReceipt,
  type Ap2Mandate,
  type Ap2VerifiedAgent,
  type JsonValue,
} from './types.js';

export interface BuildAp2InboundReceiptInput {
  mandate: Ap2Mandate;
  agent: Ap2VerifiedAgent;
  approval: { id: string; kind: Ap2ApprovalKind };
  txid: string;
  walletAddress: string;
  cluster: Ap2Cluster;
  finalizedAt?: string;
  issuedAt?: string;
}

export function buildAp2InboundReceipt(input: BuildAp2InboundReceiptInput): Ap2InboundReceipt {
  const payment = paymentDetailsFor(input.mandate);
  const issuedAt = input.issuedAt ?? input.finalizedAt ?? new Date().toISOString();
  const finalizedAt = input.finalizedAt ?? issuedAt;
  const draft: Omit<Ap2InboundReceipt, 'artifactHash'> = {
    schema: AP2_INBOUND_RECEIPT_SCHEMA,
    mandateId: input.mandate.mandateId,
    mandateType: input.mandate.mandateType,
    protocolVersion: input.mandate.protocolVersion,
    issuedAt,
    agent: {
      agentId: input.agent.agentId,
      agentLabel: input.agent.agentLabel,
      publicKey: input.agent.publicKey,
    },
    payment: {
      amount: payment.amount,
      tokenSymbol: payment.tokenSymbol,
      tokenMint: payment.tokenMint,
      recipient: payment.recipient,
      cluster: payment.cluster,
      ...(payment.memo === undefined ? {} : { memo: payment.memo }),
    },
    approval: { id: input.approval.id, kind: input.approval.kind },
    execution: {
      txid: input.txid,
      walletAddress: input.walletAddress,
      cluster: input.cluster,
      finalizedAt,
    },
  };
  const artifactHash = sha256Hex(canonicalize(draft as unknown as JsonValue));
  return { ...draft, artifactHash };
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
