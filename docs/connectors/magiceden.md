# Magic Eden Connector

Magic Eden is a first-class Solana NFT marketplace connector. The MCP runtime owns the adapter for reads (API health, collection snapshots, listings, bids, recent activity, wallet NFTs, NFT detail) and prepare-only buy, list, cancel-listing, bid, and cancel-bid actions. Transaction building is delegated to the Magic Eden API; the wallet always signs.

## Requirements

- Mainnet-beta only; Solana NFTs only. Bitcoin, EVM, and Runes are out of scope.
- `MAGICEDEN_API_KEY` must be set in the host environment for live reads and prepared actions.
- `MAGICEDEN_CONNECTOR_ENABLED` must equal `true` to enable the connector. This feature flag guards against the 2026-02-27 Magic Eden API infrastructure transition.
- `MAGICEDEN_API_BASE_URL` is optional; defaults to `https://api-mainnet.magiceden.dev/v2`.
- The API key is sent only as the `Authorization: Bearer` request header. It is never stored in receipts, prepared-action params, notes, warnings, or browser state, and it is redacted from any error message before the error reaches the agent or user.

## What It Can Read

- `solana_magiceden_api_health` probes the read and trading endpoints and returns operational flags, rate-limit information, and the active API-transition warning. Use this before any write prepare.
- `solana_magiceden_collection_snapshot` returns collection metadata, floor price, listed count, top bid, royalty (when reported), and optional listing/bid rows.
- `solana_magiceden_collection_listings` returns active listings with price, seller, listing id, and auction house.
- `solana_magiceden_collection_bids` returns active collection bids with price, buyer, and bid id.
- `solana_magiceden_recent_activity` returns recent on-marketplace activity (list, delist, buy_now, bid, accept_bid, transfer, mint).
- `solana_magiceden_wallet_nfts` returns the wallet's Magic Eden NFTs with listed-vs-held breakdown. Defaults to the connected wallet.
- `solana_magiceden_nft_detail` returns one NFT by mint with ownership, current listing, top bid, last sale, and royalty when available.

## What It Can Prepare

- `solana_prepare_magiceden_buy` prepares a `magiceden_buy` inbox item capped by `maxPriceSol`. Refuses if the listing price exceeds the cap, if the seller is wrong, or if the listing id no longer matches at execution time.
- `solana_prepare_magiceden_list` prepares a `magiceden_list` inbox item. Refuses when the wallet does not own the mint per Magic Eden.
- `solana_prepare_magiceden_cancel_listing` prepares a `magiceden_cancel_listing` inbox item for the wallet's active listing.
- `solana_prepare_magiceden_bid` prepares a `magiceden_bid` inbox item (item or collection bid) capped by `maxEscrowSol`. Refuses when required escrow exceeds the cap.
- `solana_prepare_magiceden_cancel_bid` prepares a `magiceden_cancel_bid` inbox item by bid id, mint, or collection.
- `solana_execute_prepared_action` sends the prepared item to the wallet after refreshing listing or bid state.

## Required Inputs

- Buy: `mintAddress`, `maxPriceSol`. Optional: `collectionSymbol`/`collectionId`, `expectedSeller`, `expectedListingId`.
- List: `mintAddress`, `priceSol`. Optional: `expiresAt`.
- Cancel listing: `mintAddress`. Optional: `listingId`.
- Bid: `bidPriceSol`, `maxEscrowSol`, plus either `mintAddress` (item bid) or `collectionSymbol`/`collectionId` (collection bid). Optional: `quantity`, `expiresAt`.
- Cancel bid: at least one of `bidId`, `mintAddress`, or `collectionSymbol`/`collectionId`.
- Optional: `dueAt` for delayed inbox readiness; `note` for free-form context.

Ask concise questions when fields are missing:

- "Which NFT mint should Magic Eden use?"
- "What is the maximum price (in SOL) you will pay?"
- "What list price (in SOL)?"
- "What bid price and what maximum SOL may Magic Eden lock in escrow?"

## Required Facts

- Magic Eden API health snapshot (trading endpoints operational) before any write prepare.
- Active listing row before buy prepare or execute (price, seller, listing id).
- Wallet ownership of the mint before list prepare or execute.
- Required escrow lamports versus the `maxEscrowSol` cap before bid prepare.
- Verified collection flag and royalty basis points where the API exposes them. Missing data is a warning, never a silent zero.

## Deny Or Ask

Deny any request that:

- Promises guaranteed sales, floor support, or speculative returns.
- Targets devnet or testnet.
- Targets Bitcoin, Runes, or EVM NFTs.
- Asks the agent to move funds without wallet approval or to sign autonomously.
- Tries to use Magic Eden when `MAGICEDEN_API_KEY` is missing or `MAGICEDEN_CONNECTOR_ENABLED` is not `true`.

Ask when mint, price cap, escrow cap, or bid scope is missing.

## User Approval

Magic Eden writes create prepared actions. They do not sign, submit, or grant delegated authority. At execution time the adapter re-calls the Magic Eden trading endpoints, refuses on any listing or bid drift (price, seller, listing id, ownership), and only the wallet signs and broadcasts.

## API Transition Note

Magic Eden's 2026-02-27 announcement put broader API support under review while keeping the Solana API operational. Every prepared action carries the warning so the user can see why the connector remains feature-flagged. If `solana_magiceden_api_health` reports degraded trading endpoints, writes are refused with a `health_degraded` reason rather than silently failing later.
