import { PublicKey, type Connection } from '@solana/web3.js';

import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { parseDecimalAmount } from '../../amounts.js';
import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';
import type { PreparedAction } from '../../preparedActions.js';
import { AdapterError } from '../types.js';
import type {
  AdapterAction,
  AdapterExecuteResult,
  AdapterPrepareResult,
} from '../types.js';

import {
  getDriftVaultClient,
  type DriftVaultDepositor,
  type DriftVaultSnapshot,
} from './client.js';
import { DRIFT_ADAPTER_ID, DRIFT_VAULTS_PROGRAM_ID } from './constants.js';

export interface DriftVaultDepositInput {
  vaultAddress: string;
  amount: string;
  mint?: string;
  initializeDepositorIfMissing?: boolean;
  dueAt?: string;
  note?: string;
}

export async function getVaultSnapshot(
  connection: Connection,
  vaultAddress: string,
): Promise<DriftVaultSnapshot> {
  const normalized = vaultAddress.trim();
  if (!normalized) {
    throw new AdapterError(
      DRIFT_ADAPTER_ID,
      'invalid_request',
      'vaultAddress is required to read a Drift vault snapshot.',
    );
  }
  return getDriftVaultClient().getVaultSnapshot(connection, normalized);
}

export async function getWalletVaultPositions(
  connection: Connection,
  walletAddress: string,
  vaultAddress?: string,
): Promise<DriftVaultDepositor[]> {
  if (!walletAddress || !walletAddress.trim()) {
    throw new AdapterError(
      DRIFT_ADAPTER_ID,
      'invalid_request',
      'walletAddress is required to read Drift vault positions.',
    );
  }
  return getDriftVaultClient().getWalletVaultPositions(
    connection,
    walletAddress.trim(),
    vaultAddress?.trim(),
  );
}

export function summarizeVaultPositions(positions: DriftVaultDepositor[]): {
  vaultCount: number;
  pendingWithdrawCount: number;
  totalShares: string;
  totalValue: string;
} {
  let totalShares = 0;
  let totalValue = 0;
  let pendingWithdrawCount = 0;
  for (const position of positions) {
    const shares = Number(position.shares);
    const value = Number(position.valueAtSharePrice);
    if (Number.isFinite(shares)) totalShares += shares;
    if (Number.isFinite(value)) totalValue += value;
    if (Number(position.pendingWithdrawShares) > 0) pendingWithdrawCount += 1;
  }
  return {
    vaultCount: positions.length,
    pendingWithdrawCount,
    totalShares: trimNumber(totalShares),
    totalValue: trimNumber(totalValue),
  };
}

export const driftVaultDepositAction: AdapterAction<DriftVaultDepositInput> = {
  id: 'vault_deposit',
  kind: 'drift_vault_deposit',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const vaultAddress = requireVaultAddress(input.vaultAddress);
    const snapshot = await getVaultSnapshot(ctx.connection, vaultAddress);

    if (input.mint && input.mint.trim() !== snapshot.depositMint) {
      throw new AdapterError(
        DRIFT_ADAPTER_ID,
        'mint_mismatch',
        `Drift vault ${vaultAddress} accepts ${snapshot.depositMint}, not ${input.mint.trim()}.`,
      );
    }

    const amountRaw = parseDecimalAmount(
      input.amount,
      snapshot.decimals,
      'Drift vault deposit amount',
    );

    const walletAddress = await ctx.backend.getAddress();
    const positions = await getDriftVaultClient().getWalletVaultPositions(
      ctx.connection,
      walletAddress,
      vaultAddress,
    );
    const existing = positions.find((entry) => entry.vaultAddress === vaultAddress);
    const depositorExists = Boolean(existing);
    const initializeRequested = input.initializeDepositorIfMissing === true;
    if (!depositorExists && !initializeRequested) {
      throw new AdapterError(
        DRIFT_ADAPTER_ID,
        'depositor_not_initialized',
        `No Drift vault depositor account found for ${walletAddress} in ${vaultAddress}. Re-prepare with initializeDepositorIfMissing: true to create the depositor as part of this approval.`,
      );
    }

    const summary = `Deposit ${input.amount} ${displaySymbol(snapshot)} into Drift vault ${displayVaultName(snapshot)}`;
    const previewParams: Record<string, unknown> = {
      adapter: DRIFT_ADAPTER_ID,
      connectorId: DRIFT_ADAPTER_ID,
      action: 'vault_deposit',
      operation: 'vault_deposit',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      vaultAddress: snapshot.vaultAddress,
      vaultName: snapshot.name,
      manager: snapshot.manager,
      depositMint: snapshot.depositMint,
      depositSymbol: snapshot.depositSymbol ?? null,
      decimals: snapshot.decimals,
      amount: input.amount,
      amountRaw: amountRaw.toString(),
      sharePrice: snapshot.sharePrice,
      totalShares: snapshot.totalShares,
      totalValue: snapshot.totalValue,
      redeemPeriodSec: snapshot.redeemPeriodSec,
      lockupSec: snapshot.lockupSec,
      profitShareBps: snapshot.profitShareBps,
      managementFeeBps: snapshot.managementFeeBps,
      hurdleRateBps: snapshot.hurdleRateBps ?? null,
      initializeDepositorIfMissing: initializeRequested,
      depositorExists,
      depositorPendingWithdrawShares: existing?.pendingWithdrawShares ?? '0',
      vaultPendingWithdrawShares: snapshot.pendingWithdrawShares,
      vaultProgramId: DRIFT_VAULTS_PROGRAM_ID.toBase58(),
      preparedSnapshotAt: new Date().toISOString(),
      refreshAtExecution: true,
    };

    return {
      addInput: {
        kind: 'drift_vault_deposit',
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
    const vaultAddress = requireString(action, 'vaultAddress');
    const depositMint = requireString(action, 'depositMint');
    const amountRawText = requireString(action, 'amountRaw');
    const decimals = requireNumber(action, 'decimals');
    const initializeDepositorIfMissing = action.params.initializeDepositorIfMissing === true;

    const walletAddress = await ctx.backend.getAddress();
    if (walletAddress !== action.walletAddress) {
      throw new ProtocolError(
        'unauthorized',
        `Drift vault deposit belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }

    const freshSnapshot = await getDriftVaultClient().getVaultSnapshot(ctx.connection, vaultAddress);
    if (freshSnapshot.depositMint !== depositMint) {
      throw new ProtocolError(
        'invalid_request',
        `Drift vault ${vaultAddress} deposit mint changed from ${depositMint} to ${freshSnapshot.depositMint} since prepare time. Re-prepare before executing.`,
      );
    }
    if (freshSnapshot.decimals !== decimals) {
      throw new ProtocolError(
        'invalid_request',
        `Drift vault ${vaultAddress} decimals changed since prepare time. Re-prepare before executing.`,
      );
    }
    const refreshedPositions = await getDriftVaultClient().getWalletVaultPositions(
      ctx.connection,
      walletAddress,
      vaultAddress,
    );
    const refreshedExists = refreshedPositions.some((entry) => entry.vaultAddress === vaultAddress);
    if (!refreshedExists && !initializeDepositorIfMissing) {
      throw new ProtocolError(
        'invalid_request',
        `Drift vault depositor account for ${vaultAddress} is missing. Re-prepare with initializeDepositorIfMissing: true.`,
      );
    }

    const amountRaw = BigInt(amountRawText);
    const built = await getDriftVaultClient().buildVaultDepositTransaction(ctx.connection, {
      walletAddress,
      vaultAddress,
      amountRaw,
      initializeDepositorIfMissing,
    });
    const summary = `Deposit ${built.amountUi} ${built.depositSymbol ?? built.depositMint} into Drift vault ${built.vaultName ?? short(vaultAddress)}`;
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        vaultAddress: built.vaultAddress,
        vaultName: built.vaultName,
        depositMint: built.depositMint,
        depositSymbol: built.depositSymbol,
        amountUi: built.amountUi,
        initializedDepositor: built.initializedDepositor,
        sharePrice: built.summarySnapshot.sharePrice,
        totalShares: built.summarySnapshot.totalShares,
      },
    };
  },
};

export function requireVaultAddress(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new AdapterError(
      DRIFT_ADAPTER_ID,
      'invalid_request',
      'vaultAddress is required for Drift vault actions.',
    );
  }
  try {
    // eslint-disable-next-line no-new
    new PublicKey(normalized);
  } catch {
    throw new AdapterError(
      DRIFT_ADAPTER_ID,
      'invalid_vault',
      `vaultAddress ${normalized} is not a valid base58 public key.`,
    );
  }
  return normalized;
}

export function requireString(action: PreparedAction, key: string): string {
  const value = action.params[key];
  if (typeof value !== 'string' || !value) {
    throw new ProtocolError('invalid_request', `Drift action ${action.id} is missing ${key}.`);
  }
  return value;
}

export function requireNumber(action: PreparedAction, key: string): number {
  const value = action.params[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProtocolError(
      'invalid_request',
      `Drift action ${action.id} is missing numeric ${key}.`,
    );
  }
  return value;
}

export function displaySymbol(snapshot: DriftVaultSnapshot): string {
  return snapshot.depositSymbol?.trim() || short(snapshot.depositMint);
}

export function displayVaultName(snapshot: DriftVaultSnapshot): string {
  return snapshot.name?.trim() || short(snapshot.vaultAddress);
}

export function short(address: string): string {
  const trimmed = address.trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

function trimNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(6).replace(/\.?0+$/, '');
}
