export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type Ap2MandateType = 'intent_mandate' | 'payment_mandate';
export type Ap2Cluster = 'mainnet-beta' | 'testnet' | 'devnet' | 'localnet';

export const AP2_PROTOCOL_VERSION = 'ap2/0.1';
export const AP2_INBOUND_RECEIPT_SCHEMA = 'ap2/inbound/0.1';
export const SOL_NATIVE_MINT = 'So11111111111111111111111111111111111111112';

export interface Ap2VerifiedAgent {
  agentId: string;
  agentLabel: string;
  publicKey: string;
}

export interface Ap2PaymentDetails {
  amount: string;
  tokenSymbol: string;
  tokenMint: string;
  recipient: string;
  cluster: Ap2Cluster;
  memo?: string;
}

export interface Ap2IntentDetails {
  description: string;
  cap: Ap2PaymentDetails;
  maxRuns?: number;
}

export interface Ap2MandateCommonFields {
  mandateId: string;
  mandateType: Ap2MandateType;
  protocolVersion: string;
  issuedAt: string;
  expiresAt: string;
  agent: Ap2VerifiedAgent;
  signature: string;
  signedFields: JsonObject;
}

export interface Ap2IntentMandate extends Ap2MandateCommonFields {
  mandateType: 'intent_mandate';
  intent: Ap2IntentDetails;
}

export interface Ap2PaymentMandate extends Ap2MandateCommonFields {
  mandateType: 'payment_mandate';
  intentMandateId: string;
  payment: Ap2PaymentDetails;
}

export type Ap2Mandate = Ap2IntentMandate | Ap2PaymentMandate;

/** Type guard for the `intent_mandate` variant of `Ap2Mandate`. */
export function isIntentMandate(mandate: Ap2Mandate): mandate is Ap2IntentMandate {
  return mandate.mandateType === 'intent_mandate';
}

/** Type guard for the `payment_mandate` variant of `Ap2Mandate`. */
export function isPaymentMandate(mandate: Ap2Mandate): mandate is Ap2PaymentMandate {
  return mandate.mandateType === 'payment_mandate';
}

export type Ap2ApprovalKind = 'transfer_sol' | 'transfer_spl';

export interface Ap2InboundApprovalParams {
  kind: Ap2ApprovalKind;
  summary: string;
  cluster: Ap2Cluster;
  amount: string;
  token: string;
  recipient: string;
  params: JsonObject;
  metadata: JsonObject;
}

export interface Ap2InboundReceiptApprovalRef {
  id: string;
  kind: Ap2ApprovalKind;
}

export interface Ap2InboundReceiptExecution {
  txid: string;
  walletAddress: string;
  cluster: Ap2Cluster;
  finalizedAt: string;
}

export interface Ap2InboundReceipt {
  schema: typeof AP2_INBOUND_RECEIPT_SCHEMA;
  mandateId: string;
  mandateType: Ap2MandateType;
  protocolVersion: string;
  issuedAt: string;
  agent: Ap2VerifiedAgent;
  payment: Ap2PaymentDetails;
  approval: Ap2InboundReceiptApprovalRef;
  execution: Ap2InboundReceiptExecution;
  artifactHash: string;
}

/**
 * Structural / forbidden-secret validation failure raised by the parser and
 * receipt parser. `code` is stable and machine-readable; the route layer
 * wraps it as `WorkflowValidationError('invalid_ap2_mandate:<code>', …)`.
 */
export class Ap2ParseError extends Error {
  readonly code: string;
  readonly path?: string;
  constructor(code: string, message: string, path?: string) {
    super(message);
    this.name = 'Ap2ParseError';
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

/**
 * Signature / expiry / binding failure raised by `verifyAp2Mandate`. `code`
 * is stable: `expired`, `invalid_expiry`, `invalid_public_key`,
 * `invalid_signature`, `bad_signature`, `recipient_mismatch`, `cluster_mismatch`.
 */
export class Ap2VerifyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'Ap2VerifyError';
    this.code = code;
  }
}
