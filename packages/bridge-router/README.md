# @solana-agent-wallet-adapter/bridge-router

Dev-only settlement routing. Given a `SettlementRequest` (USD amount + recipient
+ optional target mint), it picks the cheapest viable route to deliver that
value on Solana — preferring a direct USDC transfer when the payer already
holds USDC, falling back to a Jupiter swap, a Sanctum LST swap, a Wormhole
bridge transfer, or a deterministic stub when nothing else fits.

The package is **dependency-free at runtime**. The router is pure logic; all
network IO lives behind a small `QuoteSource` interface that callers wire up.
This is intentional — `apps/render-web` and tests inject the real or stub
clients without dragging the entire `mcp-server` transitive tree into a tiny
library.

## Public API

| Export | Purpose |
| --- | --- |
| `findOptimalSettlement(request, sources, options?)` | Run every source in parallel with a per-source timeout (default 5s), then pick the lowest-cost `SettlementRoute`. Always resolves; never throws. |
| `createDirectStablecoinSource()` | Returns a route only when the payer already holds enough USDC. Zero slippage, zero fee. |
| `createStubStablecoinSource(opts?)` | Deterministic 1:1 USD→USDC stub. Always returns a route for USDC targets. Useful while real adapter sources are being wired up. |
| `createJupiterSource(client)` | Wraps an injected `JupiterSwapClient` (typed in `sources.ts`) into a quote source. |
| `createSanctumSource(client)` | Wraps an injected `SanctumLstClient`. Only proposes routes when the target is a non-USDC LST. |
| `createWormholeSource(client, overrides?)` | Wraps an injected `WormholeQuoteClient`. Requires `overrides.destinationChain` — bridge routes are explicitly opt-in per request. |

Types: `SettlementRequest`, `SettlementRoute`, `SettlementHop`,
`QuoteSource`, `QuoteContext`, `RouterOptions`, `RouterResult`,
`SourceDiagnostic`, `PayerHolding`, `SupportedCluster`.

Decimal helpers: `decimalUsdToRaw`, `rawToDecimal`, `addDecimalStrings`,
`compareUnsignedBigStrings`, `applySlippageBps`, `subtractUnsignedIntegerStrings`,
`decimalStringIsPositive`. All string-based; no floats internally.

USDC helpers: `USDC_MINT_MAINNET`, `USDC_MINT_DEVNET`, `defaultUsdcMint`,
`isUsdcMint`.

## Consumers

- `apps/render-web/src/cloud/bridgeRoutes.ts` (live) — `POST /api/agents/settlement/quote`.
- `packages/workflow/src/dev/bridge.ts` — request-shape validator at the workflow boundary (`DevLayer1.bridge.validateSettlementQuoteRequest`).

## Smoke test

`smoke.mts` at the package root is a manual end-to-end sanity check. Run with:

```sh
npx tsx smoke.mts
```

Three scenarios:
1. **Direct USDC** — payer holds USDC, expects `direct-usdc` to win at `$50` cost.
2. **Jupiter fallback** — payer holds only SOL, Jupiter stub returns a SOL→USDC quote.
3. **Timeout degradation** — hanging source aborted at 200ms, diagnostic shows `status: 'timeout'`.

## Tests

```sh
pnpm -F @solana-agent-wallet-adapter/bridge-router test
```

## Parent plan

`/Users/devlegacy/.claude/plans/ok-please-plan-out-purrfect-squirrel.md` —
Agentic Layer 1 dev-gated rollout. This package is Agent 4 of that plan.

## Future work (deferred)

- Wire real `JupiterSwapClient` / `SanctumLstClient` / `WormholeQuoteClient`
  implementations into `bridgeRoutes.ts` (currently uses only the stub source).
  Blocked on opening up `packages/mcp-server`'s adapter client deep imports.
- Emit `AgentEvidenceFact` entries from the route handler for cited prices.
- USD price feed integration so the router scores routes on real spread.
- **Streaming-session escrow replenishment (Phase 2.5+).** When an active
  streaming session (see `packages/streaming-sessions/`) approaches its
  delegate cap and the agent's owner wallet holds the funds in a non-escrow
  mint, `findOptimalSettlement` is the right primitive to quote the cheapest
  swap-and-fund route. Today the streaming-sessions package and bridge-router
  do not import each other; the integration point would be a new
  `apps/render-web/src/cloud/streamingTopUpService.ts` that composes both.
