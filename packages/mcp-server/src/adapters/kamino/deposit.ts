import { PublicKey } from '@solana/web3.js';

import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { parseDecimalAmount, formatRawAmount } from '../../amounts.js';
import type { PreparedAction } from '../../preparedActions.js';
import type {
  AdapterAction,
  AdapterExecuteResult,
  AdapterPrepareResult,
  DAppAdapterContext,
} from '../types.js';
import { AdapterError } from '../types.js';

import { getKaminoClient } from './client.js';
import {
  KAMINO_ADAPTER_ID,
  resolveKnownReserve,
} from './constants.js';
import { invalidateReserveSnapshot } from './reserveSnapshot.js';
import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';

export interface KaminoDepositInput {
  amount: string;
  token?: string;
  reserveMint?: string;
  dueAt?: string;
  note?: string;
}

export const kaminoDepositAction: AdapterAction<KaminoDepositInput> = {
  id: 'deposit',
  kind: 'kamino_deposit',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const tokenIdentifier = (input.token ?? input.reserveMint ?? 'SOL').trim();
    const known = resolveKnownReserve(tokenIdentifier);
    const reserveSymbolHint = known?.symbol ?? tokenIdentifier;
    const reserveMint = known?.mint ?? input.reserveMint?.trim();
    if (!reserveMint) {
      throw new AdapterError(
        KAMINO_ADAPTER_ID,
        'unknown_reserve',
        `Unknown Kamino reserve "${tokenIdentifier}". Pass token: SOL, USDC, JitoSOL, mSOL, bSOL, or reserveMint as a mint address.`,
      );
    }

    const decimals = known?.decimals;
    if (typeof decimals !== 'number') {
      throw new AdapterError(
        KAMINO_ADAPTER_ID,
        'unknown_reserve',
        `Kamino reserve "${tokenIdentifier}" is not in the known list. Add it to KAMINO_KNOWN_RESERVES with its decimals before depositing by mint.`,
      );
    }
    const amountRaw = parseDecimalAmount(input.amount, decimals, `${reserveSymbolHint} deposit amount`);

    const walletAddress = await ctx.backend.getAddress();
    const snapshot = await getKaminoClient().getReserveSnapshot(ctx.connection, reserveMint);

    const summary = `Deposit ${input.amount} ${snapshot.reserveSymbol} into Kamino`;
    const previewParams: Record<string, unknown> = {
      adapter: KAMINO_ADAPTER_ID,
      connectorId: KAMINO_ADAPTER_ID,
      action: 'deposit',
      operation: 'deposit',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      reserveMint: snapshot.reserveMint,
      reserveSymbol: snapshot.reserveSymbol,
      reserveAddress: snapshot.reserveAddress,
      decimals: snapshot.decimals,
      amount: input.amount,
      amountRaw: amountRaw.toString(),
      supplyApy: snapshot.supplyApy,
      utilization: snapshot.utilization,
      withdrawalDelaySec: snapshot.withdrawalDelaySec,
      depositLimit: snapshot.depositLimit,
      depositLimitRemaining: snapshot.depositLimitRemaining,
      withdrawAvailable: snapshot.withdrawAvailable,
      preparedSnapshotAt: new Date().toISOString(),
    };

    return {
      addInput: {
        kind: 'kamino_deposit',
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
    const amountRaw = BigInt(amountRawText);
    invalidateReserveSnapshot(reserveMint);

    const walletAddress = await ctx.backend.getAddress();
    if (walletAddress !== action.walletAddress) {
      throw new ProtocolError(
        'unauthorized',
        `Kamino deposit belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }

    const built = await getKaminoClient().buildDepositTransaction(ctx.connection, {
      walletAddress,
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
    const summary = `Deposit ${amountUi} ${built.reserveSymbol} into Kamino`;
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
