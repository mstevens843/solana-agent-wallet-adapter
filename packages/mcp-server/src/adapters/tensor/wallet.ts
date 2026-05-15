import type { DAppAdapterContext } from '../types.js';
import { AdapterError } from '../types.js';
import {
  resolveTensorClient,
  redactApiKey,
  type TensorNftDetail,
  type TensorWalletExposure,
  type TensorWalletNftsResult,
} from './client.js';
import { TENSOR_ADAPTER_ID } from './constants.js';
import { optionalPublicKey, requireMintOrAssetId } from './validation.js';

export interface GetWalletNftsInput {
  walletAddress?: string;
  collectionId?: string;
  includeCompressed?: boolean;
}

export async function getWalletNfts(
  ctx: DAppAdapterContext,
  input: GetWalletNftsInput,
): Promise<TensorWalletNftsResult> {
  try {
    const walletAddress =
      optionalPublicKey(input.walletAddress, 'walletAddress') ?? (await ctx.backend.getAddress());
    return await resolveTensorClient(ctx).fetchWalletNfts(ctx.connection, {
      walletAddress,
      ...(input.collectionId !== undefined && input.collectionId.trim() !== '' && { collectionId: input.collectionId.trim() }),
      includeCompressed: input.includeCompressed ?? true,
    });
  } catch (err) {
    throw wrapAsAdapterError(err, 'fetchWalletNfts');
  }
}

export async function getNftDetail(
  ctx: DAppAdapterContext,
  input: { mintAddress?: string; assetId?: string },
): Promise<TensorNftDetail> {
  const idRef = requireMintOrAssetId(input);
  try {
    return await resolveTensorClient(ctx).fetchNftDetail(ctx.connection, idRef);
  } catch (err) {
    throw wrapAsAdapterError(err, 'fetchNftDetail');
  }
}

export async function getWalletMarketplaceExposure(
  ctx: DAppAdapterContext,
  input: { walletAddress?: string },
): Promise<TensorWalletExposure> {
  try {
    const walletAddress =
      optionalPublicKey(input.walletAddress, 'walletAddress') ?? (await ctx.backend.getAddress());
    return await resolveTensorClient(ctx).fetchWalletExposure(ctx.connection, walletAddress);
  } catch (err) {
    throw wrapAsAdapterError(err, 'fetchWalletExposure');
  }
}

function wrapAsAdapterError(err: unknown, method: string): Error {
  if (err instanceof AdapterError) {
    return new AdapterError(TENSOR_ADAPTER_ID, err.code, redactApiKey(err.message));
  }
  const message = err instanceof Error ? err.message : String(err);
  return new AdapterError(
    TENSOR_ADAPTER_ID,
    'api_error',
    `Tensor ${method} failed: ${redactApiKey(message)}`,
  );
}
