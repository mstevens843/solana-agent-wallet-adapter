# Magic Eden First-Class Connector Plan

## Goal

Add a first-class Agentic connector for Magic Eden Solana NFT marketplace reads and prepare-only marketplace actions.

V1 scope:

- Read Solana collection metadata, listings, bids, activities, and wallet NFTs where API access allows it.
- Prepare buy, list, cancel listing, bid, and cancel bid actions for Solana NFTs.
- Show clear API health and support status because Magic Eden has announced broader API infrastructure changes.

Do not include Bitcoin, EVM, Runes, wallet services, launchpad admin actions, royalty policy overrides, or cross-chain NFT flows in v1.

## Current Repo State

Magic Eden is not in the current connector catalog.

Implementation will need to add it to:

- `apps/browser-demo/src/connectedDapps.ts`
- `packages/mcp-server/src/connectorRegistry.ts`
- `packages/mcp-server/src/adapters/types.ts`
- `packages/mcp-server/src/adapters/registry.ts`
- `packages/mcp-server/src/preparedActions.ts`
- `spec/connectors/magiceden.connector.json`
- `docs/connectors/README.md`

Magic Eden should appear as `First-class marketplace connector`.

## External Source Of Truth

Use official Magic Eden sources:

- Developer docs: https://docs.magiceden.io/
- Solana API reference: https://docs.magiceden.io/reference
- API infrastructure notice: https://help.magiceden.io/en/articles/13885533-magic-eden-api-infrastructure-changes

Important integration facts to preserve:

- Magic Eden provides marketplace data and trading endpoints for NFTs.
- Some endpoints are API-key gated and rate-limited.
- Magic Eden's February 27, 2026 infrastructure notice says the Solana API remains operational for now, while broader API support is being evaluated.
- The connector must be feature-flagged and health-checked because API support can change.

## Dependencies

No required SDK dependency in v1 unless Magic Eden publishes a stable SDK for the exact Solana trading endpoints.

Config:

- `MAGICEDEN_API_KEY`: required for gated Solana API endpoints.
- `MAGICEDEN_API_BASE_URL`: optional, default to official Solana API base.
- `MAGICEDEN_CONNECTOR_ENABLED`: optional feature flag, default false until API health checks are implemented.

The connector should work read-first. Write tools should remain unavailable if the API cannot generate stable unsigned transactions.

## Proposed MCP Tools

Read tools:

- `solana_magiceden_api_health`
- `solana_magiceden_collection_snapshot`
- `solana_magiceden_collection_listings`
- `solana_magiceden_collection_bids`
- `solana_magiceden_recent_activity`
- `solana_magiceden_wallet_nfts`
- `solana_magiceden_nft_detail`

Prepare tools:

- `solana_prepare_magiceden_buy`
- `solana_prepare_magiceden_list`
- `solana_prepare_magiceden_cancel_listing`
- `solana_prepare_magiceden_bid`
- `solana_prepare_magiceden_cancel_bid`

Prepared action kinds:

- `magiceden_buy`
- `magiceden_list`
- `magiceden_cancel_listing`
- `magiceden_bid`
- `magiceden_cancel_bid`

## Inputs

API health:

- `includeTradingEndpoints`: optional boolean, default true.

Collection snapshot:

- `collectionSymbol` or `collectionId`: required.
- `includeListings`: optional boolean, default true.
- `includeBids`: optional boolean, default true.
- `limit`: optional integer, default 20, maximum 100.

Wallet NFTs:

- `walletAddress`: optional. Defaults to connected wallet.
- `collectionSymbol` or `collectionId`: optional.
- `listedOnly`: optional boolean.

NFT detail:

- `mintAddress`: required.
- `includeListing`: optional boolean, default true.
- `includeBids`: optional boolean, default true.

Buy:

- `mintAddress`: required.
- `collectionSymbol` or `collectionId`: optional but recommended.
- `maxPriceSol`: required decimal string.
- `expectedSeller`: optional public key.
- `expectedListingId`: optional.

List:

- `mintAddress`: required.
- `priceSol`: required decimal string.
- `expiresAt`: optional ISO timestamp.

Cancel listing:

- `mintAddress`: required.
- `listingId`: optional.

Bid:

- `collectionSymbol` or `collectionId`: required for collection bids.
- `mintAddress`: optional for item bids.
- `bidPriceSol`: required decimal string.
- `quantity`: optional integer, default 1.
- `maxEscrowSol`: required decimal string for collection bids.
- `expiresAt`: optional ISO timestamp.

Cancel bid:

- `bidId`: required unless owner plus collection uniquely identifies one bid.
- `collectionSymbol` or `collectionId`: optional.

## Adapter Design

Files:

```text
packages/mcp-server/src/adapters/magiceden/constants.ts
packages/mcp-server/src/adapters/magiceden/client.ts
packages/mcp-server/src/adapters/magiceden/health.ts
packages/mcp-server/src/adapters/magiceden/collections.ts
packages/mcp-server/src/adapters/magiceden/wallet.ts
packages/mcp-server/src/adapters/magiceden/actions.ts
packages/mcp-server/src/adapters/magiceden/index.ts
```

`client.ts` responsibilities:

- Build authenticated Magic Eden Solana API client.
- Redact API key from all logs, errors, receipts, and prepared-action params.
- Normalize rate-limit and unavailable responses.
- Expose `apiOperational`, `tradingOperational`, and `readOnlyFallback` status.

`health.ts` responsibilities:

- Run lightweight endpoint checks.
- Disable write actions when trading endpoints are unavailable or unsupported.
- Return user-facing readiness reasons.

`collections.ts` responsibilities:

- Fetch and normalize collection listings, bids, floor, recent activity, and metadata.
- Include `asOf`, `apiBaseHost`, and rate-limit status when available.

`wallet.ts` responsibilities:

- Fetch wallet NFTs and marketplace exposure.
- Distinguish wallet ownership from listed custody or escrow state where the API exposes it.

`actions.ts` responsibilities:

- Use official trading transaction endpoints only if they return unsigned Solana transactions.
- Validate touched programs and exact listing/bid identifiers.
- Store transaction preview and refresh state at execution.

## Prepared Action Payload

Store:

- `connectorId: "magiceden"`
- `operation`
- `walletAddress`
- `cluster`
- `collectionSymbol`
- `collectionId`
- `mintAddress`
- `listingId`
- `bidId`
- `priceSol`
- `priceLamports`
- `maxPriceSol`
- `maxEscrowSol`
- `feePreview`
- `royaltyPreview`
- `apiHealthSnapshot`
- `marketSnapshot`
- `programIds`
- `transactionBase64` only if API marks it reusable
- `refreshAtExecution: true`

## Safety Checks

- Reject write actions if Magic Eden API health says trading endpoint is unavailable.
- Reject unsupported clusters.
- Reject buy if listing price exceeds `maxPriceSol`.
- Reject buy if listing id, seller, mint, or price changed since prepare.
- Reject list if wallet does not own the NFT.
- Reject bid if required escrow exceeds `maxEscrowSol`.
- Warn when the API health check is degraded.
- Warn when endpoint support could change because of Magic Eden API transition.
- Warn when collection verification is missing or ambiguous.
- Warn when royalties, marketplace fees, or creator data are unavailable.
- Do not support Bitcoin or EVM endpoints in this Solana connector.
- Do not hide API deprecation/support risk from planner output.

## Tests

Unit tests:

- Missing API key returns structured readiness reason.
- Disabled feature flag blocks live API calls.
- API health controls write availability.
- Collection snapshot normalizes listing and bid data.
- Buy prepare rejects price above cap.
- Buy execute refresh blocks changed listing id or price.
- API errors redact `MAGICEDEN_API_KEY`.
- Unsupported endpoint returns `unsupported_method`.

Mock API tests:

- Health success and degraded states.
- Rate-limited reads.
- Collection listings success.
- Wallet NFTs success.
- Trading transaction generation success.

Smoke prompts:

- "Check Magic Eden API health."
- "Show Magic Eden listings for this collection."
- "Show my Magic Eden listed NFTs."
- "Prepare buying this NFT on Magic Eden for no more than 1 SOL. Do not sign."
- "Prepare listing this NFT on Magic Eden for 1.5 SOL."
- "Prepare canceling my Magic Eden listing for this mint."

## Completion Checklist

- Magic Eden appears in `/app` preferences as first-class but health-gated.
- Read tools explain missing API key, rate limit, or API transition issues.
- Trading tools only enable when official unsigned transaction endpoints work.
- Buy/list/bid/cancel create approval inbox items.
- Execution refreshes exact listing/bid state.
- No Magic Eden path signs before wallet approval.
