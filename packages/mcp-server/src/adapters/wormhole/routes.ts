import type { DAppAdapterContext } from '../types.js';
import { getWormholeClient, staticWormholeRoute, type WormholeSupportedRoutesSnapshot } from './client.js';
import {
  WORMHOLE_DESTINATION_CHAINS,
  WORMHOLE_SOURCE_CHAIN,
  wormholeNetworkForCluster,
  type WormholeRouteType,
} from './constants.js';
import { normalizeDestinationChain, normalizeMint, normalizeRouteType, normalizeSourceChain } from './validation.js';

export interface WormholeSupportedRoutesInput {
  sourceChain?: string;
  destinationChain?: string;
  mintAddress?: string;
  routeType?: WormholeRouteType | 'automatic' | 'manual';
}

export async function getWormholeSupportedRoutes(
  ctx: DAppAdapterContext,
  input: WormholeSupportedRoutesInput = {},
): Promise<WormholeSupportedRoutesSnapshot> {
  const sourceChain = normalizeSourceChain(input.sourceChain);
  const routeType = normalizeRouteType(input.routeType);
  const destinationChain = input.destinationChain ? normalizeDestinationChain(input.destinationChain) : undefined;
  const mintAddress = input.mintAddress ? normalizeMint(input.mintAddress, 'mintAddress') : undefined;
  const wormholeNetwork = wormholeNetworkForCluster(ctx.config.cluster);

  try {
    return await getWormholeClient().getSupportedRoutes(ctx.connection, {
      sourceChain,
      ...(destinationChain !== undefined && { destinationChain }),
      ...(mintAddress !== undefined && { mintAddress }),
      routeType,
      wormholeNetwork,
    });
  } catch (err) {
    if (!isUnavailable(err)) throw err;
    const destinations = destinationChain ? [destinationChain] : [...WORMHOLE_DESTINATION_CHAINS];
    return {
      sourceChain: WORMHOLE_SOURCE_CHAIN,
      wormholeNetwork,
      ...(destinationChain !== undefined && { destinationChain }),
      ...(mintAddress !== undefined && { mintAddress }),
      routeType,
      routes: destinations.map((chain) => staticWormholeRoute({
        sourceChain: WORMHOLE_SOURCE_CHAIN,
        destinationChain: chain,
        routeType,
        ...(mintAddress !== undefined && { sourceMint: mintAddress }),
      })),
      asOfIso: new Date().toISOString(),
    };
  }
}

function isUnavailable(err: unknown): boolean {
  return err instanceof Error && err.message.includes('Wormhole adapter is not configured');
}
