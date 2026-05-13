import { AdapterError } from '../types.js';

import { SAVE_ADAPTER_ID, DEFAULT_MIN_HEALTH_FACTOR } from './constants.js';
import type { SaveObligation, SaveReserveSnapshot } from './client.js';

export type HealthDeltaKind = 'deposit' | 'withdraw' | 'borrow' | 'repay';

export interface HealthDelta {
  kind: HealthDeltaKind;
  reserveMint: string;
  amountRaw: bigint;
  decimals: number;
  reserveSnapshot: SaveReserveSnapshot;
}

export interface HealthPreview {
  currentHealthFactor: number;
  projectedHealthFactor: number;
  projectedTotalDepositValueUsd: number;
  projectedTotalBorrowValueUsd: number;
  projectedBorrowLimitUsd: number;
  projectedLiquidationThresholdUsd: number;
  breaches: string[];
}

const INFINITE_HEALTH = Number.POSITIVE_INFINITY;

export function previewHealth(
  obligation: SaveObligation | null,
  delta: HealthDelta,
): HealthPreview {
  const decimalsFactor = 10 ** delta.decimals;
  const rawPrice = delta.reserveSnapshot.priceUsd;
  const priceUsd = typeof rawPrice === 'number' && Number.isFinite(rawPrice) && rawPrice > 0
    ? rawPrice
    : 0;
  const priceMissing = priceUsd <= 0;
  const amountUi = Number(delta.amountRaw) / decimalsFactor;
  const deltaValueUsd = amountUi * priceUsd;

  const currentDepositValue = obligation?.totalDepositValueUsd ?? 0;
  const currentBorrowValue = obligation?.totalBorrowValueUsd ?? 0;
  const currentBorrowLimit = obligation?.borrowLimitUsd ?? 0;
  const currentLiquidationThreshold = obligation?.liquidationThresholdUsd ?? 0;

  let projectedDepositValue = currentDepositValue;
  let projectedBorrowValue = currentBorrowValue;
  let projectedBorrowLimit = currentBorrowLimit;
  let projectedLiquidationThreshold = currentLiquidationThreshold;

  const collateralFactor = delta.reserveSnapshot.collateralFactor;
  const liquidationThreshold = delta.reserveSnapshot.liquidationThreshold;

  switch (delta.kind) {
    case 'deposit':
      projectedDepositValue += deltaValueUsd;
      projectedBorrowLimit += deltaValueUsd * collateralFactor;
      projectedLiquidationThreshold += deltaValueUsd * liquidationThreshold;
      break;
    case 'withdraw':
      projectedDepositValue -= deltaValueUsd;
      projectedBorrowLimit -= deltaValueUsd * collateralFactor;
      projectedLiquidationThreshold -= deltaValueUsd * liquidationThreshold;
      break;
    case 'borrow':
      projectedBorrowValue += deltaValueUsd;
      break;
    case 'repay':
      projectedBorrowValue -= deltaValueUsd;
      break;
  }

  if (projectedDepositValue < 0) projectedDepositValue = 0;
  if (projectedBorrowValue < 0) projectedBorrowValue = 0;
  if (projectedBorrowLimit < 0) projectedBorrowLimit = 0;
  if (projectedLiquidationThreshold < 0) projectedLiquidationThreshold = 0;

  const currentHealthFactor = computeHealthFactor(currentLiquidationThreshold, currentBorrowValue);
  const projectedHealthFactor = computeHealthFactor(
    projectedLiquidationThreshold,
    projectedBorrowValue,
  );

  const breaches: string[] = [];
  if (priceMissing && (delta.kind === 'borrow' || delta.kind === 'withdraw')) {
    // Without an oracle price we cannot model the debt-side change; refuse
    // rather than silently allow a borrow or withdraw whose health impact is
    // unknown.
    breaches.push('missing_price_oracle');
  }
  if (delta.kind === 'borrow' && projectedBorrowValue > projectedBorrowLimit + 1e-9) {
    breaches.push('projected_borrow_exceeds_borrow_limit');
  }
  if (delta.kind === 'withdraw' && projectedBorrowValue > projectedBorrowLimit + 1e-9) {
    breaches.push('withdraw_breaches_borrow_limit');
  }

  return {
    currentHealthFactor,
    projectedHealthFactor,
    projectedTotalDepositValueUsd: round(projectedDepositValue),
    projectedTotalBorrowValueUsd: round(projectedBorrowValue),
    projectedBorrowLimitUsd: round(projectedBorrowLimit),
    projectedLiquidationThresholdUsd: round(projectedLiquidationThreshold),
    breaches,
  };
}

export function assertHealthy(
  preview: HealthPreview,
  minHealthFactor: number,
  context: { operation: HealthDeltaKind; reserveSymbol: string },
): void {
  if (preview.breaches.length > 0) {
    throw new AdapterError(
      SAVE_ADAPTER_ID,
      'projected_health_unsafe',
      `Save ${context.operation} on ${context.reserveSymbol} blocked: ${preview.breaches.join(', ')}. Projected health factor ${formatHealth(preview.projectedHealthFactor)}, borrow ${preview.projectedTotalBorrowValueUsd.toFixed(2)} USD vs borrow limit ${preview.projectedBorrowLimitUsd.toFixed(2)} USD.`,
    );
  }
  if (preview.projectedHealthFactor < minHealthFactor) {
    throw new AdapterError(
      SAVE_ADAPTER_ID,
      'projected_health_unsafe',
      `Save ${context.operation} on ${context.reserveSymbol} blocked: projected health factor ${formatHealth(preview.projectedHealthFactor)} is below configured minimum ${minHealthFactor}.`,
    );
  }
}

export function resolveMinHealthFactor(input?: number | string | null): number {
  if (input === undefined || input === null) return DEFAULT_MIN_HEALTH_FACTOR;
  const parsed = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MIN_HEALTH_FACTOR;
  return parsed;
}

function computeHealthFactor(liquidationThresholdUsd: number, borrowValueUsd: number): number {
  if (borrowValueUsd <= 0) return INFINITE_HEALTH;
  return liquidationThresholdUsd / borrowValueUsd;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatHealth(value: number): string {
  if (!Number.isFinite(value)) return 'infinite';
  return value.toFixed(3);
}
