import type { Connection } from '@solana/web3.js';

import { getMarinadeClient, type MarinadeStateSnapshot } from './client.js';

export async function readMarinadeStateSnapshot(connection: Connection): Promise<MarinadeStateSnapshot> {
  return getMarinadeClient().getStateSnapshot(connection);
}
