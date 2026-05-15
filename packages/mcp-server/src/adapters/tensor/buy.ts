import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';
import type { PreparedAction } from '../../preparedActions.js';
import type { AdapterAction, AdapterExecuteResult, AdapterPrepareResult } from '../types.js';
import { AdapterError } from '../types.js';
import {
  resolveTensorClient,
  withTensorErrors,
  type TensorBuyInput,
  type TensorListing,
} from './client.js';
import {
  MAX_QUOTE_AGE_MS,
  TENSOR_ADAPTER_ID,
  TENSOR_PROGRAM_IDS,
  shortAddress,
  solFromLamports,
} from './constants.js';
import {
  optionalBooleanParam,
  optionalPublicKey,
  optionalStringParam,
  parseSolDecimal,
  requireMintOrAssetId,
  requireStringParam,
  stripUndefined,
} from './validation.js';

export interface TensorBuyPrepareInput {
  mintAddress?: string;
  assetId?: string;
  collectionId?: string;
  maxPriceSol: string;
  expectedSeller?: string;
  expectedMarketplace?: 'tensor' | 'any_tensor_supported';
  dueAt?: string;
  note?: string;
}

export const tensorBuyAction: AdapterAction<TensorBuyPrepareInput> = {
  id: 'buy',
  kind: 'tensor_buy',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const walletAddress = await ctx.backend.getAddress();
    const idRef = requireMintOrAssetId(input);
    const { priceLamports: maxPriceLamports, priceSol: maxPriceSol } = parseSolDecimal(
      input.maxPriceSol,
      'maxPriceSol',
    );
    const expectedSeller = optionalPublicKey(input.expectedSeller, 'expectedSeller');
    const expectedMarketplace = input.expectedMarketplace;

    const listing = await withTensorErrors('refreshListing', () =>
      resolveTensorClient(ctx).refreshListing(ctx.connection, idRef),
    );
    if (!listing) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'listing_not_found',
        'No active Tensor listing for this NFT.',
      );
    }
    assertListingFresh(listing);
    const currentLamports = BigInt(listing.priceLamports);
    if (currentLamports > maxPriceLamports) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'price_above_cap',
        `Tensor listing price ${solFromLamports(currentLamports)} SOL exceeds cap ${maxPriceSol} SOL.`,
      );
    }
    if (expectedSeller && listing.seller !== expectedSeller) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'seller_mismatch',
        `Tensor listing seller ${shortAddress(listing.seller)} does not match expectedSeller.`,
      );
    }
    if (expectedMarketplace === 'tensor' && listing.marketplace !== 'tensor') {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'marketplace_mismatch',
        `Tensor listing marketplace is ${listing.marketplace}, not tensor.`,
      );
    }

    const buyInput: TensorBuyInput = {
      walletAddress,
      ...(idRef.mintAddress !== undefined && { mintAddress: idRef.mintAddress }),
      ...(idRef.assetId !== undefined && { assetId: idRef.assetId }),
      ...(input.collectionId !== undefined && input.collectionId.trim() !== '' && {
        collectionId: input.collectionId.trim(),
      }),
      maxPriceLamports: maxPriceLamports.toString(),
      ...(expectedSeller !== undefined && { expectedSeller }),
      ...(expectedMarketplace !== undefined && { expectedMarketplace }),
      compressed: listing.compressed,
    };
    const built = await withTensorErrors('buildBuyTx', () =>
      resolveTensorClient(ctx).buildBuyTx(ctx.connection, buyInput),
    );

    const identifier = idRef.mintAddress ?? idRef.assetId!;
    const params: Record<string, unknown> = stripUndefined({
      adapter: TENSOR_ADAPTER_ID,
      connectorId: TENSOR_ADAPTER_ID,
      action: 'buy',
      operation: 'buy',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      refreshAtExecution: true,
      walletAddress,
      mintAddress: idRef.mintAddress,
      assetId: idRef.assetId,
      collectionId: input.collectionId?.trim() || undefined,
      listingId: listing.listingId,
      priceSol: solFromLamports(currentLamports),
      priceLamports: currentLamports.toString(),
      maxPriceSol,
      maxPriceLamports: maxPriceLamports.toString(),
      feePreview: built.preview.feeLamports,
      royaltyPreview: built.preview.royaltyLamports,
      compressed: listing.compressed,
      programIds: TENSOR_PROGRAM_IDS,
      apiSnapshot: {
        seller: listing.seller,
        marketplace: listing.marketplace,
        asOf: listing.asOf,
      },
      marketSnapshot: {
        priceLamports: listing.priceLamports,
        asOf: listing.asOf,
      },
      expectedSeller,
      expectedMarketplace,
      preparedSnapshotAt: new Date().toISOString(),
    });

    const summary = `Buy Tensor NFT ${shortAddress(identifier)} for up to ${maxPriceSol} SOL`;
    return {
      addInput: {
        kind: 'tensor_buy',
        walletAddress,
        cluster: ctx.config.cluster,
        summary,
        params,
        ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
        ...(input.note !== undefined && { note: input.note }),
      },
      preview: params,
    };
  },

  async execute(action: PreparedAction, ctx): Promise<AdapterExecuteResult> {
    const walletAddress = await ctx.backend.getAddress();
    if (walletAddress !== action.walletAddress) {
      throw new ProtocolError(
        'unauthorized',
        `Tensor buy belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }
    const mintAddress = optionalStringParam(action, 'mintAddress');
    const assetId = optionalStringParam(action, 'assetId');
    if (!mintAddress && !assetId) {
      throw new ProtocolError('invalid_request', 'Tensor buy action is missing mintAddress and assetId.');
    }
    const maxPriceLamportsText = requireStringParam(action, 'maxPriceLamports');
    const maxPriceLamports = BigInt(maxPriceLamportsText);
    const expectedSeller = optionalStringParam(action, 'expectedSeller');
    const expectedMarketplace = optionalStringParam(action, 'expectedMarketplace');

    const refreshed = await withTensorErrors('refreshListing', () =>
      resolveTensorClient(ctx).refreshListing(ctx.connection, {
        ...(mintAddress !== undefined && { mintAddress }),
        ...(assetId !== undefined && { assetId }),
      }),
    );
    if (!refreshed) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'state_changed',
        'Tensor listing is no longer active.',
      );
    }
    const currentLamports = BigInt(refreshed.priceLamports);
    if (currentLamports > maxPriceLamports) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'state_changed',
        `Tensor listing price changed to ${solFromLamports(currentLamports)} SOL, above prepared cap.`,
      );
    }
    if (expectedSeller && refreshed.seller !== expectedSeller) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'state_changed',
        'Tensor listing seller changed since prepare; create a new prepared action.',
      );
    }
    if (expectedMarketplace === 'tensor' && refreshed.marketplace !== 'tensor') {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'state_changed',
        'Tensor listing marketplace changed since prepare.',
      );
    }

    const compressed = optionalBooleanParam(action, 'compressed') ?? refreshed.compressed;
    const buyInput: TensorBuyInput = {
      walletAddress,
      ...(mintAddress !== undefined && { mintAddress }),
      ...(assetId !== undefined && { assetId }),
      ...(optionalStringParam(action, 'collectionId') !== undefined && {
        collectionId: optionalStringParam(action, 'collectionId')!,
      }),
      maxPriceLamports: maxPriceLamportsText,
      ...(expectedSeller !== undefined && { expectedSeller }),
      ...(expectedMarketplace !== undefined && { expectedMarketplace }),
      compressed,
    };

    const built = await withTensorErrors('buildBuyTx', () =>
      resolveTensorClient(ctx).buildBuyTx(ctx.connection, buyInput),
    );
    const summary = `Buy Tensor NFT ${shortAddress((mintAddress ?? assetId)!)}`;
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: built.preview as unknown as Record<string, unknown>,
    };
  },
};

function assertListingFresh(listing: TensorListing): void {
  if (!listing.asOf) return;
  const asOf = new Date(listing.asOf).getTime();
  if (!Number.isFinite(asOf)) return;
  if (Date.now() - asOf > MAX_QUOTE_AGE_MS) {
    throw new AdapterError(
      TENSOR_ADAPTER_ID,
      'stale_listing',
      'Tensor listing snapshot is stale; ask the user to refresh.',
    );
  }
}
