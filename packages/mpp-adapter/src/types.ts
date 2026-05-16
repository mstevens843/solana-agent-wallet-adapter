export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type MppCluster = 'mainnet-beta' | 'testnet' | 'devnet' | 'localnet';
export type MppPaymentRail = 'solana-sol' | 'solana-spl';

export const MPP_PROTOCOL_VERSION = 'mpp/0.1';
export const MPP_PAYMENT_RECEIPT_SCHEMA = 'mpp/payment/0.1';
export const SOL_NATIVE_MINT = 'So11111111111111111111111111111111111111112';

export interface MppMerchant {
  id?: string;
  name?: string;
  url?: string;
}

export interface MppPaymentMethod {
  kind: MppPaymentRail;
  recipient: string;
  network: MppCluster;
  mint?: string;
}

export interface MppChallenge {
  protocolVersion: string;
  nonce: string;
  amount: string;
  currency: string;
  resourceUrl: string;
  expiresAt: string;
  paymentMethods: MppPaymentMethod[];
  merchant?: MppMerchant;
  metadata?: JsonObject;
}

export interface MppCredential {
  kind: MppPaymentRail;
  signature: string;
  txid?: string;
  payerWallet: string;
  settledAt: string;
}

export interface MppReceipt {
  schema: typeof MPP_PAYMENT_RECEIPT_SCHEMA;
  protocolVersion: typeof MPP_PROTOCOL_VERSION;
  receiptId: string;
  challengeHash: string;
  credentialHash: string;
  artifactHash: string;
  payerWallet: string;
  cluster: MppCluster;
  amount: string;
  currency: string;
  recipient: string;
  paymentMethod: MppPaymentMethod;
  resourceUrl: string;
  nonce: string;
  txid?: string;
  issuedAt: string;
  settledAt: string;
  merchant?: MppMerchant;
  metadata?: JsonObject;
}

export type MppApprovalKind = 'transfer_sol' | 'transfer_spl';

export interface MppApprovalParams {
  kind: MppApprovalKind;
  summary: string;
  cluster: MppCluster;
  amount: string;
  token: string;
  recipient: string;
  params: JsonObject;
  metadata: JsonObject;
}
