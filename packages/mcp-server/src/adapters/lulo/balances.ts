import type { DAppAdapterContext } from '../types.js';

import {
  getLuloClient,
  type LuloBalancesUnavailable,
  type LuloWalletBalancesSnapshot,
} from './client.js';

export interface GetLuloBalancesInput {
  walletAddress?: string;
}

export async function getLuloWalletBalances(
  input: GetLuloBalancesInput,
  ctx: DAppAdapterContext,
): Promise<LuloWalletBalancesSnapshot | LuloBalancesUnavailable> {
  const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
  if (!walletAddress) {
    throw new Error('walletAddress is required to read Lulo balances.');
  }
  return getLuloClient().getWalletBalances({ walletAddress });
}
