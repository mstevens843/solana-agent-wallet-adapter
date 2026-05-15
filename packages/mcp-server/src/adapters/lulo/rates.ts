import type { DAppAdapterContext } from '../types.js';

import {
  resolveLuloClient,
  type LuloPoolMetaSnapshot,
  type LuloRatesSnapshot,
} from './client.js';
import type { LuloDepositType } from './constants.js';

export interface GetLuloRatesInput {
  mintAddress?: string;
  depositType?: LuloDepositType;
}

export async function getLuloRates(
  input: GetLuloRatesInput,
  ctx: DAppAdapterContext,
): Promise<LuloRatesSnapshot> {
  return resolveLuloClient(ctx).getRates({
    ...(input.mintAddress?.trim() ? { mintAddress: input.mintAddress.trim() } : {}),
    ...(input.depositType ? { depositType: input.depositType } : {}),
  });
}

export interface GetLuloPoolMetaInput {
  mintAddress?: string;
}

export async function getLuloPoolMeta(
  input: GetLuloPoolMetaInput,
  ctx: DAppAdapterContext,
): Promise<LuloPoolMetaSnapshot> {
  return resolveLuloClient(ctx).getPoolMeta({
    ...(input.mintAddress?.trim() ? { mintAddress: input.mintAddress.trim() } : {}),
  });
}
