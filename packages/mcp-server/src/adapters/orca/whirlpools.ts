import { getOrcaClient, type OrcaWhirlpoolSnapshot } from './client.js';
import { assertKnownWhirlpoolProgram, parsePublicKey } from './validation.js';
import type { DAppAdapterContext } from '../types.js';

export async function getWhirlpoolSnapshot(
  ctx: DAppAdapterContext,
  whirlpoolAddress: string,
): Promise<OrcaWhirlpoolSnapshot> {
  const normalized = parsePublicKey(whirlpoolAddress, 'whirlpoolAddress');
  const snapshot = await getOrcaClient().getWhirlpoolSnapshot(ctx.connection, normalized);
  assertKnownWhirlpoolProgram(snapshot);
  return snapshot;
}
