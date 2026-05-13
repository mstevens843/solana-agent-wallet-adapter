import type { DAppAdapterContext } from '../types.js';
import {
  getWormholeClient,
  type WormholeQuoteSnapshot,
  type WormholeTokenSnapshot,
} from './client.js';
import { WORMHOLE_SOURCE_CHAIN, wormholeNetworkForCluster } from './constants.js';
import {
  normalizeDestinationChain,
  normalizeMint,
  normalizeRouteType,
  normalizeSourceChain,
  normalizeWormholeAmount,
  optionalNonNegativeDecimal,
  validateDestinationAddress,
} from './validation.js';

export interface WormholeTokenSnapshotInput {
  mintAddress: string;
  destinationChain?: string;
  includeWrappedAssets?: boolean;
}

export interface WormholeQuoteReadInput {
  sourceMint: string;
  amount: string;
  destinationChain: string;
  destinationAddress: string;
  routeType?: string;
  nativeGasDropoff?: string;
}

export async function getWormholeTokenSnapshot(
  ctx: DAppAdapterContext,
  input: WormholeTokenSnapshotInput,
): Promise<WormholeTokenSnapshot> {
  const wormholeNetwork = wormholeNetworkForCluster(ctx.config.cluster);
  const mintAddress = normalizeMint(input.mintAddress, 'mintAddress');
  const destinationChain = input.destinationChain ? normalizeDestinationChain(input.destinationChain) : undefined;
  return getWormholeClient().getTokenSnapshot(ctx.connection, {
    mintAddress,
    ...(destinationChain !== undefined && { destinationChain }),
    includeWrappedAssets: input.includeWrappedAssets ?? true,
    wormholeNetwork,
  });
}

export async function getWormholeQuote(
  ctx: DAppAdapterContext,
  input: WormholeQuoteReadInput,
): Promise<WormholeQuoteSnapshot> {
  const walletAddress = await ctx.backend.getAddress().catch(() => undefined);
  const wormholeNetwork = wormholeNetworkForCluster(ctx.config.cluster);
  const sourceChain = normalizeSourceChain(undefined);
  const sourceMint = normalizeMint(input.sourceMint, 'sourceMint');
  const amount = await normalizeWormholeAmount({
    connection: ctx.connection,
    sourceMint,
    amount: input.amount,
  });
  const destinationChain = normalizeDestinationChain(input.destinationChain);
  const destinationAddress = validateDestinationAddress(destinationChain, input.destinationAddress);
  const routeType = normalizeRouteType(input.routeType);
  const nativeGasDropoff = optionalNonNegativeDecimal(input.nativeGasDropoff, 'nativeGasDropoff');
  return getWormholeClient().quoteTransfer(ctx.connection, {
    ...(walletAddress !== undefined && { walletAddress }),
    sourceChain,
    sourceMint,
    amount: amount.amount,
    amountRaw: amount.amountRaw,
    sourceDecimals: amount.decimals,
    destinationChain,
    destinationAddress,
    routeType,
    ...(nativeGasDropoff !== undefined && { nativeGasDropoff }),
    wormholeNetwork,
  });
}

export function quoteInputFromActionParams(params: Record<string, unknown>): WormholeQuoteReadInput {
  return {
    sourceMint: requireParam(params, 'sourceMint'),
    amount: requireParam(params, 'amount'),
    destinationChain: requireParam(params, 'destinationChain'),
    destinationAddress: requireParam(params, 'destinationAddress'),
    ...(typeof params.routeType === 'string' ? { routeType: params.routeType } : {}),
    ...(typeof params.nativeGasDropoff === 'string' ? { nativeGasDropoff: params.nativeGasDropoff } : {}),
  };
}

export function emptyTokenSnapshot(mintAddress: string): WormholeTokenSnapshot {
  return {
    mintAddress,
    sourceChain: WORMHOLE_SOURCE_CHAIN,
    wormholeNetwork: 'Mainnet',
    supportedRoutes: [],
    warnings: ['Wormhole token snapshot is unavailable because the client is not configured.'],
    asOfIso: new Date().toISOString(),
  };
}

function requireParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Wormhole action is missing ${key}.`);
  }
  return value.trim();
}
