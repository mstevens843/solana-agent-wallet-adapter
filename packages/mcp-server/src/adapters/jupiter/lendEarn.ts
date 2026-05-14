import { jupiterFetchJson } from './client.js';
import { getJupiterLendClient, type JupiterLendEarnEarningsSnapshot, type JupiterLendEarnPositionSnapshot, type JupiterLendEarnTokenSnapshot } from './lendClient.js';
import { JUPITER_ADAPTER_ID } from './constants.js';
import { AdapterError } from '../types.js';
import type { AgentWalletConfig } from '../../config.js';

export interface ListEarnTokensInput {
  includeInactive?: boolean;
  assetMint?: string;
}

export interface EarnPositionsInput {
  walletAddress: string;
  assetMint?: string;
}

export interface EarnEarningsInput {
  walletAddress: string;
  assetMint?: string;
  from?: string;
  to?: string;
}

const KNOWN_EARN_ASSET_MINTS: Record<string, string> = {
  SOL: 'So11111111111111111111111111111111111111112',
  WSOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
};

export function normalizeJupiterLendEarnAssetMint(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return KNOWN_EARN_ASSET_MINTS[normalized.toUpperCase()] ?? normalized;
}

export async function listEarnTokens(
  config: AgentWalletConfig,
  walletAddress: string,
  input: ListEarnTokensInput,
): Promise<JupiterLendEarnTokenSnapshot[]> {
  const normalizedInput = {
    ...input,
    ...(input.assetMint ? { assetMint: normalizeJupiterLendEarnAssetMint(input.assetMint) } : {}),
  };
  if (config.connectors?.jupiter?.useSdk === false) {
    return fetchEarnTokensViaRest(config, normalizedInput);
  }
  try {
    const client = await getJupiterLendClient(walletAddress, config);
    return await client.getEarnTokens(normalizedInput);
  } catch (err) {
    if (isSdkUnavailable(err)) {
      return fetchEarnTokensViaRest(config, normalizedInput);
    }
    throw err;
  }
}

export async function getEarnTokenDetail(
  config: AgentWalletConfig,
  walletAddress: string,
  assetMint: string,
): Promise<JupiterLendEarnTokenSnapshot> {
  const normalizedAssetMint = normalizeJupiterLendEarnAssetMint(assetMint);
  if (!normalizedAssetMint) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'assetMint is required to read a Jupiter Lend Earn token.');
  }
  if (config.connectors?.jupiter?.useSdk === false) {
    const tokens = await fetchEarnTokensViaRest(config, { assetMint: normalizedAssetMint });
    const matched = findEarnToken(tokens, normalizedAssetMint, assetMint);
    if (!matched) {
      throw new AdapterError(JUPITER_ADAPTER_ID, 'unknown_asset', `Jupiter Lend Earn token "${assetMint}" was not found.`);
    }
    return matched;
  }
  try {
    const client = await getJupiterLendClient(walletAddress, config);
    return await client.getEarnTokenDetail({ assetMint: normalizedAssetMint });
  } catch (err) {
    if (isSdkUnavailable(err)) {
      const tokens = await fetchEarnTokensViaRest(config, { assetMint: normalizedAssetMint });
      const matched = findEarnToken(tokens, normalizedAssetMint, assetMint);
      if (!matched) {
        throw new AdapterError(JUPITER_ADAPTER_ID, 'unknown_asset', `Jupiter Lend Earn token "${assetMint}" was not found.`);
      }
      return matched;
    }
    throw err;
  }
}

export async function getEarnPositions(
  config: AgentWalletConfig,
  input: EarnPositionsInput,
): Promise<JupiterLendEarnPositionSnapshot[]> {
  if (!input.walletAddress.trim()) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'walletAddress is required to read Jupiter Lend Earn positions.');
  }
  const normalizedInput = {
    ...input,
    ...(input.assetMint ? { assetMint: normalizeJupiterLendEarnAssetMint(input.assetMint) } : {}),
  };
  if (config.connectors?.jupiter?.useSdk === false) {
    return fetchEarnPositionsViaRest(config, normalizedInput);
  }
  try {
    const client = await getJupiterLendClient(input.walletAddress, config);
    return await client.getEarnPositions(normalizedInput);
  } catch (err) {
    if (isSdkUnavailable(err)) {
      return fetchEarnPositionsViaRest(config, normalizedInput);
    }
    throw err;
  }
}

export async function getEarnEarnings(
  config: AgentWalletConfig,
  input: EarnEarningsInput,
): Promise<JupiterLendEarnEarningsSnapshot[]> {
  if (!input.walletAddress.trim()) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'walletAddress is required to read Jupiter Lend Earn earnings.');
  }
  const normalizedInput = {
    ...input,
    ...(input.assetMint ? { assetMint: normalizeJupiterLendEarnAssetMint(input.assetMint) } : {}),
  };
  if (config.connectors?.jupiter?.useSdk === false) {
    return fetchEarnEarningsViaRest(config, normalizedInput);
  }
  try {
    const client = await getJupiterLendClient(input.walletAddress, config);
    return await client.getEarnEarnings(normalizedInput);
  } catch (err) {
    if (isSdkUnavailable(err)) {
      return fetchEarnEarningsViaRest(config, normalizedInput);
    }
    throw err;
  }
}

async function fetchEarnTokensViaRest(
  config: AgentWalletConfig,
  input: ListEarnTokensInput,
): Promise<JupiterLendEarnTokenSnapshot[]> {
  const body = await jupiterFetchJson(config, 'lend', '/earn/tokens', {
    searchParams: {
      ...(input.includeInactive !== undefined ? { includeInactive: input.includeInactive } : {}),
      ...(input.assetMint ? { assetMint: input.assetMint } : {}),
    },
  });
  return normalizeTokenList(body);
}

async function fetchEarnPositionsViaRest(
  config: AgentWalletConfig,
  input: EarnPositionsInput,
): Promise<JupiterLendEarnPositionSnapshot[]> {
  const body = await jupiterFetchJson(config, 'lend', '/earn/positions', {
    searchParams: {
      walletAddress: input.walletAddress,
      ...(input.assetMint ? { assetMint: input.assetMint } : {}),
    },
  });
  return normalizePositionList(body);
}

async function fetchEarnEarningsViaRest(
  config: AgentWalletConfig,
  input: EarnEarningsInput,
): Promise<JupiterLendEarnEarningsSnapshot[]> {
  const body = await jupiterFetchJson(config, 'lend', '/earn/earnings', {
    searchParams: {
      walletAddress: input.walletAddress,
      ...(input.assetMint ? { assetMint: input.assetMint } : {}),
      ...(input.from ? { from: input.from } : {}),
      ...(input.to ? { to: input.to } : {}),
    },
  });
  return normalizeEarningsList(body, input.walletAddress);
}

function normalizeTokenList(body: Record<string, unknown>): JupiterLendEarnTokenSnapshot[] {
  const tokens = pickArray(body, ['tokens', 'data', 'items']);
  return tokens.map((entry) => normalizeEarnToken(entry));
}

function normalizePositionList(body: Record<string, unknown>): JupiterLendEarnPositionSnapshot[] {
  const positions = pickArray(body, ['positions', 'data', 'items']);
  return positions.map((entry) => normalizeEarnPosition(entry));
}

function normalizeEarningsList(
  body: Record<string, unknown>,
  walletAddress: string,
): JupiterLendEarnEarningsSnapshot[] {
  const earnings = pickArray(body, ['earnings', 'data', 'items']);
  return earnings.map((entry) => normalizeEarnEarnings(entry, walletAddress));
}

function normalizeEarnToken(value: unknown): JupiterLendEarnTokenSnapshot {
  const record = asRecord(value);
  return {
    assetMint: stringField(record, ['assetMint', 'asset', 'mint']) ?? '',
    shareMint: stringField(record, ['shareMint', 'share', 'lpMint']) ?? '',
    ...optionalString(record, ['tokenSymbol', 'symbol'], 'tokenSymbol'),
    decimals: numberField(record, ['decimals', 'assetDecimals']) ?? 0,
    shareDecimals: numberField(record, ['shareDecimals', 'lpDecimals']) ?? 0,
    ...optionalNumber(record, ['apy', 'supplyApy'], 'apy'),
    ...optionalNumber(record, ['rewardApy', 'rewardsApy'], 'rewardApy'),
    ...optionalString(record, ['totalSupplyUnderlying', 'totalSupply'], 'totalSupplyUnderlying'),
    ...optionalString(record, ['totalSupplyShares', 'totalShares'], 'totalSupplyShares'),
    ...optionalString(record, ['exchangePrice', 'pricePerShare'], 'exchangePrice'),
    ...optionalNumber(record, ['utilization'], 'utilization'),
    ...optionalString(record, ['availableLiquidity', 'liquidity'], 'availableLiquidity'),
    ...optionalBoolean(record, ['active', 'isActive'], 'active'),
    ...(Array.isArray(record.rewards)
      ? { rewards: record.rewards.map((reward) => normalizeReward(reward)) }
      : {}),
    ...(record.withdrawalSmoothing && typeof record.withdrawalSmoothing === 'object'
      ? {
          withdrawalSmoothing: {
            enabled: Boolean((record.withdrawalSmoothing as Record<string, unknown>).enabled),
            ...optionalString(record.withdrawalSmoothing as Record<string, unknown>, ['note', 'message'], 'note'),
          },
        }
      : {}),
    ...optionalString(record, ['asOf', 'updatedAt', 'timestamp'], 'asOf'),
  };
}

function normalizeReward(value: unknown): { rewardMint: string; rewardSymbol?: string; apy?: number } {
  const record = asRecord(value);
  return {
    rewardMint: stringField(record, ['rewardMint', 'mint']) ?? '',
    ...optionalString(record, ['rewardSymbol', 'symbol'], 'rewardSymbol'),
    ...optionalNumber(record, ['apy', 'rewardApy'], 'apy'),
  };
}

function normalizeEarnPosition(value: unknown): JupiterLendEarnPositionSnapshot {
  const record = asRecord(value);
  const decimals = numberField(record, ['decimals', 'assetDecimals']) ?? 0;
  const shareDecimals = numberField(record, ['shareDecimals', 'lpDecimals']) ?? 0;
  return {
    assetMint: stringField(record, ['assetMint', 'asset', 'mint']) ?? '',
    shareMint: stringField(record, ['shareMint', 'share', 'lpMint']) ?? '',
    ...optionalString(record, ['tokenSymbol', 'symbol'], 'tokenSymbol'),
    decimals,
    shareDecimals,
    shares: stringField(record, ['shares', 'shareAmount']) ?? '0',
    sharesRaw: stringField(record, ['sharesRaw', 'shareAmountRaw']) ?? '0',
    underlyingAmount: stringField(record, ['underlyingAmount', 'amount', 'assetAmount']) ?? '0',
    underlyingAmountRaw: stringField(record, ['underlyingAmountRaw', 'assetAmountRaw']) ?? '0',
    ...optionalString(record, ['walletBalanceUnderlying', 'walletBalance'], 'walletBalanceUnderlying'),
    ...optionalString(record, ['exchangePrice', 'pricePerShare'], 'exchangePrice'),
    ...optionalNumber(record, ['apy', 'supplyApy'], 'apy'),
    ...optionalNumber(record, ['rewardApy', 'rewardsApy'], 'rewardApy'),
    ...optionalString(record, ['asOf', 'updatedAt', 'timestamp'], 'asOf'),
  };
}

function normalizeEarnEarnings(
  value: unknown,
  walletAddress: string,
): JupiterLendEarnEarningsSnapshot {
  const record = asRecord(value);
  return {
    assetMint: stringField(record, ['assetMint', 'asset', 'mint']) ?? '',
    walletAddress: stringField(record, ['walletAddress', 'wallet']) ?? walletAddress,
    totalEarnings: stringField(record, ['totalEarnings', 'earnings', 'amount']) ?? '0',
    ...optionalString(record, ['rewardEarnings', 'rewards'], 'rewardEarnings'),
    decimals: numberField(record, ['decimals', 'assetDecimals']) ?? 0,
    ...optionalString(record, ['from', 'startTime', 'periodStart'], 'from'),
    ...optionalString(record, ['to', 'endTime', 'periodEnd'], 'to'),
    ...optionalString(record, ['asOf', 'updatedAt', 'timestamp'], 'asOf'),
  };
}

function pickArray(body: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = body[key];
    if (Array.isArray(value)) return value;
  }
  if (Array.isArray(body)) return body as unknown[];
  return [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function optionalString<K extends string>(
  record: Record<string, unknown>,
  keys: string[],
  outKey: K,
): Partial<Record<K, string>> {
  const value = stringField(record, keys);
  return value !== undefined ? ({ [outKey]: value } as Partial<Record<K, string>>) : {};
}

function optionalNumber<K extends string>(
  record: Record<string, unknown>,
  keys: string[],
  outKey: K,
): Partial<Record<K, number>> {
  const value = numberField(record, keys);
  return value !== undefined ? ({ [outKey]: value } as Partial<Record<K, number>>) : {};
}

function optionalBoolean<K extends string>(
  record: Record<string, unknown>,
  keys: string[],
  outKey: K,
): Partial<Record<K, boolean>> {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') {
      return { [outKey]: value } as Partial<Record<K, boolean>>;
    }
  }
  return {};
}

function isSdkUnavailable(err: unknown): boolean {
  if (err instanceof AdapterError && err.code === 'sdk_unavailable') return true;
  return false;
}

function findEarnToken(
  tokens: JupiterLendEarnTokenSnapshot[],
  normalizedAssetMint: string,
  originalAssetMint: string,
): JupiterLendEarnTokenSnapshot | undefined {
  const originalSymbol = originalAssetMint.trim().toUpperCase();
  return tokens.find((token) =>
    token.assetMint === normalizedAssetMint ||
    normalizeJupiterLendEarnAssetMint(token.assetMint) === normalizedAssetMint ||
    token.tokenSymbol?.trim().toUpperCase() === originalSymbol,
  );
}
