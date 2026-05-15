export type SupportedCluster = 'mainnet-beta' | 'devnet';

export interface PayerHolding {
  mint: string;
  amountRaw: string;
  decimals: number;
  usdPrice?: string;
}

export interface SettlementRequest {
  usdAmount: string;
  recipient: string;
  targetMint?: string;
  payerWallet?: string;
  cluster?: SupportedCluster;
  payerHoldings?: PayerHolding[];
  maxSlippageBps?: number;
}

export type SettlementHop =
  | { kind: 'direct'; mint: string; amountRaw: string; decimals: number }
  | {
      kind: 'jupiter-swap';
      inputMint: string;
      outputMint: string;
      inputAmountRaw: string;
      outputAmountRaw: string;
      slippageBps: number;
      routeKey?: string;
    }
  | {
      kind: 'sanctum-swap';
      inputMint: string;
      outputMint: string;
      inputAmountRaw: string;
      outputAmountRaw: string;
      slippageBps?: number;
      routeSources: string[];
    }
  | {
      kind: 'wormhole-bridge';
      sourceChain: string;
      destinationChain: string;
      sourceMint: string;
      destinationToken?: string;
      bridgeFee?: string;
      etaSeconds?: number;
    };

export interface SettlementRoute {
  sourceId: string;
  label: string;
  hops: SettlementHop[];
  expectedUsdOut: string;
  estimatedCostUsd: string;
  slippageBps: number;
  expiresAtIso?: string;
  warnings: string[];
}

export interface QuoteContext {
  request: SettlementRequest;
  signal: AbortSignal;
  now: () => Date;
}

export interface QuoteSource {
  id: string;
  quote(ctx: QuoteContext): Promise<SettlementRoute | null>;
}

export interface RouterOptions {
  perSourceTimeoutMs?: number;
  now?: () => Date;
}

export type SourceStatus = 'ok' | 'no_route' | 'timeout' | 'error';

export interface SourceDiagnostic {
  sourceId: string;
  status: SourceStatus;
  latencyMs: number;
  errorMessage?: string;
}

export interface RouterResult {
  best?: SettlementRoute;
  candidates: SettlementRoute[];
  diagnostics: SourceDiagnostic[];
}
