# Jupiter Prediction Connector Plan

## Goal

Add read-first Jupiter Prediction API beta support.

V1 scope:

- Read events and markets.
- Search events.
- Read event details and suggested events.
- Read market detail and orderbook.
- Read wallet orders, order status, positions, position detail, history, and vault info.
- Mark every response as beta and subject to change.

Do not implement create order, close position, close all positions, or claim payout in v1 unless the user separately approves beta write support.

## Current Repo State

Jupiter Prediction is not in the current connector catalog.

It should be a Jupiter capability group, not a separate connector id:

- `connectorId: "jupiter"`
- `capability: "prediction"`

No existing prepared action kinds should be added in read-only v1.

## External Source Of Truth

Use official Jupiter Prediction docs:

- Prediction API beta: https://developers.jup.ag/docs/api-reference/prediction/get-events
- Get events/search/event/markets/orderbook/orders/positions/history pages under the official Prediction docs.

Important facts:

- The Prediction API is marked beta.
- It requires `x-api-key`.
- It supports events, markets, orders, positions, history/data, profile/social, and vault endpoints.
- Providers can include Polymarket and Kalshi where supported by query params.
- Events can be filtered by categories such as crypto, sports, politics, esports, culture, economics, and tech.
- Some endpoints can request unsigned transactions for order creation, close position, close all positions, and claim payout, but these are out of v1 scope.

## Dependencies

No new dependency is required.

Config:

- `JUPITER_API_KEY` or `JUP_API_KEY`: required.
- `JUPITER_PREDICTION_BASE_URL`: optional, default `https://api.jup.ag/prediction/v1`.
- `connectors.jupiter.prediction.enabled`: default false until beta UI copy is added.
- `connectors.jupiter.prediction.readOnly`: default true.

## Proposed MCP Tools

Read tools:

- `solana_jupiter_prediction_events`
- `solana_jupiter_prediction_search_events`
- `solana_jupiter_prediction_event_detail`
- `solana_jupiter_prediction_event_markets`
- `solana_jupiter_prediction_market_detail`
- `solana_jupiter_prediction_orderbook`
- `solana_jupiter_prediction_orders`
- `solana_jupiter_prediction_order_status`
- `solana_jupiter_prediction_positions`
- `solana_jupiter_prediction_history`
- `solana_jupiter_prediction_vault_info`

Prepared action kinds:

- None in v1.

Reserved future action kinds:

- `jupiter_prediction_create_order`
- `jupiter_prediction_close_position`
- `jupiter_prediction_close_all_positions`
- `jupiter_prediction_claim_position`

## Inputs

Events:

- `provider`: optional enum `polymarket | kalshi`, default `polymarket`.
- `includeMarkets`: optional boolean.
- `category`: optional enum `all | crypto | sports | politics | esports | culture | economics | tech`.
- `sortBy`: optional enum `volume | beginAt`.
- `sortDirection`: optional enum `asc | desc`.
- `filter`: optional enum `new | live | trending`.
- `start`: optional integer.
- `end`: optional integer.

Search events:

- `query`: required string.
- `provider`: optional enum `polymarket | kalshi`.
- `limit`: optional integer.

Event detail:

- `eventId`: required.
- `includeMarkets`: optional boolean, default true.

Market detail:

- `marketId`: required.

Orderbook:

- `marketId`: required.

Orders:

- `owner`: optional. Defaults to connected wallet when wallet-scoped.
- `marketId`: optional.
- `status`: optional enum `pending | filled | failed | all`.

Positions:

- `owner`: optional. Defaults to connected wallet.
- `marketId`: optional.
- `eventId`: optional.

History:

- `owner`: optional. Defaults to connected wallet.
- `marketId`: optional.
- `eventId`: optional.
- `limit`: optional integer.

Vault info:

- `owner`: optional. Defaults to connected wallet.

## Adapter Design

Files:

```text
packages/mcp-server/src/adapters/jupiter/predictionClient.ts
packages/mcp-server/src/adapters/jupiter/predictionEvents.ts
packages/mcp-server/src/adapters/jupiter/predictionMarkets.ts
packages/mcp-server/src/adapters/jupiter/predictionWallet.ts
packages/mcp-server/src/adapters/jupiter/predictionEvidence.ts
```

`predictionClient.ts` responsibilities:

- Call Prediction API with `x-api-key`.
- Add beta warning metadata to every response.
- Redact API key.
- Normalize rate limits, unavailable responses, and schema changes.

`predictionEvents.ts` responsibilities:

- Read and normalize events, event metadata, categories, close times, rules links, market list, and pricing.

`predictionMarkets.ts` responsibilities:

- Read market detail and orderbook.
- Normalize YES/NO prices, volume, status, result, rules, and close/resolve times.

`predictionWallet.ts` responsibilities:

- Read wallet orders, positions, history, and vault facts.
- Normalize owner, order pubkey, position pubkey, fill status, settlement, and claimability.

`predictionEvidence.ts` responsibilities:

- Return compact beta evidence for planner Q&A and read-only reviews.

## Response Shape

Every read response should include:

- `connectorId: "jupiter"`
- `product: "prediction"`
- `beta: true`
- `apiBaseUrlHost`
- `asOf`
- `data`
- `warnings`

Warnings should always include a beta warning until Jupiter removes beta status from official docs.

## Safety Checks

- Reject missing API key.
- Reject write requests in v1 with `unsupported_method`.
- Warn that Prediction API is beta and subject to breaking changes.
- Warn that market outcomes and rules come from external providers.
- Warn that orderbook/prices can change quickly.
- Warn when market status is closed, resolved, paused, or unknown.
- Do not claim odds imply truth.
- Do not create orders, close positions, or claim payouts in v1.

## Tests

Unit tests:

- Missing API key returns readiness reason.
- Events read includes beta warning.
- Event filters serialize correctly.
- Market detail normalizes status and prices.
- Orderbook normalizes YES/NO books.
- Wallet positions default to connected wallet.
- Write-like prediction request returns unsupported.
- API errors redact API key.

Mock API tests:

- Get events success.
- Search events success.
- Get event markets success.
- Get orderbook success.
- Get orders success.
- Get positions success.
- Get history success.
- Vault info success.

Smoke prompts:

- "Show live Jupiter prediction markets for crypto."
- "Search Jupiter prediction events for election markets."
- "Show the orderbook for this Jupiter prediction market."
- "Show my Jupiter prediction positions."
- "Create a prediction order." Expected: deny in v1, beta writes not enabled.
- "Claim my prediction payout." Expected: deny in v1, explain reserved future action.

## Completion Checklist

- Prediction appears under Jupiter read capabilities.
- Every response includes beta warning metadata.
- Wallet-scoped reads work.
- Write requests are denied clearly.
- No Prediction path signs before wallet approval because no v1 writes exist.
