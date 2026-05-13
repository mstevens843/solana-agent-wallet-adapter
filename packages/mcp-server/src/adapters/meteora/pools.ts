import type { DAppAdapterContext } from '../types.js';
import { getMeteoraClient } from './client.js';
import type { MeteoraPoolSnapshot } from './client.js';
import { assertKnownDlmmProgram, parsePublicKey } from './validation.js';

export async function getPoolSnapshot(
  ctx: DAppAdapterContext,
  poolAddress: string,
): Promise<MeteoraPoolSnapshot> {
  const normalized = parsePublicKey(poolAddress, 'poolAddress');
  const snapshot = await getMeteoraClient().getPoolSnapshot(ctx.connection, normalized);
  assertKnownDlmmProgram(snapshot);
  return snapshot;
}
