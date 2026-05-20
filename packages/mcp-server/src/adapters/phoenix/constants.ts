import { PublicKey } from '@solana/web3.js';

import type { Cluster } from '@solana-agent-wallet-adapter/core';

export const PHOENIX_ADAPTER_ID = 'phoenix' as const;
export const PHOENIX_NAME = 'Phoenix Perpetuals';
export const PHOENIX_WEBSITE = 'https://www.phoenix.trade';
export const PHOENIX_DESCRIPTION =
  'Read Phoenix Perpetuals markets, positions, and funding facts and preview leverage health. Prepare actions are policy-gated and stubbed until the Rise SDK lands on npm.';

export const PHOENIX_SUPPORTED_CLUSTERS: Cluster[] = ['mainnet-beta'];

export const PHOENIX_ACCESS_CODE_ENV = 'PHOENIX_ACCESS_CODE';
export const PHOENIX_API_BASE_URL_ENV = 'PHOENIX_API_BASE_URL';
export const PHOENIX_DEFAULT_API_BASE_URL = 'https://perp-api.phoenix.trade';

/**
 * Phoenix Perpetuals on-chain program IDs.
 *
 * Intentionally empty until the Rise SDK (github.com/Ellipsis-Labs/rise-public) publishes the perps program ID. The
 * legacy Phoenix spot CLOB program (`PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY`) is a different deployment and must
 * NOT be advertised here — security review, fee estimation, and tx-routing utilities all consult `programIds` and
 * would route to the wrong program if we listed it.
 *
 * Populate this array as soon as the perps program ID is publicly confirmed.
 */
export const PHOENIX_PERPS_PROGRAM_IDS: PublicKey[] = [];

export const PHOENIX_DEFAULT_SYMBOL = 'SOL-PERP';
export const PHOENIX_TRADER_PDA_INDEX_DEFAULT = 0;

/** Tick math constants. Phoenix uses fixed-point tick prices for stop-loss triggers. */
export const PHOENIX_TICKS_PER_USD = 1_000_000n;
