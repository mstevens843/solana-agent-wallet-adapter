import { PublicKey } from '@solana/web3.js';

import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { parseDecimalAmount, formatRawAmount } from '../../amounts.js';
import type { PreparedAction } from '../../preparedActions.js';
import type {
  AdapterAction,
  AdapterExecuteResult,
  AdapterPrepareResult,
} from '../types.js';
import { AdapterError } from '../types.js';

import { getKaminoClient } from './client.js';
import { KAMINO_ADAPTER_ID, resolveKnownReserve } from './constants.js';
import { invalidateReserveSnapshot } from './reserveSnapshot.js';
import { getPositions } from './positions.js';
import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';

export interface KaminoWithdrawInput {
  amount?: string;
  withdrawAll?: boolean;
  token?: string;
  reserveMint?: string;
  dueAt?: string;
  note?: string;
}

export const kaminoWithdrawAction: AdapterAction<KaminoWithdrawInput> = {
  id: 'withdraw',
  kind: 'kamino_withdraw',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const tokenIdentifier = (input.token ?? input.reserveMint ?? 'SOL').trim();
    const known = resolveKnownReserve(tokenIdentifier);
    const reserveMint = known?.mint ?? input.reserveMint?.trim();
    if (!reserveMint) {
      throw new AdapterError(
        KAMINO_ADAPTER_ID,
        'unknown_reserve',
        `Unknown Kamino reserve "${tokenIdentifier}".`,
      );
    }
    const decimals = known?.decimals;
    if (typeof decimals !== 'number') {
      throw new AdapterError(
        KAMINO_ADAPTER_ID,
        'unknown_reserve',
        `Kamino reserve "${tokenIdentifier}" is not in the known list; add decimals first.`,
      );
    }

    const walletAddress = await ctx.backend.getAddress();
    const positions = await getPositions(ctx.connection, walletAddress);
    const position = positions.find((entry) => entry.reserveMint === reserveMint);
    if (!position) {
      throw new AdapterError(
        KAMINO_ADAPTER_ID,
        'no_position',
        `No supplied balance to withdraw from the ${tokenIdentifier} reserve.`,
      );
    }

    const snapshot = await getKaminoClient().getReserveSnapshot(ctx.connection, reserveMint);
    const withdrawAll = input.withdrawAll === true || (input.amount ?? '').toLowerCase() === 'all';
    let amountRaw: bigint;
    let amountUi: string;
    if (withdrawAll) {
      amountUi = position.currentValue;
      amountRaw = parseDecimalAmount(position.currentValue, decimals, `${position.reserveSymbol} withdraw amount`);
    } else {
      if (!input.amount) {
        throw new AdapterError(
          KAMINO_ADAPTER_ID,
          'invalid_amount',
          'Provide amount (or withdrawAll: true) for a Kamino withdrawal.',
        );
      }
      amountRaw = parseDecimalAmount(input.amount, decimals, `${position.reserveSymbol} withdraw amount`);
      amountUi = input.amount;
    }

    const summary = `Withdraw ${amountUi} ${position.reserveSymbol} from Kamino`;
    const previewParams: Record<string, unknown> = {
      adapter: KAMINO_ADAPTER_ID,
      connectorId: KAMINO_ADAPTER_ID,
      action: 'withdraw',
      operation: 'withdraw',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      reserveMint: snapshot.reserveMint,
      reserveSymbol: snapshot.reserveSymbol,
      reserveAddress: snapshot.reserveAddress,
      decimals: snapshot.decimals,
      amount: amountUi,
      amountRaw: amountRaw.toString(),
      withdrawAll,
      suppliedBefore: position.suppliedAmount,
      earnedInterest: position.earnedInterest,
      supplyApy: snapshot.supplyApy,
      utilization: snapshot.utilization,
      withdrawalDelaySec: snapshot.withdrawalDelaySec,
      withdrawAvailable: snapshot.withdrawAvailable,
      preparedSnapshotAt: new Date().toISOString(),
    };

    return {
      addInput: {
        kind: 'kamino_withdraw',
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
    const withdrawAll = action.params.withdrawAll === true;
    const amountRaw = BigInt(amountRawText);
    invalidateReserveSnapshot(reserveMint);

    const walletAddress = await ctx.backend.getAddress();
    if (walletAddress !== action.walletAddress) {
      throw new ProtocolError(
        'unauthorized',
        `Kamino withdraw belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }

    const built = await getKaminoClient().buildWithdrawTransaction(ctx.connection, {
      walletAddress,
      reserveMint,
      amountRaw,
      ...(withdrawAll ? { withdrawAll: true } : {}),
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
    const summary = `Withdraw ${amountUi} ${built.reserveSymbol} from Kamino`;
    const txid = await ctx.signAndBroadcast(base64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        reserveAddress: built.reserveAddress,
        reserveSymbol: built.reserveSymbol,
        amountUi,
      },
    };
  },
};

function requireString(action: PreparedAction, key: string): string {
  const value = action.params[key];
  if (typeof value !== 'string' || !value) {
    throw new ProtocolError('invalid_request', `Kamino action ${action.id} is missing ${key}.`);
  }
  return value;
}

function requireNumber(action: PreparedAction, key: string): number {
  const value = action.params[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProtocolError('invalid_request', `Kamino action ${action.id} is missing numeric ${key}.`);
  }
  return value;
}
