import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';
import type { PreparedAction } from '../../preparedActions.js';
import type { AdapterAction, AdapterExecuteResult, AdapterPrepareResult } from '../types.js';
import { AdapterError } from '../types.js';
import {
  getWormholeClient,
  type WormholeQuoteSnapshot,
  type WormholeTransferStatus,
} from './client.js';
import {
  MAX_WORMHOLE_QUOTE_AGE_MS,
  WORMHOLE_ADAPTER_ID,
  WORMHOLE_PROGRAM_IDS,
  WORMHOLE_SOURCE_CHAIN,
  routeTypeLabel,
  shortWormholeAddress,
  wormholeNetworkForCluster,
} from './constants.js';
import {
  actionRecord,
  assertDecimalAtLeast,
  assertDecimalAtMost,
  assertFreshIso,
  assertNotExpiredIso,
  normalizeDestinationChain,
  normalizeMint,
  normalizeRouteType,
  normalizeWormholeAmount,
  optionalActionString,
  optionalNonNegativeDecimal,
  optionalNonEmptyString,
  requireActionString,
  requireNonEmptyString,
  validateDestinationAddress,
} from './validation.js';

export interface WormholeTransferInput {
  sourceMint: string;
  amount: string;
  destinationChain: string;
  destinationAddress: string;
  routeType?: string;
  minDestinationAmount?: string;
  maxBridgeFee?: string;
  nativeGasDropoff?: string;
  recipientMemo?: string;
  dueAt?: string;
  note?: string;
}

export interface WormholeRedeemInput {
  vaa?: string;
  transferId?: string;
  destinationChain: string;
  expectedMint?: string;
  dueAt?: string;
  note?: string;
}

export interface WormholeRecoverOrResumeInput {
  sourceTxid?: string;
  transferId?: string;
  destinationChain?: string;
  dueAt?: string;
  note?: string;
}

export const wormholeTransferAction: AdapterAction<WormholeTransferInput> = {
  id: 'transfer',
  kind: 'wormhole_transfer',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const walletAddress = await ctx.backend.getAddress();
    const wormholeNetwork = wormholeNetworkForCluster(ctx.config.cluster);
    const sourceMint = normalizeMint(input.sourceMint, 'sourceMint');
    const amount = await normalizeWormholeAmount({
      connection: ctx.connection,
      sourceMint,
      amount: requireNonEmptyString(input.amount, 'amount'),
    });
    const destinationChain = normalizeDestinationChain(input.destinationChain);
    const destinationAddress = validateDestinationAddress(destinationChain, input.destinationAddress);
    const routeType = normalizeRouteType(input.routeType);
    const nativeGasDropoff = optionalNonNegativeDecimal(input.nativeGasDropoff, 'nativeGasDropoff');
    const minDestinationAmount = optionalNonNegativeDecimal(input.minDestinationAmount, 'minDestinationAmount');
    const maxBridgeFee = optionalNonNegativeDecimal(input.maxBridgeFee, 'maxBridgeFee');
    const recipientMemo = optionalNonEmptyString(input.recipientMemo);

    const quote = await getWormholeClient().quoteTransfer(ctx.connection, {
      walletAddress,
      sourceChain: WORMHOLE_SOURCE_CHAIN,
      sourceMint,
      amount: amount.amount,
      amountRaw: amount.amountRaw,
      sourceDecimals: amount.decimals,
      destinationChain,
      destinationAddress,
      routeType,
      ...(nativeGasDropoff !== undefined && { nativeGasDropoff }),
      wormholeNetwork,
    });
    validateQuoteAgainstCaps(quote, { minDestinationAmount, maxBridgeFee });
    assertQuoteRouteCompatible(routeType, quote);
    assertDestinationTokenPresent(quote);
    const programIds = programIdsForQuote(quote);

    const warnings = [
      ...(quote.warnings ?? []),
      ...(quote.manualRedemptionRequired
        ? ['This route may require manual redemption after Guardian attestation.']
        : []),
      ...(destinationChain !== 'Solana'
        ? ['Destination-chain signing, if needed, is outside this Solana wallet approval.']
        : []),
    ];
    const params: Record<string, unknown> = {
      adapter: WORMHOLE_ADAPTER_ID,
      connectorId: WORMHOLE_ADAPTER_ID,
      operation: 'transfer',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      refreshAtExecution: true,
      walletAddress,
      cluster: ctx.config.cluster,
      wormholeNetwork,
      sourceChain: WORMHOLE_SOURCE_CHAIN,
      destinationChain,
      sourceMint,
      destinationToken: quote.destinationToken ?? null,
      amount: amount.amount,
      amountRaw: amount.amountRaw,
      sourceDecimals: amount.decimals,
      destinationAddress,
      routeType: quote.routeType,
      routeMode: quote.mode,
      ...(minDestinationAmount !== undefined && { minDestinationAmount }),
      ...(maxBridgeFee !== undefined && { maxBridgeFee }),
      ...(nativeGasDropoff !== undefined && { nativeGasDropoff }),
      ...(recipientMemo !== undefined && { recipientMemo }),
      quoteSnapshot: quote,
      ...(quote.routeSnapshot !== undefined && { routeSnapshot: quote.routeSnapshot }),
      programIds,
      warnings,
      preparedSnapshotAt: new Date().toISOString(),
    };

    return {
      addInput: {
        kind: 'wormhole_transfer',
        walletAddress,
        cluster: ctx.config.cluster,
        summary: `Bridge ${amount.amount} ${shortWormholeAddress(sourceMint)} from Solana to ${destinationChain} via Wormhole`,
        params,
        ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
        ...(input.note !== undefined && { note: input.note }),
      },
      preview: params,
    };
  },

  async execute(action, ctx): Promise<AdapterExecuteResult> {
    const walletAddress = await assertConnectedWallet(ctx, action);
    const wormholeNetwork = requireActionString(action, 'wormholeNetwork') as ReturnType<typeof wormholeNetworkForCluster>;
    const sourceMint = requireActionString(action, 'sourceMint');
    const destinationChain = requireActionString(action, 'destinationChain');
    const destinationAddress = requireActionString(action, 'destinationAddress');
    const routeType = normalizeRouteType(requireActionString(action, 'routeType'));
    const amount = requireActionString(action, 'amount');
    const amountRaw = requireActionString(action, 'amountRaw');
    const sourceDecimals = numericParam(action, 'sourceDecimals');
    const expectedRouteMode = requireActionString(action, 'routeMode');
    const minDestinationAmount = optionalNonNegativeDecimal(optionalActionString(action, 'minDestinationAmount'), 'minDestinationAmount');
    const maxBridgeFee = optionalNonNegativeDecimal(optionalActionString(action, 'maxBridgeFee'), 'maxBridgeFee');
    const nativeGasDropoff = optionalNonNegativeDecimal(optionalActionString(action, 'nativeGasDropoff'), 'nativeGasDropoff');
    const recipientMemo = optionalActionString(action, 'recipientMemo');
    const expectedDestinationToken = requireActionString(action, 'destinationToken');

    const quote = await getWormholeClient().quoteTransfer(ctx.connection, {
      walletAddress,
      sourceChain: WORMHOLE_SOURCE_CHAIN,
      sourceMint,
      amount,
      amountRaw,
      sourceDecimals,
      destinationChain,
      destinationAddress,
      routeType,
      ...(nativeGasDropoff !== undefined && { nativeGasDropoff }),
      wormholeNetwork,
    });
    validateQuoteAgainstCaps(quote, { minDestinationAmount, maxBridgeFee });
    assertQuoteRouteStable(routeType, expectedRouteMode, quote);
    assertDestinationTokenPresent(quote);
    assertDestinationTokenStable(expectedDestinationToken, quote);
    programIdsForQuote(quote);

    const built = await getWormholeClient().buildTransferTransaction(ctx.connection, {
      walletAddress,
      sourceChain: WORMHOLE_SOURCE_CHAIN,
      sourceMint,
      amount,
      amountRaw,
      sourceDecimals,
      destinationChain,
      destinationAddress,
      routeType,
      ...(nativeGasDropoff !== undefined && { nativeGasDropoff }),
      ...(minDestinationAmount !== undefined && { minDestinationAmount }),
      ...(maxBridgeFee !== undefined && { maxBridgeFee }),
      ...(recipientMemo !== undefined && { recipientMemo }),
      quote,
      wormholeNetwork,
    });
    const txid = await ctx.signAndBroadcast(
      built.transactionBase64,
      `Wormhole bridge ${amount} to ${destinationChain}`,
    );
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        quoteSnapshot: quote,
        ...(built.routeSnapshot !== undefined && { routeSnapshot: built.routeSnapshot }),
        ...(built.sequence !== undefined && { sequence: built.sequence }),
        ...(built.transferId !== undefined && { transferId: built.transferId }),
        programIds: built.programIds,
        warnings: built.warnings ?? quote.warnings ?? [],
      },
    };
  },
};

export const wormholeRedeemAction: AdapterAction<WormholeRedeemInput> = {
  id: 'redeem',
  kind: 'wormhole_redeem',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const walletAddress = await ctx.backend.getAddress();
    const destinationChain = normalizeDestinationChain(input.destinationChain);
    assertSolanaDestination(destinationChain);
    const vaa = optionalNonEmptyString(input.vaa);
    const transferId = optionalNonEmptyString(input.transferId);
    if (!vaa && !transferId) {
      throw new AdapterError(WORMHOLE_ADAPTER_ID, 'invalid_request', 'Wormhole redeem requires vaa or transferId.');
    }
    const expectedMint = input.expectedMint ? normalizeMint(input.expectedMint, 'expectedMint') : undefined;
    const wormholeNetwork = wormholeNetworkForCluster(ctx.config.cluster);
    const status = await getWormholeClient().getTransferStatus(ctx.connection, {
      sourceChain: WORMHOLE_SOURCE_CHAIN,
      destinationChain,
      ...(vaa !== undefined && { vaa }),
      ...(transferId !== undefined && { transferId }),
      wormholeNetwork,
    });
    assertStatusSolanaExecutable(status, 'redeem');
    assertExpectedMint(status, expectedMint);

    const params: Record<string, unknown> = {
      adapter: WORMHOLE_ADAPTER_ID,
      connectorId: WORMHOLE_ADAPTER_ID,
      operation: 'redeem',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      refreshAtExecution: true,
      walletAddress,
      wormholeNetwork,
      sourceChain: WORMHOLE_SOURCE_CHAIN,
      destinationChain,
      ...(vaa !== undefined && { vaa }),
      ...(transferId !== undefined && { transferId }),
      ...(expectedMint !== undefined && { expectedMint }),
      ...(status !== undefined && { statusSnapshot: status }),
      programIds: WORMHOLE_PROGRAM_IDS,
      preparedSnapshotAt: new Date().toISOString(),
    };
    return {
      addInput: {
        kind: 'wormhole_redeem',
        walletAddress,
        cluster: ctx.config.cluster,
        summary: `Redeem Wormhole transfer on Solana`,
        params,
        ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
        ...(input.note !== undefined && { note: input.note }),
      },
      preview: params,
    };
  },

  async execute(action, ctx): Promise<AdapterExecuteResult> {
    const walletAddress = await assertConnectedWallet(ctx, action);
    const destinationChain = requireActionString(action, 'destinationChain');
    assertSolanaDestination(destinationChain);
    const expectedMint = optionalActionString(action, 'expectedMint');
    const wormholeNetwork = requireActionString(action, 'wormholeNetwork') as ReturnType<typeof wormholeNetworkForCluster>;
    const vaa = optionalActionString(action, 'vaa');
    const transferId = optionalActionString(action, 'transferId');
    const status = await getWormholeClient().getTransferStatus(ctx.connection, {
      sourceChain: WORMHOLE_SOURCE_CHAIN,
      destinationChain,
      ...(vaa !== undefined && { vaa }),
      ...(transferId !== undefined && { transferId }),
      wormholeNetwork,
    });
    assertStatusSolanaExecutable(status, 'redeem');
    assertExpectedMint(status, expectedMint);
    const built = await getWormholeClient().buildRedeemTransaction(ctx.connection, {
      walletAddress,
      destinationChain,
      ...(vaa !== undefined && { vaa }),
      ...(transferId !== undefined && { transferId }),
      ...(expectedMint !== undefined && { expectedMint }),
      status,
      wormholeNetwork,
    });
    const txid = await ctx.signAndBroadcast(built.transactionBase64, 'Redeem Wormhole transfer on Solana');
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        statusSnapshot: status,
        programIds: built.programIds,
        ...(built.vaa !== undefined && { vaa: built.vaa }),
        ...(built.transferId !== undefined && { transferId: built.transferId }),
      },
    };
  },
};

export const wormholeRecoverOrResumeAction: AdapterAction<WormholeRecoverOrResumeInput> = {
  id: 'recover_or_resume',
  kind: 'wormhole_recover_or_resume',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const walletAddress = await ctx.backend.getAddress();
    const sourceTxid = optionalNonEmptyString(input.sourceTxid);
    const transferId = optionalNonEmptyString(input.transferId);
    if (!sourceTxid && !transferId) {
      throw new AdapterError(
        WORMHOLE_ADAPTER_ID,
        'invalid_request',
        'Wormhole recover/resume requires sourceTxid or transferId.',
      );
    }
    const destinationChain = input.destinationChain ? normalizeDestinationChain(input.destinationChain) : undefined;
    const wormholeNetwork = wormholeNetworkForCluster(ctx.config.cluster);
    const status = await getWormholeClient().getTransferStatus(ctx.connection, {
      sourceChain: WORMHOLE_SOURCE_CHAIN,
      ...(destinationChain !== undefined && { destinationChain }),
      ...(sourceTxid !== undefined && { txid: sourceTxid }),
      ...(transferId !== undefined && { transferId }),
      wormholeNetwork,
    });
    assertStatusSolanaExecutable(status, 'recover_or_resume');

    const params: Record<string, unknown> = {
      adapter: WORMHOLE_ADAPTER_ID,
      connectorId: WORMHOLE_ADAPTER_ID,
      operation: 'recover_or_resume',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      refreshAtExecution: true,
      walletAddress,
      wormholeNetwork,
      sourceChain: WORMHOLE_SOURCE_CHAIN,
      ...(destinationChain !== undefined && { destinationChain }),
      ...(sourceTxid !== undefined && { sourceTxid }),
      ...(transferId !== undefined && { transferId }),
      statusSnapshot: status,
      programIds: WORMHOLE_PROGRAM_IDS,
      preparedSnapshotAt: new Date().toISOString(),
    };
    return {
      addInput: {
        kind: 'wormhole_recover_or_resume',
        walletAddress,
        cluster: ctx.config.cluster,
        summary: `Recover or resume Wormhole transfer ${shortWormholeAddress(sourceTxid ?? transferId)}`,
        params,
        ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
        ...(input.note !== undefined && { note: input.note }),
      },
      preview: params,
    };
  },

  async execute(action, ctx): Promise<AdapterExecuteResult> {
    const walletAddress = await assertConnectedWallet(ctx, action);
    const wormholeNetwork = requireActionString(action, 'wormholeNetwork') as ReturnType<typeof wormholeNetworkForCluster>;
    const destinationChain = optionalActionString(action, 'destinationChain');
    const sourceTxid = optionalActionString(action, 'sourceTxid');
    const transferId = optionalActionString(action, 'transferId');
    const status = await getWormholeClient().getTransferStatus(ctx.connection, {
      sourceChain: WORMHOLE_SOURCE_CHAIN,
      ...(destinationChain !== undefined && { destinationChain }),
      ...(sourceTxid !== undefined && { txid: sourceTxid }),
      ...(transferId !== undefined && { transferId }),
      wormholeNetwork,
    });
    assertStatusSolanaExecutable(status, 'recover_or_resume');
    const built = await getWormholeClient().buildRecoverOrResumeTransaction(ctx.connection, {
      walletAddress,
      ...(destinationChain !== undefined && { destinationChain }),
      ...(sourceTxid !== undefined && { sourceTxid }),
      ...(transferId !== undefined && { transferId }),
      status,
      wormholeNetwork,
    });
    const txid = await ctx.signAndBroadcast(built.transactionBase64, 'Recover or resume Wormhole transfer');
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        statusSnapshot: status,
        programIds: built.programIds,
        ...(built.transferId !== undefined && { transferId: built.transferId }),
      },
    };
  },
};

function validateQuoteAgainstCaps(
  quote: WormholeQuoteSnapshot,
  caps: { minDestinationAmount?: string; maxBridgeFee?: string },
): void {
  assertFreshIso(quote.asOfIso, MAX_WORMHOLE_QUOTE_AGE_MS);
  assertNotExpiredIso(quote.expiresAtIso);
  assertDecimalAtMost({
    actual: quote.bridgeFee,
    cap: caps.maxBridgeFee,
    code: 'fee_above_cap',
    label: 'bridge fee',
  });
  assertDecimalAtLeast({
    actual: quote.estimatedDestinationAmount,
    floor: caps.minDestinationAmount,
    code: 'destination_amount_below_minimum',
    label: 'destination amount',
  });
}

function assertDestinationTokenPresent(quote: WormholeQuoteSnapshot): void {
  if (!quote.destinationToken?.trim()) {
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      'missing_destination_token',
      'Wormhole quote is missing destination token mapping; refresh route facts before preparing.',
    );
  }
}

function assertQuoteRouteCompatible(
  requestedRouteType: ReturnType<typeof normalizeRouteType>,
  quote: WormholeQuoteSnapshot,
): void {
  assertConcreteQuoteRoute(quote);
  if (requestedRouteType !== 'auto' && quote.routeType !== requestedRouteType) {
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      'route_type_changed',
      `Wormhole quote resolved ${quote.routeType} instead of requested ${requestedRouteType}; create a new prepared action.`,
    );
  }
}

function assertQuoteRouteStable(
  expectedRouteType: ReturnType<typeof normalizeRouteType>,
  expectedRouteMode: string,
  quote: WormholeQuoteSnapshot,
): void {
  assertConcreteQuoteRoute(quote);
  if (quote.routeType !== expectedRouteType) {
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      'route_type_changed',
      `Wormhole refreshed quote changed route type from ${expectedRouteType} to ${quote.routeType}; create a new prepared action.`,
    );
  }
  if (quote.mode !== expectedRouteMode) {
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      'route_mode_changed',
      `Wormhole refreshed quote changed route mode from ${expectedRouteMode} to ${quote.mode}; create a new prepared action.`,
    );
  }
}

function assertConcreteQuoteRoute(quote: WormholeQuoteSnapshot): void {
  if (quote.routeType === 'auto') {
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      'missing_route_facts',
      'Wormhole quote did not resolve automatic routing to a concrete route type; refresh route facts before approval.',
    );
  }
}

function assertDestinationTokenStable(expected: string, quote: WormholeQuoteSnapshot): void {
  const actual = quote.destinationToken?.trim();
  if (!actual) {
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      'missing_destination_token',
      'Wormhole refreshed quote is missing destination token mapping; create a new prepared action.',
    );
  }
  if (canonicalTokenForCompare(expected) !== canonicalTokenForCompare(actual)) {
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      'destination_token_changed',
      `Wormhole destination token changed from ${expected} to ${actual}; create a new prepared action.`,
    );
  }
}

function programIdsForQuote(quote: WormholeQuoteSnapshot): string[] {
  const programIds = quote.programIds ?? quote.routeSnapshot?.programIds;
  if (quote.routeType !== 'token_bridge' && (!programIds || programIds.length === 0)) {
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      'missing_route_program_ids',
      `Wormhole ${quote.routeType} route is missing route-specific program ids; refresh route facts before preparing.`,
    );
  }
  return programIds ?? WORMHOLE_PROGRAM_IDS;
}

function assertSolanaDestination(destinationChain: string): void {
  if (destinationChain.toLowerCase() !== 'solana') {
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      'unsupported_destination_signing',
      'Wormhole redeem can only be prepared when the destination chain is Solana.',
    );
  }
}

function assertStatusSolanaExecutable(
  status: WormholeTransferStatus | undefined,
  operation: 'redeem' | 'recover_or_resume',
): void {
  if (!status) {
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      'status_unavailable',
      `Wormhole ${operation} requires a resolved transfer status before preparing.`,
    );
  }
  if (status.redeemed) {
    throw new AdapterError(WORMHOLE_ADAPTER_ID, 'already_redeemed', 'Wormhole transfer is already redeemed.');
  }
  if (status.state === 'failed') {
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      'transfer_failed',
      status.error ?? 'Wormhole transfer is marked failed and cannot be redeemed or resumed.',
    );
  }
  if (status.state === 'pending_vaa' || status.nextAction === 'wait_for_vaa' || !status.vaaAvailable) {
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      'vaa_not_ready',
      'Wormhole Guardian attestation is not ready yet; retry after the VAA is available.',
    );
  }
  if (status.solanaExecutable !== true || status.nextAction !== 'redeem_on_solana') {
    const destination = status.destinationChain ?? 'the destination chain';
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      'destination_wallet_required',
      `Wormhole ${operation} is not Solana-executable; redemption or recovery must be completed on ${destination}.`,
    );
  }
  if (status.state !== 'ready_to_redeem') {
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      'status_not_ready',
      `Wormhole ${operation} requires transfer state ready_to_redeem; current state is ${status.state}.`,
    );
  }
}

function assertExpectedMint(status: WormholeTransferStatus | undefined, expectedMint: string | undefined): void {
  if (!status || !expectedMint) return;
  if (!status.destinationToken?.trim()) {
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      'missing_destination_token',
      'Wormhole status is missing destination token mapping; refresh status before preparing.',
    );
  }
  if (canonicalTokenForCompare(status.destinationToken) !== canonicalTokenForCompare(expectedMint)) {
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      'destination_token_mismatch',
      `Wormhole destination token ${status.destinationToken} does not match expectedMint ${expectedMint}.`,
    );
  }
}

function canonicalTokenForCompare(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('0x') ? trimmed.toLowerCase() : trimmed;
}

async function assertConnectedWallet(
  ctx: { backend: { getAddress(): Promise<string> } },
  action: PreparedAction,
): Promise<string> {
  const walletAddress = await ctx.backend.getAddress();
  if (walletAddress !== action.walletAddress) {
    throw new ProtocolError(
      'unauthorized',
      `Wormhole action belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
    );
  }
  return walletAddress;
}

function numericParam(action: PreparedAction, key: string): number | undefined {
  const value = action.params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function wormholeActionStatusSnapshot(action: PreparedAction): WormholeTransferStatus | undefined {
  return actionRecord(action, 'statusSnapshot') as WormholeTransferStatus | undefined;
}

export function wormholeRouteTypeLabel(action: PreparedAction): string {
  const routeType = optionalActionString(action, 'routeType');
  return routeType ? routeTypeLabel(normalizeRouteType(routeType)) : 'Wormhole';
}
