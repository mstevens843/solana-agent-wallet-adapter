import { AdapterError } from '../types.js';
import {
  getWormholeClient,
  type WormholeTransferStatus,
  type WormholeWalletBridgeExposure,
} from './client.js';
import { WORMHOLE_ADAPTER_ID, WORMHOLE_SOURCE_CHAIN, wormholeNetworkForCluster } from './constants.js';
import type { DAppAdapterContext } from '../types.js';
import { normalizeDestinationChain, normalizeSourceChain, optionalNonEmptyString } from './validation.js';

export interface WormholeTransferStatusInput {
  txid?: string;
  vaa?: string;
  sequence?: string;
  transferId?: string;
  sourceChain?: string;
  destinationChain?: string;
}

export interface WormholeWalletBridgeExposureInput {
  walletAddress?: string;
  includePendingTransfers?: boolean;
}

export async function getWormholeTransferStatus(
  ctx: DAppAdapterContext,
  input: WormholeTransferStatusInput,
): Promise<WormholeTransferStatus> {
  const txid = optionalNonEmptyString(input.txid);
  const vaa = optionalNonEmptyString(input.vaa);
  const sequence = optionalNonEmptyString(input.sequence);
  const transferId = optionalNonEmptyString(input.transferId);
  if (!txid && !vaa && !sequence && !transferId) {
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      'invalid_request',
      'Wormhole transfer status requires txid, vaa, sequence, or transferId.',
    );
  }
  const sourceChain = normalizeSourceChain(input.sourceChain);
  const destinationChain = input.destinationChain ? normalizeDestinationChain(input.destinationChain) : undefined;
  return getWormholeClient().getTransferStatus(ctx.connection, {
    sourceChain,
    ...(destinationChain !== undefined && { destinationChain }),
    ...(txid !== undefined && { txid }),
    ...(vaa !== undefined && { vaa }),
    ...(sequence !== undefined && { sequence }),
    ...(transferId !== undefined && { transferId }),
    wormholeNetwork: wormholeNetworkForCluster(ctx.config.cluster),
  });
}

export async function getWormholeWalletBridgeExposure(
  ctx: DAppAdapterContext,
  input: WormholeWalletBridgeExposureInput,
): Promise<WormholeWalletBridgeExposure> {
  const walletAddress = input.walletAddress?.trim() || await ctx.backend.getAddress();
  return getWormholeClient().getWalletBridgeExposure(ctx.connection, {
    walletAddress,
    includePendingTransfers: input.includePendingTransfers ?? true,
    wormholeNetwork: wormholeNetworkForCluster(ctx.config.cluster),
  });
}

export function unknownWormholeStatus(input: WormholeTransferStatusInput): WormholeTransferStatus {
  return {
    sourceChain: input.sourceChain ?? WORMHOLE_SOURCE_CHAIN,
    ...(input.destinationChain !== undefined && { destinationChain: input.destinationChain }),
    ...(input.txid !== undefined && { sourceTxid: input.txid }),
    ...(input.sequence !== undefined && { sequence: input.sequence }),
    ...(input.vaa !== undefined && { vaa: input.vaa }),
    ...(input.transferId !== undefined && { transferId: input.transferId }),
    vaaAvailable: Boolean(input.vaa),
    redeemed: false,
    state: input.vaa ? 'ready_to_redeem' : 'unknown',
    nextAction: input.vaa ? 'redeem_on_destination' : 'wait_for_vaa',
    solanaExecutable: false,
    warnings: ['Wormhole transfer status could not be resolved by the configured client.'],
    updatedAtIso: new Date().toISOString(),
  };
}
