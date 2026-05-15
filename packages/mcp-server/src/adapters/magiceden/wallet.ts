import type { DAppAdapterContext } from '../types.js';

import { resolveMagicedenClient, type MagicedenWalletNftsSnapshot } from './client.js';

export interface WalletNftsInput {
  walletAddress?: string;
  collectionSymbol?: string;
  collectionId?: string;
  listedOnly?: boolean;
}

export async function getWalletNfts(
  input: WalletNftsInput,
  ctx: DAppAdapterContext,
): Promise<MagicedenWalletNftsSnapshot> {
  const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
  return resolveMagicedenClient(ctx).getWalletNfts({
    walletAddress,
    ...(input.collectionSymbol ? { collectionSymbol: input.collectionSymbol } : {}),
    ...(input.collectionId ? { collectionId: input.collectionId } : {}),
    ...(input.listedOnly !== undefined ? { listedOnly: input.listedOnly } : {}),
  });
}
