import type { DAppAdapterContext } from '../types.js';

import {
  getLuloClient,
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
  _ctx: DAppAdapterContext,
): Promise<LuloRatesSnapshot> {
  void _ctx;
  return getLuloClient().getRates({
    ...(input.mintAddress?.trim() ? { mintAddress: input.mintAddress.trim() } : {}),
    ...(input.depositType ? { depositType: input.depositType } : {}),
  });
}

export interface GetLuloPoolMetaInput {
  mintAddress?: string;
}

export async function getLuloPoolMeta(
  input: GetLuloPoolMetaInput,
  _ctx: DAppAdapterContext,
): Promise<LuloPoolMetaSnapshot> {
  void _ctx;
  return getLuloClient().getPoolMeta({
    ...(input.mintAddress?.trim() ? { mintAddress: input.mintAddress.trim() } : {}),
  });
}
