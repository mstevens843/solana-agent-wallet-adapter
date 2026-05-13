import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';
import type { PreparedAction } from '../../preparedActions.js';
import type {
  AdapterAction,
  AdapterExecuteResult,
  AdapterPrepareResult,
} from '../types.js';
import { getOrcaClient, type OrcaCollectInput } from './client.js';
import { ORCA_ADAPTER_ID, ORCA_PROGRAM_IDS, shortAddress } from './constants.js';
import { getPositionDetail } from './positions.js';
import { getWhirlpoolSnapshot } from './whirlpools.js';
import {
  ensurePositionMatchesWhirlpool,
  optionalPublicKey,
  optionalStringParam,
  parsePublicKey,
  requireStringParam,
} from './validation.js';

export interface OrcaCollectPrepareInput {
  positionMint: string;
  whirlpoolAddress?: string;
  dueAt?: string;
  note?: string;
}

export const orcaCollectFeesAction: AdapterAction<OrcaCollectPrepareInput> = {
  id: 'collect_fees',
  kind: 'orca_collect_fees',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    return prepareCollectAction('collect_fees', input, ctx);
  },

  async execute(action: PreparedAction, ctx): Promise<AdapterExecuteResult> {
    return executeCollectAction('collect_fees', action, ctx);
  },
};

export const orcaCollectRewardsAction: AdapterAction<OrcaCollectPrepareInput> = {
  id: 'collect_rewards',
  kind: 'orca_collect_rewards',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    return prepareCollectAction('collect_rewards', input, ctx);
  },

  async execute(action: PreparedAction, ctx): Promise<AdapterExecuteResult> {
    return executeCollectAction('collect_rewards', action, ctx);
  },
};

async function prepareCollectAction(
  operation: 'collect_fees' | 'collect_rewards',
  input: OrcaCollectPrepareInput,
  ctx: Parameters<AdapterAction<OrcaCollectPrepareInput>['prepare']>[1],
): Promise<AdapterPrepareResult> {
  const walletAddress = await ctx.backend.getAddress();
  const positionMint = parsePublicKey(input.positionMint, 'positionMint');
  const whirlpoolAddress = optionalPublicKey(input.whirlpoolAddress, 'whirlpoolAddress');
  const position = await getPositionDetail(ctx, { positionMint, ...(whirlpoolAddress !== undefined && { whirlpoolAddress }) });
  const resolvedWhirlpoolAddress = whirlpoolAddress ?? position.whirlpoolAddress;
  await getWhirlpoolSnapshot(ctx, resolvedWhirlpoolAddress);
  const collectInput: OrcaCollectInput = {
    walletAddress,
    positionMint,
    whirlpoolAddress: resolvedWhirlpoolAddress,
  };
  const preview = operation === 'collect_fees'
    ? await getOrcaClient().previewCollectFees(ctx.connection, collectInput)
    : await getOrcaClient().previewCollectRewards(ctx.connection, collectInput);
  const warnings = operation === 'collect_rewards'
    ? uniqueStrings([...(preview.warnings ?? []), ...unknownRewardWarnings(position)])
    : uniqueStrings(preview.warnings ?? []);
  const params = {
    adapter: ORCA_ADAPTER_ID,
    connectorId: ORCA_ADAPTER_ID,
    action: operation,
    operation,
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    refreshAtExecution: true,
    positionMint,
    whirlpoolAddress: collectInput.whirlpoolAddress,
    lowerTick: position.tickLowerIndex,
    upperTick: position.tickUpperIndex,
    tickRange: { lowerTick: position.tickLowerIndex, upperTick: position.tickUpperIndex },
    programIds: ORCA_PROGRAM_IDS,
    tokenMints: preview.tokenMints,
    tokenAmounts: preview.tokenAmounts,
    quote: preview.quote,
    warnings,
    preparedSnapshotAt: new Date().toISOString(),
  };
  const label = operation === 'collect_fees' ? 'Collect Orca fees' : 'Collect Orca rewards';
  return {
    addInput: {
      kind: operation === 'collect_fees' ? 'orca_collect_fees' : 'orca_collect_rewards',
      walletAddress,
      cluster: ctx.config.cluster,
      summary: `${label} for ${shortAddress(positionMint)}`,
      params: stripUndefined(params),
      ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
      ...(input.note !== undefined && { note: input.note }),
    },
    preview: stripUndefined(params),
  };
}

async function executeCollectAction(
  operation: 'collect_fees' | 'collect_rewards',
  action: PreparedAction,
  ctx: Parameters<AdapterAction<OrcaCollectPrepareInput>['execute']>[1],
): Promise<AdapterExecuteResult> {
  const walletAddress = await ctx.backend.getAddress();
  if (walletAddress !== action.walletAddress) {
    throw new ProtocolError(
      'unauthorized',
      `Orca ${operation.replace('_', '-')} action belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
    );
  }
  const input: OrcaCollectInput = {
    walletAddress,
    positionMint: parsePublicKey(requireStringParam(action, 'positionMint'), 'positionMint'),
  };
  const storedWhirlpoolAddress = optionalPublicKey(optionalStringParam(action, 'whirlpoolAddress'), 'whirlpoolAddress');
  const position = await getPositionDetail(ctx, {
    positionMint: input.positionMint,
    ...(storedWhirlpoolAddress !== undefined && { whirlpoolAddress: storedWhirlpoolAddress }),
  });
  const whirlpoolAddress = storedWhirlpoolAddress ?? position.whirlpoolAddress;
  ensurePositionMatchesWhirlpool(position, whirlpoolAddress);
  await getWhirlpoolSnapshot(ctx, whirlpoolAddress);
  input.whirlpoolAddress = whirlpoolAddress;
  const built = operation === 'collect_fees'
    ? await getOrcaClient().buildCollectFeesTransaction(ctx.connection, input)
    : await getOrcaClient().buildCollectRewardsTransaction(ctx.connection, input);
  const label = operation === 'collect_fees' ? 'Collect Orca fees' : 'Collect Orca rewards';
  const txid = await ctx.signAndBroadcast(built.transactionBase64, `${label} for ${shortAddress(input.positionMint)}`);
  return {
    txid,
    signedAt: new Date().toISOString(),
    ...(built.preview ? { preview: built.preview as unknown as Record<string, unknown> } : {}),
  };
}

function unknownRewardWarnings(position: { rewardsOwed?: Array<{ mint: string; familiar?: boolean }> }): string[] {
  return (position.rewardsOwed ?? [])
    .filter((reward) => reward.familiar === false)
    .map((reward) => `Reward mint ${reward.mint} is not in the familiar token list.`);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
