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
import { previewHealth } from './health.js';
import { findBorrowForReserve, getObligation } from './obligations.js';
import { requireNumber, requireOptionalString, requireString } from './params.js';

export interface SaveRepayInput {
  amount?: string;
  repayAll?: boolean;
  token?: string;
  reserveMint?: string;
  marketAddress?: string;
  dueAt?: string;
  note?: string;
}

export const saveRepayAction: AdapterAction<SaveRepayInput> = {
  id: 'repay',
  kind: 'save_repay',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const { reserveMint, decimals, reserveSymbolHint } = resolveReserveSelection(input);
    const marketAddress = input.marketAddress?.trim() || SAVE_MAIN_MARKET.toBase58();
    const walletAddress = await ctx.backend.getAddress();
    const client = getSaveClient();
    const snapshot = await client.getReserveSnapshot(ctx.connection, reserveMint, marketAddress);
    const obligation = await getObligation(ctx.connection, walletAddress, marketAddress);
    const borrow = findBorrowForReserve(obligation, reserveMint);
    if (!borrow) {
      throw new AdapterError(
        SAVE_ADAPTER_ID,
        'no_position',
        `No Save borrow found for ${reserveSymbolHint}; nothing to repay.`,
      );
    }

    const repayAll = input.repayAll === true || (input.amount ?? '').toLowerCase() === 'all';
    let amountRaw: bigint;
    let amountUi: string;
    if (repayAll) {
      amountUi = borrow.amount;
      amountRaw = BigInt(borrow.amountRaw);
    } else {
      if (!input.amount) {
        throw new AdapterError(
          SAVE_ADAPTER_ID,
          'invalid_amount',
          'Provide amount (or repayAll: true) for a Save repay.',
        );
      }
      amountRaw = parseDecimalAmount(input.amount, decimals, `${reserveSymbolHint} repay amount`);
      amountUi = input.amount;
    }

    const healthPreview = previewHealth(obligation, {
      kind: 'repay',
      reserveMint: snapshot.reserveMint,
      amountRaw,
      decimals: snapshot.decimals,
      reserveSnapshot: snapshot,
    });

    const summary = `Repay ${amountUi} ${snapshot.reserveSymbol} on Save`;
    const previewParams: Record<string, unknown> = {
      adapter: SAVE_ADAPTER_ID,
      connectorId: SAVE_ADAPTER_ID,
      action: 'repay',
      operation: 'repay',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      marketAddress: snapshot.marketAddress,
      reserveAddress: snapshot.reserveAddress,
      reserveMint: snapshot.reserveMint,
      reserveSymbol: snapshot.reserveSymbol,
      decimals: snapshot.decimals,
      amount: amountUi,
      amountRaw: amountRaw.toString(),
      repayAll,
      borrowedBefore: borrow.amount,
      borrowApy: snapshot.borrowApy,
      utilization: snapshot.utilization,
      programIds: [SOLEND_PROGRAM_ID.toBase58()],
      obligationSnapshot: obligation,
      reserveSnapshot: snapshot,
      healthPreview,
      preparedSnapshotAt: new Date().toISOString(),
      refreshAtExecution: true,
    };

    return {
      addInput: {
        kind: 'save_repay',
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
    const decimals = requireNumber(action, 'decimals');
    const marketAddress = requireOptionalString(action, 'marketAddress') ?? SAVE_MAIN_MARKET.toBase58();
    const repayAll = action.params.repayAll === true;

    const walletAddress = await ctx.backend.getAddress();
    if (walletAddress !== action.walletAddress) {
      throw new ProtocolError(
        'unauthorized',
        `Save repay belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }

    const client = getSaveClient();
    const freshSnapshot = await client.getReserveSnapshot(ctx.connection, reserveMint, marketAddress);
    const freshObligation = await getObligation(ctx.connection, walletAddress, marketAddress);
    const freshBorrow = findBorrowForReserve(freshObligation, reserveMint);
    if (!freshBorrow) {
      throw new AdapterError(
        SAVE_ADAPTER_ID,
        'no_position',
        `Save borrow for ${freshSnapshot.reserveSymbol} no longer exists; nothing to repay.`,
      );
    }

    let amountRaw: bigint;
    if (repayAll) {
      amountRaw = BigInt(freshBorrow.amountRaw);
    } else {
      amountRaw = BigInt(requireString(action, 'amountRaw'));
    }

    const built = await client.buildRepayTransaction(ctx.connection, {
      walletAddress,
      marketAddress,
      reserveMint,
      amountRaw,
      ...(repayAll ? { repayAll: true } : {}),
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
    const summary = `Repay ${amountUi} ${built.reserveSymbol} on Save`;
    const txid = await ctx.signAndBroadcast(base64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        reserveAddress: built.reserveAddress,
        reserveSymbol: built.reserveSymbol,
        amountUi,
        borrowApy: built.reserveSnapshot.borrowApy,
      },
    };
  },
};

function resolveReserveSelection(input: SaveRepayInput): {
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
      `Unknown Save reserve "${tokenIdentifier}".`,
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
