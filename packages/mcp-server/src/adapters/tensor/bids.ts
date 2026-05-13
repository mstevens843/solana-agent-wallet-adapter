import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';
import type { PreparedAction } from '../../preparedActions.js';
import type { AdapterAction, AdapterExecuteResult, AdapterPrepareResult } from '../types.js';
import { AdapterError } from '../types.js';
import {
  getTensorClient,
  withTensorErrors,
  type TensorBidInput,
  type TensorCancelBidInput,
} from './client.js';
import {
  TENSOR_ADAPTER_ID,
  TENSOR_PROGRAM_IDS,
  shortAddress,
  solFromLamports,
} from './constants.js';
import { getWalletMarketplaceExposure } from './wallet.js';
import {
  optionalBooleanParam,
  optionalStringParam,
  parseExpiresAt,
  parsePositiveQuantity,
  parsePublicKey,
  parseSolDecimal,
  requireMintOrAssetId,
  requireStringParam,
  stripUndefined,
} from './validation.js';

export interface TensorBidPrepareInput {
  collectionId: string;
  mintAddress?: string;
  assetId?: string;
  bidPriceSol: string;
  quantity?: number;
  expiresAt?: string;
  maxEscrowSol: string;
  dueAt?: string;
  note?: string;
}

export interface TensorCancelBidPrepareInput {
  bidId?: string;
  collectionId?: string;
  dueAt?: string;
  note?: string;
}

export const tensorBidAction: AdapterAction<TensorBidPrepareInput> = {
  id: 'bid',
  kind: 'tensor_bid',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const walletAddress = await ctx.backend.getAddress();
    const collectionId = (input.collectionId ?? '').trim();
    if (!collectionId) {
      throw new AdapterError(TENSOR_ADAPTER_ID, 'missing_input', 'collectionId is required for Tensor bids.');
    }
    const itemRef = input.mintAddress || input.assetId
      ? requireMintOrAssetId({ mintAddress: input.mintAddress, assetId: input.assetId })
      : {};
    const { priceLamports: bidPriceLamports, priceSol: bidPriceSol } = parseSolDecimal(
      input.bidPriceSol,
      'bidPriceSol',
    );
    const { priceLamports: maxEscrowLamports, priceSol: maxEscrowSol } = parseSolDecimal(
      input.maxEscrowSol,
      'maxEscrowSol',
    );
    const quantity = parsePositiveQuantity(input.quantity, 'quantity');
    const expiresAt = parseExpiresAt(input.expiresAt, 'expiresAt');

    const exposure = await getWalletMarketplaceExposure(ctx, { walletAddress });
    const currentEscrow = exposure.marginBalanceLamports
      ? BigInt(exposure.marginBalanceLamports)
      : 0n;
    const delta = bidPriceLamports * BigInt(quantity);
    const required = currentEscrow + delta;
    if (required > maxEscrowLamports) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'escrow_above_cap',
        `Tensor bid requires ${solFromLamports(required)} SOL escrow (current ${solFromLamports(currentEscrow)} + delta ${solFromLamports(delta)}), exceeding cap ${maxEscrowSol} SOL.`,
      );
    }

    // The bid is compressed iff every item in the collection is compressed; default false unless the host marks it.
    const compressed = false;

    const bidInput: TensorBidInput = {
      walletAddress,
      collectionId,
      ...(itemRef.mintAddress !== undefined && { mintAddress: itemRef.mintAddress }),
      ...(itemRef.assetId !== undefined && { assetId: itemRef.assetId }),
      bidPriceLamports: bidPriceLamports.toString(),
      quantity,
      ...(expiresAt !== undefined && { expiresAt }),
      maxEscrowLamports: maxEscrowLamports.toString(),
      compressed,
    };
    const built = await withTensorErrors('buildBidTx', () =>
      getTensorClient().buildBidTx(ctx.connection, bidInput),
    );

    const params: Record<string, unknown> = stripUndefined({
      adapter: TENSOR_ADAPTER_ID,
      connectorId: TENSOR_ADAPTER_ID,
      action: 'bid',
      operation: 'bid',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      refreshAtExecution: true,
      walletAddress,
      collectionId,
      mintAddress: itemRef.mintAddress,
      assetId: itemRef.assetId,
      bidPriceSol,
      bidPriceLamports: bidPriceLamports.toString(),
      quantity,
      expiresAt,
      maxEscrowSol,
      maxEscrowLamports: maxEscrowLamports.toString(),
      currentEscrowLamports: currentEscrow.toString(),
      feePreview: built.preview.feeLamports,
      compressed,
      programIds: TENSOR_PROGRAM_IDS,
      preparedSnapshotAt: new Date().toISOString(),
    });

    const summary = itemRef.mintAddress || itemRef.assetId
      ? `Bid ${bidPriceSol} SOL on Tensor NFT ${shortAddress((itemRef.mintAddress ?? itemRef.assetId)!)}`
      : `Bid ${bidPriceSol} SOL on Tensor collection ${shortAddress(collectionId)} (qty ${quantity})`;
    return {
      addInput: {
        kind: 'tensor_bid',
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
        `Tensor bid belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }
    const collectionId = requireStringParam(action, 'collectionId');
    const bidPriceLamportsText = requireStringParam(action, 'bidPriceLamports');
    const bidPriceLamports = BigInt(bidPriceLamportsText);
    const maxEscrowLamportsText = requireStringParam(action, 'maxEscrowLamports');
    const maxEscrowLamports = BigInt(maxEscrowLamportsText);
    const quantity = parsePositiveQuantity(
      typeof action.params.quantity === 'number' ? (action.params.quantity as number) : 1,
      'quantity',
    );
    const compressed = optionalBooleanParam(action, 'compressed') ?? false;

    const exposure = await getWalletMarketplaceExposure(ctx, { walletAddress });
    const currentEscrow = exposure.marginBalanceLamports
      ? BigInt(exposure.marginBalanceLamports)
      : 0n;
    const required = currentEscrow + bidPriceLamports * BigInt(quantity);
    if (required > maxEscrowLamports) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'state_changed',
        `Tensor escrow now ${solFromLamports(currentEscrow)} SOL; total required ${solFromLamports(required)} exceeds prepared cap.`,
      );
    }

    const bidInput: TensorBidInput = {
      walletAddress,
      collectionId,
      ...(optionalStringParam(action, 'mintAddress') !== undefined && {
        mintAddress: optionalStringParam(action, 'mintAddress')!,
      }),
      ...(optionalStringParam(action, 'assetId') !== undefined && {
        assetId: optionalStringParam(action, 'assetId')!,
      }),
      bidPriceLamports: bidPriceLamportsText,
      quantity,
      ...(optionalStringParam(action, 'expiresAt') !== undefined && {
        expiresAt: optionalStringParam(action, 'expiresAt')!,
      }),
      maxEscrowLamports: maxEscrowLamportsText,
      compressed,
    };
    const built = await withTensorErrors('buildBidTx', () =>
      getTensorClient().buildBidTx(ctx.connection, bidInput),
    );
    const summary = `Tensor bid on collection ${shortAddress(collectionId)}`;
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: built.preview as unknown as Record<string, unknown>,
    };
  },
};

export const tensorCancelBidAction: AdapterAction<TensorCancelBidPrepareInput> = {
  id: 'cancel_bid',
  kind: 'tensor_cancel_bid',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const walletAddress = await ctx.backend.getAddress();
    const explicitBidId = input.bidId?.trim() || undefined;
    const collectionId = input.collectionId?.trim() || undefined;
    if (collectionId) parsePublicKey(collectionId, 'collectionId');

    const exposure = await getWalletMarketplaceExposure(ctx, { walletAddress });
    const ownedBids = exposure.openBids.filter((bid) => bid.bidder === walletAddress);
    const matchingBids = collectionId
      ? ownedBids.filter((bid) => bid.collectionId === collectionId)
      : ownedBids;
    if (matchingBids.length === 0) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'bid_not_found',
        'No active Tensor bid found for this wallet.',
      );
    }
    let bidId = explicitBidId;
    if (!bidId) {
      if (matchingBids.length > 1) {
        throw new AdapterError(
          TENSOR_ADAPTER_ID,
          'needs_input',
          'Multiple open Tensor bids; pass bidId to disambiguate.',
        );
      }
      bidId = matchingBids[0]!.bidId;
    }
    const bid = matchingBids.find((entry) => entry.bidId === bidId);
    if (!bid) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'bid_not_found',
        `No active Tensor bid ${bidId} owned by this wallet.`,
      );
    }

    const cancelInput: TensorCancelBidInput = {
      walletAddress,
      bidId,
      ...(bid.collectionId !== undefined && { collectionId: bid.collectionId }),
    };
    const built = await withTensorErrors('buildCancelBidTx', () =>
      getTensorClient().buildCancelBidTx(ctx.connection, cancelInput),
    );

    const params: Record<string, unknown> = stripUndefined({
      adapter: TENSOR_ADAPTER_ID,
      connectorId: TENSOR_ADAPTER_ID,
      action: 'cancel_bid',
      operation: 'cancel_bid',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      refreshAtExecution: true,
      walletAddress,
      bidId,
      collectionId: bid.collectionId,
      bidPriceSol: bid.bidPriceSol,
      bidPriceLamports: bid.bidPriceLamports,
      escrowLamports: bid.escrowLamports,
      feePreview: built.preview.feeLamports,
      programIds: TENSOR_PROGRAM_IDS,
      preparedSnapshotAt: new Date().toISOString(),
    });

    const summary = `Cancel Tensor bid ${shortAddress(bidId)}`;
    return {
      addInput: {
        kind: 'tensor_cancel_bid',
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
        `Tensor cancel-bid belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }
    const bidId = requireStringParam(action, 'bidId');
    const refreshed = await withTensorErrors('refreshBid', () =>
      getTensorClient().refreshBid(ctx.connection, { bidId }),
    );
    if (!refreshed) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'state_changed',
        `Tensor bid ${bidId} is no longer active.`,
      );
    }
    if (refreshed.bidder !== walletAddress) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'state_changed',
        `Tensor bid ${bidId} is not owned by this wallet.`,
      );
    }

    const cancelInput: TensorCancelBidInput = {
      walletAddress,
      bidId,
      ...(optionalStringParam(action, 'collectionId') !== undefined && {
        collectionId: optionalStringParam(action, 'collectionId')!,
      }),
    };
    const built = await withTensorErrors('buildCancelBidTx', () =>
      getTensorClient().buildCancelBidTx(ctx.connection, cancelInput),
    );
    const summary = `Cancel Tensor bid ${shortAddress(bidId)}`;
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: built.preview as unknown as Record<string, unknown>,
    };
  },
};

