import {
  createDirectStablecoinSource,
  createJupiterSource,
  findOptimalSettlement,
  type JupiterSwapClient,
  type QuoteSource,
  type SettlementRoute,
} from './src/index.js';

const RECIPIENT = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';

console.log('— Acceptance #1: direct USDC route when payer holds USDC —');
const direct = await findOptimalSettlement(
  {
    usdAmount: '50',
    recipient: RECIPIENT,
    payerHoldings: [{ mint: USDC, amountRaw: '100000000', decimals: 6 }],
  },
  [createDirectStablecoinSource()],
);
console.log('best.sourceId =', direct.best?.sourceId);
console.log('best.expectedUsdOut =', direct.best?.expectedUsdOut);
console.log('best.hops[0].kind =', direct.best?.hops[0]?.kind);

console.log('\n— Acceptance #1b: Jupiter fallback when no USDC holdings —');
const jupiterClient: JupiterSwapClient = {
  async getQuote() {
    return {
      inputMint: SOL,
      outputMint: USDC,
      inputAmountRaw: '500000000',
      outputAmountRaw: '50000000',
      slippageBps: 50,
      inputUsdValue: '50',
      estimatedFeeUsd: '0.10',
    };
  },
};
const jupiter = await findOptimalSettlement(
  {
    usdAmount: '50',
    recipient: RECIPIENT,
    payerHoldings: [{ mint: SOL, amountRaw: '1000000000', decimals: 9 }],
  },
  [createDirectStablecoinSource(), createJupiterSource(jupiterClient)],
);
console.log('best.sourceId =', jupiter.best?.sourceId);
console.log('best.label =', jupiter.best?.label);
console.log('best.estimatedCostUsd =', jupiter.best?.estimatedCostUsd);

console.log('\n— Acceptance #2: timeout degrades gracefully —');
const hanging: QuoteSource = {
  id: 'slow',
  async quote({ signal }): Promise<SettlementRoute | null> {
    return await new Promise<SettlementRoute | null>((_r, rej) =>
      signal.addEventListener('abort', () => rej(new Error('aborted'))),
    );
  },
};
const degraded = await findOptimalSettlement(
  { usdAmount: '50', recipient: RECIPIENT },
  [hanging],
  { perSourceTimeoutMs: 200 },
);
console.log('best =', degraded.best);
console.log('diagnostics =', degraded.diagnostics);
