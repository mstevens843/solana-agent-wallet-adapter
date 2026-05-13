import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';
import type { PreparedAction } from '../../preparedActions.js';
import type {
  AdapterAction,
  AdapterExecuteResult,
  AdapterPrepareResult,
} from '../types.js';
import { getRaydiumClient, type RaydiumFarmInput } from './client.js';
import { RAYDIUM_ADAPTER_ID, RAYDIUM_PROGRAM_IDS, shortAddress } from './constants.js';
import {
  optionalStringParam,
  parsePublicKey,
  requireStringParam,
  stripUndefined,
  validateOptionalPositiveDecimalString,
  validatePositiveDecimalString,
} from './validation.js';

export interface RaydiumFarmPrepareInput {
  farmId: string;
  amount?: string;
  dueAt?: string;
  note?: string;
}

export const raydiumFarmStakeAction: AdapterAction<RaydiumFarmPrepareInput> = {
  id: 'farm_stake',
  kind: 'raydium_farm_stake',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    return prepareFarmAction('stake', input, ctx);
  },
  async execute(action: PreparedAction, ctx): Promise<AdapterExecuteResult> {
    return executeFarmAction('stake', action, ctx);
  },
};

export const raydiumFarmUnstakeAction: AdapterAction<RaydiumFarmPrepareInput> = {
  id: 'farm_unstake',
  kind: 'raydium_farm_unstake',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    return prepareFarmAction('unstake', input, ctx);
  },
  async execute(action: PreparedAction, ctx): Promise<AdapterExecuteResult> {
    return executeFarmAction('unstake', action, ctx);
  },
};

export const raydiumHarvestAction: AdapterAction<Omit<RaydiumFarmPrepareInput, 'amount'>> = {
  id: 'harvest',
  kind: 'raydium_harvest',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    return prepareFarmAction('harvest', input, ctx);
  },
  async execute(action: PreparedAction, ctx): Promise<AdapterExecuteResult> {
    return executeFarmAction('harvest', action, ctx);
  },
};

async function prepareFarmAction(
  operation: 'stake' | 'unstake' | 'harvest',
  input: RaydiumFarmPrepareInput,
  ctx: Parameters<AdapterAction<RaydiumFarmPrepareInput>['prepare']>[1],
): Promise<AdapterPrepareResult> {
  const walletAddress = await ctx.backend.getAddress();
  const farmId = parsePublicKey(input.farmId, 'farmId');
  if (operation === 'harvest') {
    validateOptionalPositiveDecimalString(input.amount, 'amount');
  } else {
    validatePositiveDecimalString(input.amount ?? '', 'amount');
  }
  const farmInput: RaydiumFarmInput = {
    walletAddress,
    farmId,
    ...(input.amount !== undefined && { amount: input.amount }),
  };
  const preview = operation === 'stake'
    ? await getRaydiumClient().previewFarmStake(ctx.connection, farmInput)
    : operation === 'unstake'
      ? await getRaydiumClient().previewFarmUnstake(ctx.connection, farmInput)
      : await getRaydiumClient().previewHarvest(ctx.connection, farmInput);
  const params = {
    adapter: RAYDIUM_ADAPTER_ID,
    connectorId: RAYDIUM_ADAPTER_ID,
    action: operation === 'stake' ? 'farm_stake' : operation === 'unstake' ? 'farm_unstake' : 'harvest',
    operation: operation === 'stake' ? 'farm_stake' : operation === 'unstake' ? 'farm_unstake' : 'harvest',
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    refreshAtExecution: true,
    farmId,
    ...(input.amount !== undefined && { amount: input.amount }),
    lpMint: preview.lpMint,
    rewardMints: preview.rewardMints,
    tokenAmounts: preview.tokenAmounts,
    quote: preview.quote,
    programIds: RAYDIUM_PROGRAM_IDS,
    warnings: preview.warnings,
    preparedSnapshotAt: new Date().toISOString(),
  };
  const label = operation === 'stake'
    ? `Stake Raydium farm LP on ${shortAddress(farmId)}`
    : operation === 'unstake'
      ? `Unstake Raydium farm LP from ${shortAddress(farmId)}`
      : `Harvest Raydium farm rewards from ${shortAddress(farmId)}`;
  return {
    addInput: {
      kind: operation === 'stake'
        ? 'raydium_farm_stake'
        : operation === 'unstake'
          ? 'raydium_farm_unstake'
          : 'raydium_harvest',
      walletAddress,
      cluster: ctx.config.cluster,
      summary: label,
      params: stripUndefined(params),
      ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
      ...(input.note !== undefined && { note: input.note }),
    },
    preview: stripUndefined(params),
  };
}

async function executeFarmAction(
  operation: 'stake' | 'unstake' | 'harvest',
  action: PreparedAction,
  ctx: Parameters<AdapterAction<RaydiumFarmPrepareInput>['execute']>[1],
): Promise<AdapterExecuteResult> {
  const walletAddress = await ctx.backend.getAddress();
  if (walletAddress !== action.walletAddress) {
    throw new ProtocolError(
      'unauthorized',
      `Raydium ${operation} action belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
    );
  }
  const input: RaydiumFarmInput = {
    walletAddress,
    farmId: requireStringParam(action, 'farmId'),
    ...(optionalStringParam(action, 'amount') !== undefined && { amount: optionalStringParam(action, 'amount') }),
  };
  const built = operation === 'stake'
    ? await getRaydiumClient().buildFarmStakeTransaction(ctx.connection, input)
    : operation === 'unstake'
      ? await getRaydiumClient().buildFarmUnstakeTransaction(ctx.connection, input)
      : await getRaydiumClient().buildHarvestTransaction(ctx.connection, input);
  const txid = await ctx.signAndBroadcast(built.transactionBase64, action.summary);
  return {
    txid,
    signedAt: new Date().toISOString(),
    ...(built.preview ? { preview: built.preview as unknown as Record<string, unknown> } : {}),
  };
}
