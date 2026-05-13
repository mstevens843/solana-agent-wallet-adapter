import type { PublicKey } from '@solana/web3.js';

import type { Cluster } from '@solana-agent-wallet-adapter/core';

export const PYTH_ADAPTER_ID = 'pyth' as const;
export const PYTH_NAME = 'Pyth';
export const PYTH_WEBSITE = 'https://pyth.network';
export const PYTH_DESCRIPTION =
  'Read Pyth oracle price feeds (price, confidence interval, exponent, publish time) and prepare optional on-chain price-update postings for wallet approval. Read tools use the public Hermes API; the wallet signs every transaction.';

export const PYTH_SUPPORTED_CLUSTERS: Cluster[] = ['mainnet-beta'];

// The Solana Receiver program ids are resolved through the optional
// @pythnetwork/pyth-solana-receiver dependency at execute time. The static list
// is intentionally empty so unrelated tooling does not assume on-chain
// instructions can be assembled without the SDK.
export const PYTH_PROGRAM_IDS: PublicKey[] = [];

export const PYTH_HERMES_URL_ENV = 'PYTH_HERMES_URL';
export const PYTH_HERMES_AUTH_ENV = 'PYTH_HERMES_AUTH';
export const PYTH_CONNECTOR_ENABLED_ENV = 'PYTH_CONNECTOR_ENABLED';
export const PYTH_DEFAULT_HERMES_URL = 'https://hermes.pyth.network';

export const PYTH_DEFAULT_MAX_AGE_SECONDS = 60;
export const PYTH_DEFAULT_MAX_CONFIDENCE_BPS = 200;
export const PYTH_RESPONSE_BYTE_LIMIT = 524_288;
export const PYTH_MAX_FEEDS_PER_POST = 2;
export const PYTH_MAX_BATCH_READ = 32;

export const PYTH_ASSET_TYPES = ['crypto', 'equity', 'fx', 'commodity', 'all'] as const;
export type PythAssetType = (typeof PYTH_ASSET_TYPES)[number];

export const PYTH_EVIDENCE_STATUSES = [
  'fresh',
  'stale',
  'wide_confidence',
  'missing',
  'api_unavailable',
] as const;
export type PythEvidenceStatus = (typeof PYTH_EVIDENCE_STATUSES)[number];

interface PythAliasEntry {
  symbol: string;
  feedId: string;
  displayName: string;
}

/**
 * Mainnet Pyth price-feed ids for common Solana assets. Source:
 * https://pyth.network/developers/price-feed-ids
 * Stored without the leading "0x"; the Hermes client normalizes either form.
 */
export const PYTH_ALIAS_ENTRIES: PythAliasEntry[] = [
  {
    symbol: 'SOL/USD',
    feedId: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    displayName: 'Solana / US Dollar',
  },
  {
    symbol: 'USDC/USD',
    feedId: 'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
    displayName: 'USD Coin / US Dollar',
  },
  {
    symbol: 'USDT/USD',
    feedId: '2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
    displayName: 'Tether USD / US Dollar',
  },
  {
    symbol: 'JITOSOL/USD',
    feedId: '67be9f519b95cf24338801051f9a808eff0a578ccb388db73b7f6fe1de019ffb',
    displayName: 'Jito SOL / US Dollar',
  },
  {
    symbol: 'MSOL/USD',
    feedId: 'c2289a6a43d2ce91c6f55caec370f4acc38a2ed477f58813334c6d03749ff2a4',
    displayName: 'Marinade SOL / US Dollar',
  },
  {
    symbol: 'BSOL/USD',
    feedId: '89875379e70f8fbadc17aef315adf3a8d5d160b811435537e03c97e8aac97d9c',
    displayName: 'BlazeStake SOL / US Dollar',
  },
  {
    symbol: 'BTC/USD',
    feedId: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
    displayName: 'Bitcoin / US Dollar',
  },
  {
    symbol: 'ETH/USD',
    feedId: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
    displayName: 'Ethereum / US Dollar',
  },
];

const ALIAS_INDEX = new Map<string, PythAliasEntry>();
for (const entry of PYTH_ALIAS_ENTRIES) {
  ALIAS_INDEX.set(normalizeAlias(entry.symbol), entry);
  ALIAS_INDEX.set(normalizeAlias(entry.symbol.split('/')[0] ?? ''), entry);
}

export function resolveAlias(input: string | undefined): PythAliasEntry | undefined {
  const normalized = normalizeAlias(input);
  if (!normalized) return undefined;
  return ALIAS_INDEX.get(normalized);
}

export function normalizePriceFeedId(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return '';
  return trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
}

export function withFeedIdPrefix(value: string): string {
  const normalized = normalizePriceFeedId(value);
  return normalized ? `0x${normalized}` : '';
}

export function shortFeedId(value: string): string {
  const normalized = normalizePriceFeedId(value);
  if (!normalized) return value;
  if (normalized.length <= 12) return normalized;
  return `${normalized.slice(0, 4)}…${normalized.slice(-4)}`;
}

function normalizeAlias(value: string | undefined): string {
  if (!value) return '';
  return value
    .trim()
    .toUpperCase()
    .replace(/[\s_-]+/g, '')
    .replace(/^0X/, '');
}
