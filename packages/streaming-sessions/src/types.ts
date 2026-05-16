export type StreamingCluster = 'mainnet-beta' | 'testnet' | 'devnet' | 'localnet';
export type StreamingSessionStatus = 'pending' | 'active' | 'expired' | 'revoked' | 'settled';

export const STREAMING_SESSION_GRANT_SCHEMA = 'streaming/session-grant/0.1';
export const STREAMING_VOUCHER_SCHEMA = 'streaming/voucher/0.1';
export const STREAMING_SETTLEMENT_SCHEMA = 'streaming/settlement/0.1';
export const DEFAULT_TOKEN_DECIMALS = 6;

export interface SessionGrant {
  sessionId: string;
  walletAddress: string;
  cluster: StreamingCluster;
  tokenMint: string;
  tokenDecimals?: number;
  delegatePubkey: string;
  ephemeralSignerPubkey: string;
  capAmount: string;
  spentAmount: string;
  expiresAt: string;
  status: StreamingSessionStatus;
  recipientAllowlist?: readonly string[];
  createdAt: string;
  updatedAt: string;
  approveTxid?: string;
  revokeTxid?: string;
  metadata?: Record<string, unknown>;
}

export interface Voucher {
  schema: typeof STREAMING_VOUCHER_SCHEMA;
  sessionId: string;
  nonce: string;
  amount: string;
  recipient: string;
  issuedAt: string;
  signature: string;
}

export type VoucherHash = string;

export interface SettlementBundle {
  schema: typeof STREAMING_SETTLEMENT_SCHEMA;
  sessionId: string;
  vouchers: Voucher[];
  totalAmount: string;
  tokenMint?: string;
  tokenDecimals?: number;
  startedAt: string;
  settledAt?: string;
  txid?: string;
}
