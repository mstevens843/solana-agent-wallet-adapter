# CoinGecko Review Evidence

CoinGecko is exposed as a read-only market evidence provider for Ask agent and Check request flows. It is not a wallet connector and cannot prepare, sign, approve, or submit transactions.

## What It Can Read

- `solana_market_endpoint_catalog` with `provider: "coingecko"` lists Starter-compatible endpoint ids, path parameters, query parameters, and the review-only boundary.
- `solana_coingecko_read` calls a cataloged GET endpoint by id. Arbitrary URLs are not accepted.
- `solana_coingecko_token_evidence` reads Solana token price, market cap, 24h volume, 24h change, and optional GeckoTerminal token metadata for up to 10 mints.
- Browser Check enrichment uses CoinGecko token evidence as a cross-check alongside local token resolution, BirdEye, DEX Screener, alternative.me sentiment, and CoinGecko global market conditions.

## Approval Boundary

CoinGecko facts can help an agent decide `approve`, `deny`, or `needs_input`. They never approve the plan themselves. If the agent approves a draft, it still moves through the existing Needs Approval path where the user signs with their wallet.

## Configuration

Set `COINGECKO_API_KEY` to use the Pro base URL. `COINGECKO_REST_BASE` can override the default base URL for local or hosted deployments.
