# Pyth First-Class Connector Plan

## Goal

Add a first-class Agentic connector for Pyth oracle facts and optional price-update posting.

V1 scope:

- Read Pyth price feeds through official Hermes/Price Service APIs.
- Read Solana price-feed account state where useful.
- Return staleness, confidence interval, publish time, exponent, and source facts.
- Provide connector-wide oracle evidence to other protocol planners.
- Optionally prepare a Solana price-update posting transaction when an app or protocol flow needs fresh on-chain price data.

Do not include trading signals, autonomous liquidation actions, price manipulation claims, publisher/admin actions, or custom oracle configuration in v1.

## Current Repo State

Pyth is not in the current connector catalog.

Implementation will need to add it to:

- `apps/browser-demo/src/connectedDapps.ts`
- `packages/mcp-server/src/connectorRegistry.ts`
- `packages/mcp-server/src/adapters/types.ts`
- `packages/mcp-server/src/adapters/registry.ts`
- `packages/mcp-server/src/preparedActions.ts`
- `spec/connectors/pyth.connector.json`
- `docs/connectors/README.md`

Pyth should appear as `First-class oracle connector`.

## External Source Of Truth

Use official Pyth docs:

- Pyth docs: https://docs.pyth.network/
- Solana price-feed docs: https://docs.pyth.network/price-feeds/use-real-time-data/solana
- Hermes docs: https://docs.pyth.network/price-feeds/api-instances-and-providers/hermes
- Pyth Solana receiver docs when posting price updates is implemented.

Important protocol facts to preserve:

- Pyth price data includes price, confidence interval, exponent, and publish time.
- Hermes provides price update data that can be consumed off-chain or posted on-chain through receiver flows.
- A read-only oracle fact is not a trade recommendation.
- Posting an update costs transaction fees and should be wallet-approved if done from the user's wallet.

## Dependencies

Shared runtime worker should add optional dependencies as needed:

- `@pythnetwork/hermes-client`
- `@pythnetwork/pyth-solana-receiver`

Config:

- `PYTH_HERMES_URL`: optional, default `https://hermes.pyth.network`.
- `PYTH_CONNECTOR_ENABLED`: optional feature flag during rollout.

No API key is required for public Hermes reads unless a private provider endpoint is configured.

## Proposed MCP Tools

Read tools:

- `solana_pyth_price_feed`
- `solana_pyth_price_feeds_batch`
- `solana_pyth_feed_search`
- `solana_pyth_onchain_price_account`
- `solana_pyth_oracle_evidence`

Prepare tools:

- `solana_prepare_pyth_post_price_update`

Prepared action kinds:

- `pyth_post_price_update`

The prepare tool is optional for v1. Read tools should ship first.

## Inputs

Price feed:

- `priceFeedId`: required unless `symbol` is supplied.
- `symbol`: optional convenience alias resolved through official metadata.
- `maxAgeSeconds`: optional, default connector risk config.
- `includeEma`: optional boolean, default true.

Price feeds batch:

- `priceFeedIds`: required array.
- `maxAgeSeconds`: optional.
- `includeEma`: optional boolean, default true.

Feed search:

- `query`: required string.
- `assetType`: optional enum `crypto | equity | fx | commodity | all`, default `crypto`.
- `limit`: optional integer, default 20.

On-chain price account:

- `priceFeedId` or `priceAccount`: required.
- `includeRawAccount`: optional boolean, default false.

Oracle evidence:

- `priceFeedId` or `symbol`: required.
- `consumerProtocol`: optional string, used only for evidence labels.
- `maxAgeSeconds`: optional.
- `maxConfidenceBps`: optional.

Post price update:

- `priceFeedIds`: required array.
- `maxAgeSeconds`: optional.
- `payerAddress`: optional. Defaults to connected wallet.
- `consumerTransactionId`: optional local reference if another prepared action needs this update first.

## Adapter Design

Files:

```text
packages/mcp-server/src/adapters/pyth/constants.ts
packages/mcp-server/src/adapters/pyth/client.ts
packages/mcp-server/src/adapters/pyth/feeds.ts
packages/mcp-server/src/adapters/pyth/prices.ts
packages/mcp-server/src/adapters/pyth/evidence.ts
packages/mcp-server/src/adapters/pyth/actions.ts
packages/mcp-server/src/adapters/pyth/index.ts
```

`constants.ts` responsibilities:

- Store Hermes default URL.
- Store freshness and confidence defaults.
- Store receiver program ids only from official docs/SDK.

`client.ts` responsibilities:

- Build Hermes client.
- Dynamic import Pyth SDKs.
- Normalize feed ids, price values, exponents, publish times, and API errors.

`feeds.ts` responsibilities:

- Search and resolve feed metadata.
- Keep alias resolution explicit and evidence-backed.

`prices.ts` responsibilities:

- Fetch latest price updates.
- Normalize price, confidence, exponent, EMA, publish time, and stale status.
- Convert to user-facing decimal strings without losing raw values.

`evidence.ts` responsibilities:

- Create compact oracle evidence for other connectors.
- Return status values like `fresh`, `stale`, `wide_confidence`, `missing`, and `api_unavailable`.

`actions.ts` responsibilities:

- Build optional unsigned transaction for posting price updates to Solana.
- Avoid posting updates unless a downstream protocol flow or explicit user request needs it.

## Prepared Action Payload

Store:

- `connectorId: "pyth"`
- `operation`
- `walletAddress`
- `cluster`
- `priceFeedIds`
- `maxAgeSeconds`
- `priceSnapshot`
- `confidenceSnapshot`
- `publishTime`
- `hermesUrlHost`
- `programIds`
- `consumerTransactionId`
- `transactionBase64` only if reusable
- `refreshAtExecution: true`

## Safety Checks

- Reject unsupported clusters for post-update actions.
- Reject unknown price feed id.
- Reject stale price when `maxAgeSeconds` is exceeded.
- Reject oracle evidence when confidence is wider than `maxConfidenceBps`.
- Reject post update if Hermes data is unavailable.
- Warn when price feed alias resolution is ambiguous.
- Warn when price is stale or confidence interval is wide.
- Warn that Pyth data is evidence, not a guarantee or trade instruction.
- Do not generate trading recommendations in this connector.
- Do not expose publisher/admin actions in v1.

## Tests

Unit tests:

- Price feed normalizes exponent and confidence.
- Batch read returns per-feed status.
- Feed search handles no results and ambiguous aliases.
- Oracle evidence marks stale prices.
- Oracle evidence marks wide confidence.
- Post price update prepare rejects missing SDK.
- Hermes errors do not leak private endpoint auth if configured.

Mock tests:

- Hermes single price success.
- Hermes batch price success.
- Feed metadata search success.
- On-chain account read success.
- Price update transaction serialization.

Smoke prompts:

- "Show the current Pyth SOL/USD price with confidence and publish time."
- "Check whether this Pyth feed is fresh enough for a lending action."
- "Compare Pyth prices for SOL, JitoSOL, and mSOL."
- "Prepare posting a fresh Pyth price update for this feed. Do not sign."
- "Give oracle evidence for this protocol plan."

## Completion Checklist

- Pyth appears in `/app` preferences as first-class oracle.
- Price-feed reads work without wallet approval.
- Oracle evidence can be consumed by other connector planners.
- Optional post-update prepare creates approval inbox items only when requested.
- No Pyth path signs before wallet approval.
