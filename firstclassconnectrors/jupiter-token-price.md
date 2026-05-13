# Jupiter Token And Price Connector Plan

## Goal

Add first-class read-only Jupiter Token API V2 and Price API V3 support.

V1 scope:

- Search token metadata by symbol, name, or mint.
- Read token tag lists such as verified, LST, and stocks where available.
- Read token categories such as top organic score, top traded, and top trending.
- Read recent tokens.
- Read USD prices for up to 50 mints.
- Produce reusable token and price evidence for swap, lend, trigger, recurring, and risk reviews.

Do not create write actions. Do not use token or price data as an oracle guarantee.

## Current Repo State

Token resolution currently comes from local config and on-chain mint decimals.

The app has some swap/token risk language, but Jupiter Token and Price APIs are not first-class MCP tools.

This plan should improve:

- Unknown token review.
- Meme-token risk review.
- Slippage review.
- Trigger minimum order value checks.
- Lend collateral/borrow valuation evidence.
- Prediction/perps denial evidence when needed.

## External Source Of Truth

Use official Jupiter docs:

- Token API V2 docs: https://developers.jup.ag/docs/tokens/token-information
- Token API reference: https://developers.jup.ag/docs/api-reference/tokens
- Price API V3 docs: https://developers.jup.ag/docs/price
- Price API reference: https://developers.jup.ag/docs/api-reference/price

Important facts:

- Token API V2 can search by symbol, name, or mint.
- Search can accept comma-separated mints, with up to 100 mint addresses.
- Tags include `lst`, `verified`, and `stocks`.
- Categories include `toporganicscore`, `toptraded`, and `toptrending`.
- Recent tokens are based on first pool creation time, not mint creation time.
- Token response can include metadata, decimals, token program, holder count, audit flags, organic score, tags, FDV, market cap, USD price, liquidity, and interval stats.
- Price API V3 returns one USD price per token, decimals, block id, and 24-hour change.
- Price API can return null/missing when a token has not traded recently or Jupiter heuristics flag unreliable pricing.
- Price API supports up to 50 ids per request.

## Dependencies

No new dependency is required.

Config:

- `JUPITER_API_KEY` or `JUP_API_KEY`: required.
- `JUPITER_TOKENS_BASE_URL`: optional, default `https://api.jup.ag/tokens/v2`.
- `JUPITER_PRICE_BASE_URL`: optional, default `https://api.jup.ag/price/v3`.
- `connectors.jupiter.tokenPrice.enabled`: default true when API key exists.
- `connectors.jupiter.tokenPrice.maxBatchPriceIds`: default 50.
- `connectors.jupiter.tokenPrice.maxSearchMintIds`: default 100.

## Proposed MCP Tools

Read tools:

- `solana_jupiter_token_search`
- `solana_jupiter_token_by_tag`
- `solana_jupiter_token_category`
- `solana_jupiter_token_recent`
- `solana_jupiter_price`
- `solana_jupiter_price_batch`
- `solana_jupiter_token_risk_evidence`

Prepared action kinds:

- None. This is read-only in v1.

## Inputs

Token search:

- `query`: required string. Symbol, name, mint, or comma-separated mints.
- `limit`: optional integer, default 20.

Token by tag:

- `tag`: required enum `lst | verified | stocks`.
- `limit`: optional integer.

Token category:

- `category`: required enum `toporganicscore | toptraded | toptrending`.
- `interval`: required enum `5m | 1h | 6h | 24h`.
- `limit`: optional integer, default 50.

Recent tokens:

- `limit`: optional integer, default 30.

Price:

- `mint`: required.

Price batch:

- `mints`: required array, maximum 50.

Token risk evidence:

- `mint`: required.
- `includePrice`: optional boolean, default true.
- `includeSearchFallback`: optional boolean, default true.

## Adapter Design

Files:

```text
packages/mcp-server/src/adapters/jupiter/tokenClient.ts
packages/mcp-server/src/adapters/jupiter/tokens.ts
packages/mcp-server/src/adapters/jupiter/prices.ts
packages/mcp-server/src/adapters/jupiter/tokenEvidence.ts
```

`tokenClient.ts` responsibilities:

- Call Token and Price APIs with `x-api-key`.
- Redact API keys.
- Enforce batch limits and response size limits.
- Normalize missing price/token cases.

`tokens.ts` responsibilities:

- Normalize token metadata, audit, tags, liquidity, stats, holder count, token program, and first pool facts.
- Mark verified, strict, organic score, suspicious flags, mint/freeze authority facts where available.

`prices.ts` responsibilities:

- Normalize USD price, decimals, block id, price change, missing-price reasons, and as-of timestamp.

`tokenEvidence.ts` responsibilities:

- Return compact evidence for planner reviews:
  - token identity
  - verification status
  - audit flags
  - holder concentration
  - liquidity
  - organic score
  - price freshness
  - risk labels

## Response Shape

Token evidence should return:

- `connectorId: "jupiter"`
- `product: "tokens_price"`
- `mint`
- `symbol`
- `name`
- `decimals`
- `tokenProgram`
- `isVerified`
- `tags`
- `organicScore`
- `organicScoreLabel`
- `audit`
- `holderCount`
- `topHoldersPercentage`
- `liquidity`
- `mcap`
- `fdv`
- `usdPrice`
- `priceBlockId`
- `priceChange24h`
- `stats`
- `riskLabels`
- `asOf`

## Safety Checks

- Reject missing API key.
- Reject batch price requests above 50 mints.
- Reject search requests above 100 comma-separated mint ids.
- Warn when price is missing or null.
- Warn when token is unverified.
- Warn when audit flags indicate suspicious status, freeze authority, mint authority, or high holder concentration.
- Warn when liquidity is low.
- Warn when organic score is low or absent.
- Warn that Jupiter price is evidence, not an oracle guarantee.
- Do not use Token/Price reads as approval.
- Do not create write tools from this adapter.

## Tests

Unit tests:

- Token search sends API key and query.
- Token search enforces mint batch cap.
- Tag read supports `lst`, `verified`, and `stocks`.
- Category read supports interval.
- Price batch enforces 50-id cap.
- Missing price returns structured evidence.
- Token risk evidence creates warnings for unverified/low-liquidity tokens.
- API errors redact API key.

Mock API tests:

- Token search success.
- Token by tag success.
- Category success.
- Recent success.
- Price single success.
- Price batch partial missing success.

Smoke prompts:

- "Search Jupiter tokens for JUP."
- "Show token risk evidence for this mint."
- "Get Jupiter prices for SOL, USDC, and JUP."
- "Show recent tokens from Jupiter, but do not trade."
- "Is this token verified and liquid enough for a small swap review?"

## Completion Checklist

- Token and Price tools appear under Jupiter reads.
- Swap planner can use token evidence for unknown mints.
- Lend/Trigger/Recurring planners can use prices for caps and previews.
- Missing price/token data produces useful warnings.
- No Token/Price path prepares or signs transactions.
