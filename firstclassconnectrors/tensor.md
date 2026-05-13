# Tensor First-Class Connector Plan

## Goal

Add a first-class Agentic connector for Tensor NFT marketplace reads and prepare-only marketplace actions.

V1 scope:

- Read supported Tensor collections.
- Read collection floor, top listings, top bids, recent sales, and market stats.
- Read wallet-owned NFTs and wallet marketplace exposure where API and SDK support it.
- Prepare buy/list/cancel-listing/bid/cancel-bid actions.
- Prepare capped collection sweep only when every item is individually previewed.

Do not include autonomous NFT trading, unlimited bid escrows, wash-trading detection claims, token launch support, leverage, loans, or price-lock style derivatives in v1.

## Current Repo State

Tensor is not in the current connector catalog.

Implementation will need to add it to:

- `apps/browser-demo/src/connectedDapps.ts`
- `packages/mcp-server/src/connectorRegistry.ts`
- `packages/mcp-server/src/adapters/types.ts`
- `packages/mcp-server/src/adapters/registry.ts`
- `packages/mcp-server/src/preparedActions.ts`
- `spec/connectors/tensor.connector.json`
- `docs/connectors/README.md`

Tensor should appear as `First-class marketplace connector`, not `Blink connector`.

## External Source Of Truth

Use official Tensor docs only for runtime behavior:

- Tensor API and SDK docs: https://docs.tensor.trade/trade/api-and-sdk
- Tensor REST API docs: https://docs.tensor.so/consume/rest-api
- Tensor protocol docs: https://docs.tensor.foundation/protocols

Important protocol facts to preserve:

- Tensor exposes marketplace APIs for traders and market makers, but access can require approval.
- Tensor public SDK packages include legacy marketplace and compressed marketplace SDKs:
  - `@tensor-oss/tensorswap-sdk`
  - `@tensor-oss/tcomp-sdk`
- Tensor protocol docs list separate programs for marketplace, AMM, escrow, whitelist, and fees.
- Known Tensor program ids from official protocol docs:
  - Marketplace: `TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp`
  - AMM: `TAMM6ub33ij1mbetoMyVBLeKY5iP41i4UPUJQGkhfsg`
  - Escrow: `TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN`
  - Whitelist: `TL1ST2iRBzuGTqLn1KXnGdSnEow62BzPnGiqyRXhWtW`
  - Fees: `TFEEgwDP6nn1s8mMX2tTNPPz8j2VomkphLUmyxKm17A`

## Dependencies

Shared runtime worker should add optional dependencies:

- `@tensor-oss/tensorswap-sdk`
- `@tensor-oss/tcomp-sdk`

Config:

- `TENSOR_API_KEY`: required for Tensor API reads where access is gated.
- `TENSOR_API_BASE_URL`: optional, default to official Tensor API base when approved by Tensor.

The connector must run in a degraded read/action-unavailable mode if API credentials or SDKs are missing.

## Proposed MCP Tools

Read tools:

- `solana_tensor_collection_snapshot`
- `solana_tensor_collection_listings`
- `solana_tensor_collection_bids`
- `solana_tensor_recent_sales`
- `solana_tensor_wallet_nfts`
- `solana_tensor_nft_detail`
- `solana_tensor_wallet_marketplace_exposure`

Prepare tools:

- `solana_prepare_tensor_buy`
- `solana_prepare_tensor_list`
- `solana_prepare_tensor_cancel_listing`
- `solana_prepare_tensor_bid`
- `solana_prepare_tensor_cancel_bid`
- `solana_prepare_tensor_sweep`

Prepared action kinds:

- `tensor_buy`
- `tensor_list`
- `tensor_cancel_listing`
- `tensor_bid`
- `tensor_cancel_bid`
- `tensor_sweep`

## Inputs

Collection snapshot:

- `collectionId`: required. Accept Tensor collection id, collection mint, or verified collection address.
- `includeListings`: optional boolean, default true.
- `includeBids`: optional boolean, default true.
- `maxListings`: optional integer, default 10, maximum 50.
- `maxBids`: optional integer, default 10, maximum 50.

Wallet NFTs:

- `walletAddress`: optional. Defaults to connected wallet.
- `collectionId`: optional.
- `includeCompressed`: optional boolean, default true.

NFT detail:

- `mintAddress` or `assetId`: required.
- `includeListing`: optional boolean, default true.
- `includeBids`: optional boolean, default true.

Buy:

- `mintAddress` or `assetId`: required.
- `collectionId`: required when the SDK needs collection context.
- `maxPriceSol`: required decimal string.
- `expectedSeller`: optional public key.
- `expectedMarketplace`: optional enum `tensor | any_tensor_supported`.
- `slippageBps`: optional, default 0 for fixed-price purchases.

List:

- `mintAddress` or `assetId`: required.
- `priceSol`: required decimal string.
- `expiresAt`: optional ISO timestamp.
- `allowCompressed`: optional boolean, default true.

Cancel listing:

- `mintAddress` or `assetId`: required.
- `listingId`: optional, required if multiple open listings exist.

Bid:

- `collectionId`: required for collection bid.
- `mintAddress` or `assetId`: optional for item bid.
- `bidPriceSol`: required decimal string.
- `quantity`: optional integer, default 1.
- `expiresAt`: optional ISO timestamp.
- `maxEscrowSol`: required decimal string for collection bids.

Cancel bid:

- `bidId`: required unless `collectionId` plus owner can identify one open bid.
- `collectionId`: optional.

Sweep:

- `collectionId`: required.
- `maxItems`: required integer, maximum 10 in v1.
- `maxTotalSol`: required decimal string.
- `maxPricePerItemSol`: required decimal string.
- `requiredMintAddresses`: optional array; if supplied, sweep can only buy those exact NFTs.
- `excludeMintAddresses`: optional array.
- `traitFilters`: optional read-only filter used only before prepare. Prepared action must store exact items.

## Adapter Design

Files:

```text
packages/mcp-server/src/adapters/tensor/constants.ts
packages/mcp-server/src/adapters/tensor/client.ts
packages/mcp-server/src/adapters/tensor/collections.ts
packages/mcp-server/src/adapters/tensor/wallet.ts
packages/mcp-server/src/adapters/tensor/listings.ts
packages/mcp-server/src/adapters/tensor/bids.ts
packages/mcp-server/src/adapters/tensor/actions.ts
packages/mcp-server/src/adapters/tensor/index.ts
```

`constants.ts` responsibilities:

- Store known Tensor program ids.
- Store max sweep item count, max stale quote age, and default market caps.
- Store action names and supported cluster list.

`client.ts` responsibilities:

- Build Tensor API client with API-key redaction.
- Dynamic import Tensor SDK packages.
- Detect compressed NFT support.
- Return typed unavailable reasons for `missingApiKey`, `sdkUnavailable`, `unsupportedCluster`, and `apiUnavailable`.

`collections.ts` responsibilities:

- Resolve collection aliases to Tensor collection identifiers.
- Fetch floor, top listings, top bids, volume, and recent sales.
- Normalize prices to SOL decimal strings and lamports.
- Attach `asOf` and API source metadata.

`wallet.ts` responsibilities:

- Read wallet NFTs, compressed assets, listed items, open bids, escrow exposure, and collection concentration.
- Never infer verified ownership from off-chain metadata alone when on-chain owner data is available.

`actions.ts` responsibilities:

- Build unsigned Tensor SDK transactions.
- Produce a prepared action with exact mint/listing/bid ids.
- Refresh listing or bid state at execution before wallet approval.

## Prepared Action Payload

Every Tensor action should store:

- `connectorId: "tensor"`
- `operation`
- `walletAddress`
- `cluster`
- `collectionId`
- `mintAddress` or `assetId`
- `listingId` or `bidId` when present
- `priceSol`
- `priceLamports`
- `maxPriceSol`
- `maxTotalSol`
- `maxEscrowSol`
- `feePreview`
- `royaltyPreview`
- `compressed`
- `programIds`
- `apiSnapshot`
- `marketSnapshot`
- `exactSweepItems` for sweep
- `transactionBase64` only if reusable
- `refreshAtExecution: true`

Sweep prepared actions must store the exact assets selected at prepare time. Execution must not replace them with different items unless the user creates a new prepared action.

## Safety Checks

- Reject unsupported clusters.
- Reject buy if current price exceeds `maxPriceSol`.
- Reject sweep if item count exceeds max or total exceeds `maxTotalSol`.
- Reject sweep if any exact item is no longer listed.
- Reject listing if wallet does not own the NFT.
- Reject cancel listing/bid if wallet is not the owner.
- Reject bid if required escrow exceeds `maxEscrowSol`.
- Warn when collection verification is missing or ambiguous.
- Warn when collection floor changed since prepare.
- Warn when listing has unusual royalty or fee data.
- Warn when compressed NFT handling is required.
- Warn when the item has suspicious metadata, frozen state, or missing creator verification if the API exposes it.
- Do not create unlimited delegate authorities in v1.
- Do not auto-renew bids or listings.
- Do not claim rarity, price, or profitability as guaranteed.

## Tests

Unit tests:

- Missing API key returns structured readiness reason.
- Missing SDK returns `sdkUnavailable`.
- Collection snapshot normalizes listings and bids.
- Buy prepare rejects stale or above-cap listing.
- List prepare rejects non-owned NFT.
- Bid prepare rejects escrow above cap.
- Sweep prepare rejects more than 10 items.
- Execute path refreshes listing state and blocks changed item/price.
- API errors redact `TENSOR_API_KEY`.

Mock tests:

- Tensor API collection success.
- Tensor API wallet NFTs success.
- Legacy SDK transaction serialization.
- Compressed SDK transaction serialization.
- Collection bid escrow preview.

Smoke prompts:

- "Show the Tensor floor and top bids for this collection."
- "Show my Tensor-listed NFTs."
- "Prepare buying this NFT on Tensor for no more than 1.2 SOL. Do not sign."
- "Prepare listing this NFT on Tensor for 2 SOL."
- "Prepare a Tensor collection bid capped at 5 SOL escrow."
- "Prepare sweeping the three cheapest listed items under 0.3 SOL each."

## Completion Checklist

- Tensor appears in `/app` preferences as first-class.
- `solana_connector_capabilities tensor` reports marketplace reads and prepared actions.
- Collection reads work with API config.
- Buy/list/bid/cancel prepare actions create approval inbox items.
- Sweep is capped, itemized, and refreshed at execution.
- No Tensor path signs before wallet approval.
