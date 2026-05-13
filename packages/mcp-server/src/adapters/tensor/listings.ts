import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';
import type { PreparedAction } from '../../preparedActions.js';
import type { AdapterAction, AdapterExecuteResult, AdapterPrepareResult } from '../types.js';
import { AdapterError } from '../types.js';
import {
  getTensorClient,
  withTensorErrors,
  type TensorCancelListingInput,
  type TensorListInput,
} from './client.js';
import {
  TENSOR_ADAPTER_ID,
  TENSOR_PROGRAM_IDS,
  shortAddress,
  solFromLamports,
} from './constants.js';
import { getNftDetail } from './wallet.js';
import {
  optionalBooleanParam,
  optionalStringParam,
  parseExpiresAt,
  parseSolDecimal,
  requireMintOrAssetId,
  requireStringParam,
  stripUndefined,
} from './validation.js';

export interface TensorListPrepareInput {
  mintAddress?: string;
  assetId?: string;
  priceSol: string;
  expiresAt?: string;
  /**
   * When false, the prepare rejects compressed NFTs with `compressed_not_allowed`
   * so the caller doesn't accidentally publish a tcomp listing. Defaults to true.
   */
  allowCompressed?: boolean;
  dueAt?: string;
  note?: string;
}

export interface TensorCancelListingPrepareInput {
  mintAddress?: string;
  assetId?: string;
  listingId?: string;
  dueAt?: string;
  note?: string;
}

export const tensorListAction: AdapterAction<TensorListPrepareInput> = {
  id: 'list',
  kind: 'tensor_list',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const walletAddress = await ctx.backend.getAddress();
    const idRef = requireMintOrAssetId(input);
    const { priceLamports, priceSol } = parseSolDecimal(input.priceSol, 'priceSol');
    const expiresAt = parseExpiresAt(input.expiresAt, 'expiresAt');

    const detail = await getNftDetail(ctx, idRef);
    if (detail.owner !== walletAddress) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'not_owner',
        `Connected wallet ${shortAddress(walletAddress)} does not own this NFT; current owner ${shortAddress(detail.owner)}.`,
      );
    }
    if (detail.frozen === true) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'frozen_asset',
        'Tensor cannot list a frozen NFT.',
      );
    }
    const allowCompressed = input.allowCompressed !== false;
    if (detail.compressed && !allowCompressed) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'compressed_not_allowed',
        'This NFT is compressed (tcomp). Pass allowCompressed: true to list it.',
      );
    }
    const warnings: string[] = [...(detail.warnings ?? [])];
    if (detail.topListing && BigInt(detail.topListing.priceLamports) === priceLamports) {
      warnings.push('An existing listing already matches this price.');
    }

    const listInput: TensorListInput = {
      walletAddress,
      ...(idRef.mintAddress !== undefined && { mintAddress: idRef.mintAddress }),
      ...(idRef.assetId !== undefined && { assetId: idRef.assetId }),
      priceLamports: priceLamports.toString(),
      ...(expiresAt !== undefined && { expiresAt }),
      compressed: detail.compressed,
    };
    const built = await withTensorErrors('buildListTx', () =>
      getTensorClient().buildListTx(ctx.connection, listInput),
    );

    const identifier = idRef.mintAddress ?? idRef.assetId!;
    const params: Record<string, unknown> = stripUndefined({
      adapter: TENSOR_ADAPTER_ID,
      connectorId: TENSOR_ADAPTER_ID,
      action: 'list',
      operation: 'list',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      refreshAtExecution: true,
      walletAddress,
      mintAddress: idRef.mintAddress,
      assetId: idRef.assetId,
      collectionId: detail.collectionId,
      priceSol,
      priceLamports: priceLamports.toString(),
      expiresAt,
      feePreview: built.preview.feeLamports,
      royaltyPreview: built.preview.royaltyLamports,
      compressed: detail.compressed,
      programIds: TENSOR_PROGRAM_IDS,
      warnings: warnings.length > 0 ? warnings : undefined,
      preparedSnapshotAt: new Date().toISOString(),
    });

    const summary = `List Tensor NFT ${shortAddress(identifier)} for ${priceSol} SOL`;
    return {
      addInput: {
        kind: 'tensor_list',
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
        `Tensor list belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }
    const mintAddress = optionalStringParam(action, 'mintAddress');
    const assetId = optionalStringParam(action, 'assetId');
    if (!mintAddress && !assetId) {
      throw new ProtocolError('invalid_request', 'Tensor list action is missing mintAddress and assetId.');
    }
    const priceLamportsText = requireStringParam(action, 'priceLamports');

    const detail = await getNftDetail(ctx, {
      ...(mintAddress !== undefined && { mintAddress }),
      ...(assetId !== undefined && { assetId }),
    });
    if (detail.owner !== walletAddress) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'state_changed',
        `Wallet ${shortAddress(walletAddress)} no longer owns this NFT.`,
      );
    }
    const compressed = optionalBooleanParam(action, 'compressed') ?? detail.compressed;

    const listInput: TensorListInput = {
      walletAddress,
      ...(mintAddress !== undefined && { mintAddress }),
      ...(assetId !== undefined && { assetId }),
      priceLamports: priceLamportsText,
      ...(optionalStringParam(action, 'expiresAt') !== undefined && {
        expiresAt: optionalStringParam(action, 'expiresAt')!,
      }),
      compressed,
    };
    const built = await withTensorErrors('buildListTx', () =>
      getTensorClient().buildListTx(ctx.connection, listInput),
    );
    const summary = `List Tensor NFT ${shortAddress((mintAddress ?? assetId)!)} for ${solFromLamports(priceLamportsText)} SOL`;
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: built.preview as unknown as Record<string, unknown>,
    };
  },
};

export const tensorCancelListingAction: AdapterAction<TensorCancelListingPrepareInput> = {
  id: 'cancel_listing',
  kind: 'tensor_cancel_listing',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const walletAddress = await ctx.backend.getAddress();
    const idRef = requireMintOrAssetId(input);
    const listingId = input.listingId?.trim() || undefined;

    const detail = await getNftDetail(ctx, idRef);
    const listing = detail.topListing ?? null;
    if (!listing) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'listing_not_found',
        'No active Tensor listing found for this NFT.',
      );
    }
    if (listing.seller !== walletAddress) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'not_owner',
        `Connected wallet does not own this Tensor listing.`,
      );
    }
    if (!listingId && typeof detail.walletOpenListings === 'number' && detail.walletOpenListings > 1) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'needs_input',
        `Wallet has ${detail.walletOpenListings} open Tensor listings for this NFT; pass listingId to disambiguate.`,
      );
    }

    const cancelInput: TensorCancelListingInput = {
      walletAddress,
      ...(idRef.mintAddress !== undefined && { mintAddress: idRef.mintAddress }),
      ...(idRef.assetId !== undefined && { assetId: idRef.assetId }),
      ...(listingId !== undefined && { listingId }),
      compressed: listing.compressed,
    };
    const built = await withTensorErrors('buildCancelListingTx', () =>
      getTensorClient().buildCancelListingTx(ctx.connection, cancelInput),
    );

    const identifier = idRef.mintAddress ?? idRef.assetId!;
    const params: Record<string, unknown> = stripUndefined({
      adapter: TENSOR_ADAPTER_ID,
      connectorId: TENSOR_ADAPTER_ID,
      action: 'cancel_listing',
      operation: 'cancel_listing',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      refreshAtExecution: true,
      walletAddress,
      mintAddress: idRef.mintAddress,
      assetId: idRef.assetId,
      collectionId: detail.collectionId,
      listingId: listingId ?? listing.listingId,
      priceSol: listing.priceSol,
      priceLamports: listing.priceLamports,
      feePreview: built.preview.feeLamports,
      compressed: listing.compressed,
      programIds: TENSOR_PROGRAM_IDS,
      preparedSnapshotAt: new Date().toISOString(),
    });

    const summary = `Cancel Tensor listing for ${shortAddress(identifier)}`;
    return {
      addInput: {
        kind: 'tensor_cancel_listing',
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
        `Tensor cancel-listing belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }
    const mintAddress = optionalStringParam(action, 'mintAddress');
    const assetId = optionalStringParam(action, 'assetId');
    const listingId = optionalStringParam(action, 'listingId');

    const refreshed = await withTensorErrors('refreshListing', () =>
      getTensorClient().refreshListing(ctx.connection, {
        ...(mintAddress !== undefined && { mintAddress }),
        ...(assetId !== undefined && { assetId }),
        ...(listingId !== undefined && { listingId }),
      }),
    );
    if (!refreshed) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'state_changed',
        'Tensor listing is no longer active.',
      );
    }
    if (refreshed.seller !== walletAddress) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'state_changed',
        'Tensor listing is no longer owned by this wallet.',
      );
    }

    const compressed = optionalBooleanParam(action, 'compressed') ?? refreshed.compressed;
    const cancelInput: TensorCancelListingInput = {
      walletAddress,
      ...(mintAddress !== undefined && { mintAddress }),
      ...(assetId !== undefined && { assetId }),
      ...(listingId !== undefined && { listingId }),
      compressed,
    };
    const built = await withTensorErrors('buildCancelListingTx', () =>
      getTensorClient().buildCancelListingTx(ctx.connection, cancelInput),
    );
    const summary = `Cancel Tensor listing for ${shortAddress((mintAddress ?? assetId)!)}`;
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: built.preview as unknown as Record<string, unknown>,
    };
  },
};
