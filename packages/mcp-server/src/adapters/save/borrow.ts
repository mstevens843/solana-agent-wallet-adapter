import { PublicKey } from '@solana/web3.js';

import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { parseDecimalAmount, formatRawAmount } from '../../amounts.js';
import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';
import type { PreparedAction } from '../../preparedActions.js';
import type {
  AdapterAction,
  AdapterExecuteResult,
  AdapterPrepareResult,
} from '../types.js';
import { AdapterError } from '../types.js';

import { getSaveClient } from './client.js';
import {
  SAVE_ADAPTER_ID,
  SAVE_MAIN_MARKET,
  SOLEND_PROGRAM_ID,
  resolveKnownReserve,
} from './constants.js';
import { assertHealthy, previewHealth, resolveMinHealthFactor } from './health.js';
import { getObligation } from './obligations.js';
import { requireNumber, requireOptionalString, requireString } from './params.js';

export interface SaveBorrowInput {
  amount: string;
  token?: string;
  reserveMint?: string;
  marketAddress?: string;
  minHealthFactor?: number;
  dueAt?: string;
  note?: string;
}

export const saveBorrowAction: AdapterAction<SaveBorrowInput> = {
  id: 'borrow',
  kind: 'save_borrow',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const { reserveMint, decimals, reserveSymbolHint } = resolveReserveSelection(input);
    const amountRaw = parseDecimalAmount(input.amount, decimals, `${reserveSymbolHint} borrow amount`);
    const marketAddress = input.marketAddress?.trim() || SAVE_MAIN_MARKET.toBase58();

    const walletAddress = await ctx.backend.getAddress();
    const client = getSaveClient();
    const snapshot = await client.getReserveSnapshot(ctx.connection, reserveMint, marketAddress);
    const obligation = await getObligation(ctx.connection, walletAddress, marketAddress);
    const minHealthFactor = resolveMinHealthFactor(input.minHealthFactor);
    const healthPreview = previewHealth(obligation, {
      kind: 'borrow',
      reserveMint: snapshot.reserveMint,
      amountRaw,
      decimals: snapshot.decimals,
      reserveSnapshot: snapshot,
    });
    assertHealthy(healthPreview, minHealthFactor, {
      operation: 'borrow',
      reserveSymbol: snapshot.reserveSymbol,
    });

    const summary = `Borrow ${input.amount} ${snapshot.reserveSymbol} from Save`;
    const previewParams: Record<string, unknown> = {
      adapter: SAVE_ADAPTER_ID,
      connectorId: SAVE_ADAPTER_ID,
      action: 'borrow',
      operation: 'borrow',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      marketAddress: snapshot.marketAddress,
      reserveAddress: snapshot.reserveAddress,
      reserveMint: snapshot.reserveMint,
      reserveSymbol: snapshot.reserveSymbol,
      decimals: snapshot.decimals,
      amount: input.amount,
      amountRaw: amountRaw.toString(),
      borrowApy: snapshot.borrowApy,
      utilization: snapshot.utilization,
      borrowLimit: snapshot.borrowLimit,
      borrowLimitRemaining: snapshot.borrowLimitRemaining,
      liquidationThreshold: snapshot.liquidationThreshold,
      programIds: [SOLEND_PROGRAM_ID.toBase58()],
      minHealthFactor,
      obligationSnapshot: obligation,
      reserveSnapshot: snapshot,
      healthPreview,
      preparedSnapshotAt: new Date().toISOString(),
      refreshAtExecution: true,
    };

    return {
      addInput: {
        kind: 'save_borrow',
        walletAddress,
        cluster: ctx.config.cluster,
        summary,
        params: previewParams,
        ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
        ...(input.note !== undefined && { note: input.note }),
      },
      preview: previewParams,
    };
  },

  async execute(action: PreparedAction, ctx): Promise<AdapterExecuteResult> {
    const reserveMint = requireString(action, 'reserveMint');
    const amountRawText = requireString(action, 'amountRaw');
    const decimals = requireNumber(action, 'decimals');
    const marketAddress = requireOptionalString(action, 'marketAddress') ?? SAVE_MAIN_MARKET.toBase58();
    const minHealthFactor = typeof action.params.minHealthFactor === 'number'
      ? action.params.minHealthFactor
      : resolveMinHealthFactor(undefined);
    const amountRaw = BigInt(amountRawText);

    const walletAddress = await ctx.backend.getAddress();
    if (walletAddress !== action.walletAddress) {
      throw new ProtocolError(
        'unauthorized',
        `Save borrow belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }

    const client = getSaveClient();
    const freshSnapshot = await client.getReserveSnapshot(ctx.connection, reserveMint, marketAddress);
    const freshObligation = await getObligation(ctx.connection, walletAddress, marketAddress);
    const healthPreview = previewHealth(freshObligation, {
      kind: 'borrow',
      reserveMint: freshSnapshot.reserveMint,
      amountRaw,
      decimals: freshSnapshot.decimals,
      reserveSnapshot: freshSnapshot,
    });
    assertHealthy(healthPreview, minHealthFactor, {
      operation: 'borrow',
      reserveSymbol: freshSnapshot.reserveSymbol,
    });

    const built = await client.buildBorrowTransaction(ctx.connection, {
      walletAddress,
      marketAddress,
      reserveMint,
      amountRaw,
    });
    if (!built.transaction.feePayer) {
      built.transaction.feePayer = new PublicKey(walletAddress);
    }
    if (!built.transaction.recentBlockhash) {
      const blockhash = await ctx.connection.getLatestBlockhash('confirmed');
      built.transaction.recentBlockhash = blockhash.blockhash;
    }
    const base64 = built.transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');
    const amountUi = built.amountUi || formatRawAmount(amountRaw, decimals);
    const summary = `Borrow ${amountUi} ${built.reserveSymbol} from Save`;
    const txid = await ctx.signAndBroadcast(base64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        reserveAddress: built.reserveAddress,
        reserveSymbol: built.reserveSymbol,
        amountUi,
        borrowApy: built.reserveSnapshot.borrowApy,
        projectedHealthFactor: healthPreview.projectedHealthFactor,
      },
    };
  },
};

function resolveReserveSelection(input: SaveBorrowInput): {
  reserveMint: string;
  decimals: number;
  reserveSymbolHint: string;
} {
  const tokenIdentifier = (input.token ?? input.reserveMint ?? 'USDC').trim();
  const known = resolveKnownReserve(tokenIdentifier);
  const reserveSymbolHint = known?.symbol ?? tokenIdentifier;
  const reserveMint = known?.mint ?? input.reserveMint?.trim();
  if (!reserveMint) {
    throw new AdapterError(
      SAVE_ADAPTER_ID,
      'unknown_reserve',
      `Unknown Save reserve "${tokenIdentifier}". Pass token: SOL, USDC, USDT, or reserveMint as a mint address.`,
    );
  }
  const decimals = known?.decimals;
  if (typeof decimals !== 'number') {
    throw new AdapterError(
      SAVE_ADAPTER_ID,
      'unknown_reserve',
      `Save reserve "${tokenIdentifier}" is not in the known list; add decimals first.`,
    );
  }
  return { reserveMint, decimals, reserveSymbolHint };
}
