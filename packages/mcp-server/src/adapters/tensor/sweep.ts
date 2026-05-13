import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';
import type { PreparedAction } from '../../preparedActions.js';
import type { AdapterAction, AdapterExecuteResult, AdapterPrepareResult } from '../types.js';
import { AdapterError } from '../types.js';
import {
  getTensorClient,
  withTensorErrors,
  type TensorListing,
  type TensorSweepInput,
  type TensorSweepItem,
} from './client.js';
import {
  MAX_SWEEP_ITEMS,
  TENSOR_ADAPTER_ID,
  TENSOR_PROGRAM_IDS,
  shortAddress,
  solFromLamports,
} from './constants.js';
import {
  assertCompressedHomogeneous,
  assertNotMoreThanMaxSweep,
  parseSolDecimal,
  requireArrayParam,
  requireCollectionId,
  requireStringParam,
  stripUndefined,
  sumLamports,
} from './validation.js';

export interface TensorSweepPrepareInput {
  collectionId: string;
  maxItems: number;
  maxTotalSol: string;
  maxPricePerItemSol: string;
  requiredMintAddresses?: string[];
  excludeMintAddresses?: string[];
  dueAt?: string;
  note?: string;
}

interface SerializedSweepItem extends TensorSweepItem {
  expectedPriceSol: string;
}

export const tensorSweepAction: AdapterAction<TensorSweepPrepareInput> = {
  id: 'sweep',
  kind: 'tensor_sweep',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const walletAddress = await ctx.backend.getAddress();
    const collectionId = requireCollectionId(input.collectionId);
    if (!Number.isInteger(input.maxItems) || input.maxItems <= 0) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'invalid_input',
        'maxItems must be a positive integer.',
      );
    }
    if (input.maxItems > MAX_SWEEP_ITEMS) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'too_many_items',
        `Tensor sweep supports at most ${MAX_SWEEP_ITEMS} items in v1; requested ${input.maxItems}.`,
      );
    }
    const { priceLamports: maxTotalLamports, priceSol: maxTotalSol } = parseSolDecimal(
      input.maxTotalSol,
      'maxTotalSol',
    );
    const { priceLamports: maxPricePerItemLamports, priceSol: maxPricePerItemSol } = parseSolDecimal(
      input.maxPricePerItemSol,
      'maxPricePerItemSol',
    );

    const exclude = new Set((input.excludeMintAddresses ?? []).map((m) => m.trim()).filter(Boolean));
    const required = (input.requiredMintAddresses ?? []).map((m) => m.trim()).filter(Boolean);
    if (required.length > MAX_SWEEP_ITEMS) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'too_many_items',
        `Tensor sweep supports at most ${MAX_SWEEP_ITEMS} items in v1; requiredMintAddresses lists ${required.length}.`,
      );
    }

    const client = getTensorClient();
    let selected: TensorListing[];
    if (required.length > 0) {
      // When the caller pins specific items, refresh each one directly. A bulk
      // listing fetch would miss items past the page window even if they are
      // legitimately listed under the per-item cap.
      const refreshed = await Promise.all(
        required.map(async (itemId) => {
          if (exclude.has(itemId)) {
            throw new AdapterError(
              TENSOR_ADAPTER_ID,
              'invalid_input',
              `Tensor sweep item ${shortAddress(itemId)} appears in both requiredMintAddresses and excludeMintAddresses.`,
            );
          }
          const listing = await withTensorErrors('refreshListing', () =>
            client.refreshListing(ctx.connection, { mintAddress: itemId }),
          );
          if (!listing) {
            const alt = await withTensorErrors('refreshListing', () =>
              client.refreshListing(ctx.connection, { assetId: itemId }),
            );
            if (!alt) {
              throw new AdapterError(
                TENSOR_ADAPTER_ID,
                'listing_not_found',
                `Required Tensor item ${shortAddress(itemId)} is not actively listed.`,
              );
            }
            return alt;
          }
          if (BigInt(listing.priceLamports) > maxPricePerItemLamports) {
            throw new AdapterError(
              TENSOR_ADAPTER_ID,
              'price_above_cap',
              `Required Tensor item ${shortAddress(itemId)} listed at ${listing.priceSol} SOL exceeds per-item cap ${maxPricePerItemSol} SOL.`,
            );
          }
          return listing;
        }),
      );
      selected = refreshed;
    } else {
      const candidates = await withTensorErrors('fetchCollectionListings', () =>
        client.fetchCollectionListings(ctx.connection, collectionId, MAX_SWEEP_ITEMS * 4),
      );
      const pool = candidates
        .filter((listing) => {
          const id = listing.mintAddress ?? listing.assetId;
          if (!id) return false;
          if (exclude.has(id)) return false;
          return BigInt(listing.priceLamports) <= maxPricePerItemLamports;
        })
        .sort((a, b) =>
          BigInt(a.priceLamports) < BigInt(b.priceLamports) ? -1 : 1,
        );
      selected = pool.slice(0, input.maxItems);
    }

    assertNotMoreThanMaxSweep(selected.length);
    const compressed = assertCompressedHomogeneous(
      selected.map((listing) => ({ compressed: listing.compressed })),
    );

    const totalLamports = sumLamports(selected.map((listing) => listing.priceLamports));
    if (totalLamports > maxTotalLamports) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'total_above_cap',
        `Tensor sweep total ${solFromLamports(totalLamports)} SOL exceeds cap ${maxTotalSol} SOL.`,
      );
    }

    const exactItems: SerializedSweepItem[] = selected.map((listing) => ({
      ...(listing.mintAddress !== undefined && { mintAddress: listing.mintAddress }),
      ...(listing.assetId !== undefined && { assetId: listing.assetId }),
      ...(listing.listingId !== undefined && { listingId: listing.listingId }),
      expectedPriceLamports: listing.priceLamports,
      expectedPriceSol: listing.priceSol,
      compressed: listing.compressed,
    }));

    const sweepInput: TensorSweepInput = {
      walletAddress,
      collectionId,
      exactItems: exactItems.map(toClientItem),
      maxTotalLamports: maxTotalLamports.toString(),
      maxPricePerItemLamports: maxPricePerItemLamports.toString(),
      compressed,
    };
    const built = await withTensorErrors('buildSweepTx', () =>
      client.buildSweepTx(ctx.connection, sweepInput),
    );

    const params: Record<string, unknown> = stripUndefined({
      adapter: TENSOR_ADAPTER_ID,
      connectorId: TENSOR_ADAPTER_ID,
      action: 'sweep',
      operation: 'sweep',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      refreshAtExecution: true,
      walletAddress,
      collectionId,
      maxItems: input.maxItems,
      totalSol: solFromLamports(totalLamports),
      totalLamports: totalLamports.toString(),
      maxTotalSol,
      maxTotalLamports: maxTotalLamports.toString(),
      maxPricePerItemSol,
      maxPricePerItemLamports: maxPricePerItemLamports.toString(),
      exactSweepItems: exactItems,
      compressed,
      feePreview: built.preview.feeLamports,
      royaltyPreview: built.preview.royaltyLamports,
      programIds: TENSOR_PROGRAM_IDS,
      preparedSnapshotAt: new Date().toISOString(),
    });

    const summary = `Sweep ${exactItems.length} Tensor NFTs from ${shortAddress(collectionId)} (≤ ${maxTotalSol} SOL)`;
    return {
      addInput: {
        kind: 'tensor_sweep',
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
        `Tensor sweep belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }
    const collectionId = requireStringParam(action, 'collectionId');
    const maxTotalLamports = BigInt(requireStringParam(action, 'maxTotalLamports'));
    const maxPricePerItemLamports = BigInt(requireStringParam(action, 'maxPricePerItemLamports'));
    const storedItems = requireArrayParam<SerializedSweepItem>(action, 'exactSweepItems');
    assertNotMoreThanMaxSweep(storedItems.length);
    const compressed = assertCompressedHomogeneous(storedItems);

    const client = getTensorClient();
    const refreshed: TensorListing[] = [];
    for (const item of storedItems) {
      const fresh = await withTensorErrors('refreshListing', () =>
        client.refreshListing(ctx.connection, {
          ...(item.mintAddress !== undefined && { mintAddress: item.mintAddress }),
          ...(item.assetId !== undefined && { assetId: item.assetId }),
          ...(item.listingId !== undefined && { listingId: item.listingId }),
        }),
      );
      if (!fresh) {
        throw new AdapterError(
          TENSOR_ADAPTER_ID,
          'state_changed',
          `Tensor sweep item ${shortAddress((item.mintAddress ?? item.assetId)!)} is no longer listed.`,
        );
      }
      if (fresh.compressed !== item.compressed) {
        throw new AdapterError(
          TENSOR_ADAPTER_ID,
          'state_changed',
          'Tensor sweep item compressed flag changed since prepare.',
        );
      }
      if (BigInt(fresh.priceLamports) !== BigInt(item.expectedPriceLamports)) {
        throw new AdapterError(
          TENSOR_ADAPTER_ID,
          'state_changed',
          `Tensor sweep item price changed from ${solFromLamports(item.expectedPriceLamports)} to ${solFromLamports(fresh.priceLamports)} SOL.`,
        );
      }
      if (BigInt(fresh.priceLamports) > maxPricePerItemLamports) {
        throw new AdapterError(
          TENSOR_ADAPTER_ID,
          'state_changed',
          'Tensor sweep item now exceeds per-item cap.',
        );
      }
      refreshed.push(fresh);
    }

    const totalLamports = sumLamports(refreshed.map((listing) => listing.priceLamports));
    if (totalLamports > maxTotalLamports) {
      throw new AdapterError(
        TENSOR_ADAPTER_ID,
        'state_changed',
        `Tensor sweep total now ${solFromLamports(totalLamports)} SOL exceeds cap.`,
      );
    }

    const sweepInput: TensorSweepInput = {
      walletAddress,
      collectionId,
      exactItems: storedItems.map(toClientItem),
      maxTotalLamports: maxTotalLamports.toString(),
      maxPricePerItemLamports: maxPricePerItemLamports.toString(),
      compressed,
    };
    const built = await withTensorErrors('buildSweepTx', () =>
      client.buildSweepTx(ctx.connection, sweepInput),
    );
    const summary = `Tensor sweep on collection ${shortAddress(collectionId)}`;
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: built.preview as unknown as Record<string, unknown>,
    };
  },
};

function toClientItem(item: TensorSweepItem | SerializedSweepItem): TensorSweepItem {
  return {
    ...(item.mintAddress !== undefined && { mintAddress: item.mintAddress }),
    ...(item.assetId !== undefined && { assetId: item.assetId }),
    ...(item.listingId !== undefined && { listingId: item.listingId }),
    expectedPriceLamports: item.expectedPriceLamports,
    compressed: item.compressed,
  };
}
