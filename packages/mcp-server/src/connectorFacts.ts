import { redactSecrets } from './trace.js';
import type { ConnectorCapability, ConnectorId } from './connectorRegistry.js';
import type {
  KaminoPosition,
  KaminoReserveSnapshot,
} from './adapters/kamino/client.js';
import type { KaminoEarningsProof } from './adapters/kamino/earningsProof.js';

export type ConnectorFactTone = 'good' | 'warn' | 'neutral' | 'fail';

export interface ConnectorFact {
  connectorId: ConnectorId;
  label: string;
  value: string;
  tone: ConnectorFactTone;
  source: 'connector';
  checkedAt: string;
  detail?: Record<string, unknown>;
}

export interface ConnectorFactReadInput {
  connectorId: string;
  capability?: ConnectorCapability;
  walletAddress?: string;
  token?: string;
  reserveMint?: string;
  inputToken?: string;
  outputToken?: string;
  amount?: string;
  slippageBps?: number;
  taker?: string;
}

export function fact(input: {
  connectorId: ConnectorId;
  label: string;
  value: string;
  tone?: ConnectorFactTone;
  checkedAt?: string;
  detail?: Record<string, unknown>;
}): ConnectorFact {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  return {
    connectorId: input.connectorId,
    label: input.label,
    value: input.value,
    tone: input.tone ?? 'neutral',
    source: 'connector',
    checkedAt,
    ...(input.detail ? { detail: redactSecrets(input.detail) as Record<string, unknown> } : {}),
  };
}

export function factsFromKaminoReserveSnapshot(
  snapshot: KaminoReserveSnapshot,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  return [
    fact({
      connectorId: 'kamino',
      label: 'Reserve',
      value: `${snapshot.reserveSymbol} reserve`,
      checkedAt,
      detail: {
        reserveMint: snapshot.reserveMint,
        reserveAddress: snapshot.reserveAddress,
        decimals: snapshot.decimals,
        lastUpdateSlot: snapshot.lastUpdateSlot,
        asOfBlockTime: snapshot.asOfBlockTime,
      },
    }),
    fact({
      connectorId: 'kamino',
      label: 'Supply APY',
      value: formatPercent(snapshot.supplyApy),
      tone: rateTone(snapshot.supplyApy),
      checkedAt,
    }),
    fact({
      connectorId: 'kamino',
      label: 'Borrow APY',
      value: formatPercent(snapshot.borrowApy),
      tone: 'neutral',
      checkedAt,
    }),
    fact({
      connectorId: 'kamino',
      label: 'Utilization',
      value: formatPercent(snapshot.utilization),
      tone: utilizationTone(snapshot.utilization),
      checkedAt,
    }),
    fact({
      connectorId: 'kamino',
      label: 'Deposit capacity',
      value: snapshot.depositLimitRemaining
        ? `${snapshot.depositLimitRemaining} ${snapshot.reserveSymbol} remaining`
        : 'No deposit capacity reported',
      tone: positiveString(snapshot.depositLimitRemaining) ? 'good' : 'warn',
      checkedAt,
      detail: {
        depositLimit: snapshot.depositLimit,
        depositLimitRemaining: snapshot.depositLimitRemaining,
      },
    }),
    fact({
      connectorId: 'kamino',
      label: 'Withdraw available',
      value: `${snapshot.withdrawAvailable} ${snapshot.reserveSymbol}`,
      tone: positiveString(snapshot.withdrawAvailable) ? 'good' : 'warn',
      checkedAt,
      detail: {
        withdrawalDelaySec: snapshot.withdrawalDelaySec,
      },
    }),
  ];
}

export function factsFromKaminoPositions(
  input: {
    walletAddress: string;
    positions: KaminoPosition[];
    totals?: { reserves?: number; totalSupplied?: string; totalEarned?: string };
  },
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  if (input.positions.length === 0) {
    return [
      fact({
        connectorId: 'kamino',
        label: 'Kamino positions',
        value: 'No supplied positions found for this wallet',
        tone: 'neutral',
        checkedAt,
        detail: { walletAddress: input.walletAddress },
      }),
    ];
  }
  const totals = input.totals;
  return [
    fact({
      connectorId: 'kamino',
      label: 'Kamino positions',
      value: totals
        ? `${totals.reserves ?? input.positions.length} reserves · ${totals.totalSupplied ?? '0'} supplied · ${totals.totalEarned ?? '0'} earned`
        : `${input.positions.length} reserves`,
      tone: 'good',
      checkedAt,
      detail: { walletAddress: input.walletAddress },
    }),
    ...input.positions.map((position) => fact({
      connectorId: 'kamino',
      label: `${position.reserveSymbol} supplied`,
      value: `${position.suppliedAmount} supplied · ${position.currentValue} current · ${position.earnedInterest} earned`,
      tone: positiveString(position.earnedInterest) ? 'good' : 'neutral',
      checkedAt,
      detail: {
        reserveMint: position.reserveMint,
        reserveAddress: position.reserveAddress,
        supplyApy: position.supplyApy,
        withdrawAvailable: position.withdrawAvailable,
        asOfSlot: position.asOfSlot,
      },
    })),
  ];
}

export function factsFromKaminoEarningsProof(
  proof: KaminoEarningsProof,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  return [
    fact({
      connectorId: 'kamino',
      label: 'Earnings proof',
      value: `${proof.payload.totals.reserveCount} reserves · ${proof.payload.totals.earnedInterest} earned`,
      tone: proof.payload.totals.reserveCount > 0 ? 'good' : 'neutral',
      checkedAt,
      detail: {
        schema: proof.payload.schema,
        wallet: proof.payload.wallet,
        cluster: proof.payload.cluster,
        asOfIso: proof.payload.asOfIso,
      },
    }),
    fact({
      connectorId: 'kamino',
      label: 'Proof payload',
      value: `${proof.canonicalBase64.length} base64 chars ready for wallet message signing`,
      tone: 'neutral',
      checkedAt,
      detail: {
        canonicalBase64Length: proof.canonicalBase64.length,
      },
    }),
  ];
}

export function factsFromJupiterOrderPreview(
  order: Record<string, unknown>,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const outAmount = stringValue(order.outAmount);
  const errorMessage = stringValue(order.errorMessage ?? order.error);
  return [
    fact({
      connectorId: 'jupiter',
      label: 'Jupiter preview',
      value: errorMessage || (outAmount ? `Expected output ${outAmount}` : 'Preview returned without output amount'),
      tone: errorMessage ? 'fail' : outAmount ? 'good' : 'warn',
      checkedAt,
      detail: {
        mode: order.mode,
        router: order.router,
        requestId: order.requestId,
        hasTransaction: order.hasTransaction,
      },
    }),
    fact({
      connectorId: 'jupiter',
      label: 'Slippage',
      value: order.slippageBps === undefined ? 'Not reported' : `${order.slippageBps} bps`,
      tone: slippageTone(order.slippageBps),
      checkedAt,
    }),
    fact({
      connectorId: 'jupiter',
      label: 'Price impact',
      value: order.priceImpact === undefined ? 'Not reported' : String(order.priceImpact),
      tone: priceImpactTone(order.priceImpact),
      checkedAt,
    }),
  ];
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return 'Not reported';
  return `${trimNumber(value)}%`;
}

function rateTone(value: number): ConnectorFactTone {
  if (!Number.isFinite(value)) return 'neutral';
  return value > 0 ? 'good' : 'neutral';
}

function utilizationTone(value: number): ConnectorFactTone {
  if (!Number.isFinite(value)) return 'neutral';
  if (value >= 98) return 'fail';
  if (value >= 90) return 'warn';
  return 'good';
}

function slippageTone(value: unknown): ConnectorFactTone {
  const parsed = finiteNumber(value);
  if (parsed === undefined) return 'neutral';
  if (parsed > 300) return 'fail';
  if (parsed > 100) return 'warn';
  return 'good';
}

function priceImpactTone(value: unknown): ConnectorFactTone {
  const parsed = finiteNumber(value);
  if (parsed === undefined) return 'neutral';
  if (parsed > 0.05) return 'fail';
  if (parsed > 0.01) return 'warn';
  return 'good';
}

function positiveString(value: string | undefined): boolean {
  if (value === undefined) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function trimNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(4).replace(/\.?0+$/, '');
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
