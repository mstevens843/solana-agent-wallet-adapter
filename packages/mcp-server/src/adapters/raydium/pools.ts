import type { DAppAdapterContext } from '../types.js';
import { getRaydiumClient, type RaydiumPoolSnapshot, type RaydiumPoolType } from './client.js';
import { parsePublicKey, parseReadPoolType } from './validation.js';

export async function getRaydiumPoolSnapshot(
  ctx: DAppAdapterContext,
  input: { poolId: string; poolType?: RaydiumPoolType | string },
): Promise<RaydiumPoolSnapshot> {
  const poolId = parsePublicKey(input.poolId, 'poolId');
  const poolType = parseReadPoolType(input.poolType);
  return getRaydiumClient().getPoolSnapshot(ctx.connection, poolId, poolType);
}
