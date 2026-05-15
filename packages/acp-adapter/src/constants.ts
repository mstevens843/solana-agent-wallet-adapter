import type { AcpCluster, AcpPaymentToken } from './types.js';

export const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const USDT_MINT_MAINNET = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

export const DEFAULT_ALLOWED_TOKEN_MINTS: Readonly<Record<AcpCluster, readonly string[]>> = Object.freeze({
  'mainnet-beta': Object.freeze([USDC_MINT_MAINNET, USDT_MINT_MAINNET]),
  testnet: Object.freeze([]),
  devnet: Object.freeze([USDC_MINT_DEVNET]),
  localnet: Object.freeze([]),
});

export const SYMBOL_TO_DEFAULT_MINT: Readonly<Record<AcpCluster, Readonly<Partial<Record<AcpPaymentToken, string>>>>> = Object.freeze({
  'mainnet-beta': Object.freeze({ USDC: USDC_MINT_MAINNET, USDT: USDT_MINT_MAINNET }),
  testnet: Object.freeze({}),
  devnet: Object.freeze({ USDC: USDC_MINT_DEVNET }),
  localnet: Object.freeze({}),
});

// Accept colloquial 'mainnet' as an alias for 'mainnet-beta' so external ACP
// carts (Stripe/OpenAI demos) don't get rejected on a naming detail.
export const CLUSTER_ALIASES: Readonly<Record<string, AcpCluster>> = Object.freeze({
  mainnet: 'mainnet-beta',
  'mainnet-beta': 'mainnet-beta',
  testnet: 'testnet',
  devnet: 'devnet',
  localnet: 'localnet',
});

export const DEFAULT_MAX_LINE_ITEMS = 50;
export const DEFAULT_MAX_TOTAL_AMOUNT_USD = 10_000;
export const DEFAULT_MAX_QUANTITY_PER_LINE_ITEM = 10_000;
export const CART_VERSION = '1' as const;
export const RECEIPT_VERSION = '1' as const;
export const RECEIPT_SCHEMA = 'acp/outbound/0.1' as const;
export const MAX_CART_BYTES = 65_536;

export const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const DECIMAL_AMOUNT_REGEX = /^(?!0\d)\d+(\.\d{1,9})?$/;
