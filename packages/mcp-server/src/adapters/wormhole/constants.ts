import { PublicKey } from '@solana/web3.js';
import type { Cluster } from '@solana-agent-wallet-adapter/core';

import { AdapterError } from '../types.js';

export const WORMHOLE_ADAPTER_ID = 'wormhole' as const;
export const WORMHOLE_NAME = 'Wormhole';
export const WORMHOLE_WEBSITE = 'https://wormhole.com';
export const WORMHOLE_DESCRIPTION =
  'First-class Wormhole bridge facts and prepare-only Solana-source token transfer actions.';

export type WormholeNetwork = 'Mainnet' | 'Testnet';
export type WormholeRouteType = 'auto' | 'token_bridge' | 'cctp' | 'ntt';
export type WormholeRouteMode = 'manual' | 'automatic';
export type WormholeTransferState =
  | 'unknown'
  | 'pending_source'
  | 'pending_vaa'
  | 'ready_to_redeem'
  | 'redeemed'
  | 'failed';

export const WORMHOLE_SUPPORTED_CLUSTERS: Cluster[] = ['mainnet-beta', 'devnet'];

export const WORMHOLE_CORE_BRIDGE_PROGRAM_ID = new PublicKey('worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth');
export const WORMHOLE_TOKEN_BRIDGE_PROGRAM_ID = new PublicKey('wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb');
export const WORMHOLE_PROGRAM_IDS = [
  WORMHOLE_CORE_BRIDGE_PROGRAM_ID.toBase58(),
  WORMHOLE_TOKEN_BRIDGE_PROGRAM_ID.toBase58(),
];

export const WORMHOLE_FEATURE_FLAG_ENV = 'WORMHOLE_CONNECTOR_ENABLED';
export const WORMHOLE_NETWORK_ENV = 'WORMHOLE_NETWORK';
export const WORMHOLE_RPC_BASE_URL_ENV = 'WORMHOLE_RPC_BASE_URL';

export const MAX_WORMHOLE_QUOTE_AGE_MS = 60_000;

export const WORMHOLE_SOURCE_CHAIN = 'Solana';

export const WORMHOLE_DESTINATION_CHAINS = [
  'Ethereum',
  'Base',
  'Arbitrum',
  'Optimism',
  'Polygon',
  'Avalanche',
  'Bsc',
  'Sui',
  'Aptos',
  'Solana',
] as const;

export type WormholeDestinationChain = typeof WORMHOLE_DESTINATION_CHAINS[number];

export function wormholeNetworkForCluster(cluster: Cluster): WormholeNetwork {
  const configured = process.env[WORMHOLE_NETWORK_ENV]?.trim();
  if (configured) {
    const normalized = configured.replace(/[\s_-]+/g, '').toLowerCase();
    if (normalized === 'mainnet') return 'Mainnet';
    if (normalized === 'testnet') return 'Testnet';
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      'invalid_request',
      `${WORMHOLE_NETWORK_ENV} must be Mainnet or Testnet; received ${configured}.`,
    );
  }
  if (cluster === 'mainnet-beta') return 'Mainnet';
  if (cluster === 'devnet') return 'Testnet';
  throw new AdapterError(
    WORMHOLE_ADAPTER_ID,
    'unsupported_cluster',
    `Wormhole is only configured for mainnet-beta and devnet in this runtime; current cluster is ${cluster}.`,
  );
}

export function normalizeWormholeChain(value: string | undefined, field = 'destinationChain'): string {
  const raw = value?.trim();
  if (!raw) throw new Error(`${field} is required.`);
  const compact = raw.replace(/[\s_-]+/g, '').toLowerCase();
  const found = WORMHOLE_DESTINATION_CHAINS.find((chain) =>
    chain.replace(/[\s_-]+/g, '').toLowerCase() === compact
  );
  return found ?? raw;
}

export function normalizeWormholeRouteType(value: string | undefined): WormholeRouteType {
  const normalized = (value ?? 'auto').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'automatic') return 'auto';
  if (normalized === 'manual') return 'token_bridge';
  if (normalized === 'auto' || normalized === 'token_bridge' || normalized === 'cctp' || normalized === 'ntt') {
    return normalized;
  }
  throw new Error(`Unsupported Wormhole routeType: ${value}.`);
}

export function routeTypeLabel(value: WormholeRouteType): string {
  if (value === 'auto') return 'auto';
  if (value === 'token_bridge') return 'Token Bridge / WTT';
  if (value === 'cctp') return 'CCTP';
  return 'NTT';
}

export function shortWormholeAddress(value: string | undefined): string {
  const text = value?.trim();
  if (!text) return 'unknown';
  if (text.length <= 12) return text;
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}
