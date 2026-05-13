import type { Connection } from '@solana/web3.js';

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
  type DriftWithdrawStatus,
} from './client.js';
import { DRIFT_ADAPTER_ID, type DriftWithdrawUnit } from './constants.js';
import {
  displaySymbol,
  displayVaultName,
  requireNumber,
  requireString,
  requireVaultAddress,
  short,
} from './vaults.js';

export interface DriftVaultRequestWithdrawInput {
  vaultAddress: string;
  amount?: string;
  shares?: string;
  withdrawUnit?: DriftWithdrawUnit;
  dueAt?: string;
  note?: string;
}

export interface DriftVaultCancelWithdrawInput {
  vaultAddress: string;
  dueAt?: string;
  note?: string;
}

export interface DriftVaultCompleteWithdrawInput {
  vaultAddress: string;
  dueAt?: string;
  note?: string;
}

export async function getWithdrawStatus(
  connection: Connection,
  walletAddress: string,
  vaultAddress: string,
): Promise<DriftWithdrawStatus> {
  if (!walletAddress || !walletAddress.trim()) {
    throw new AdapterError(
      DRIFT_ADAPTER_ID,
      'invalid_request',
      'walletAddress is required to read Drift withdraw status.',
    );
  }
  const normalizedVault = requireVaultAddress(vaultAddress);
  return getDriftVaultClient().getWithdrawStatus(connection, walletAddress.trim(), normalizedVault);
}

export const driftVaultRequestWithdrawAction: AdapterAction<DriftVaultRequestWithdrawInput> = {
  id: 'vault_request_withdraw',
  kind: 'drift_vault_request_withdraw',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const vaultAddress = requireVaultAddress(input.vaultAddress);
    const withdrawUnit: DriftWithdrawUnit = input.withdrawUnit ?? 'token';
    const walletAddress = await ctx.backend.getAddress();

    const snapshot = await getDriftVaultClient().getVaultSnapshot(ctx.connection, vaultAddress);
    const positions = await getDriftVaultClient().getWalletVaultPositions(
      ctx.connection,
      walletAddress,
      vaultAddress,
    );
    const position = positions.find((entry) => entry.vaultAddress === vaultAddress);
    if (!position || Number(position.shares) <= 0) {
      throw new AdapterError(
        DRIFT_ADAPTER_ID,
        'no_position',
        `No Drift vault position to withdraw from in ${vaultAddress}.`,
      );
    }
    if (Number(position.pendingWithdrawShares) > 0) {
      throw new AdapterError(
        DRIFT_ADAPTER_ID,
        'pending_withdraw_active',
        `Drift vault ${vaultAddress} already has a pending withdraw request. Wait for the redeem period to elapse or cancel before requesting a new one.`,
      );
    }

    let amountRaw: bigint | undefined;
    let sharesRaw: bigint | undefined;
    let displayAmount: string;
    let amountUi: string | undefined;
    let sharesUi: string | undefined;

    if (withdrawUnit === 'token') {
      if (!input.amount) {
        throw new AdapterError(
          DRIFT_ADAPTER_ID,
          'invalid_amount',
          'Provide amount when withdrawUnit is "token".',
        );
      }
      amountRaw = parseDecimalAmount(input.amount, snapshot.decimals, 'Drift vault withdraw amount');
      const requested = Number(input.amount);
      const available = Number(position.valueAtSharePrice);
      if (Number.isFinite(requested) && Number.isFinite(available) && requested > available) {
        throw new AdapterError(
          DRIFT_ADAPTER_ID,
          'insufficient_position',
          `Requested withdraw of ${input.amount} ${displaySymbol(snapshot)} exceeds position value ${position.valueAtSharePrice}.`,
        );
      }
      amountUi = input.amount;
      displayAmount = `${input.amount} ${displaySymbol(snapshot)}`;
    } else {
      if (!input.shares) {
        throw new AdapterError(
          DRIFT_ADAPTER_ID,
          'invalid_amount',
          'Provide shares when withdrawUnit is "shares".',
        );
      }
      sharesRaw = parseDecimalAmount(input.shares, snapshot.decimals, 'Drift vault withdraw shares');
      const requested = Number(input.shares);
      const available = Number(position.shares);
      if (Number.isFinite(requested) && Number.isFinite(available) && requested > available) {
        throw new AdapterError(
          DRIFT_ADAPTER_ID,
          'insufficient_position',
          `Requested withdraw of ${input.shares} shares exceeds position shares ${position.shares}.`,
        );
      }
      sharesUi = input.shares;
      displayAmount = `${input.shares} shares`;
    }

    const redeemableAtMs = Date.now() + snapshot.redeemPeriodSec * 1000;
    const redeemableAt = new Date(redeemableAtMs).toISOString();

    const summary = `Request Drift vault withdraw of ${displayAmount} from ${displayVaultName(snapshot)}`;
    const previewParams: Record<string, unknown> = {
      adapter: DRIFT_ADAPTER_ID,
      connectorId: DRIFT_ADAPTER_ID,
      action: 'vault_request_withdraw',
      operation: 'vault_request_withdraw',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      vaultAddress: snapshot.vaultAddress,
      vaultName: snapshot.name,
      manager: snapshot.manager,
      depositMint: snapshot.depositMint,
      depositSymbol: snapshot.depositSymbol ?? null,
      decimals: snapshot.decimals,
      withdrawUnit,
      amount: amountUi ?? null,
      amountRaw: amountRaw?.toString() ?? null,
      shares: sharesUi ?? null,
      sharesRaw: sharesRaw?.toString() ?? null,
      redeemPeriodSec: snapshot.redeemPeriodSec,
      redeemableAt,
      lockupSec: snapshot.lockupSec,
      profitShareBps: snapshot.profitShareBps,
      managementFeeBps: snapshot.managementFeeBps,
      depositorSharesBefore: position.shares,
      depositorValueBefore: position.valueAtSharePrice,
      sharePrice: snapshot.sharePrice,
      preparedSnapshotAt: new Date().toISOString(),
      refreshAtExecution: true,
    };

    return {
      addInput: {
        kind: 'drift_vault_request_withdraw',
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

  async execute(action, ctx): Promise<AdapterExecuteResult> {
    const vaultAddress = requireString(action, 'vaultAddress');
    const withdrawUnit = requireWithdrawUnit(action);
    const walletAddress = await ctx.backend.getAddress();
    if (walletAddress !== action.walletAddress) {
      throw new ProtocolError(
        'unauthorized',
        `Drift vault withdraw request belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }

    const refreshed = await getDriftVaultClient().getWalletVaultPositions(
      ctx.connection,
      walletAddress,
      vaultAddress,
    );
    const position = refreshed.find((entry) => entry.vaultAddress === vaultAddress);
    if (!position || Number(position.shares) <= 0) {
      throw new ProtocolError(
        'invalid_request',
        `Drift vault position for ${vaultAddress} is empty or missing at execute time.`,
      );
    }
    if (Number(position.pendingWithdrawShares) > 0) {
      throw new ProtocolError(
        'invalid_request',
        `Drift vault ${vaultAddress} now has a pending withdraw request. Re-prepare to continue.`,
      );
    }

    const amountRawText = typeof action.params.amountRaw === 'string' ? action.params.amountRaw : undefined;
    const sharesRawText = typeof action.params.sharesRaw === 'string' ? action.params.sharesRaw : undefined;
    if (withdrawUnit === 'token' && !amountRawText) {
      throw new ProtocolError('invalid_request', 'Drift withdraw request token unit requires amountRaw.');
    }
    if (withdrawUnit === 'shares' && !sharesRawText) {
      throw new ProtocolError('invalid_request', 'Drift withdraw request shares unit requires sharesRaw.');
    }

    const built = await getDriftVaultClient().buildVaultRequestWithdrawTransaction(ctx.connection, {
      walletAddress,
      vaultAddress,
      withdrawUnit,
      ...(amountRawText ? { amountRaw: BigInt(amountRawText) } : {}),
      ...(sharesRawText ? { sharesRaw: BigInt(sharesRawText) } : {}),
    });
    const displayAmount = built.amountUi
      ? `${built.amountUi} ${built.depositSymbol ?? built.depositMint}`
      : `${built.sharesUi ?? '?'} shares`;
    const summary = `Request Drift vault withdraw of ${displayAmount} from ${built.vaultName ?? short(vaultAddress)}`;
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        vaultAddress: built.vaultAddress,
        vaultName: built.vaultName,
        withdrawUnit,
        amountUi: built.amountUi,
        sharesUi: built.sharesUi,
        redeemableAt: built.redeemableAt,
        sharePrice: built.summarySnapshot.sharePrice,
      },
    };
  },
};

export const driftVaultCancelWithdrawAction: AdapterAction<DriftVaultCancelWithdrawInput> = {
  id: 'vault_cancel_withdraw',
  kind: 'drift_vault_cancel_withdraw',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const vaultAddress = requireVaultAddress(input.vaultAddress);
    const walletAddress = await ctx.backend.getAddress();
    const status = await getDriftVaultClient().getWithdrawStatus(
      ctx.connection,
      walletAddress,
      vaultAddress,
    );
    if (!status.hasPendingRequest) {
      throw new AdapterError(
        DRIFT_ADAPTER_ID,
        'no_pending_request',
        `Drift vault ${vaultAddress} has no pending withdraw to cancel.`,
      );
    }
    const snapshot = await getDriftVaultClient().getVaultSnapshot(ctx.connection, vaultAddress);
    const summary = `Cancel pending Drift vault withdraw on ${displayVaultName(snapshot)}`;
    const previewParams: Record<string, unknown> = {
      adapter: DRIFT_ADAPTER_ID,
      connectorId: DRIFT_ADAPTER_ID,
      action: 'vault_cancel_withdraw',
      operation: 'vault_cancel_withdraw',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      vaultAddress: snapshot.vaultAddress,
      vaultName: snapshot.name,
      manager: snapshot.manager,
      depositMint: snapshot.depositMint,
      depositSymbol: snapshot.depositSymbol ?? null,
      decimals: snapshot.decimals,
      pendingShares: status.requestedShares,
      pendingRequestedAt: status.requestedAt ?? null,
      redeemableAt: status.redeemableAt ?? null,
      redeemPeriodSec: snapshot.redeemPeriodSec,
      sharePrice: snapshot.sharePrice,
      preparedSnapshotAt: new Date().toISOString(),
      refreshAtExecution: true,
    };
    return {
      addInput: {
        kind: 'drift_vault_cancel_withdraw',
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

  async execute(action, ctx): Promise<AdapterExecuteResult> {
    const vaultAddress = requireString(action, 'vaultAddress');
    const walletAddress = await ctx.backend.getAddress();
    if (walletAddress !== action.walletAddress) {
      throw new ProtocolError(
        'unauthorized',
        `Drift vault cancel withdraw belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }
    const refreshed = await getDriftVaultClient().getWithdrawStatus(
      ctx.connection,
      walletAddress,
      vaultAddress,
    );
    if (!refreshed.hasPendingRequest) {
      throw new ProtocolError(
        'invalid_request',
        `Drift vault ${vaultAddress} no longer has a pending withdraw to cancel.`,
      );
    }
    const built = await getDriftVaultClient().buildVaultCancelWithdrawTransaction(ctx.connection, {
      walletAddress,
      vaultAddress,
    });
    const summary = `Cancel pending Drift vault withdraw on ${built.vaultName ?? short(vaultAddress)}`;
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        vaultAddress: built.vaultAddress,
        vaultName: built.vaultName,
        cancelledShares: built.cancelledShares,
      },
    };
  },
};

export const driftVaultCompleteWithdrawAction: AdapterAction<DriftVaultCompleteWithdrawInput> = {
  id: 'vault_complete_withdraw',
  kind: 'drift_vault_complete_withdraw',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const vaultAddress = requireVaultAddress(input.vaultAddress);
    const walletAddress = await ctx.backend.getAddress();
    const status = await getDriftVaultClient().getWithdrawStatus(
      ctx.connection,
      walletAddress,
      vaultAddress,
    );
    if (!status.hasPendingRequest) {
      throw new AdapterError(
        DRIFT_ADAPTER_ID,
        'no_pending_request',
        `Drift vault ${vaultAddress} has no pending withdraw to complete.`,
      );
    }
    if (!status.isReady) {
      const eta = status.redeemableAt
        ? new Date(status.redeemableAt * 1000).toISOString()
        : 'unknown';
      throw new AdapterError(
        DRIFT_ADAPTER_ID,
        'redeem_period_not_elapsed',
        `Drift vault ${vaultAddress} withdraw redeem period has not elapsed yet (redeemable at ${eta}).`,
      );
    }
    const snapshot = await getDriftVaultClient().getVaultSnapshot(ctx.connection, vaultAddress);
    const nowIso = new Date().toISOString();
    const summary = `Complete Drift vault withdraw on ${displayVaultName(snapshot)}`;
    const previewParams: Record<string, unknown> = {
      adapter: DRIFT_ADAPTER_ID,
      connectorId: DRIFT_ADAPTER_ID,
      action: 'vault_complete_withdraw',
      operation: 'vault_complete_withdraw',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      vaultAddress: snapshot.vaultAddress,
      vaultName: snapshot.name,
      manager: snapshot.manager,
      depositMint: snapshot.depositMint,
      depositSymbol: snapshot.depositSymbol ?? null,
      decimals: snapshot.decimals,
      redeemableShares: status.requestedShares,
      redeemableValue: status.requestedValue ?? null,
      redeemableAt: status.redeemableAt ?? null,
      sharePrice: snapshot.sharePrice,
      nowIso,
      preparedSnapshotAt: nowIso,
      refreshAtExecution: true,
    };
    return {
      addInput: {
        kind: 'drift_vault_complete_withdraw',
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

  async execute(action, ctx): Promise<AdapterExecuteResult> {
    const vaultAddress = requireString(action, 'vaultAddress');
    const walletAddress = await ctx.backend.getAddress();
    if (walletAddress !== action.walletAddress) {
      throw new ProtocolError(
        'unauthorized',
        `Drift vault complete withdraw belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }
    const refreshed = await getDriftVaultClient().getWithdrawStatus(
      ctx.connection,
      walletAddress,
      vaultAddress,
    );
    if (!refreshed.hasPendingRequest) {
      throw new ProtocolError(
        'invalid_request',
        `Drift vault ${vaultAddress} no longer has a pending withdraw to complete.`,
      );
    }
    if (!refreshed.isReady) {
      const eta = refreshed.redeemableAt
        ? new Date(refreshed.redeemableAt * 1000).toISOString()
        : 'unknown';
      throw new ProtocolError(
        'invalid_request',
        `Drift vault ${vaultAddress} withdraw redeem period has not elapsed yet (redeemable at ${eta}).`,
      );
    }
    const built = await getDriftVaultClient().buildVaultCompleteWithdrawTransaction(ctx.connection, {
      walletAddress,
      vaultAddress,
    });
    const summary = `Complete Drift vault withdraw on ${built.vaultName ?? short(vaultAddress)}`;
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      preview: {
        vaultAddress: built.vaultAddress,
        vaultName: built.vaultName,
        redeemedShares: built.redeemedShares,
        redeemedAmountUi: built.redeemedAmountUi,
      },
    };
  },
};

function requireWithdrawUnit(action: PreparedAction): DriftWithdrawUnit {
  const value = action.params.withdrawUnit;
  if (value === 'token' || value === 'shares') return value;
  throw new ProtocolError(
    'invalid_request',
    `Drift action ${action.id} is missing withdrawUnit ("token" or "shares").`,
  );
}
