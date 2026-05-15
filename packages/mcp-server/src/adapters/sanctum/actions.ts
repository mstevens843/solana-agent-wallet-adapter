import { PublicKey } from '@solana/web3.js';

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
import {
  resolveSanctumClient,
  type SanctumLstSnapshot,
  type SanctumTokenOrder,
} from './client.js';
import {
  SANCTUM_ADAPTER_ID,
  SANCTUM_DEFAULT_MAX_FEE_BPS,
  SANCTUM_DEFAULT_SLIPPAGE_BPS,
  SANCTUM_INF_MINT,
  SANCTUM_INFINITY_SWAP_SOURCES,
  SANCTUM_PROGRAM_IDS,
  SANCTUM_ROUTER_SWAP_SOURCES,
  WSOL_MINT,
  shortAddress,
  type SanctumSwapSource,
} from './constants.js';

export interface SanctumSwapLstInput {
  inputMint: string;
  outputMint: string;
  amount: string;
  minOutputAmount?: string;
  maxFeeBps?: number;
  slippageBps?: number;
  dueAt?: string;
  note?: string;
}

export interface SanctumAddInfinityLiquidityInput {
  inputMint: string;
  amount: string;
  minInfAmount?: string;
  maxFeeBps?: number;
  slippageBps?: number;
  dueAt?: string;
  note?: string;
}

export interface SanctumRemoveInfinityLiquidityInput {
  infAmount: string;
  outputMint: string;
  minOutputAmount?: string;
  maxFeeBps?: number;
  slippageBps?: number;
  dueAt?: string;
  note?: string;
}

export interface SanctumStakeSolToLstInput {
  lstMint: string;
  solAmount: string;
  minLstAmount?: string;
  maxFeeBps?: number;
  slippageBps?: number;
  dueAt?: string;
  note?: string;
}

export interface SanctumUnstakeLstToSolInput {
  lstMint: string;
  lstAmount: string;
  minSolAmount?: string;
  maxFeeBps?: number;
  slippageBps?: number;
  allowDelayedUnstake?: boolean;
  dueAt?: string;
  note?: string;
}

export const sanctumSwapLstAction: AdapterAction<SanctumSwapLstInput> = {
  id: 'swap_lst',
  kind: 'sanctum_swap_lst',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    return prepareSanctumOrder({
      operation: 'swap_lst',
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      amount: input.amount,
      minOutputAmount: input.minOutputAmount,
      maxFeeBps: input.maxFeeBps,
      slippageBps: input.slippageBps,
      swapSources: SANCTUM_ROUTER_SWAP_SOURCES,
      dueAt: input.dueAt,
      note: input.note,
    }, ctx);
  },
  async execute(action, ctx): Promise<AdapterExecuteResult> {
    return executeSanctumOrder(action, ctx);
  },
};

export const sanctumAddInfinityLiquidityAction: AdapterAction<SanctumAddInfinityLiquidityInput> = {
  id: 'add_infinity_liquidity',
  kind: 'sanctum_add_infinity_liquidity',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    return prepareSanctumOrder({
      operation: 'add_infinity_liquidity',
      inputMint: input.inputMint,
      outputMint: SANCTUM_INF_MINT,
      amount: input.amount,
      minOutputAmount: input.minInfAmount,
      maxFeeBps: input.maxFeeBps,
      slippageBps: input.slippageBps,
      swapSources: SANCTUM_INFINITY_SWAP_SOURCES,
      dueAt: input.dueAt,
      note: input.note,
    }, ctx);
  },
  async execute(action, ctx): Promise<AdapterExecuteResult> {
    return executeSanctumOrder(action, ctx);
  },
};

export const sanctumRemoveInfinityLiquidityAction: AdapterAction<SanctumRemoveInfinityLiquidityInput> = {
  id: 'remove_infinity_liquidity',
  kind: 'sanctum_remove_infinity_liquidity',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    return prepareSanctumOrder({
      operation: 'remove_infinity_liquidity',
      inputMint: SANCTUM_INF_MINT,
      outputMint: input.outputMint,
      amount: input.infAmount,
      minOutputAmount: input.minOutputAmount,
      maxFeeBps: input.maxFeeBps,
      slippageBps: input.slippageBps,
      swapSources: SANCTUM_INFINITY_SWAP_SOURCES,
      dueAt: input.dueAt,
      note: input.note,
    }, ctx);
  },
  async execute(action, ctx): Promise<AdapterExecuteResult> {
    return executeSanctumOrder(action, ctx);
  },
};

export const sanctumStakeSolToLstAction: AdapterAction<SanctumStakeSolToLstInput> = {
  id: 'stake_sol_to_lst',
  kind: 'sanctum_stake_sol_to_lst',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    return prepareSanctumOrder({
      operation: 'stake_sol_to_lst',
      inputMint: WSOL_MINT,
      outputMint: input.lstMint,
      amount: input.solAmount,
      minOutputAmount: input.minLstAmount,
      maxFeeBps: input.maxFeeBps,
      slippageBps: input.slippageBps,
      swapSources: SANCTUM_ROUTER_SWAP_SOURCES,
      dueAt: input.dueAt,
      note: input.note,
    }, ctx);
  },
  async execute(action, ctx): Promise<AdapterExecuteResult> {
    return executeSanctumOrder(action, ctx);
  },
};

export const sanctumUnstakeLstToSolAction: AdapterAction<SanctumUnstakeLstToSolInput> = {
  id: 'unstake_lst_to_sol',
  kind: 'sanctum_unstake_lst_to_sol',
  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    return prepareSanctumOrder({
      operation: 'unstake_lst_to_sol',
      inputMint: input.lstMint,
      outputMint: WSOL_MINT,
      amount: input.lstAmount,
      minOutputAmount: input.minSolAmount,
      maxFeeBps: input.maxFeeBps,
      slippageBps: input.slippageBps,
      swapSources: SANCTUM_ROUTER_SWAP_SOURCES,
      allowDelayedUnstake: input.allowDelayedUnstake === true,
      dueAt: input.dueAt,
      note: input.note,
    }, ctx);
  },
  async execute(action, ctx): Promise<AdapterExecuteResult> {
    return executeSanctumOrder(action, ctx);
  },
};

type SanctumOperation =
  | 'swap_lst'
  | 'add_infinity_liquidity'
  | 'remove_infinity_liquidity'
  | 'stake_sol_to_lst'
  | 'unstake_lst_to_sol';

interface PrepareOrderSpec {
  operation: SanctumOperation;
  inputMint: string;
  outputMint: string;
  amount: string;
  minOutputAmount?: string;
  maxFeeBps?: number;
  slippageBps?: number;
  swapSources: SanctumSwapSource[];
  allowDelayedUnstake?: boolean;
  dueAt?: string;
  note?: string;
}

async function prepareSanctumOrder(
  spec: PrepareOrderSpec,
  ctx: DAppAdapterContext,
): Promise<AdapterPrepareResult> {
  const walletAddress = await ctx.backend.getAddress();
  const inputMint = normalizeMint(spec.inputMint, 'inputMint');
  const outputMint = normalizeMint(spec.outputMint, 'outputMint');
  const inputMeta = await resolveTokenMeta(inputMint, ctx);
  const outputMeta = await resolveTokenMeta(outputMint, ctx);
  const amountRaw = parseDecimalAmount(spec.amount, inputMeta.decimals, `${inputMeta.symbol} Sanctum input amount`);
  const minOutputAmountRaw = spec.minOutputAmount
    ? parseDecimalAmount(spec.minOutputAmount, outputMeta.decimals, `${outputMeta.symbol} minimum output amount`)
    : undefined;
  const slippageBps = resolveSlippageBps(spec.slippageBps, ctx.config.mainnet.maxSlippageBps);
  const maxFeeBps = resolveMaxFeeBps(spec.maxFeeBps);
  const quote = await resolveSanctumClient(ctx).getTokenOrder({
    inputMint,
    outputMint,
    amountRaw: amountRaw.toString(),
    signer: walletAddress,
    slippageBps,
    swapSources: spec.swapSources,
  });
  validateQuote(quote, {
    operation: spec.operation,
    minOutputAmountRaw,
    maxFeeBps,
    allowDelayedUnstake: spec.allowDelayedUnstake === true,
    allowedSources: spec.swapSources,
  });
  const summary = summaryForOperation(spec.operation, spec.amount, inputMeta.symbol, outputMeta.symbol);
  const params = stripUndefined({
    adapter: SANCTUM_ADAPTER_ID,
    connectorId: SANCTUM_ADAPTER_ID,
    action: spec.operation,
    operation: spec.operation,
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    walletAddress,
    inputMint,
    outputMint,
    inputSymbol: inputMeta.symbol,
    outputSymbol: outputMeta.symbol,
    inputDecimals: inputMeta.decimals,
    outputDecimals: outputMeta.decimals,
    inputAmount: spec.amount,
    inputAmountRaw: amountRaw.toString(),
    minOutputAmount: spec.minOutputAmount,
    ...(minOutputAmountRaw !== undefined && { minOutputAmountRaw: minOutputAmountRaw.toString() }),
    maxFeeBps,
    slippageBps,
    allowDelayedUnstake: spec.allowDelayedUnstake === true,
    quoteSnapshot: quoteForStorage(quote),
    routeSources: quote.routeSources,
    requestedSources: spec.swapSources,
    programIds: programIdsForQuote(quote),
    warnings: quote.warnings,
    refreshAtExecution: true,
    preparedSnapshotAt: new Date().toISOString(),
  });
  return {
    addInput: {
      kind: kindForOperation(spec.operation),
      walletAddress,
      cluster: ctx.config.cluster,
      summary,
      params,
      ...(spec.dueAt !== undefined && { dueAt: spec.dueAt }),
      ...(spec.note !== undefined && { note: spec.note }),
    },
    preview: params,
  };
}

async function executeSanctumOrder(
  action: PreparedAction,
  ctx: DAppAdapterContext,
): Promise<AdapterExecuteResult> {
  const walletAddress = await ctx.backend.getAddress();
  if (walletAddress !== action.walletAddress) {
    throw new ProtocolError(
      'unauthorized',
      `Sanctum action belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
    );
  }
  const operation = requireOperation(action);
  const inputMint = requireStringParam(action, 'inputMint');
  const outputMint = requireStringParam(action, 'outputMint');
  const inputAmountRaw = requireStringParam(action, 'inputAmountRaw');
  const minOutputAmountRawText = optionalStringParam(action, 'minOutputAmountRaw');
  const minOutputAmountRaw = minOutputAmountRawText
    ? parsePreparedRawAmount(action, 'minOutputAmountRaw', minOutputAmountRawText)
    : undefined;
  const maxFeeBps = optionalNumberParam(action, 'maxFeeBps') ?? SANCTUM_DEFAULT_MAX_FEE_BPS;
  const slippageBps = optionalNumberParam(action, 'slippageBps') ?? SANCTUM_DEFAULT_SLIPPAGE_BPS;
  const allowDelayedUnstake = action.params.allowDelayedUnstake === true;
  const requestedSources = requestedSourcesFromAction(action, operation);
  const fresh = await resolveSanctumClient(ctx).getTokenOrder({
    inputMint,
    outputMint,
    amountRaw: inputAmountRaw,
    signer: walletAddress,
    slippageBps,
    swapSources: requestedSources,
  });
  const validation = validateQuote(fresh, {
    operation,
    minOutputAmountRaw,
    maxFeeBps,
    allowDelayedUnstake,
    allowedSources: requestedSources,
  });
  if (!fresh.transactionBase64) {
    throw new AdapterError(
      SANCTUM_ADAPTER_ID,
      'transaction_unavailable',
      'Sanctum did not return an unsigned transaction for wallet approval.',
    );
  }
  const signedTx = await ctx.signTransaction(fresh.transactionBase64, action.summary);
  const executed = await resolveSanctumClient(ctx).executeTokenOrder({
    signedTx,
    orderResponse: fresh.orderResponse,
  });
  return {
    txid: executed.signature,
    signedAt: new Date().toISOString(),
    preview: {
      operation,
      inputMint,
      outputMint,
      inputAmountRaw,
      outputAmountRaw: fresh.outputAmountRaw,
      outputAmount: formatRawAmount(validation.outputAmountRaw, optionalNumberParam(action, 'outputDecimals') ?? 9),
      routeSources: fresh.routeSources,
      programIds: programIdsForQuote(fresh),
    },
  };
}

function validateQuote(
  quote: SanctumTokenOrder,
  opts: {
    operation: SanctumOperation;
    minOutputAmountRaw?: bigint;
    maxFeeBps: number;
    allowDelayedUnstake: boolean;
    allowedSources: SanctumSwapSource[];
  },
): { outputAmountRaw: bigint } {
  validateRouteSources(quote.routeSources, opts.allowedSources);
  parseQuoteRawAmount(quote.inputAmountRaw, 'inputAmountRaw');
  const outputAmountRaw = parseQuoteRawAmount(quote.outputAmountRaw, 'outputAmountRaw');
  if (opts.minOutputAmountRaw !== undefined && outputAmountRaw < opts.minOutputAmountRaw) {
    throw new AdapterError(
      SANCTUM_ADAPTER_ID,
      'output_below_minimum',
      `Sanctum quote output ${quote.outputAmountRaw} is below the requested minimum ${opts.minOutputAmountRaw.toString()}.`,
    );
  }
  if (quote.maxObservedFeeBps !== undefined && quote.maxObservedFeeBps > opts.maxFeeBps) {
    throw new AdapterError(
      SANCTUM_ADAPTER_ID,
      'fee_above_cap',
      `Sanctum quote fee ${quote.maxObservedFeeBps} bps exceeds maxFeeBps ${opts.maxFeeBps}.`,
    );
  }
  if (opts.operation === 'unstake_lst_to_sol' && !opts.allowDelayedUnstake && quoteRequiresDelayedUnstake(quote)) {
    throw new AdapterError(
      SANCTUM_ADAPTER_ID,
      'delayed_unstake_required',
      'Sanctum route appears to require delayed unstake. Pass allowDelayedUnstake=true to prepare it explicitly.',
    );
  }
  return { outputAmountRaw };
}

async function resolveTokenMeta(
  mint: string,
  ctx: DAppAdapterContext,
): Promise<{ symbol: string; decimals: number; snapshot?: SanctumLstSnapshot }> {
  if (mint === WSOL_MINT) return { symbol: 'SOL', decimals: 9 };
  if (mint === SANCTUM_INF_MINT) return { symbol: 'INF', decimals: 9 };
  const snapshot = await resolveSanctumClient(ctx).getLst({ mintOrSymbol: mint });
  if (!snapshot.enabled) {
    throw new AdapterError(
      SANCTUM_ADAPTER_ID,
      'disabled_lst',
      `${snapshot.symbol} is disabled or not currently supported by Sanctum.`,
    );
  }
  return {
    symbol: snapshot.symbol,
    decimals: snapshot.decimals ?? 9,
    snapshot,
  };
}

function normalizeMint(value: string, label: string): string {
  try {
    return new PublicKey(value.trim()).toBase58();
  } catch {
    throw new AdapterError(SANCTUM_ADAPTER_ID, 'invalid_request', `${label} must be a valid Solana mint address.`);
  }
}

function resolveSlippageBps(value: number | undefined, configMax: number): number {
  const selected = value ?? Math.min(configMax, SANCTUM_DEFAULT_SLIPPAGE_BPS);
  if (!Number.isInteger(selected) || selected < 0) {
    throw new AdapterError(SANCTUM_ADAPTER_ID, 'invalid_request', 'Sanctum slippageBps must be a non-negative integer.');
  }
  if (selected > configMax) {
    throw new AdapterError(
      SANCTUM_ADAPTER_ID,
      'slippage_above_cap',
      `Sanctum slippageBps ${selected} exceeds configured maxSlippageBps ${configMax}.`,
    );
  }
  return selected;
}

function resolveMaxFeeBps(value: number | undefined): number {
  const selected = value ?? SANCTUM_DEFAULT_MAX_FEE_BPS;
  if (!Number.isInteger(selected) || selected < 0) {
    throw new AdapterError(SANCTUM_ADAPTER_ID, 'invalid_request', 'Sanctum maxFeeBps must be a non-negative integer.');
  }
  return selected;
}

function kindForOperation(operation: SanctumOperation): AdapterAction['kind'] {
  switch (operation) {
    case 'swap_lst':
      return 'sanctum_swap_lst';
    case 'add_infinity_liquidity':
      return 'sanctum_add_infinity_liquidity';
    case 'remove_infinity_liquidity':
      return 'sanctum_remove_infinity_liquidity';
    case 'stake_sol_to_lst':
      return 'sanctum_stake_sol_to_lst';
    case 'unstake_lst_to_sol':
      return 'sanctum_unstake_lst_to_sol';
  }
}

function summaryForOperation(
  operation: SanctumOperation,
  amount: string,
  inputSymbol: string,
  outputSymbol: string,
): string {
  switch (operation) {
    case 'swap_lst':
      return `Swap ${amount} ${inputSymbol} to ${outputSymbol} through Sanctum`;
    case 'add_infinity_liquidity':
      return `Add ${amount} ${inputSymbol} to Sanctum Infinity`;
    case 'remove_infinity_liquidity':
      return `Remove ${amount} INF from Sanctum Infinity to ${outputSymbol}`;
    case 'stake_sol_to_lst':
      return `Stake ${amount} SOL to ${outputSymbol} through Sanctum`;
    case 'unstake_lst_to_sol':
      return `Unstake ${amount} ${inputSymbol} to SOL through Sanctum`;
  }
}

function quoteForStorage(quote: SanctumTokenOrder): Record<string, unknown> {
  return {
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    inputAmountRaw: quote.inputAmountRaw,
    outputAmountRaw: quote.outputAmountRaw,
    mode: quote.mode,
    routeSources: quote.routeSources,
    requestedSources: quote.requestedSources,
    ...(quote.slippageBps !== undefined && { slippageBps: quote.slippageBps }),
    ...(quote.maxObservedFeeBps !== undefined && { maxObservedFeeBps: quote.maxObservedFeeBps }),
    hasTransaction: quote.hasTransaction,
    warnings: quote.warnings,
    asOfIso: quote.asOfIso,
    apiBaseHost: quote.apiBaseHost,
  };
}

function programIdsForQuote(_quote: SanctumTokenOrder): string[] {
  return SANCTUM_PROGRAM_IDS.map((programId) => programId.toBase58());
}

function quoteRequiresDelayedUnstake(quote: SanctumTokenOrder): boolean {
  const text = JSON.stringify({
    routeSources: quote.routeSources,
    warnings: quote.warnings,
    orderResponse: quote.orderResponse,
  }).toLowerCase();
  return text.includes('delayed') || text.includes('withdrawstake');
}

function requireOperation(action: PreparedAction): SanctumOperation {
  const value = requireStringParam(action, 'operation');
  if (
    value === 'swap_lst' ||
    value === 'add_infinity_liquidity' ||
    value === 'remove_infinity_liquidity' ||
    value === 'stake_sol_to_lst' ||
    value === 'unstake_lst_to_sol'
  ) {
    return value;
  }
  throw new ProtocolError('invalid_request', `Sanctum action ${action.id} has unsupported operation ${value}.`);
}

function requestedSourcesFromAction(action: PreparedAction, operation: SanctumOperation): SanctumSwapSource[] {
  const value = action.params.requestedSources;
  const allowedForOperation = defaultSourcesForOperation(operation);
  if (value === undefined) return allowedForOperation;
  if (!Array.isArray(value)) {
    throw new ProtocolError('invalid_request', `Sanctum action ${action.id} has malformed requestedSources.`);
  }
  const allowedSet = new Set<SanctumSwapSource>(allowedForOperation);
  const sources: SanctumSwapSource[] = [];
  for (const entry of value) {
    if (entry !== 'Inf' && entry !== 'SanctumRouter') {
      throw new ProtocolError('invalid_request', `Sanctum action ${action.id} has unsupported requested source ${String(entry)}.`);
    }
    if (!allowedSet.has(entry)) {
      throw new ProtocolError(
        'invalid_request',
        `Sanctum action ${action.id} cannot use requested source ${entry} for ${operation}.`,
      );
    }
    if (!sources.includes(entry)) sources.push(entry);
  }
  if (sources.length === 0) {
    throw new ProtocolError('invalid_request', `Sanctum action ${action.id} must keep at least one requested source.`);
  }
  return sources;
}

function defaultSourcesForOperation(operation: SanctumOperation): SanctumSwapSource[] {
  return operation === 'add_infinity_liquidity' || operation === 'remove_infinity_liquidity'
    ? SANCTUM_INFINITY_SWAP_SOURCES
    : SANCTUM_ROUTER_SWAP_SOURCES;
}

function validateRouteSources(routeSources: string[], allowedSources: SanctumSwapSource[]): void {
  const allowed = new Set(allowedSources);
  for (const source of routeSources) {
    const parsed = parseRouteSource(source);
    if (parsed.hasJupiter) {
      throw new AdapterError(
        SANCTUM_ADAPTER_ID,
        'unsupported_route',
        'Sanctum connector routes must stay on Sanctum Infinity or Sanctum Router; Jupiter fallback is not allowed here.',
      );
    }
    if (parsed.sources.length === 0) {
      throw new AdapterError(
        SANCTUM_ADAPTER_ID,
        'unsupported_route',
        `Sanctum quote returned unsupported route source ${source}.`,
      );
    }
    for (const routeSource of parsed.sources) {
      if (!allowed.has(routeSource)) {
        throw new AdapterError(
          SANCTUM_ADAPTER_ID,
          'unsupported_route',
          `Sanctum quote returned unrequested route source ${routeSource}.`,
        );
      }
    }
  }
}

function parseRouteSource(source: string): { hasJupiter: boolean; sources: SanctumSwapSource[] } {
  const tokens = routeSourceTokens(source);
  const normalized = normalizeRouteSourceText(source);
  const candidates = new Set([normalized, ...tokens]);
  const sources: SanctumSwapSource[] = [];
  if (
    candidates.has('inf') ||
    candidates.has('infinity') ||
    candidates.has('sanctuminf') ||
    candidates.has('sanctuminfinity')
  ) {
    sources.push('Inf');
  }
  if (
    candidates.has('router') ||
    candidates.has('sanctumrouter') ||
    (candidates.has('sanctum') && candidates.has('router'))
  ) {
    sources.push('SanctumRouter');
  }
  return {
    hasJupiter: [...candidates].some((candidate) => candidate.includes('jup')),
    sources,
  };
}

function routeSourceTokens(source: string): string[] {
  return source
    .split(/[^A-Za-z0-9]+/)
    .map(normalizeRouteSourceText)
    .filter((token) => token.length > 0);
}

function normalizeRouteSourceText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseQuoteRawAmount(value: string, label: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new AdapterError(
      SANCTUM_ADAPTER_ID,
      'invalid_quote',
      `Sanctum quote ${label} must be an unsigned integer raw amount.`,
    );
  }
  return BigInt(value);
}

function parsePreparedRawAmount(action: PreparedAction, key: string, value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new ProtocolError('invalid_request', `Sanctum action ${action.id} has malformed ${key}.`);
  }
  return BigInt(value);
}

function requireStringParam(action: PreparedAction, key: string): string {
  const value = action.params[key];
  if (typeof value !== 'string' || !value) {
    throw new ProtocolError('invalid_request', `Sanctum action ${action.id} is missing ${key}.`);
  }
  return value;
}

function optionalStringParam(action: PreparedAction, key: string): string | undefined {
  const value = action.params[key];
  return typeof value === 'string' && value ? value : undefined;
}

function optionalNumberParam(action: PreparedAction, key: string): number | undefined {
  const value = action.params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

export function sanctumShortLabel(mint: string): string {
  if (mint === WSOL_MINT) return 'SOL';
  if (mint === SANCTUM_INF_MINT) return 'INF';
  return shortAddress(mint);
}
