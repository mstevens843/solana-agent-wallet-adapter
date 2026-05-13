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
import { getObligation } from './obligations.js';
import { assertWithinCap, requireNumber, requireOptionalString, requireString } from './params.js';

export interface SaveDepositInput {
  amount: string;
  token?: string;
  reserveMint?: string;
  marketAddress?: string;
  depositCollateral?: boolean;
  dueAt?: string;
  note?: string;
}

export const saveDepositAction: AdapterAction<SaveDepositInput> = {
  id: 'deposit',
  kind: 'save_deposit',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const { reserveMint, decimals, reserveSymbolHint } = resolveReserveSelection(input);
    const amountRaw = parseDecimalAmount(input.amount, decimals, `${reserveSymbolHint} deposit amount`);
    const marketAddress = input.marketAddress?.trim() || SAVE_MAIN_MARKET.toBase58();

    const walletAddress = await ctx.backend.getAddress();
    const client = getSaveClient();
    const snapshot = await client.getReserveSnapshot(ctx.connection, reserveMint, marketAddress);
    assertWithinCap({
      amountRaw,
      capUi: snapshot.depositLimitRemaining,
      decimals: snapshot.decimals,
      reserveSymbol: snapshot.reserveSymbol,
      operation: 'deposit',
    });
    const obligation = await getObligation(ctx.connection, walletAddress, marketAddress);
    const healthPreview = previewHealth(obligation, {
      kind: 'deposit',
      reserveMint: snapshot.reserveMint,
      amountRaw,
      decimals: snapshot.decimals,
      reserveSnapshot: snapshot,
    });

    const summary = `Deposit ${input.amount} ${snapshot.reserveSymbol} into Save`;
    const previewParams: Record<string, unknown> = {
      adapter: SAVE_ADAPTER_ID,
      connectorId: SAVE_ADAPTER_ID,
      action: 'deposit',
      operation: 'deposit',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      marketAddress: snapshot.marketAddress,
      reserveAddress: snapshot.reserveAddress,
      reserveMint: snapshot.reserveMint,
      reserveSymbol: snapshot.reserveSymbol,
      decimals: snapshot.decimals,
      amount: input.amount,
      amountRaw: amountRaw.toString(),
      depositCollateral: input.depositCollateral ?? true,
      supplyApy: snapshot.supplyApy,
      utilization: snapshot.utilization,
      collateralFactor: snapshot.collateralFactor,
      liquidationThreshold: snapshot.liquidationThreshold,
      depositLimit: snapshot.depositLimit,
      depositLimitRemaining: snapshot.depositLimitRemaining,
      withdrawAvailable: snapshot.withdrawAvailable,
      programIds: [SOLEND_PROGRAM_ID.toBase58()],
      obligationSnapshot: obligation,
      reserveSnapshot: snapshot,
      healthPreview,
      preparedSnapshotAt: new Date().toISOString(),
      refreshAtExecution: true,
    };

    return {
      addInput: {
        kind: 'save_deposit',
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
    const depositCollateral = action.params.depositCollateral !== false;
    const amountRaw = BigInt(amountRawText);

    const walletAddress = await ctx.backend.getAddress();
    if (walletAddress !== action.walletAddress) {
      throw new ProtocolError(
        'unauthorized',
        `Save deposit belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }

    const built = await getSaveClient().buildDepositTransaction(ctx.connection, {
      walletAddress,
      marketAddress,
      reserveMint,
      amountRaw,
      depositCollateral,
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
    const summary = `Deposit ${amountUi} ${built.reserveSymbol} into Save`;
    const txid = await ctx.signAndBroadcast(base64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        reserveAddress: built.reserveAddress,
        reserveSymbol: built.reserveSymbol,
        amountUi,
        supplyApy: built.reserveSnapshot.supplyApy,
        utilization: built.reserveSnapshot.utilization,
      },
    };
  },
};

function resolveReserveSelection(input: SaveDepositInput): {
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
      `Save reserve "${tokenIdentifier}" is not in the known list. Add it to SAVE_KNOWN_RESERVES with its decimals before depositing by mint.`,
    );
  }
  return { reserveMint, decimals, reserveSymbolHint };
}
