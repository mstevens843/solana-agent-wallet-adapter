import type { AcpCluster, AcpPaymentToken } from './types.js';

export const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const USDT_MINT_MAINNET = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

export const DEFAULT_ALLOWED_TOKEN_MINTS: Readonly<Record<AcpCluster, readonly string[]>> = Object.freeze({
  mainnet: Object.freeze([USDC_MINT_MAINNET, USDT_MINT_MAINNET]),
  devnet: Object.freeze([USDC_MINT_DEVNET]),
});

export const SYMBOL_TO_DEFAULT_MINT: Readonly<Record<AcpCluster, Readonly<Partial<Record<AcpPaymentToken, string>>>>> = Object.freeze({
  mainnet: Object.freeze({ USDC: USDC_MINT_MAINNET, USDT: USDT_MINT_MAINNET }),
  devnet: Object.freeze({ USDC: USDC_MINT_DEVNET }),
});

export const DEFAULT_MAX_LINE_ITEMS = 50;
export const DEFAULT_MAX_TOTAL_AMOUNT_USD = 10_000;
export const DEFAULT_MAX_QUANTITY_PER_LINE_ITEM = 10_000;
export const CART_VERSION = '1' as const;
export const RECEIPT_VERSION = '1' as const;

export const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const DECIMAL_AMOUNT_REGEX = /^(?!0\d)\d+(\.\d{1,9})?$/;
