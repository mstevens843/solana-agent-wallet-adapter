import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';
import type { PreparedAction } from '../../preparedActions.js';
import type {
  AdapterAction,
  AdapterExecuteResult,
  AdapterPrepareResult,
  DAppAdapterContext,
} from '../types.js';
import { AdapterError } from '../types.js';

import {
  resolveMagicedenClient,
  type MagicedenApiHealthSnapshot,
  type MagicedenListingRow,
} from './client.js';
import {
  MAGICEDEN_ADAPTER_ID,
  MAGICEDEN_API_TRANSITION_WARNING,
  MAGICEDEN_MARKETPLACE_PROGRAM_ID,
  lamportsFromSol,
  normalizeSolDecimal,
  shortMint,
  solFromLamports,
} from './constants.js';
import { getApiHealthSnapshot, requireTradingOperational } from './health.js';

const PROVES_CLAUSE = CONNECTOR_APPROVAL_BOUNDARY;

export interface MagicedenBuyPrepareInput {
  mintAddress: string;
  maxPriceSol: string;
  collectionSymbol?: string;
  collectionId?: string;
  expectedSeller?: string;
  expectedListingId?: string;
  dueAt?: string;
  note?: string;
}

export interface MagicedenListPrepareInput {
  mintAddress: string;
  priceSol: string;
  expiresAt?: string;
  dueAt?: string;
  note?: string;
}

export interface MagicedenCancelListingPrepareInput {
  mintAddress: string;
  listingId?: string;
  dueAt?: string;
  note?: string;
}

export interface MagicedenBidPrepareInput {
  bidPriceSol: string;
  maxEscrowSol: string;
  mintAddress?: string;
  collectionSymbol?: string;
  collectionId?: string;
  quantity?: number;
  expiresAt?: string;
  dueAt?: string;
  note?: string;
}

export interface MagicedenCancelBidPrepareInput {
  bidId?: string;
  collectionSymbol?: string;
  collectionId?: string;
  mintAddress?: string;
  dueAt?: string;
  note?: string;
}

export const magicedenBuyAction: AdapterAction<MagicedenBuyPrepareInput> = {
  id: 'buy',
  kind: 'magiceden_buy',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const mintAddress = requireString(input.mintAddress, 'mintAddress');
    const maxPriceLamports = lamportsFromSolField(input.maxPriceSol, 'maxPriceSol');
    const health = await getApiHealthSnapshot({ includeTradingEndpoints: true }, ctx);
    requireTradingOperational(health);

    const client = resolveMagicedenClient(ctx);
    const listings = await client.getCollectionListings({
      ...(input.collectionSymbol ? { collectionSymbol: input.collectionSymbol } : {}),
      ...(input.collectionId ? { collectionId: input.collectionId } : {}),
      limit: 100,
    });
    const listing = pickListingForMint(listings.rows, mintAddress, input.expectedListingId);
    if (!listing) {
      throw new AdapterError(
        MAGICEDEN_ADAPTER_ID,
        'listing_not_found',
        `No active Magic Eden listing found for ${shortMint(mintAddress)}.`,
      );
    }
    if (input.expectedSeller && listing.seller && listing.seller !== input.expectedSeller) {
      throw new AdapterError(
        MAGICEDEN_ADAPTER_ID,
        'seller_mismatch',
        `Magic Eden listing seller ${listing.seller} does not match expectedSeller ${input.expectedSeller}.`,
      );
    }
    const listingLamports = BigInt(listing.priceLamports);
    if (listingLamports > maxPriceLamports) {
      throw new AdapterError(
        MAGICEDEN_ADAPTER_ID,
        'price_above_cap',
        `Magic Eden listing price ${listing.priceSol} SOL exceeds maxPriceSol cap ${input.maxPriceSol} SOL.`,
      );
    }

    const walletAddress = await ctx.backend.getAddress();
    const built = await client.generateBuyTransaction({
      buyerAddress: walletAddress,
      sellerAddress: listing.seller ?? '',
      mintAddress,
      priceLamports: listing.priceLamports,
      ...(listing.auctionHouse ? { auctionHouse: listing.auctionHouse } : {}),
      ...(input.collectionSymbol ? { collectionSymbol: input.collectionSymbol } : {}),
      ...(listing.listingId ? { expectedListingId: listing.listingId } : {}),
    });

    const warnings = buildWarnings(health, listing, built.warnings);
    const summary = `Buy ${listing.tokenName ?? shortMint(mintAddress)} on Magic Eden for ${listing.priceSol} SOL`;
    const params: Record<string, unknown> = {
      adapter: MAGICEDEN_ADAPTER_ID,
      connectorId: MAGICEDEN_ADAPTER_ID,
      operation: 'buy',
      approvalBoundary: PROVES_CLAUSE,
      walletAddress,
      mintAddress,
      ...(input.collectionSymbol ? { collectionSymbol: input.collectionSymbol } : {}),
      ...(input.collectionId ? { collectionId: input.collectionId } : {}),
      ...(listing.listingId ? { listingId: listing.listingId } : {}),
      ...(listing.seller ? { seller: listing.seller } : {}),
      priceLamports: listing.priceLamports,
      priceSol: listing.priceSol,
      maxPriceLamports: maxPriceLamports.toString(),
      maxPriceSol: input.maxPriceSol,
      ...(built.feeLamports ? { feePreview: { lamports: built.feeLamports, sol: solFromLamports(built.feeLamports) } } : {}),
      ...(built.royaltyLamports
        ? {
            royaltyPreview: {
              lamports: built.royaltyLamports,
              sol: solFromLamports(built.royaltyLamports),
            },
          }
        : {}),
      apiHealthSnapshot: health,
      marketSnapshot: serializeListing(listing),
      programIds: built.programIds,
      ...(built.reusable ? { transactionBase64: built.transactionBase64 } : {}),
      warnings,
      refreshAtExecution: true,
      preparedSnapshotAt: new Date().toISOString(),
    };

    return {
      addInput: {
        kind: 'magiceden_buy',
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
    const mintAddress = requireParamString(action, 'mintAddress');
    const expectedListingId = optionalParamString(action, 'listingId');
    const expectedSeller = optionalParamString(action, 'seller');
    const expectedPriceLamports = BigInt(requireParamString(action, 'priceLamports'));
    const maxPriceLamports = BigInt(requireParamString(action, 'maxPriceLamports'));
    const collectionSymbol = optionalParamString(action, 'collectionSymbol');

    requireTradingOperational(await getApiHealthSnapshot({ includeTradingEndpoints: true }, ctx));
    const walletAddress = await assertConnectedWallet(ctx, action);
    const client = resolveMagicedenClient(ctx);
    const listings = await client.getCollectionListings({
      ...(collectionSymbol ? { collectionSymbol } : {}),
      limit: 100,
    });
    const listing = pickListingForMint(listings.rows, mintAddress, expectedListingId);
    if (!listing) {
      throw new AdapterError(MAGICEDEN_ADAPTER_ID, 'listing_drift', 'Listing no longer available on Magic Eden.');
    }
    if (expectedListingId && listing.listingId && listing.listingId !== expectedListingId) {
      throw new AdapterError(
        MAGICEDEN_ADAPTER_ID,
        'listing_drift',
        `Magic Eden listing id changed from ${expectedListingId} to ${listing.listingId}; refusing to buy.`,
      );
    }
    if (expectedSeller && listing.seller && listing.seller !== expectedSeller) {
      throw new AdapterError(
        MAGICEDEN_ADAPTER_ID,
        'listing_drift',
        `Magic Eden listing seller changed from ${expectedSeller} to ${listing.seller}; refusing to buy.`,
      );
    }
    const currentLamports = BigInt(listing.priceLamports);
    if (currentLamports !== expectedPriceLamports) {
      throw new AdapterError(
        MAGICEDEN_ADAPTER_ID,
        'price_drift',
        `Magic Eden listing price changed from ${solFromLamports(expectedPriceLamports)} to ${listing.priceSol} SOL; refusing to buy.`,
      );
    }
    if (currentLamports > maxPriceLamports) {
      throw new AdapterError(
        MAGICEDEN_ADAPTER_ID,
        'price_above_cap',
        `Magic Eden listing now exceeds maxPriceSol cap; refusing to buy.`,
      );
    }

    const built = await client.generateBuyTransaction({
      buyerAddress: walletAddress,
      sellerAddress: listing.seller ?? '',
      mintAddress,
      priceLamports: listing.priceLamports,
      ...(listing.auctionHouse ? { auctionHouse: listing.auctionHouse } : {}),
      ...(collectionSymbol ? { collectionSymbol } : {}),
      ...(listing.listingId ? { expectedListingId: listing.listingId } : {}),
    });
    assertMagicedenProgramIds(built.programIds);
    const summary = `Buy ${listing.tokenName ?? shortMint(mintAddress)} on Magic Eden for ${listing.priceSol} SOL`;
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        mintAddress,
        priceSol: listing.priceSol,
        priceLamports: listing.priceLamports,
        programIds: built.programIds,
      },
    };
  },
};

export const magicedenListAction: AdapterAction<MagicedenListPrepareInput> = {
  id: 'list',
  kind: 'magiceden_list',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const mintAddress = requireString(input.mintAddress, 'mintAddress');
    const priceLamports = lamportsFromSolField(input.priceSol, 'priceSol');
    const health = await getApiHealthSnapshot({ includeTradingEndpoints: true }, ctx);
    requireTradingOperational(health);

    const walletAddress = await ctx.backend.getAddress();
    const client = resolveMagicedenClient(ctx);
    const wallet = await client.getWalletNfts({ walletAddress });
    const owned = wallet.rows.find((row) => row.mintAddress === mintAddress);
    if (!owned) {
      throw new AdapterError(
        MAGICEDEN_ADAPTER_ID,
        'nft_not_owned',
        `Connected wallet does not own ${shortMint(mintAddress)} per Magic Eden; refusing to list.`,
      );
    }

    const built = await client.generateListTransaction({
      sellerAddress: walletAddress,
      mintAddress,
      priceLamports: priceLamports.toString(),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    });

    const warnings = buildWarnings(health, undefined, built.warnings);
    const summary = `List ${owned.tokenName ?? shortMint(mintAddress)} on Magic Eden for ${input.priceSol} SOL`;
    const params: Record<string, unknown> = {
      adapter: MAGICEDEN_ADAPTER_ID,
      connectorId: MAGICEDEN_ADAPTER_ID,
      operation: 'list',
      approvalBoundary: PROVES_CLAUSE,
      walletAddress,
      mintAddress,
      priceLamports: priceLamports.toString(),
      priceSol: input.priceSol,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      apiHealthSnapshot: health,
      marketSnapshot: { owned: true, listed: owned.listed },
      programIds: built.programIds,
      ...(built.reusable ? { transactionBase64: built.transactionBase64 } : {}),
      warnings,
      refreshAtExecution: true,
      preparedSnapshotAt: new Date().toISOString(),
    };
    return {
      addInput: {
        kind: 'magiceden_list',
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
    const mintAddress = requireParamString(action, 'mintAddress');
    const priceLamports = requireParamString(action, 'priceLamports');
    const expiresAt = optionalParamString(action, 'expiresAt');
    requireTradingOperational(await getApiHealthSnapshot({ includeTradingEndpoints: true }, ctx));
    const walletAddress = await assertConnectedWallet(ctx, action);

    const client = resolveMagicedenClient(ctx);
    const wallet = await client.getWalletNfts({ walletAddress });
    if (!wallet.rows.some((row) => row.mintAddress === mintAddress)) {
      throw new AdapterError(
        MAGICEDEN_ADAPTER_ID,
        'nft_not_owned',
        `Magic Eden no longer reports ownership of ${shortMint(mintAddress)}; refusing to list.`,
      );
    }
    const built = await client.generateListTransaction({
      sellerAddress: walletAddress,
      mintAddress,
      priceLamports,
      ...(expiresAt ? { expiresAt } : {}),
    });
    assertMagicedenProgramIds(built.programIds);
    const summary = `List ${shortMint(mintAddress)} on Magic Eden for ${solFromLamports(priceLamports)} SOL`;
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: { mintAddress, priceLamports, programIds: built.programIds },
    };
  },
};

export const magicedenCancelListingAction: AdapterAction<MagicedenCancelListingPrepareInput> = {
  id: 'cancel_listing',
  kind: 'magiceden_cancel_listing',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const mintAddress = requireString(input.mintAddress, 'mintAddress');
    const health = await getApiHealthSnapshot({ includeTradingEndpoints: true }, ctx);
    requireTradingOperational(health);

    const walletAddress = await ctx.backend.getAddress();
    const client = resolveMagicedenClient(ctx);
    const wallet = await client.getWalletNfts({ walletAddress, listedOnly: true });
    const owned = wallet.rows.find((row) => row.mintAddress === mintAddress);
    if (!owned || !owned.listed || !owned.listingPriceLamports) {
      throw new AdapterError(
        MAGICEDEN_ADAPTER_ID,
        'listing_not_found',
        `No active Magic Eden listing for ${shortMint(mintAddress)} owned by the connected wallet.`,
      );
    }
    const built = await client.generateCancelListingTransaction({
      sellerAddress: walletAddress,
      mintAddress,
      priceLamports: owned.listingPriceLamports,
      ...(input.listingId ? { listingId: input.listingId } : owned.listingId ? { listingId: owned.listingId } : {}),
    });
    const summary = `Cancel Magic Eden listing for ${owned.tokenName ?? shortMint(mintAddress)}`;
    const params: Record<string, unknown> = {
      adapter: MAGICEDEN_ADAPTER_ID,
      connectorId: MAGICEDEN_ADAPTER_ID,
      operation: 'cancel_listing',
      approvalBoundary: PROVES_CLAUSE,
      walletAddress,
      mintAddress,
      priceLamports: owned.listingPriceLamports,
      priceSol: owned.listingPriceSol,
      ...(owned.listingId ? { listingId: owned.listingId } : {}),
      apiHealthSnapshot: health,
      marketSnapshot: { listed: true },
      programIds: built.programIds,
      ...(built.reusable ? { transactionBase64: built.transactionBase64 } : {}),
      warnings: buildWarnings(health, undefined, built.warnings),
      refreshAtExecution: true,
      preparedSnapshotAt: new Date().toISOString(),
    };
    return {
      addInput: {
        kind: 'magiceden_cancel_listing',
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
    const mintAddress = requireParamString(action, 'mintAddress');
    const priceLamports = requireParamString(action, 'priceLamports');
    const listingId = optionalParamString(action, 'listingId');
    requireTradingOperational(await getApiHealthSnapshot({ includeTradingEndpoints: true }, ctx));
    const walletAddress = await assertConnectedWallet(ctx, action);
    const built = await resolveMagicedenClient(ctx).generateCancelListingTransaction({
      sellerAddress: walletAddress,
      mintAddress,
      priceLamports,
      ...(listingId ? { listingId } : {}),
    });
    assertMagicedenProgramIds(built.programIds);
    const summary = `Cancel Magic Eden listing for ${shortMint(mintAddress)}`;
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: { mintAddress, programIds: built.programIds },
    };
  },
};

export const magicedenBidAction: AdapterAction<MagicedenBidPrepareInput> = {
  id: 'bid',
  kind: 'magiceden_bid',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const bidLamports = lamportsFromSolField(input.bidPriceSol, 'bidPriceSol');
    const escrowCapLamports = lamportsFromSolField(input.maxEscrowSol, 'maxEscrowSol');
    const bidPriceSol = normalizeSolDecimalField(input.bidPriceSol, 'bidPriceSol');
    const maxEscrowSol = normalizeSolDecimalField(input.maxEscrowSol, 'maxEscrowSol');
    const isCollectionBid = !input.mintAddress;
    if (isCollectionBid && !input.collectionSymbol && !input.collectionId) {
      throw new AdapterError(
        MAGICEDEN_ADAPTER_ID,
        'invalid_request',
        'Magic Eden collection bid requires collectionSymbol or collectionId.',
      );
    }
    const quantity = input.quantity ?? 1;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new AdapterError(
        MAGICEDEN_ADAPTER_ID,
        'invalid_request',
        'Magic Eden bid quantity must be a positive integer.',
      );
    }
    const requiredEscrow = bidLamports * BigInt(Math.trunc(quantity));
    if (requiredEscrow > escrowCapLamports) {
      throw new AdapterError(
        MAGICEDEN_ADAPTER_ID,
        'escrow_exceeded',
        `Magic Eden bid escrow ${solFromLamports(requiredEscrow)} SOL exceeds spend cap ${maxEscrowSol} SOL.`,
      );
    }

    const health = await getApiHealthSnapshot({ includeTradingEndpoints: true }, ctx);
    requireTradingOperational(health);

    const walletAddress = await ctx.backend.getAddress();
    const client = resolveMagicedenClient(ctx);
    const built = await client.generateBidTransaction({
      buyerAddress: walletAddress,
      bidPriceLamports: bidLamports.toString(),
      ...(input.mintAddress ? { mintAddress: input.mintAddress } : {}),
      ...(input.collectionSymbol ? { collectionSymbol: input.collectionSymbol } : {}),
      ...(input.collectionId ? { collectionId: input.collectionId } : {}),
      ...(input.quantity !== undefined ? { quantity } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    });

    const summary = isCollectionBid
      ? `Bid ${bidPriceSol} SOL on Magic Eden collection ${input.collectionSymbol ?? input.collectionId}`
      : `Bid ${bidPriceSol} SOL on Magic Eden token ${shortMint(input.mintAddress!)}`;
    const params: Record<string, unknown> = {
      adapter: MAGICEDEN_ADAPTER_ID,
      connectorId: MAGICEDEN_ADAPTER_ID,
      operation: 'bid',
      approvalBoundary: PROVES_CLAUSE,
      walletAddress,
      ...(input.mintAddress ? { mintAddress: input.mintAddress } : {}),
      ...(input.collectionSymbol ? { collectionSymbol: input.collectionSymbol } : {}),
      ...(input.collectionId ? { collectionId: input.collectionId } : {}),
      bidPriceLamports: bidLamports.toString(),
      bidPriceSol,
      maxEscrowLamports: escrowCapLamports.toString(),
      maxEscrowSol,
      quantity,
      requiredEscrowLamports: requiredEscrow.toString(),
      requiredEscrowSol: solFromLamports(requiredEscrow),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      apiHealthSnapshot: health,
      programIds: built.programIds,
      ...(built.reusable ? { transactionBase64: built.transactionBase64 } : {}),
      warnings: buildWarnings(health, undefined, built.warnings),
      refreshAtExecution: true,
      preparedSnapshotAt: new Date().toISOString(),
    };
    return {
      addInput: {
        kind: 'magiceden_bid',
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
    requireTradingOperational(await getApiHealthSnapshot({ includeTradingEndpoints: true }, ctx));
    const walletAddress = await assertConnectedWallet(ctx, action);
    const bidLamports = requireParamString(action, 'bidPriceLamports');
    const quantity = typeof action.params.quantity === 'number' ? action.params.quantity : 1;
    const mintAddress = optionalParamString(action, 'mintAddress');
    const collectionSymbol = optionalParamString(action, 'collectionSymbol');
    const collectionId = optionalParamString(action, 'collectionId');
    const expiresAt = optionalParamString(action, 'expiresAt');
    const built = await resolveMagicedenClient(ctx).generateBidTransaction({
      buyerAddress: walletAddress,
      bidPriceLamports: bidLamports,
      ...(mintAddress ? { mintAddress } : {}),
      ...(collectionSymbol ? { collectionSymbol } : {}),
      ...(collectionId ? { collectionId } : {}),
      ...(quantity !== 1 ? { quantity } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    });
    assertMagicedenProgramIds(built.programIds);
    const summary = mintAddress
      ? `Bid ${solFromLamports(bidLamports)} SOL on Magic Eden token ${shortMint(mintAddress)}`
      : `Bid ${solFromLamports(bidLamports)} SOL on Magic Eden collection ${collectionSymbol ?? collectionId}`;
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: { bidPriceLamports: bidLamports, programIds: built.programIds },
    };
  },
};

export const magicedenCancelBidAction: AdapterAction<MagicedenCancelBidPrepareInput> = {
  id: 'cancel_bid',
  kind: 'magiceden_cancel_bid',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    if (!input.bidId && !input.mintAddress && !input.collectionSymbol && !input.collectionId) {
      throw new AdapterError(
        MAGICEDEN_ADAPTER_ID,
        'invalid_request',
        'Magic Eden cancel bid requires bidId, mintAddress, or collectionSymbol/collectionId.',
      );
    }
    const health = await getApiHealthSnapshot({ includeTradingEndpoints: true }, ctx);
    requireTradingOperational(health);
    const walletAddress = await ctx.backend.getAddress();
    const built = await resolveMagicedenClient(ctx).generateCancelBidTransaction({
      buyerAddress: walletAddress,
      ...(input.bidId ? { bidId: input.bidId } : {}),
      ...(input.mintAddress ? { mintAddress: input.mintAddress } : {}),
      ...(input.collectionSymbol ? { collectionSymbol: input.collectionSymbol } : {}),
      ...(input.collectionId ? { collectionId: input.collectionId } : {}),
    });
    const summary = `Cancel Magic Eden bid${input.mintAddress ? ` on ${shortMint(input.mintAddress)}` : input.collectionSymbol ? ` on collection ${input.collectionSymbol}` : ''}`;
    const params: Record<string, unknown> = {
      adapter: MAGICEDEN_ADAPTER_ID,
      connectorId: MAGICEDEN_ADAPTER_ID,
      operation: 'cancel_bid',
      approvalBoundary: PROVES_CLAUSE,
      walletAddress,
      ...(input.bidId ? { bidId: input.bidId } : {}),
      ...(input.mintAddress ? { mintAddress: input.mintAddress } : {}),
      ...(input.collectionSymbol ? { collectionSymbol: input.collectionSymbol } : {}),
      ...(input.collectionId ? { collectionId: input.collectionId } : {}),
      apiHealthSnapshot: health,
      programIds: built.programIds,
      ...(built.reusable ? { transactionBase64: built.transactionBase64 } : {}),
      warnings: buildWarnings(health, undefined, built.warnings),
      refreshAtExecution: true,
      preparedSnapshotAt: new Date().toISOString(),
    };
    return {
      addInput: {
        kind: 'magiceden_cancel_bid',
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
    requireTradingOperational(await getApiHealthSnapshot({ includeTradingEndpoints: true }, ctx));
    const walletAddress = await assertConnectedWallet(ctx, action);
    const bidId = optionalParamString(action, 'bidId');
    const mintAddress = optionalParamString(action, 'mintAddress');
    const collectionSymbol = optionalParamString(action, 'collectionSymbol');
    const collectionId = optionalParamString(action, 'collectionId');
    const built = await resolveMagicedenClient(ctx).generateCancelBidTransaction({
      buyerAddress: walletAddress,
      ...(bidId ? { bidId } : {}),
      ...(mintAddress ? { mintAddress } : {}),
      ...(collectionSymbol ? { collectionSymbol } : {}),
      ...(collectionId ? { collectionId } : {}),
    });
    assertMagicedenProgramIds(built.programIds);
    const summary = `Cancel Magic Eden bid${mintAddress ? ` on ${shortMint(mintAddress)}` : collectionSymbol ? ` on collection ${collectionSymbol}` : ''}`;
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: { programIds: built.programIds },
    };
  },
};

// Internal helpers (not exported) below.

function requireString(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new AdapterError(MAGICEDEN_ADAPTER_ID, 'invalid_request', `Magic Eden requires ${label}.`);
  }
  return trimmed;
}

function lamportsFromSolField(value: string | undefined, label: string): bigint {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new AdapterError(MAGICEDEN_ADAPTER_ID, 'invalid_request', `Magic Eden requires ${label} as a decimal SOL string.`);
  }
  try {
    return lamportsFromSol(trimmed, label);
  } catch (err) {
    throw new AdapterError(
      MAGICEDEN_ADAPTER_ID,
      'invalid_request',
      err instanceof Error ? err.message : String(err),
    );
  }
}

function normalizeSolDecimalField(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new AdapterError(MAGICEDEN_ADAPTER_ID, 'invalid_request', `Magic Eden requires ${label} as a decimal SOL string.`);
  }
  try {
    return normalizeSolDecimal(trimmed, label);
  } catch (err) {
    throw new AdapterError(
      MAGICEDEN_ADAPTER_ID,
      'invalid_request',
      err instanceof Error ? err.message : String(err),
    );
  }
}

function pickListingForMint(
  rows: MagicedenListingRow[],
  mintAddress: string,
  expectedListingId?: string,
): MagicedenListingRow | undefined {
  const candidates = rows
    .filter((row) => row.mintAddress === mintAddress)
    .filter((row) => isValidListingRow(row));
  if (candidates.length === 0) return undefined;
  if (expectedListingId) {
    const exact = candidates.find((row) => row.listingId === expectedListingId);
    if (exact) return exact;
  }
  candidates.sort((a, b) => compareLamports(a.priceLamports, b.priceLamports));
  return candidates[0];
}

function isValidListingRow(row: MagicedenListingRow): boolean {
  if (!row.seller || !row.seller.trim()) return false;
  if (!/^\d+$/.test(row.priceLamports)) return false;
  try {
    return BigInt(row.priceLamports) > 0n;
  } catch {
    return false;
  }
}

function compareLamports(a: string, b: string): number {
  const left = /^\d+$/.test(a) ? BigInt(a) : 0n;
  const right = /^\d+$/.test(b) ? BigInt(b) : 0n;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertMagicedenProgramIds(programIds: string[]): void {
  if (programIds.length === 0) return;
  const expected = MAGICEDEN_MARKETPLACE_PROGRAM_ID.toBase58();
  if (!programIds.includes(expected)) {
    throw new AdapterError(
      MAGICEDEN_ADAPTER_ID,
      'program_mismatch',
      `Magic Eden API returned a transaction touching unexpected programs [${programIds.join(', ')}]; expected ${expected}. Refusing to sign.`,
    );
  }
}

function serializeListing(listing: MagicedenListingRow): Record<string, unknown> {
  return {
    mintAddress: listing.mintAddress,
    ...(listing.listingId ? { listingId: listing.listingId } : {}),
    ...(listing.seller ? { seller: listing.seller } : {}),
    priceLamports: listing.priceLamports,
    priceSol: listing.priceSol,
    ...(listing.auctionHouse ? { auctionHouse: listing.auctionHouse } : {}),
  };
}

function buildWarnings(
  health: MagicedenApiHealthSnapshot,
  listing?: MagicedenListingRow,
  extra?: string[],
): string[] {
  const warnings: string[] = [MAGICEDEN_API_TRANSITION_WARNING];
  if (health.warnings.length > 0) {
    for (const w of health.warnings) {
      if (!warnings.includes(w)) warnings.push(w);
    }
  }
  if (health.readOnlyFallback) {
    warnings.push('Magic Eden trading endpoints are degraded; preparing without execution guarantees.');
  }
  if (listing && !listing.auctionHouse) {
    warnings.push('Listing did not report an auction house address; verify the marketplace contract in your wallet.');
  }
  if (Array.isArray(extra)) {
    for (const w of extra) if (!warnings.includes(w)) warnings.push(w);
  }
  return warnings;
}

function requireParamString(action: PreparedAction, key: string): string {
  const value = action.params[key];
  if (typeof value !== 'string' || !value) {
    throw new ProtocolError('invalid_request', `Magic Eden action ${action.id} is missing ${key}.`);
  }
  return value;
}

function optionalParamString(action: PreparedAction, key: string): string | undefined {
  const value = action.params[key];
  return typeof value === 'string' && value ? value : undefined;
}

async function assertConnectedWallet(ctx: DAppAdapterContext, action: PreparedAction): Promise<string> {
  const walletAddress = await ctx.backend.getAddress();
  if (walletAddress !== action.walletAddress) {
    throw new ProtocolError(
      'unauthorized',
      `Magic Eden action belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
    );
  }
  return walletAddress;
}
