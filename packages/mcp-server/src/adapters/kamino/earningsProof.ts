import type { Connection } from '@solana/web3.js';

import { EARNINGS_PROOF_SCHEMA } from './constants.js';
import { getPositions } from './positions.js';
import type { KaminoPosition } from './client.js';

export interface KaminoEarningsProofPayload {
  schema: typeof EARNINGS_PROOF_SCHEMA;
  wallet: string;
  cluster: string;
  asOfBlockTime: number;
  asOfIso: string;
  positions: Array<{
    reserveAddress: string;
    reserveMint: string;
    reserveSymbol: string;
    decimals: number;
    suppliedAmount: string;
    currentValue: string;
    earnedInterest: string;
    supplyApy: number;
  }>;
  totals: {
    reserveCount: number;
    suppliedAmount: string;
    earnedInterest: string;
  };
}

export interface KaminoEarningsProof {
  payload: KaminoEarningsProofPayload;
  canonicalJson: string;
  canonicalBase64: string;
}

export interface BuildEarningsProofInput {
  walletAddress: string;
  cluster: string;
  reserveMint?: string;
  now?: Date;
}

export async function buildEarningsProof(
  connection: Connection,
  input: BuildEarningsProofInput,
): Promise<KaminoEarningsProof> {
  const all = await getPositions(connection, input.walletAddress);
  const filtered = input.reserveMint
    ? all.filter((position) => position.reserveMint === input.reserveMint)
    : all;
  const asOfMs = (input.now ?? new Date()).getTime();
  const payload = composePayload({
    walletAddress: input.walletAddress,
    cluster: input.cluster,
    positions: filtered,
    asOfMs,
  });
  const canonicalJson = canonicalizeJson(payload as unknown as Record<string, unknown>);
  const canonicalBase64 = Buffer.from(canonicalJson, 'utf8').toString('base64');
  return { payload, canonicalJson, canonicalBase64 };
}

function composePayload(args: {
  walletAddress: string;
  cluster: string;
  positions: KaminoPosition[];
  asOfMs: number;
}): KaminoEarningsProofPayload {
  const positions = args.positions
    .map((position) => ({
      reserveAddress: position.reserveAddress,
      reserveMint: position.reserveMint,
      reserveSymbol: position.reserveSymbol,
      decimals: position.decimals,
      suppliedAmount: position.suppliedAmount,
      currentValue: position.currentValue,
      earnedInterest: position.earnedInterest,
      supplyApy: roundApy(position.supplyApy),
    }))
    .sort((left, right) => left.reserveMint.localeCompare(right.reserveMint));

  const totals = positions.reduce(
    (acc, position) => {
      const supplied = Number(position.suppliedAmount);
      const earned = Number(position.earnedInterest);
      if (Number.isFinite(supplied)) acc.suppliedSum += supplied;
      if (Number.isFinite(earned)) acc.earnedSum += earned;
      return acc;
    },
    { suppliedSum: 0, earnedSum: 0 },
  );

  return {
    schema: EARNINGS_PROOF_SCHEMA,
    wallet: args.walletAddress,
    cluster: args.cluster,
    asOfBlockTime: Math.floor(args.asOfMs / 1000),
    asOfIso: new Date(args.asOfMs).toISOString(),
    positions,
    totals: {
      reserveCount: positions.length,
      suppliedAmount: trim(totals.suppliedSum),
      earnedInterest: trim(totals.earnedSum),
    },
  };
}

function roundApy(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10_000) / 10_000;
}

function trim(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(8).replace(/\.?0+$/, '');
}

// JSON canonicalization (RFC 8785-style, simplified): deterministic key ordering,
// no extra whitespace, fixed number formatting. The same input must always produce
// the same bytes so off-chain verifiers can re-derive the signed message.
export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    ordered[key] = canonicalize(obj[key]);
  }
  return ordered;
}
