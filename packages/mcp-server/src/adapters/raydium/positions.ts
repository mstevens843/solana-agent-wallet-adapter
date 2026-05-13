import type { DAppAdapterContext } from '../types.js';
import {
  getRaydiumClient,
  type RaydiumLiquidityPoolType,
  type RaydiumPosition,
  type RaydiumWalletPositionsResult,
} from './client.js';
import { optionalPublicKey, parsePositionPoolType, parsePublicKey } from './validation.js';

export async function getRaydiumWalletPositions(
  ctx: DAppAdapterContext,
  input: { walletAddress?: string; poolId?: string; poolType?: RaydiumLiquidityPoolType | string; farmId?: string },
): Promise<RaydiumWalletPositionsResult> {
  const walletAddress = input.walletAddress?.trim()
    ? parsePublicKey(input.walletAddress, 'walletAddress')
    : parsePublicKey(await ctx.backend.getAddress(), 'walletAddress');
  const poolId = optionalPublicKey(input.poolId, 'poolId');
  const farmId = optionalPublicKey(input.farmId, 'farmId');
  const poolType = parsePositionPoolType(input.poolType);
  return getRaydiumClient().getWalletPositions(ctx.connection, walletAddress, {
    ...(poolId !== undefined && { poolId }),
    ...(poolType !== undefined && { poolType }),
    ...(farmId !== undefined && { farmId }),
  });
}

export async function getRaydiumPositionDetail(
  ctx: DAppAdapterContext,
  input: { walletAddress?: string; positionMint: string; poolId?: string },
): Promise<RaydiumPosition> {
  const walletAddress = input.walletAddress?.trim()
    ? parsePublicKey(input.walletAddress, 'walletAddress')
    : parsePublicKey(await ctx.backend.getAddress(), 'walletAddress');
  const positionMint = parsePublicKey(input.positionMint, 'positionMint');
  const poolId = optionalPublicKey(input.poolId, 'poolId');
  return getRaydiumClient().getPositionDetail(ctx.connection, walletAddress, {
    positionMint,
    ...(poolId !== undefined && { poolId }),
  });
}
