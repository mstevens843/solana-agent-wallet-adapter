import {
  addDecimalStrings,
  applySlippageBps,
  compareUnsignedBigStrings,
  decimalUsdToRaw,
} from './decimal.js';
import { defaultUsdcMint, isUsdcMint } from './usdc.js';
import type {
  QuoteContext,
  QuoteSource,
  SettlementRequest,
  SettlementRoute,
  SupportedCluster,
} from './types.js';

const DIRECT_SOURCE_ID = 'direct-usdc';
const JUPITER_SOURCE_ID = 'jupiter';
const SANCTUM_SOURCE_ID = 'sanctum';
const WORMHOLE_SOURCE_ID = 'wormhole';

const DEFAULT_SLIPPAGE_BPS = 50;

// ── Direct stablecoin (no swap) source ────────────────────────────────────

export function createDirectStablecoinSource(): QuoteSource {
  return {
    id: DIRECT_SOURCE_ID,
    async quote({ request }: QuoteContext): Promise<SettlementRoute | null> {
      const targetMint = effectiveTargetMint(request);
      if (!isUsdcMint(targetMint)) return null;
      const holdings = request.payerHoldings ?? [];
      const usdcHolding = holdings.find((h) => isUsdcMint(h.mint));
      if (!usdcHolding) return null;

      let requiredRaw: string;
      try {
        requiredRaw = decimalUsdToRaw(request.usdAmount, usdcHolding.decimals);
      } catch {
        return null;
      }
      if (compareUnsignedBigStrings(usdcHolding.amountRaw, requiredRaw) < 0) return null;

      return {
        sourceId: DIRECT_SOURCE_ID,
        label: 'Direct USDC transfer',
        hops: [
          {
            kind: 'direct',
            mint: targetMint,
            amountRaw: requiredRaw,
            decimals: usdcHolding.decimals,
          },
        ],
        expectedUsdOut: request.usdAmount,
        estimatedCostUsd: request.usdAmount,
        slippageBps: 0,
        warnings: [],
      };
    },
  };
}

// ── Jupiter swap source ────────────────────────────────────────────────────

export interface JupiterQuoteInput {
  inputMint: string;
  outputMint: string;
  targetOutputAmountRaw: string;
  slippageBps: number;
  signal: AbortSignal;
}

export interface JupiterRouterQuote {
  inputMint: string;
  outputMint: string;
  inputAmountRaw: string;
  outputAmountRaw: string;
  slippageBps: number;
  routeKey?: string;
  warnings?: string[];
  estimatedFeeUsd?: string;
  inputUsdValue?: string;
}

export interface JupiterSwapClient {
  getQuote(input: JupiterQuoteInput): Promise<JupiterRouterQuote | null>;
}

export function createJupiterSource(client: JupiterSwapClient): QuoteSource {
  return {
    id: JUPITER_SOURCE_ID,
    async quote({ request, signal }: QuoteContext): Promise<SettlementRoute | null> {
      const targetMint = effectiveTargetMint(request);
      const decimals = stablecoinDecimals(targetMint);
      let targetOutputAmountRaw: string;
      try {
        targetOutputAmountRaw = decimalUsdToRaw(request.usdAmount, decimals);
      } catch {
        return null;
      }
      const slippageBps = request.maxSlippageBps ?? DEFAULT_SLIPPAGE_BPS;
      const inputMint = chooseJupiterInputMint(request, targetMint);
      if (!inputMint) return null;

      const quote = await client.getQuote({
        inputMint,
        outputMint: targetMint,
        targetOutputAmountRaw,
        slippageBps,
        signal,
      });
      if (!quote) return null;

      const fee = quote.estimatedFeeUsd ?? '0';
      const slippageCost = slippageCostUsd(request.usdAmount, slippageBps);
      const estimatedCostUsd = addDecimalStrings(
        addDecimalStrings(quote.inputUsdValue ?? request.usdAmount, fee),
        slippageCost,
      );

      return {
        sourceId: JUPITER_SOURCE_ID,
        label: `Jupiter swap → ${shortMint(targetMint)}`,
        hops: [
          {
            kind: 'jupiter-swap',
            inputMint: quote.inputMint,
            outputMint: quote.outputMint,
            inputAmountRaw: quote.inputAmountRaw,
            outputAmountRaw: quote.outputAmountRaw,
            slippageBps: quote.slippageBps,
            ...(quote.routeKey !== undefined && { routeKey: quote.routeKey }),
          },
        ],
        expectedUsdOut: request.usdAmount,
        estimatedCostUsd,
        slippageBps: quote.slippageBps,
        warnings: quote.warnings ?? [],
      };
    },
  };
}

// ── Sanctum LST swap source ────────────────────────────────────────────────

export interface SanctumQuoteInput {
  inputMint: string;
  outputMint: string;
  targetOutputAmountRaw: string;
  slippageBps?: number;
  signal: AbortSignal;
}

export interface SanctumRouterQuote {
  inputMint: string;
  outputMint: string;
  inputAmountRaw: string;
  outputAmountRaw: string;
  routeSources: string[];
  slippageBps?: number;
  warnings?: string[];
  estimatedFeeUsd?: string;
  inputUsdValue?: string;
}

export interface SanctumLstClient {
  getQuote(input: SanctumQuoteInput): Promise<SanctumRouterQuote | null>;
}

export function createSanctumSource(client: SanctumLstClient): QuoteSource {
  return {
    id: SANCTUM_SOURCE_ID,
    async quote({ request, signal }: QuoteContext): Promise<SettlementRoute | null> {
      const targetMint = effectiveTargetMint(request);
      if (isUsdcMint(targetMint)) return null;

      const inputMint = chooseSanctumInputMint(request, targetMint);
      if (!inputMint) return null;

      const decimals = 9;
      let targetOutputAmountRaw: string;
      try {
        targetOutputAmountRaw = decimalUsdToRaw(request.usdAmount, decimals);
      } catch {
        return null;
      }
      const slippageBps = request.maxSlippageBps ?? DEFAULT_SLIPPAGE_BPS;

      const quote = await client.getQuote({
        inputMint,
        outputMint: targetMint,
        targetOutputAmountRaw,
        slippageBps,
        signal,
      });
      if (!quote) return null;

      const fee = quote.estimatedFeeUsd ?? '0';
      const effectiveSlippageBps = quote.slippageBps ?? slippageBps;
      const slippageCost = slippageCostUsd(request.usdAmount, effectiveSlippageBps);
      const estimatedCostUsd = addDecimalStrings(
        addDecimalStrings(quote.inputUsdValue ?? request.usdAmount, fee),
        slippageCost,
      );

      return {
        sourceId: SANCTUM_SOURCE_ID,
        label: `Sanctum LST swap → ${shortMint(targetMint)}`,
        hops: [
          {
            kind: 'sanctum-swap',
            inputMint: quote.inputMint,
            outputMint: quote.outputMint,
            inputAmountRaw: quote.inputAmountRaw,
            outputAmountRaw: quote.outputAmountRaw,
            routeSources: quote.routeSources,
            ...(quote.slippageBps !== undefined && { slippageBps: quote.slippageBps }),
          },
        ],
        expectedUsdOut: request.usdAmount,
        estimatedCostUsd,
        slippageBps: effectiveSlippageBps,
        warnings: quote.warnings ?? [],
      };
    },
  };
}

// ── Wormhole bridge source ─────────────────────────────────────────────────

export interface WormholeQuoteInput {
  sourceMint: string;
  destinationChain: string;
  destinationAddress: string;
  targetOutputAmountRaw: string;
  signal: AbortSignal;
}

export interface WormholeRouterQuote {
  sourceChain: string;
  destinationChain: string;
  sourceMint: string;
  destinationToken?: string;
  inputAmountRaw: string;
  outputAmountRaw: string;
  bridgeFee?: string;
  bridgeFeeUsd?: string;
  etaSeconds?: number;
  warnings?: string[];
  inputUsdValue?: string;
}

export interface WormholeRequestOverrides {
  destinationChain?: string;
  sourceMint?: string;
}

export interface WormholeQuoteClient {
  getQuote(input: WormholeQuoteInput): Promise<WormholeRouterQuote | null>;
}

export function createWormholeSource(
  client: WormholeQuoteClient,
  overrides?: WormholeRequestOverrides,
): QuoteSource {
  return {
    id: WORMHOLE_SOURCE_ID,
    async quote({ request, signal }: QuoteContext): Promise<SettlementRoute | null> {
      const destinationChain = overrides?.destinationChain;
      if (!destinationChain) return null;

      const sourceMint = overrides?.sourceMint
        ?? request.payerHoldings?.[0]?.mint;
      if (!sourceMint) return null;

      const decimals = 6;
      let targetOutputAmountRaw: string;
      try {
        targetOutputAmountRaw = decimalUsdToRaw(request.usdAmount, decimals);
      } catch {
        return null;
      }

      const quote = await client.getQuote({
        sourceMint,
        destinationChain,
        destinationAddress: request.recipient,
        targetOutputAmountRaw,
        signal,
      });
      if (!quote) return null;

      const slippageBps = request.maxSlippageBps ?? DEFAULT_SLIPPAGE_BPS;
      const bridgeFeeUsd = quote.bridgeFeeUsd ?? '0';
      const slippageCost = slippageCostUsd(request.usdAmount, slippageBps);
      const estimatedCostUsd = addDecimalStrings(
        addDecimalStrings(quote.inputUsdValue ?? request.usdAmount, bridgeFeeUsd),
        slippageCost,
      );

      return {
        sourceId: WORMHOLE_SOURCE_ID,
        label: `Wormhole ${quote.sourceChain} → ${quote.destinationChain}`,
        hops: [
          {
            kind: 'wormhole-bridge',
            sourceChain: quote.sourceChain,
            destinationChain: quote.destinationChain,
            sourceMint: quote.sourceMint,
            ...(quote.destinationToken !== undefined && { destinationToken: quote.destinationToken }),
            ...(quote.bridgeFee !== undefined && { bridgeFee: quote.bridgeFee }),
            ...(quote.etaSeconds !== undefined && { etaSeconds: quote.etaSeconds }),
          },
        ],
        expectedUsdOut: request.usdAmount,
        estimatedCostUsd,
        slippageBps,
        warnings: quote.warnings ?? [],
      };
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function effectiveTargetMint(request: SettlementRequest): string {
  return request.targetMint ?? defaultUsdcMint(request.cluster as SupportedCluster | undefined);
}

function chooseJupiterInputMint(request: SettlementRequest, targetMint: string): string | undefined {
  const holdings = request.payerHoldings ?? [];
  const nonTarget = holdings.find((h) => h.mint !== targetMint && compareUnsignedBigStrings(h.amountRaw, '0') > 0);
  return nonTarget?.mint;
}

function chooseSanctumInputMint(request: SettlementRequest, targetMint: string): string | undefined {
  const holdings = request.payerHoldings ?? [];
  const nonTarget = holdings.find((h) => h.mint !== targetMint && compareUnsignedBigStrings(h.amountRaw, '0') > 0);
  return nonTarget?.mint;
}

function stablecoinDecimals(_mint: string): number {
  return 6;
}

function slippageCostUsd(usdAmount: string, slippageBps: number): string {
  if (slippageBps <= 0) return '0';
  let raw: string;
  try {
    raw = decimalUsdToRaw(usdAmount, 8);
  } catch {
    return '0';
  }
  const scaled = applySlippageBps(raw, slippageBps, 'inflate');
  const slippage = subtractUnsignedDecimalCents(scaled, raw);
  return rawToUsd(slippage, 8);
}

function rawToUsd(amountRaw: string, decimals: number): string {
  if (decimals === 0) return amountRaw;
  const padded = amountRaw.padStart(decimals + 1, '0');
  const cut = padded.length - decimals;
  const whole = padded.slice(0, cut).replace(/^0+(?=\d)/, '') || '0';
  const frac = padded.slice(cut).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

function subtractUnsignedDecimalCents(a: string, b: string): string {
  let i = a.length - 1;
  let j = b.length - 1;
  let borrow = 0;
  let result = '';
  while (i >= 0) {
    const ai = a.charCodeAt(i) - 48;
    const bi = j >= 0 ? b.charCodeAt(j) - 48 : 0;
    let diff = ai - bi - borrow;
    if (diff < 0) {
      diff += 10;
      borrow = 1;
    } else {
      borrow = 0;
    }
    result = `${diff}${result}`;
    i--;
    j--;
  }
  return result.replace(/^0+(?=\d)/, '') || '0';
}

function shortMint(mint: string): string {
  if (mint.length <= 8) return mint;
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}
