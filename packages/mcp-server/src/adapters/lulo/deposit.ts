import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { formatRawAmount, parseDecimalAmount } from '../../amounts.js';
import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';
import type { PreparedAction } from '../../preparedActions.js';
import type {
  AdapterAction,
  AdapterExecuteResult,
  AdapterPrepareResult,
  DAppAdapterContext,
} from '../types.js';
import { AdapterError } from '../types.js';

import { getLuloClient, type LuloPoolMetaRow, type LuloRateRow } from './client.js';
import {
  LULO_ADAPTER_ID,
  LULO_DEPOSIT_TYPES,
  depositTypeLabel,
  resolveLuloDecimals,
  shortMint,
  type LuloDepositType,
} from './constants.js';

export interface LuloDepositInput {
  amount: string;
  mintAddress: string;
  depositType?: LuloDepositType;
  priorityFee?: number;
  dueAt?: string;
  note?: string;
}

export const luloDepositAction: AdapterAction<LuloDepositInput> = {
  id: 'deposit',
  kind: 'lulo_deposit',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const mintAddress = input.mintAddress?.trim();
    if (!mintAddress) {
      throw new AdapterError(
        LULO_ADAPTER_ID,
        'invalid_request',
        'Lulo deposit requires mintAddress.',
      );
    }
    const depositType = normalizeDepositType(input.depositType);
    if (input.priorityFee !== undefined && (!Number.isFinite(input.priorityFee) || input.priorityFee < 0)) {
      throw new AdapterError(
        LULO_ADAPTER_ID,
        'invalid_request',
        'Lulo deposit priorityFee must be a non-negative integer (micro-lamports).',
      );
    }

    const decimals = await resolveLuloDecimals(ctx.connection, mintAddress);
    const amountRaw = parseDecimalAmount(input.amount, decimals, `${shortMint(mintAddress)} Lulo deposit amount`);

    const walletAddress = await ctx.backend.getAddress();
    const ratesSnapshot = await safeRateSnapshot(mintAddress, depositType);
    const poolMetaSnapshot = await safePoolMeta(mintAddress);
    const supplyApy = ratesSnapshot?.apy;

    const summary = `Deposit ${input.amount} ${ratesSnapshot?.symbol ?? poolMetaSnapshot?.symbol ?? shortMint(mintAddress)} into Lulo ${depositTypeLabel(depositType)}`;
    const previewParams: Record<string, unknown> = {
      adapter: LULO_ADAPTER_ID,
      connectorId: LULO_ADAPTER_ID,
      action: 'deposit',
      operation: 'deposit',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      mintAddress,
      decimals,
      amount: input.amount,
      amountRaw: amountRaw.toString(),
      depositType,
      ...(input.priorityFee !== undefined ? { priorityFee: input.priorityFee } : {}),
      ...(typeof supplyApy === 'number' ? { supplyApy } : {}),
      ...(ratesSnapshot ? { ratesSnapshot: pickRateSnapshot(ratesSnapshot) } : {}),
      ...(poolMetaSnapshot ? { poolMetaSnapshot: pickPoolMetaSnapshot(poolMetaSnapshot) } : {}),
      ...(poolMetaSnapshot && poolMetaSnapshot.programIds.length > 0
        ? { programIds: poolMetaSnapshot.programIds }
        : {}),
      productWarning:
        depositType === 'boost'
          ? 'Lulo Boost yield is not protected against pool losses; review product coverage before approving.'
          : depositType === 'regular'
            ? 'Lulo Regular yield does not include Protected coverage; review product terms before approving.'
            : 'Lulo Protected yield is not risk-free; review product coverage and underlying allocations before approving.',
      refreshAtExecution: true,
      preparedSnapshotAt: new Date().toISOString(),
    };

    return {
      addInput: {
        kind: 'lulo_deposit',
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
    const mintAddress = requireString(action, 'mintAddress');
    const amountRawText = requireString(action, 'amountRaw');
    const decimals = requireNumber(action, 'decimals');
    const depositType = normalizeDepositType(action.params.depositType as LuloDepositType | undefined);
    const amountRaw = BigInt(amountRawText);
    const priorityFee = typeof action.params.priorityFee === 'number' ? action.params.priorityFee : undefined;

    const walletAddress = await ctx.backend.getAddress();
    if (walletAddress !== action.walletAddress) {
      throw new ProtocolError(
        'unauthorized',
        `Lulo deposit belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }

    const built = await getLuloClient().generateDepositTransaction({
      walletAddress,
      mintAddress,
      amountRaw,
      depositType,
      ...(priorityFee !== undefined ? { priorityFee } : {}),
    });
    const amountUi = formatRawAmount(amountRaw, decimals);
    const summary = `Deposit ${amountUi} ${built.ratesSnapshot?.symbol ?? built.poolMetaSnapshot?.symbol ?? shortMint(mintAddress)} into Lulo ${depositTypeLabel(depositType)}`;
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        mintAddress,
        depositType,
        amountUi,
        programIds: built.programIds,
        ...(built.ratesSnapshot ? { supplyApyAtExecute: built.ratesSnapshot.apy } : {}),
      },
    };
  },
};

function normalizeDepositType(value: LuloDepositType | string | undefined): LuloDepositType {
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if ((LULO_DEPOSIT_TYPES as readonly string[]).includes(normalized)) {
      return normalized as LuloDepositType;
    }
  }
  return 'protected';
}

async function safeRateSnapshot(
  mintAddress: string,
  depositType: LuloDepositType,
): Promise<LuloRateRow | undefined> {
  try {
    const snapshot = await getLuloClient().getRates({ mintAddress, depositType });
    return snapshot.rows.find((row) => row.mintAddress === mintAddress && row.depositType === depositType) ?? snapshot.rows[0];
  } catch {
    return undefined;
  }
}

async function safePoolMeta(mintAddress: string): Promise<LuloPoolMetaRow | undefined> {
  try {
    const snapshot = await getLuloClient().getPoolMeta({ mintAddress });
    return snapshot.pools.find((row) => row.mintAddress === mintAddress) ?? snapshot.pools[0];
  } catch {
    return undefined;
  }
}

function pickRateSnapshot(row: LuloRateRow): Record<string, unknown> {
  return {
    mintAddress: row.mintAddress,
    depositType: row.depositType,
    apy: row.apy,
    ...(row.symbol ? { symbol: row.symbol } : {}),
    ...(row.tvlUsd ? { tvlUsd: row.tvlUsd } : {}),
    ...(row.liquidityAvailable ? { liquidityAvailable: row.liquidityAvailable } : {}),
    ...(row.apyAsOfIso ? { apyAsOfIso: row.apyAsOfIso } : {}),
  };
}

function pickPoolMetaSnapshot(row: LuloPoolMetaRow): Record<string, unknown> {
  return {
    mintAddress: row.mintAddress,
    supportedDepositTypes: row.supportedDepositTypes,
    programIds: row.programIds,
    ...(row.symbol ? { symbol: row.symbol } : {}),
    ...(typeof row.decimals === 'number' ? { decimals: row.decimals } : {}),
    ...(typeof row.cooldownSeconds === 'number' ? { cooldownSeconds: row.cooldownSeconds } : {}),
    ...(row.notes && row.notes.length > 0 ? { notes: row.notes } : {}),
  };
}

function requireString(action: PreparedAction, key: string): string {
  const value = action.params[key];
  if (typeof value !== 'string' || !value) {
    throw new ProtocolError('invalid_request', `Lulo action ${action.id} is missing ${key}.`);
  }
  return value;
}

function requireNumber(action: PreparedAction, key: string): number {
  const value = action.params[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProtocolError('invalid_request', `Lulo action ${action.id} is missing numeric ${key}.`);
  }
  return value;
}
