import type { DAppAdapterContext } from '../types.js';
import { getMeteoraClient } from './client.js';
import type { MeteoraPosition, MeteoraWalletPositionsResult } from './client.js';
import { ensurePositionMatchesPool, optionalPublicKey, parsePublicKey } from './validation.js';

export async function getWalletPositions(
  ctx: DAppAdapterContext,
  input: { walletAddress?: string; poolAddress?: string },
): Promise<MeteoraWalletPositionsResult> {
  const walletAddress = input.walletAddress ? parsePublicKey(input.walletAddress, 'walletAddress') : await ctx.backend.getAddress();
  const poolAddress = optionalPublicKey(input.poolAddress, 'poolAddress');
  return getMeteoraClient().getWalletPositions(ctx.connection, walletAddress, poolAddress);
}

export async function getPositionDetail(
  ctx: DAppAdapterContext,
  input: { poolAddress: string; positionAddress: string },
): Promise<MeteoraPosition> {
  const poolAddress = parsePublicKey(input.poolAddress, 'poolAddress');
  const positionAddress = parsePublicKey(input.positionAddress, 'positionAddress');
  const position = await getMeteoraClient().getPositionDetail(ctx.connection, poolAddress, positionAddress);
  ensurePositionMatchesPool(position, poolAddress);
  return position;
}
