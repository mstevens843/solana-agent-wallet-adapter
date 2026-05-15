export type AcpCluster = 'mainnet-beta' | 'testnet' | 'devnet' | 'localnet';
export type AcpCurrency = 'USD';
export type AcpPaymentToken = 'USDC' | 'USDT' | 'SOL';

export interface AcpLineItem {
  readonly id: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitAmount: string;
  readonly currency: AcpCurrency;
}

export interface AcpMerchant {
  readonly id: string;
  readonly name: string;
  readonly recipient: string;
}

export interface AcpCart {
  readonly id: string;
  readonly cartVersion: '1';
  readonly merchant: AcpMerchant;
  readonly lineItems: readonly AcpLineItem[];
  readonly totalAmount: string;
  readonly currency: AcpCurrency;
  readonly paymentToken: AcpPaymentToken;
  readonly paymentAmount?: string;
  readonly paymentTokenMint?: string;
  readonly cluster: AcpCluster;
  readonly expiresAt?: string;
  readonly memo?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface AcpCartValidationOptions {
  readonly maxLineItems?: number;
  readonly maxTotalAmount?: number;
  readonly allowedTokenMints?: Readonly<Record<AcpCluster, readonly string[]>>;
  readonly now?: Date;
}

export interface AcpCartValidationResult {
  readonly ok: true;
  readonly cart: AcpCart;
  readonly totalFiat: number;
  readonly transferAmount: string;
  readonly resolvedTokenMint: string;
}

export interface AcpTransferParams {
  readonly token: AcpPaymentToken;
  readonly recipient: string;
  readonly amount: string;
  readonly dueAt?: string;
  readonly note?: string;
}

export interface AcpReceipt {
  readonly schema: 'acp/outbound/0.1';
  readonly receiptVersion: '1';
  readonly receiptId: string;
  readonly cartId: string;
  readonly cartHash: string;
  readonly walletAddress: string;
  readonly txid: string;
  readonly settledAt: string;
  readonly amount: string;
  readonly token: AcpPaymentToken;
  readonly paymentTokenMint?: string;
  readonly recipient: string;
  readonly cluster: AcpCluster;
  readonly merchant: AcpMerchant;
  readonly lineItems: readonly AcpLineItem[];
  readonly memo?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}
