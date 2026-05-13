import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';
import type { PreparedAction } from '../../preparedActions.js';
import type {
  AdapterAction,
  AdapterExecuteResult,
  AdapterPrepareResult,
  DAppAdapterContext,
} from '../types.js';
import { AdapterError } from '../types.js';
import { getMeteoraClient, type MeteoraClaimInput as ClientMeteoraClaimInput } from './client.js';
import { METEORA_ADAPTER_ID, METEORA_PROGRAM_IDS, shortAddress } from './constants.js';
import { getPositionDetail } from './positions.js';
import {
  optionalPublicKey,
  optionalStringParam,
  parsePublicKey,
  requireStringParam,
} from './validation.js';

export interface MeteoraClaimPrepareInput {
  poolAddress: string;
  positionAddress?: string;
  claimAll?: boolean;
  dueAt?: string;
  note?: string;
}

export const meteoraClaimFeesAction: AdapterAction<MeteoraClaimPrepareInput> = {
  id: 'claim_fees',
  kind: 'meteora_claim_fees',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    return prepareClaimAction('claim_fees', input, ctx);
  },

  async execute(action: PreparedAction, ctx): Promise<AdapterExecuteResult> {
    return executeClaimAction('claim_fees', action, ctx);
  },
};

export const meteoraClaimRewardsAction: AdapterAction<MeteoraClaimPrepareInput> = {
  id: 'claim_rewards',
  kind: 'meteora_claim_rewards',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    return prepareClaimAction('claim_rewards', input, ctx);
  },

  async execute(action: PreparedAction, ctx): Promise<AdapterExecuteResult> {
    return executeClaimAction('claim_rewards', action, ctx);
  },
};

async function prepareClaimAction(
  operation: 'claim_fees' | 'claim_rewards',
  input: MeteoraClaimPrepareInput,
  ctx: DAppAdapterContext,
): Promise<AdapterPrepareResult> {
  const walletAddress = await ctx.backend.getAddress();
  const poolAddress = parsePublicKey(input.poolAddress, 'poolAddress');
  const positionAddress = optionalPublicKey(input.positionAddress, 'positionAddress');
  const claimAll = input.claimAll === true;
  if (!claimAll && !positionAddress) {
    throw new AdapterError(METEORA_ADAPTER_ID, 'missing_position', 'positionAddress is required unless claimAll is true.');
  }
  if (positionAddress) {
    await getPositionDetail(ctx, { poolAddress, positionAddress });
  }
  const clientInput: ClientMeteoraClaimInput = {
    walletAddress,
    poolAddress,
    ...(positionAddress !== undefined && { positionAddress }),
    ...(claimAll ? { claimAll: true } : {}),
  };
  const preview = operation === 'claim_fees'
    ? await getMeteoraClient().previewClaimFees(ctx.connection, clientInput)
    : await getMeteoraClient().previewClaimRewards(ctx.connection, clientInput);
  const params = {
    adapter: METEORA_ADAPTER_ID,
    connectorId: METEORA_ADAPTER_ID,
    action: operation,
    operation,
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    refreshAtExecution: true,
    poolAddress,
    ...(positionAddress !== undefined && { positionAddress }),
    claimAll,
    claimTypes: operation === 'claim_fees' ? ['fees'] : ['rewards'],
    programIds: METEORA_PROGRAM_IDS,
    tokenMints: preview.tokenMints,
    tokenAmounts: preview.tokenAmounts,
    quote: preview.quote,
    warnings: preview.warnings,
    preparedSnapshotAt: new Date().toISOString(),
  };
  const label = operation === 'claim_fees' ? 'Claim Meteora fees' : 'Claim Meteora rewards';
  return {
    addInput: {
      kind: operation === 'claim_fees' ? 'meteora_claim_fees' : 'meteora_claim_rewards',
      walletAddress,
      cluster: ctx.config.cluster,
      summary: `${label}${positionAddress ? ` for ${shortAddress(positionAddress)}` : ''}`,
      params: stripUndefined(params),
      ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
      ...(input.note !== undefined && { note: input.note }),
    },
    preview: stripUndefined(params),
  };
}

async function executeClaimAction(
  operation: 'claim_fees' | 'claim_rewards',
  action: PreparedAction,
  ctx: DAppAdapterContext,
): Promise<AdapterExecuteResult> {
  const walletAddress = await ctx.backend.getAddress();
  if (walletAddress !== action.walletAddress) {
    throw new ProtocolError(
      'unauthorized',
      `Meteora ${operation.replace('_', '-')} action belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
    );
  }
  const input: ClientMeteoraClaimInput = {
    walletAddress,
    poolAddress: requireStringParam(action, 'poolAddress'),
    ...(optionalStringParam(action, 'positionAddress') !== undefined && { positionAddress: optionalStringParam(action, 'positionAddress') }),
    ...(action.params.claimAll === true && { claimAll: true }),
  };
  const built = operation === 'claim_fees'
    ? await getMeteoraClient().buildClaimFeesTransaction(ctx.connection, input)
    : await getMeteoraClient().buildClaimRewardsTransaction(ctx.connection, input);
  const label = operation === 'claim_fees' ? 'Claim Meteora fees' : 'Claim Meteora rewards';
  const suffix = input.positionAddress ? ` for ${shortAddress(input.positionAddress)}` : '';
  const txid = await ctx.signAndBroadcast(built.transactionBase64, `${label}${suffix}`);
  return {
    txid,
    signedAt: new Date().toISOString(),
    ...(built.preview ? { preview: built.preview as unknown as Record<string, unknown> } : {}),
  };
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
