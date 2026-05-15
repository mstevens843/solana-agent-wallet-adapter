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

import { resolveLuloClient, type LuloPoolMetaRow, type LuloRateRow } from './client.js';
import {
  LULO_ADAPTER_ID,
  LULO_WITHDRAW_TYPES,
  resolveLuloDecimals,
  resolveLuloMint,
  shortMint,
  withdrawTypeLabel,
  type LuloDepositType,
  type LuloWithdrawType,
} from './constants.js';

export interface LuloWithdrawInput {
  mintAddress: string;
  withdrawType?: LuloWithdrawType;
  amount?: string;
  percentage?: number;
  dueAt?: string;
  note?: string;
}

export const luloWithdrawAction: AdapterAction<LuloWithdrawInput> = {
  id: 'withdraw',
  kind: 'lulo_withdraw',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const rawMint = input.mintAddress?.trim();
    if (!rawMint) {
      throw new AdapterError(
        LULO_ADAPTER_ID,
        'invalid_request',
        'Lulo withdraw requires mintAddress.',
      );
    }
    const { mint: mintAddress, decimalsHint } = resolveLuloMint(rawMint);
    const withdrawType = normalizeWithdrawType(input.withdrawType);
    const hasAmount = typeof input.amount === 'string' && input.amount.trim().length > 0;
    const hasPercentage = typeof input.percentage === 'number';
    if (hasAmount && hasPercentage) {
      throw new AdapterError(
        LULO_ADAPTER_ID,
        'invalid_request',
        'Lulo withdraw cannot accept both amount and percentage. Provide one or the other.',
      );
    }
    if (hasPercentage && (input.percentage! < 1 || input.percentage! > 100 || !Number.isInteger(input.percentage!))) {
      throw new AdapterError(
        LULO_ADAPTER_ID,
        'invalid_request',
        'Lulo withdraw percentage must be an integer between 1 and 100.',
      );
    }

    const decimals = await resolveLuloDecimals(ctx.connection, mintAddress, decimalsHint);
    let amountRaw: bigint | undefined;
    if (hasAmount) {
      amountRaw = parseDecimalAmount(
        input.amount!,
        decimals,
        `${shortMint(mintAddress)} Lulo withdraw amount`,
      );
    }
    const percentage: number = hasAmount ? 0 : hasPercentage ? input.percentage! : 100;

    const walletAddress = await ctx.backend.getAddress();
    const ratesSnapshot = await safeRateSnapshot(mintAddress, withdrawType, ctx);
    const poolMetaSnapshot = await safePoolMeta(mintAddress, ctx);

    const amountDescriptor = hasAmount
      ? `${input.amount}`
      : `${percentage}%`;
    const summary = `Withdraw ${amountDescriptor} ${ratesSnapshot?.symbol ?? poolMetaSnapshot?.symbol ?? shortMint(mintAddress)} from Lulo ${withdrawTypeLabel(withdrawType)}`;

    const cooldownSeconds = poolMetaSnapshot?.cooldownSeconds;
    const previewParams: Record<string, unknown> = {
      adapter: LULO_ADAPTER_ID,
      connectorId: LULO_ADAPTER_ID,
      action: 'withdraw',
      operation: 'withdraw',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      mintAddress,
      decimals,
      withdrawType,
      ...(hasAmount && amountRaw !== undefined
        ? { amount: input.amount, amountRaw: amountRaw.toString() }
        : { percentage }),
      ...(ratesSnapshot ? { ratesSnapshot: pickRateSnapshot(ratesSnapshot) } : {}),
      ...(poolMetaSnapshot ? { poolMetaSnapshot: pickPoolMetaSnapshot(poolMetaSnapshot) } : {}),
      ...(poolMetaSnapshot && poolMetaSnapshot.programIds.length > 0
        ? { programIds: poolMetaSnapshot.programIds }
        : {}),
      ...(typeof cooldownSeconds === 'number' && cooldownSeconds > 0
        ? { cooldownSeconds }
        : {}),
      cooldownWarning:
        withdrawType === 'regular'
          ? 'Regular withdrawals are two-step on Lulo: this prepares the initiation, then run "complete withdraw" after the cooldown finishes.'
          : 'Protected withdrawals settle in a single transaction once approved.',
      refreshAtExecution: true,
      preparedSnapshotAt: new Date().toISOString(),
    };

    return {
      addInput: {
        kind: 'lulo_withdraw',
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
    const decimals = requireNumber(action, 'decimals');
    const withdrawType = normalizeWithdrawType(action.params.withdrawType as LuloWithdrawType | undefined);
    const amountRawText = optionalString(action, 'amountRaw');
    const amountRaw = amountRawText ? BigInt(amountRawText) : undefined;
    const percentage = typeof action.params.percentage === 'number' ? action.params.percentage : undefined;

    const walletAddress = await ctx.backend.getAddress();
    if (walletAddress !== action.walletAddress) {
      throw new ProtocolError(
        'unauthorized',
        `Lulo withdraw belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }

    const built = await resolveLuloClient(ctx).generateWithdrawTransaction({
      walletAddress,
      mintAddress,
      withdrawType,
      ...(amountRaw !== undefined ? { amountRaw } : {}),
      ...(percentage !== undefined ? { percentage } : {}),
    });
    const amountUi = amountRaw !== undefined
      ? formatRawAmount(amountRaw, decimals)
      : built.amountRawHint
        ? formatRawAmount(BigInt(built.amountRawHint), decimals)
        : `${percentage ?? 100}%`;
    const summary = `Withdraw ${amountUi} ${shortMint(mintAddress)} from Lulo ${withdrawTypeLabel(withdrawType)}`;
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        mintAddress,
        withdrawType,
        amountUi,
        programIds: built.programIds,
        ...(built.withdrawalId ? { withdrawalId: built.withdrawalId } : {}),
        ...(typeof built.cooldownSeconds === 'number' ? { cooldownSeconds: built.cooldownSeconds } : {}),
        ...(built.expectedReadyAtIso ? { expectedReadyAtIso: built.expectedReadyAtIso } : {}),
      },
    };
  },
};

export interface LuloCompleteWithdrawInput {
  mintAddress: string;
  withdrawalId: string;
  dueAt?: string;
  note?: string;
}

export const luloCompleteWithdrawAction: AdapterAction<LuloCompleteWithdrawInput> = {
  id: 'complete_withdraw',
  kind: 'lulo_complete_withdraw',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const rawMint = input.mintAddress?.trim();
    const withdrawalId = input.withdrawalId?.trim();
    if (!rawMint) {
      throw new AdapterError(
        LULO_ADAPTER_ID,
        'invalid_request',
        'Lulo complete-withdraw requires mintAddress.',
      );
    }
    if (!withdrawalId) {
      throw new AdapterError(
        LULO_ADAPTER_ID,
        'invalid_request',
        'Lulo complete-withdraw requires withdrawalId.',
      );
    }

    const { mint: mintAddress, decimalsHint } = resolveLuloMint(rawMint);
    const decimals = await resolveLuloDecimals(ctx.connection, mintAddress, decimalsHint);
    const walletAddress = await ctx.backend.getAddress();
    const poolMetaSnapshot = await safePoolMeta(mintAddress, ctx);

    const summary = `Complete Lulo regular withdrawal #${withdrawalId} (${shortMint(mintAddress)})`;
    const previewParams: Record<string, unknown> = {
      adapter: LULO_ADAPTER_ID,
      connectorId: LULO_ADAPTER_ID,
      action: 'complete_withdraw',
      operation: 'complete_withdraw',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      mintAddress,
      decimals,
      withdrawalId,
      ...(poolMetaSnapshot ? { poolMetaSnapshot: pickPoolMetaSnapshot(poolMetaSnapshot) } : {}),
      ...(poolMetaSnapshot && poolMetaSnapshot.programIds.length > 0
        ? { programIds: poolMetaSnapshot.programIds }
        : {}),
      refreshAtExecution: true,
      preparedSnapshotAt: new Date().toISOString(),
    };

    return {
      addInput: {
        kind: 'lulo_complete_withdraw',
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
    const withdrawalId = requireString(action, 'withdrawalId');
    const walletAddress = await ctx.backend.getAddress();
    if (walletAddress !== action.walletAddress) {
      throw new ProtocolError(
        'unauthorized',
        `Lulo complete-withdraw belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }

    const built = await resolveLuloClient(ctx).generateCompleteWithdrawTransaction({
      walletAddress,
      mintAddress,
      withdrawalId,
    });
    const summary = `Complete Lulo regular withdrawal #${withdrawalId} (${shortMint(mintAddress)})`;
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        mintAddress,
        withdrawalId,
        programIds: built.programIds,
      },
    };
  },
};

function normalizeWithdrawType(value: LuloWithdrawType | string | undefined): LuloWithdrawType {
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if ((LULO_WITHDRAW_TYPES as readonly string[]).includes(normalized)) {
      return normalized as LuloWithdrawType;
    }
  }
  return 'protected';
}

async function safeRateSnapshot(
  mintAddress: string,
  withdrawType: LuloWithdrawType,
  ctx: DAppAdapterContext,
): Promise<LuloRateRow | undefined> {
  try {
    const ratesType: LuloDepositType = withdrawType === 'regular' ? 'regular' : 'protected';
    const snapshot = await resolveLuloClient(ctx).getRates({ mintAddress, depositType: ratesType });
    return snapshot.rows.find((row) => row.mintAddress === mintAddress) ?? snapshot.rows[0];
  } catch {
    return undefined;
  }
}

async function safePoolMeta(
  mintAddress: string,
  ctx: DAppAdapterContext,
): Promise<LuloPoolMetaRow | undefined> {
  try {
    const snapshot = await resolveLuloClient(ctx).getPoolMeta({ mintAddress });
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

function optionalString(action: PreparedAction, key: string): string | undefined {
  const value = action.params[key];
  if (typeof value === 'string' && value) return value;
  return undefined;
}
