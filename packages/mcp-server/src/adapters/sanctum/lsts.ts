import type { DAppAdapterContext } from '../types.js';
import { AdapterError } from '../types.js';
import { getSanctumClient, type SanctumLstListSnapshot, type SanctumLstSnapshot } from './client.js';
import {
  SANCTUM_ADAPTER_ID,
  SANCTUM_INF_MINT,
  SANCTUM_PROGRAM_IDS,
  SANCTUM_S_CONTROLLER_PROGRAM_ID,
} from './constants.js';

export async function listSanctumLsts(
  input: { includeDisabled?: boolean } = {},
): Promise<SanctumLstListSnapshot> {
  return getSanctumClient().getLsts({ includeDisabled: input.includeDisabled === true });
}

export async function getSanctumLstSnapshot(input: {
  lstMint?: string;
  mintOrSymbol?: string;
  includeApy?: boolean;
  apyLimit?: number;
}): Promise<SanctumLstSnapshot> {
  const mintOrSymbol = (input.lstMint ?? input.mintOrSymbol ?? '').trim();
  if (!mintOrSymbol) {
    throw new AdapterError(SANCTUM_ADAPTER_ID, 'invalid_request', 'Sanctum LST snapshot requires lstMint or mintOrSymbol.');
  }
  return getSanctumClient().getLst({
    mintOrSymbol,
    includeApy: input.includeApy === true,
    ...(input.apyLimit !== undefined && { apyLimit: input.apyLimit }),
  });
}

export async function getSanctumInfinityPoolSnapshot(
  input: { includeComposition?: boolean } = {},
  _ctx?: DAppAdapterContext,
): Promise<Record<string, unknown>> {
  const includeComposition = input.includeComposition !== false;
  const lsts = await getSanctumClient().getLsts({ includeDisabled: false });
  const composition = includeComposition
    ? lsts.rows.map((row) => ({
        mint: row.mint,
        symbol: row.symbol,
        ...(row.solValue !== undefined && { solValue: row.solValue }),
        ...(row.liquidity !== undefined && { liquidity: row.liquidity }),
        ...(row.enabled !== undefined && { enabled: row.enabled }),
      }))
    : undefined;
  return {
    programId: SANCTUM_S_CONTROLLER_PROGRAM_ID.toBase58(),
    infMint: SANCTUM_INF_MINT,
    supportedLstCount: lsts.rows.length,
    includeComposition,
    ...(composition !== undefined && { composition }),
    programIds: SANCTUM_PROGRAM_IDS.map((programId) => programId.toBase58()),
    asOfIso: lsts.asOfIso,
    source: 'sanctum-api',
    caveat: 'Composition, fees, valuations, and liquidity are current-state facts from Sanctum sources, not guarantees.',
  };
}
