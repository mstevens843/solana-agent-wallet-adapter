import { PublicKey, type Connection } from '@solana/web3.js';
import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { parseDecimalAmount } from '../../amounts.js';
import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';
import {
  DEFAULT_TOKEN_REGISTRY,
  JUPITER_TRIGGER_MIN_ORDER_USD,
  WSOL_MINT,
  getJupiterTriggerPolicy,
  type AgentWalletConfig,
  type ResolvedJupiterTriggerPolicy,
} from '../../config.js';
import type { PreparedAction } from '../../preparedActions.js';
import type {
  AdapterAction,
  AdapterExecuteResult,
  AdapterPrepareResult,
  DAppAdapterContext,
} from '../types.js';
import { AdapterError } from '../types.js';

import { jupiterFetchJson } from './client.js';
import { resolveTriggerFee } from './referral.js';
import { JUPITER_ADAPTER_ID } from './constants.js';
import { requireTriggerEnabled, requireValidJwt } from './triggerAuth.js';
import { JUPITER_TRIGGER_PRODUCT } from './triggerConstants.js';
import { prepareRegisterVault, readVault } from './triggerVault.js';
import { assertOrderCancellable, assertOrderWithdrawable, getOrder } from './triggerOrders.js';
import {
  triggerCancelWarnings,
  triggerEditWarnings,
  triggerOrderCreateWarnings,
  triggerRegisterVaultWarnings,
  triggerSummarySuffix,
  triggerWithdrawWarnings,
} from './triggerSafety.js';

export interface JupiterTriggerSingleOrderInput {
  inputMint: string;
  outputMint: string;
  /** Deprecated alias for amountRaw. */
  amount?: string;
  amountRaw?: string;
  triggerMint: string;
  triggerCondition: 'above' | 'below';
  triggerPriceUsd: number;
  slippageBps?: number;
  expiresAt: string;
  acceptHighSlippage?: boolean;
  maxDepositUsd?: number;
  dueAt?: string;
  note?: string;
}

export interface JupiterTriggerOcoOrderInput {
  inputMint: string;
  outputMint: string;
  /** Deprecated alias for amountRaw. */
  amount?: string;
  amountRaw?: string;
  triggerMint: string;
  takeProfitPriceUsd: number;
  stopLossPriceUsd: number;
  takeProfitSlippageBps?: number;
  stopLossSlippageBps?: number;
  expiresAt: string;
  side?: 'sell' | 'buy';
  acceptHighSlippage?: boolean;
  dueAt?: string;
  note?: string;
}

export interface JupiterTriggerOtocoOrderInput {
  inputMint: string;
  outputMint: string;
  /** Deprecated alias for amountRaw. */
  amount?: string;
  amountRaw?: string;
  triggerMint: string;
  entryCondition: 'above' | 'below';
  entryPriceUsd: number;
  takeProfitPriceUsd: number;
  stopLossPriceUsd: number;
  slippageBps?: number;
  takeProfitSlippageBps?: number;
  stopLossSlippageBps?: number;
  expiresAt: string;
  acceptHighSlippage?: boolean;
  dueAt?: string;
  note?: string;
}

export interface JupiterTriggerEditOrderInput {
  orderId: string;
  orderType?: 'single' | 'oco' | 'otoco';
  newTriggerPriceUsd?: number;
  newSlippageBps?: number;
  newExpiresAt?: string;
  acceptHighSlippage?: boolean;
  reason?: string;
  dueAt?: string;
  note?: string;
}

export interface JupiterTriggerCancelOrderInput {
  orderId: string;
  reason?: string;
  dueAt?: string;
  note?: string;
}

export interface JupiterTriggerWithdrawOrderFundsInput {
  orderId: string;
  destination?: string;
  reason?: string;
  dueAt?: string;
  note?: string;
}

export interface JupiterTriggerRegisterVaultInput {
  dueAt?: string;
  note?: string;
}

export const registerVaultAction: AdapterAction<JupiterTriggerRegisterVaultInput> = {
  id: 'register_vault',
  kind: 'jupiter_trigger_register_vault',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    requireTriggerEnabled(ctx.config);
    const walletAddress = await ctx.backend.getAddress();
    requireValidJwt(walletAddress, ctx.config);
    const built = await prepareRegisterVault(ctx.config, { walletAddress });
    const summary = `Register Jupiter Trigger vault for ${walletAddress}${triggerSummarySuffix({
      includeCustody: true,
    })}`;
    const params: Record<string, unknown> = baseTriggerParams({
      operation: 'register_vault',
      walletAddress,
      cluster: ctx.config.cluster,
    });
    if (built.transactionBase64) params.transactionBase64 = built.transactionBase64;
    params.vaultSnapshot = built.vaultSnapshot;
    params.warnings = triggerRegisterVaultWarnings();
    return preparedActionResult('jupiter_trigger_register_vault', walletAddress, ctx, summary, params, input);
  },
  async execute(action, ctx): Promise<AdapterExecuteResult> {
    requireTriggerEnabled(ctx.config);
    const walletAddress = await assertOwnership(action, ctx);
    requireValidJwt(walletAddress, ctx.config);
    const refreshed = await prepareRegisterVault(ctx.config, { walletAddress });
    let body = refreshed.raw;
    if (refreshed.transactionBase64) {
      const signed = await ctx.signTransaction(refreshed.transactionBase64, action.summary);
      body = await postSignedToTrigger(ctx, '/vault/register/submit', {
        walletAddress,
        signedTransaction: signed,
      });
    }
    return executeResult(body, { walletAddress });
  },
};

export const singleOrderAction: AdapterAction<JupiterTriggerSingleOrderInput> = {
  id: 'single_order',
  kind: 'jupiter_trigger_single_order',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    requireTriggerEnabled(ctx.config);
    const walletAddress = await ctx.backend.getAddress();
    requireValidJwt(walletAddress, ctx.config);
    const policy = getJupiterTriggerPolicy(ctx.config);
    validateSingleInput(input, policy);
    await assertVaultRegistered(ctx, walletAddress);
    const inputAmount = await triggerOrderAmountRaw(input, ctx);
    const orderParams = {
      orderType: 'single',
      userPubkey: walletAddress,
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      inputAmount,
      triggerMint: input.triggerMint,
      triggerCondition: input.triggerCondition,
      triggerPriceUsd: input.triggerPriceUsd,
      slippageBps: input.slippageBps,
      expiresAt: expiresAtMs(input.expiresAt),
    };
    const built = await craftDepositTransaction(ctx, 'single', orderParams, walletAddress);
    const summary = describeSingleOrder(input);
    const params: Record<string, unknown> = baseTriggerParams({
      operation: 'single_order',
      walletAddress,
      cluster: ctx.config.cluster,
    });
    Object.assign(params, {
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      triggerMint: input.triggerMint,
      amountRaw: inputAmount,
      orderType: 'single',
      triggerCondition: input.triggerCondition,
      triggerPriceUsd: input.triggerPriceUsd,
      slippageBps: input.slippageBps,
      expiresAt: input.expiresAt,
      orderParams,
      transactionBase64: built.transactionBase64,
      depositRequestId: built.requestId,
      vaultSnapshot: built.vaultSnapshot,
      automationWarningAccepted: true,
      custodyWarningAccepted: true,
      warnings: triggerOrderCreateWarnings(),
      refreshAtExecution: true,
    });
    return preparedActionResult('jupiter_trigger_single_order', walletAddress, ctx, summary, params, input);
  },
  async execute(action, ctx): Promise<AdapterExecuteResult> {
    requireTriggerEnabled(ctx.config);
    const walletAddress = await assertOwnership(action, ctx);
    requireValidJwt(walletAddress, ctx.config);
    const orderParams = requireRecordParam(action, 'orderParams');
    const refreshed = await craftDepositTransaction(ctx, 'single', orderParams, walletAddress);
    const signed = await ctx.signTransaction(refreshed.transactionBase64, action.summary);
    const body = await submitTriggerOrder(ctx, orderParams, walletAddress, refreshed.requestId, signed);
    return executeResult(body, {
      walletAddress,
      orderId: optionalString(body, 'id') ?? optionalString(body, 'orderId'),
    });
  },
};

export const ocoOrderAction: AdapterAction<JupiterTriggerOcoOrderInput> = {
  id: 'oco_order',
  kind: 'jupiter_trigger_oco_order',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    requireTriggerEnabled(ctx.config);
    const walletAddress = await ctx.backend.getAddress();
    requireValidJwt(walletAddress, ctx.config);
    const policy = getJupiterTriggerPolicy(ctx.config);
    validateOcoInput(input, policy);
    await assertVaultRegistered(ctx, walletAddress);
    const inputAmount = await triggerOrderAmountRaw(input, ctx);
    const orderParams = {
      orderType: 'oco',
      userPubkey: walletAddress,
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      inputAmount,
      triggerMint: input.triggerMint,
      tpPriceUsd: input.takeProfitPriceUsd,
      slPriceUsd: input.stopLossPriceUsd,
      tpSlippageBps: input.takeProfitSlippageBps,
      slSlippageBps: input.stopLossSlippageBps,
      expiresAt: expiresAtMs(input.expiresAt),
    };
    const built = await craftDepositTransaction(ctx, 'oco', orderParams, walletAddress);
    const summary = `OCO Jupiter Trigger order: TP ${input.takeProfitPriceUsd} USD / SL ${input.stopLossPriceUsd} USD${triggerSummarySuffix({
      includeCustody: true,
      includeAutomation: true,
      includeOutputNotGuaranteed: true,
    })}`;
    const params: Record<string, unknown> = baseTriggerParams({
      operation: 'oco_order',
      walletAddress,
      cluster: ctx.config.cluster,
    });
    Object.assign(params, {
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      triggerMint: input.triggerMint,
      amountRaw: inputAmount,
      orderType: 'oco',
      takeProfitPriceUsd: input.takeProfitPriceUsd,
      stopLossPriceUsd: input.stopLossPriceUsd,
      takeProfitSlippageBps: input.takeProfitSlippageBps,
      stopLossSlippageBps: input.stopLossSlippageBps,
      expiresAt: input.expiresAt,
      orderParams,
      transactionBase64: built.transactionBase64,
      depositRequestId: built.requestId,
      vaultSnapshot: built.vaultSnapshot,
      automationWarningAccepted: true,
      custodyWarningAccepted: true,
      warnings: triggerOrderCreateWarnings(),
      refreshAtExecution: true,
    });
    return preparedActionResult('jupiter_trigger_oco_order', walletAddress, ctx, summary, params, input);
  },
  async execute(action, ctx): Promise<AdapterExecuteResult> {
    requireTriggerEnabled(ctx.config);
    const walletAddress = await assertOwnership(action, ctx);
    requireValidJwt(walletAddress, ctx.config);
    const orderParams = requireRecordParam(action, 'orderParams');
    const refreshed = await craftDepositTransaction(ctx, 'oco', orderParams, walletAddress);
    const signed = await ctx.signTransaction(refreshed.transactionBase64, action.summary);
    const body = await submitTriggerOrder(ctx, orderParams, walletAddress, refreshed.requestId, signed);
    return executeResult(body, {
      walletAddress,
      orderId: optionalString(body, 'id') ?? optionalString(body, 'orderId'),
    });
  },
};

export const otocoOrderAction: AdapterAction<JupiterTriggerOtocoOrderInput> = {
  id: 'otoco_order',
  kind: 'jupiter_trigger_otoco_order',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    requireTriggerEnabled(ctx.config);
    const walletAddress = await ctx.backend.getAddress();
    requireValidJwt(walletAddress, ctx.config);
    const policy = getJupiterTriggerPolicy(ctx.config);
    validateOtocoInput(input, policy);
    await assertVaultRegistered(ctx, walletAddress);
    const inputAmount = await triggerOrderAmountRaw(input, ctx);
    const orderParams = {
      orderType: 'otoco',
      userPubkey: walletAddress,
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      inputAmount,
      triggerMint: input.triggerMint,
      triggerCondition: input.entryCondition,
      triggerPriceUsd: input.entryPriceUsd,
      slippageBps: input.slippageBps,
      tpPriceUsd: input.takeProfitPriceUsd,
      slPriceUsd: input.stopLossPriceUsd,
      tpSlippageBps: input.takeProfitSlippageBps,
      slSlippageBps: input.stopLossSlippageBps,
      expiresAt: expiresAtMs(input.expiresAt),
    };
    const built = await craftDepositTransaction(ctx, 'otoco', orderParams, walletAddress);
    const summary = `OTOCO Jupiter Trigger order: entry ${input.entryCondition} ${input.entryPriceUsd} USD then TP/SL${triggerSummarySuffix({
      includeCustody: true,
      includeAutomation: true,
      includeOutputNotGuaranteed: true,
    })}`;
    const params: Record<string, unknown> = baseTriggerParams({
      operation: 'otoco_order',
      walletAddress,
      cluster: ctx.config.cluster,
    });
    Object.assign(params, {
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      triggerMint: input.triggerMint,
      amountRaw: inputAmount,
      orderType: 'otoco',
      entryCondition: input.entryCondition,
      entryPriceUsd: input.entryPriceUsd,
      takeProfitPriceUsd: input.takeProfitPriceUsd,
      stopLossPriceUsd: input.stopLossPriceUsd,
      slippageBps: input.slippageBps,
      takeProfitSlippageBps: input.takeProfitSlippageBps,
      stopLossSlippageBps: input.stopLossSlippageBps,
      expiresAt: input.expiresAt,
      orderParams,
      transactionBase64: built.transactionBase64,
      depositRequestId: built.requestId,
      vaultSnapshot: built.vaultSnapshot,
      automationWarningAccepted: true,
      custodyWarningAccepted: true,
      warnings: triggerOrderCreateWarnings(),
      refreshAtExecution: true,
    });
    return preparedActionResult('jupiter_trigger_otoco_order', walletAddress, ctx, summary, params, input);
  },
  async execute(action, ctx): Promise<AdapterExecuteResult> {
    requireTriggerEnabled(ctx.config);
    const walletAddress = await assertOwnership(action, ctx);
    requireValidJwt(walletAddress, ctx.config);
    const orderParams = requireRecordParam(action, 'orderParams');
    const refreshed = await craftDepositTransaction(ctx, 'otoco', orderParams, walletAddress);
    const signed = await ctx.signTransaction(refreshed.transactionBase64, action.summary);
    const body = await submitTriggerOrder(ctx, orderParams, walletAddress, refreshed.requestId, signed);
    return executeResult(body, {
      walletAddress,
      orderId: optionalString(body, 'id') ?? optionalString(body, 'orderId'),
    });
  },
};

export const editOrderAction: AdapterAction<JupiterTriggerEditOrderInput> = {
  id: 'edit_order',
  kind: 'jupiter_trigger_edit_order',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    requireTriggerEnabled(ctx.config);
    const walletAddress = await ctx.backend.getAddress();
    requireValidJwt(walletAddress, ctx.config);
    if (!input.orderId?.trim()) {
      throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'Edit order requires orderId.');
    }
    const policy = getJupiterTriggerPolicy(ctx.config);
    const orderSnapshot = await getOrder(ctx.config, { walletAddress, orderId: input.orderId });
    validateEditInput(input, policy);
    const summary = `Edit Jupiter Trigger order ${input.orderId}${triggerSummarySuffix({
      includeAutomation: true,
      includeExpiredFundsVault: true,
    })}`;
    const params: Record<string, unknown> = baseTriggerParams({
      operation: 'edit_order',
      walletAddress,
      cluster: ctx.config.cluster,
    });
    Object.assign(params, {
      orderId: input.orderId,
      orderType: input.orderType ?? orderSnapshot.orderType ?? 'single',
      orderSnapshot,
      ...(input.newTriggerPriceUsd !== undefined && { newTriggerPriceUsd: input.newTriggerPriceUsd }),
      ...(input.newSlippageBps !== undefined && { newSlippageBps: input.newSlippageBps }),
      ...(input.newExpiresAt !== undefined && { newExpiresAt: input.newExpiresAt }),
      ...(input.reason !== undefined && { reason: input.reason }),
      automationWarningAccepted: true,
      warnings: triggerEditWarnings(),
      refreshAtExecution: true,
    });
    return preparedActionResult('jupiter_trigger_edit_order', walletAddress, ctx, summary, params, input);
  },
  async execute(action, ctx): Promise<AdapterExecuteResult> {
    requireTriggerEnabled(ctx.config);
    const walletAddress = await assertOwnership(action, ctx);
    const jwt = requireValidJwt(walletAddress, ctx.config);
    const orderId = requireStringParam(action, 'orderId');
    const editBody: Record<string, unknown> = {
      orderType: typeof action.params.orderType === 'string' ? action.params.orderType : 'single',
    };
    if (typeof action.params.newTriggerPriceUsd === 'number') editBody.triggerPriceUsd = action.params.newTriggerPriceUsd;
    if (typeof action.params.newSlippageBps === 'number') editBody.slippageBps = action.params.newSlippageBps;
    if (typeof action.params.newExpiresAt === 'string') editBody.expiresAt = action.params.newExpiresAt;
    const body = await jupiterFetchJson(ctx.config, 'trigger', `/orders/price/${encodeURIComponent(orderId)}`, {
      method: 'PATCH',
      body: editBody,
      bearerToken: jwt.jwt,
    });
    return executeResult(body, { walletAddress, orderId });
  },
};

export const cancelOrderAction: AdapterAction<JupiterTriggerCancelOrderInput> = {
  id: 'cancel_order',
  kind: 'jupiter_trigger_cancel_order',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    requireTriggerEnabled(ctx.config);
    const walletAddress = await ctx.backend.getAddress();
    requireValidJwt(walletAddress, ctx.config);
    if (!input.orderId?.trim()) {
      throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'Cancel order requires orderId.');
    }
    const orderSnapshot = await getOrder(ctx.config, { walletAddress, orderId: input.orderId });
    assertOrderCancellable(orderSnapshot);
    const summary = `Cancel Jupiter Trigger order ${input.orderId}${triggerSummarySuffix({
      includeCancelWithdrawSeparation: true,
      includeExpiredFundsVault: true,
    })}`;
    const params: Record<string, unknown> = baseTriggerParams({
      operation: 'cancel_order',
      walletAddress,
      cluster: ctx.config.cluster,
    });
    Object.assign(params, {
      orderId: input.orderId,
      orderSnapshot,
      ...(input.reason !== undefined && { reason: input.reason }),
      warnings: triggerCancelWarnings(),
      refreshAtExecution: true,
    });
    return preparedActionResult('jupiter_trigger_cancel_order', walletAddress, ctx, summary, params, input);
  },
  async execute(action, ctx): Promise<AdapterExecuteResult> {
    requireTriggerEnabled(ctx.config);
    const walletAddress = await assertOwnership(action, ctx);
    requireValidJwt(walletAddress, ctx.config);
    const orderId = requireStringParam(action, 'orderId');
    const body = await executeCancelFlow(ctx, walletAddress, orderId, action.summary);
    return executeResult(body, { walletAddress, orderId });
  },
};

export const withdrawOrderFundsAction: AdapterAction<JupiterTriggerWithdrawOrderFundsInput> = {
  id: 'withdraw_order_funds',
  kind: 'jupiter_trigger_withdraw_order_funds',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    requireTriggerEnabled(ctx.config);
    const walletAddress = await ctx.backend.getAddress();
    requireValidJwt(walletAddress, ctx.config);
    if (!input.orderId?.trim()) {
      throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'Withdraw order funds requires orderId.');
    }
    if (input.destination && input.destination !== walletAddress) {
      throw new AdapterError(
        JUPITER_ADAPTER_ID,
        'invalid_request',
        'Jupiter Trigger V2 withdraws cancelled/expired funds back to the authenticated wallet; custom destinations are not supported.',
      );
    }
    const orderSnapshot = await getOrder(ctx.config, { walletAddress, orderId: input.orderId });
    assertOrderWithdrawable(orderSnapshot);
    const summary = `Withdraw Jupiter Trigger order ${input.orderId} funds to ${input.destination ?? walletAddress}${triggerSummarySuffix(
      { includeCustody: true },
    )}`;
    const params: Record<string, unknown> = baseTriggerParams({
      operation: 'withdraw_order_funds',
      walletAddress,
      cluster: ctx.config.cluster,
    });
    Object.assign(params, {
      orderId: input.orderId,
      orderSnapshot,
      ...(input.destination !== undefined && { destination: input.destination }),
      warnings: triggerWithdrawWarnings(),
      refreshAtExecution: true,
    });
    return preparedActionResult('jupiter_trigger_withdraw_order_funds', walletAddress, ctx, summary, params, input);
  },
  async execute(action, ctx): Promise<AdapterExecuteResult> {
    requireTriggerEnabled(ctx.config);
    const walletAddress = await assertOwnership(action, ctx);
    requireValidJwt(walletAddress, ctx.config);
    const orderId = requireStringParam(action, 'orderId');
    const body = await executeCancelFlow(ctx, walletAddress, orderId, action.summary);
    return executeResult(body, { walletAddress, orderId });
  },
};

interface CraftedDepositTransaction {
  transactionBase64: string;
  requestId: string;
  vaultSnapshot?: Record<string, unknown>;
  raw: Record<string, unknown>;
}

async function craftDepositTransaction(
  ctx: DAppAdapterContext,
  orderSubType: 'single' | 'oco' | 'otoco',
  orderParams: Record<string, unknown>,
  walletAddress: string,
): Promise<CraftedDepositTransaction> {
  const jwt = requireValidJwt(walletAddress, ctx.config);
  const body = await jupiterFetchJson(ctx.config, 'trigger', '/deposit/craft', {
    method: 'POST',
    body: {
      inputMint: orderParams.inputMint,
      outputMint: orderParams.outputMint,
      userAddress: walletAddress,
      amount: orderParams.inputAmount,
      orderType: 'price',
      orderSubType,
    },
    bearerToken: jwt.jwt,
  });
  const transactionBase64 = optionalString(body, 'transaction') ?? optionalString(body, 'transactionBase64');
  if (!transactionBase64) {
    throw new ProtocolError(
      'wallet_unreachable',
      'Jupiter Trigger deposit craft did not return an unsigned transaction.',
    );
  }
  const requestId = optionalString(body, 'requestId') ?? optionalString(body, 'depositRequestId') ?? '';
  if (!requestId) {
    throw new ProtocolError(
      'wallet_unreachable',
      'Jupiter Trigger deposit craft did not return requestId.',
    );
  }
  const vaultSnapshot = (body.vault as Record<string, unknown> | undefined)
    ?? (body.vaultSnapshot as Record<string, unknown> | undefined)
    ?? undefined;
  return {
    transactionBase64,
    requestId,
    ...(vaultSnapshot !== undefined && { vaultSnapshot }),
    raw: body,
  };
}

async function submitTriggerOrder(
  ctx: DAppAdapterContext,
  orderParams: Record<string, unknown>,
  walletAddress: string,
  depositRequestId: string,
  signedTransaction: string,
): Promise<Record<string, unknown>> {
  // Integrator fee on the limit order (Swap+Trigger referral, 100% to the operator). Gated by env:
  // resolveTriggerFee returns null unless JUPITER_TRIGGER_FEE_BPS + a referral token account for the
  // OUTPUT mint are configured — so with no envs set this is a no-op and the request is unchanged.
  const outputMint = typeof orderParams.outputMint === 'string' ? orderParams.outputMint : '';
  const triggerFee = outputMint ? resolveTriggerFee(outputMint) : null;
  return postSignedToTrigger(ctx, '/orders/price', {
    ...orderParams,
    walletAddress,
    depositRequestId,
    depositSignedTx: signedTransaction,
    ...(triggerFee ? { feeBps: triggerFee.feeBps, feeAccount: triggerFee.feeAccount } : {}),
  });
}

async function executeCancelFlow(
  ctx: DAppAdapterContext,
  walletAddress: string,
  orderId: string,
  summary: string,
): Promise<Record<string, unknown>> {
  const cancelData = await postSignedToTrigger(ctx, `/orders/price/cancel/${encodeURIComponent(orderId)}`, {
    walletAddress,
  });
  const transactionBase64 = optionalString(cancelData, 'transaction') ?? optionalString(cancelData, 'transactionBase64');
  if (!transactionBase64) {
    throw new ProtocolError('wallet_unreachable', 'Jupiter Trigger cancel response missing withdrawal transaction.');
  }
  const cancelRequestId = optionalString(cancelData, 'requestId') ?? optionalString(cancelData, 'cancelRequestId');
  if (!cancelRequestId) {
    throw new ProtocolError('wallet_unreachable', 'Jupiter Trigger cancel response missing requestId.');
  }
  const signedTransaction = await ctx.signTransaction(transactionBase64, summary);
  return postSignedToTrigger(ctx, `/orders/price/confirm-cancel/${encodeURIComponent(orderId)}`, {
    walletAddress,
    signedTransaction,
    cancelRequestId,
  });
}

async function postSignedToTrigger(
  ctx: DAppAdapterContext,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const walletAddress = body.walletAddress as string;
  const jwt = requireValidJwt(walletAddress, ctx.config);
  const { walletAddress: _walletAddress, ...requestBody } = body;
  void _walletAddress;
  return jupiterFetchJson(ctx.config, 'trigger', path, {
    method: 'POST',
    ...(Object.keys(requestBody).length > 0 ? { body: requestBody } : {}),
    bearerToken: jwt.jwt,
  });
}

async function assertVaultRegistered(ctx: DAppAdapterContext, walletAddress: string): Promise<void> {
  const vault = await readVault(ctx.config, { walletAddress });
  if (!vault.registered) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'invalid_request',
      'Jupiter Trigger vault is not registered. Prepare and approve solana_prepare_jupiter_trigger_register_vault first.',
    );
  }
}

function baseTriggerParams(input: {
  operation: string;
  walletAddress: string;
  cluster: string;
}): Record<string, unknown> {
  return {
    adapter: JUPITER_ADAPTER_ID,
    connectorId: JUPITER_ADAPTER_ID,
    product: JUPITER_TRIGGER_PRODUCT,
    operation: input.operation,
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    walletAddress: input.walletAddress,
    cluster: input.cluster,
    preparedSnapshotAt: new Date().toISOString(),
  };
}

function describeSingleOrder(input: JupiterTriggerSingleOrderInput): string {
  const direction = input.triggerCondition === 'above' ? '>' : '<';
  return `Trigger ${input.amount ?? input.amountRaw ?? 'unknown'} ${shortMint(input.inputMint)} -> ${shortMint(input.outputMint)} when ${shortMint(
    input.triggerMint,
  )} ${direction} ${input.triggerPriceUsd} USD${triggerSummarySuffix({
    includeCustody: true,
    includeAutomation: true,
    includeOutputNotGuaranteed: true,
  })}`;
}

function shortMint(mint: string): string {
  if (mint.length <= 8) return mint;
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

function validateSingleInput(input: JupiterTriggerSingleOrderInput, policy: ResolvedJupiterTriggerPolicy): void {
  if (!input.inputMint || !input.outputMint || !input.triggerMint) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'Single order requires inputMint, outputMint, triggerMint.');
  }
  if (!hasOrderAmount(input)) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'Single order requires amount or amountRaw.');
  }
  if (!Number.isFinite(input.triggerPriceUsd) || input.triggerPriceUsd <= 0) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'Single order requires positive triggerPriceUsd.');
  }
  enforceMinOrderUsd(input.triggerPriceUsd, humanAmountForMinOrder(input));
  enforceExpiration(input.expiresAt, policy);
  enforceSlippage(input.slippageBps, policy.maxSlippageBps, policy.highSlippageWarnBps, input.acceptHighSlippage);
}

function validateOcoInput(input: JupiterTriggerOcoOrderInput, policy: ResolvedJupiterTriggerPolicy): void {
  if (!input.inputMint || !input.outputMint || !input.triggerMint) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'OCO order requires inputMint, outputMint, triggerMint.');
  }
  if (!hasOrderAmount(input)) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'OCO order requires amount or amountRaw.');
  }
  if (!Number.isFinite(input.takeProfitPriceUsd) || !Number.isFinite(input.stopLossPriceUsd)) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'OCO order requires takeProfitPriceUsd and stopLossPriceUsd.');
  }
  const side = input.side ?? 'sell';
  if (side === 'sell' && input.takeProfitPriceUsd <= input.stopLossPriceUsd) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'invalid_request',
      'OCO sell order requires takeProfitPriceUsd > stopLossPriceUsd.',
    );
  }
  if (side === 'buy' && input.takeProfitPriceUsd >= input.stopLossPriceUsd) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'invalid_request',
      'OCO buy order requires takeProfitPriceUsd < stopLossPriceUsd.',
    );
  }
  enforceMinOrderUsd(input.takeProfitPriceUsd, humanAmountForMinOrder(input));
  enforceExpiration(input.expiresAt, policy);
  enforceSlippage(input.takeProfitSlippageBps, policy.maxSlippageBps, policy.highSlippageWarnBps, input.acceptHighSlippage);
  enforceStopLossSlippage(input.stopLossSlippageBps, policy, input.acceptHighSlippage);
}

function validateOtocoInput(input: JupiterTriggerOtocoOrderInput, policy: ResolvedJupiterTriggerPolicy): void {
  if (!input.inputMint || !input.outputMint || !input.triggerMint) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'OTOCO order requires inputMint, outputMint, triggerMint.');
  }
  if (!hasOrderAmount(input)) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'OTOCO order requires amount or amountRaw.');
  }
  if (!Number.isFinite(input.entryPriceUsd) || !Number.isFinite(input.takeProfitPriceUsd) || !Number.isFinite(input.stopLossPriceUsd)) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'invalid_request',
      'OTOCO order requires entryPriceUsd, takeProfitPriceUsd, stopLossPriceUsd.',
    );
  }
  if (input.takeProfitPriceUsd <= input.stopLossPriceUsd) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'invalid_request',
      'OTOCO order requires takeProfitPriceUsd > stopLossPriceUsd.',
    );
  }
  enforceMinOrderUsd(input.entryPriceUsd, humanAmountForMinOrder(input));
  enforceExpiration(input.expiresAt, policy);
  enforceSlippage(input.slippageBps, policy.maxSlippageBps, policy.highSlippageWarnBps, input.acceptHighSlippage);
  enforceStopLossSlippage(input.stopLossSlippageBps, policy, input.acceptHighSlippage);
}

function validateEditInput(input: JupiterTriggerEditOrderInput, policy: ResolvedJupiterTriggerPolicy): void {
  if (input.newTriggerPriceUsd !== undefined && input.newTriggerPriceUsd <= 0) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'Edit order newTriggerPriceUsd must be positive.');
  }
  if (input.newExpiresAt) enforceExpiration(input.newExpiresAt, policy);
  enforceSlippage(input.newSlippageBps, policy.maxSlippageBps, policy.highSlippageWarnBps, input.acceptHighSlippage);
}

function enforceMinOrderUsd(priceUsd: number, amount: string | undefined): void {
  if (amount === undefined) return;
  const amountNumber = Number(amount);
  if (Number.isFinite(amountNumber) && amountNumber > 0 && priceUsd > 0) {
    const usdValue = amountNumber * priceUsd;
    if (usdValue < JUPITER_TRIGGER_MIN_ORDER_USD) {
      throw new AdapterError(
        JUPITER_ADAPTER_ID,
        'invalid_request',
        `Order value ${usdValue.toFixed(2)} USD is below Jupiter Trigger minimum of ${JUPITER_TRIGGER_MIN_ORDER_USD} USD.`,
      );
    }
  }
}

function hasOrderAmount(input: { amount?: string; amountRaw?: string }): boolean {
  return Boolean(input.amountRaw?.trim() || input.amount?.trim());
}

async function triggerOrderAmountRaw(
  input: { inputMint: string; amount?: string; amountRaw?: string },
  ctx: DAppAdapterContext,
): Promise<string> {
  if (input.amountRaw?.trim()) {
    if (!/^\d+$/.test(input.amountRaw.trim())) {
      throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'amountRaw must be an integer string.');
    }
    return input.amountRaw.trim();
  }
  if (!input.amount?.trim()) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'amount is required.');
  }
  const decimals = await resolveMintDecimals(ctx.config, ctx.connection, input.inputMint);
  return parseDecimalAmount(input.amount, decimals, 'Jupiter Trigger amount').toString();
}

function humanAmountForMinOrder(input: { amount?: string; amountRaw?: string }): string | undefined {
  return input.amount;
}

async function resolveMintDecimals(
  config: AgentWalletConfig,
  connection: Connection,
  mintText: string,
): Promise<number> {
  if (mintText === WSOL_MINT) return 9;
  const known = [...config.tokens, ...DEFAULT_TOKEN_REGISTRY].find(
    (entry) => entry.mint === mintText || entry.symbol.toLowerCase() === mintText.toLowerCase(),
  );
  if (known) return known.decimals;
  let mint: PublicKey;
  try {
    mint = new PublicKey(mintText);
  } catch {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', `Invalid token mint ${mintText}.`);
  }
  const account = await connection.getParsedAccountInfo(mint, 'confirmed').catch(() => null);
  const parsedData = account?.value?.data;
  const parsed = parsedData && typeof parsedData === 'object' && 'parsed' in parsedData
    ? parsedData.parsed as { info?: { decimals?: unknown } }
    : undefined;
  if (typeof parsed?.info?.decimals === 'number' && Number.isInteger(parsed.info.decimals) && parsed.info.decimals >= 0) {
    return parsed.info.decimals;
  }
  throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', `Could not read decimals for token mint ${mintText}.`);
}

function expiresAtMs(expiresAt: string): number {
  const ts = Date.parse(expiresAt);
  if (!Number.isFinite(ts)) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'expiresAt is not a valid ISO timestamp.');
  }
  return ts;
}

function enforceExpiration(expiresAt: string | undefined, policy: ResolvedJupiterTriggerPolicy): void {
  if (!expiresAt) return;
  const ts = Date.parse(expiresAt);
  if (!Number.isFinite(ts)) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', `expiresAt is not a valid ISO timestamp.`);
  }
  const days = (ts - Date.now()) / (24 * 60 * 60 * 1000);
  if (days < 0) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'expiresAt must be in the future.');
  }
  if (days > policy.maxOrderLifetimeDays) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'invalid_request',
      `expiresAt exceeds configured maxOrderLifetimeDays (${policy.maxOrderLifetimeDays} days).`,
    );
  }
}

function enforceSlippage(
  slippageBps: number | undefined,
  cap: number | undefined,
  warn: number,
  acceptHigh: boolean | undefined,
): void {
  if (slippageBps === undefined) return;
  if (cap !== undefined && slippageBps > cap) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'invalid_request',
      `slippageBps ${slippageBps} exceeds configured cap ${cap}.`,
    );
  }
  if (slippageBps > warn && !acceptHigh) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'invalid_request',
      `slippageBps ${slippageBps} exceeds high-slippage warn threshold ${warn}. Set acceptHighSlippage=true to override.`,
    );
  }
}

function enforceStopLossSlippage(
  stopLossSlippageBps: number | undefined,
  policy: ResolvedJupiterTriggerPolicy,
  acceptHigh: boolean | undefined,
): void {
  if (stopLossSlippageBps === undefined) return;
  if (policy.maxStopLossSlippageBps !== undefined && stopLossSlippageBps > policy.maxStopLossSlippageBps && !acceptHigh) {
    throw new AdapterError(
      JUPITER_ADAPTER_ID,
      'invalid_request',
      `stopLossSlippageBps ${stopLossSlippageBps} exceeds configured cap ${policy.maxStopLossSlippageBps}. Set acceptHighSlippage=true to override.`,
    );
  }
}

async function assertOwnership(action: PreparedAction, ctx: DAppAdapterContext): Promise<string> {
  const walletAddress = await ctx.backend.getAddress();
  if (walletAddress !== action.walletAddress) {
    throw new ProtocolError(
      'unauthorized',
      `Jupiter Trigger action belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
    );
  }
  return walletAddress;
}

function executeResult(
  body: Record<string, unknown>,
  preview: Record<string, unknown>,
): AdapterExecuteResult {
  const txid =
    optionalString(body, 'txSignature') ??
    optionalString(body, 'depositTxid') ??
    optionalString(body, 'txid') ??
    optionalString(body, 'signature');
  return {
    ...(txid !== undefined && { txid }),
    signedAt: new Date().toISOString(),
    preview: { ...preview, raw: body },
  };
}

function preparedActionResult(
  kind: PreparedAction['kind'],
  walletAddress: string,
  ctx: DAppAdapterContext,
  summary: string,
  params: Record<string, unknown>,
  input: { dueAt?: string; note?: string },
): AdapterPrepareResult {
  return {
    addInput: {
      kind,
      walletAddress,
      cluster: ctx.config.cluster,
      summary,
      params,
      ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
      ...(input.note !== undefined && { note: input.note }),
    },
    preview: params,
  };
}

function requireRecordParam(action: PreparedAction, key: string): Record<string, unknown> {
  const value = action.params[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('invalid_request', `Jupiter Trigger action is missing ${key} record.`);
  }
  return value as Record<string, unknown>;
}

function requireStringParam(action: PreparedAction, key: string): string {
  const value = action.params[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProtocolError('invalid_request', `Jupiter Trigger action is missing ${key}.`);
  }
  return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
