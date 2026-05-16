export type StreamingCluster = 'mainnet-beta' | 'testnet' | 'devnet' | 'localnet';
export type StreamingSessionStatus = 'pending' | 'active' | 'expired' | 'revoked' | 'settled';

export const STREAMING_SESSION_GRANT_SCHEMA = 'streaming/session-grant/0.1';
export const STREAMING_VOUCHER_SCHEMA = 'streaming/voucher/0.1';
export const STREAMING_SETTLEMENT_SCHEMA = 'streaming/settlement/0.1';
export const DEFAULT_TOKEN_DECIMALS = 6;

/**
 * System Program ID, conventionally used to represent "native SOL" in
 * non-SPL contexts (e.g. balance APIs). SPL Token delegate authority does
 * not apply to native SOL because SOL is moved via the System Program, not
 * the Token Program — so streaming sessions reject this value at every
 * creation layer (library, render-web, browser). Users who want SOL-denominated
 * streaming must first wrap to wSOL (`So11111111111111111111111111111111111111112`)
 * or use any regular SPL token like USDC.
 */
export const NATIVE_SOL_PSEUDO_MINT = '11111111111111111111111111111111';

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
  /**
   * Optional whitelist of accepted voucher recipients. Semantics:
   *   - `undefined` or empty array → allow ANY recipient (no restriction).
   *   - Populated array → strict whitelist; vouchers whose recipient is not
   *     in the list throw `VoucherRecipientNotAllowedError` at validation.
   * Render-web persists this in `streaming_sessions.recipient_allowlist` (JSONB);
   * voucher.ts `validateVoucher` enforces it at every settlement gate.
   */
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
