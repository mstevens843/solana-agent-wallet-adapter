# Tensor Connector

Tensor is a first-class Solana NFT marketplace connector. The MCP runtime owns the adapter for reads (collection snapshots, listings, bids, recent sales, wallet NFTs, NFT detail, wallet marketplace exposure) and prepare-only buy, list, cancel-listing, bid, cancel-bid, and capped-sweep actions. Transaction building is delegated to a host-wired Tensor client (legacy via `@tensor-oss/tensorswap-sdk`, compressed via `@tensor-oss/tcomp-sdk`); the wallet always signs.

## Requirements

- Mainnet-beta only. Tensor protocol IDs are not deployed to devnet/testnet/localnet.
- `TENSOR_API_KEY` must be set in the host environment for collection, listing, bid, and wallet reads.
- The host must call `setTensorClientFactory(buildTensorClient)` at boot. Without it, every read and prepare fails with a structured `sdk_unavailable` reason.
- `TENSOR_API_BASE_URL` is optional; defaults to the official Tensor API base.
- The API key is sent only as a header. It is never stored in receipts, prepared-action params, notes, warnings, or browser state, and it is redacted from any error message via `redactApiKey` before the error reaches the agent or user.

## What It Can Read

- `solana_tensor_collection_snapshot` returns floor price (lamports + SOL), listed count, total supply, 24h volume, top collection bid, verification flag, plus optional top listings and bids.
- `solana_tensor_collection_listings` returns the cheapest listings (price, seller, listing id, compressed flag, marketplace).
- `solana_tensor_collection_bids` returns the top bids (bidder, bid price, quantity, escrow).
- `solana_tensor_recent_sales` returns recent marketplace sales (signature, mint, price, buyer/seller, marketplace, compressed flag).
- `solana_tensor_wallet_nfts` returns wallet-owned NFTs with listed status and compressed flag. Defaults to the connected wallet. Includes compressed assets when `includeCompressed` is true (default).
- `solana_tensor_nft_detail` returns one NFT by mint or asset id with owner, top listing, top bids, royalty, frozen flag, and warnings.
- `solana_tensor_wallet_marketplace_exposure` returns open listings, open bids, owned collections, and margin escrow balance for the wallet.

## What It Can Prepare

- `solana_prepare_tensor_buy` prepares a `tensor_buy` inbox item capped by `maxPriceSol`. Refuses if the current listing price exceeds the cap, if the seller does not match `expectedSeller`, if the marketplace does not match `expectedMarketplace`, or if the listing is no longer active or the snapshot is stale.
- `solana_prepare_tensor_list` prepares a `tensor_list` inbox item. Refuses when the wallet does not own the mint or the NFT is frozen.
- `solana_prepare_tensor_cancel_listing` prepares a `tensor_cancel_listing` inbox item. Requires `listingId` when multiple open listings exist for the same NFT.
- `solana_prepare_tensor_bid` prepares a `tensor_bid` inbox item (item or collection bid) capped by `maxEscrowSol`. Refuses when `currentEscrow + bidPriceLamports * quantity` exceeds the cap.
- `solana_prepare_tensor_cancel_bid` prepares a `tensor_cancel_bid` inbox item by bid id. Requires `bidId` when multiple open bids exist.
- `solana_prepare_tensor_sweep` prepares a `tensor_sweep` inbox item with up to ten exact items. Each item must satisfy the per-item cap; the total must satisfy the total cap; all items must share the same compressed flag. Execution refreshes each listing and refuses if any item is delisted, sold, repriced, or its compressed flag flipped.
- `solana_execute_prepared_action` sends the prepared item to the wallet after refreshing listing or bid state and rebuilding the transaction.

## Required Inputs

- Buy: `maxPriceSol`, plus one of `mintAddress` (legacy) or `assetId` (compressed). Optional: `collectionId`, `expectedSeller`, `expectedMarketplace`.
- List: `priceSol`, plus one of `mintAddress` or `assetId`. Optional: `expiresAt`.
- Cancel listing: one of `mintAddress` or `assetId`. Optional: `listingId`.
- Bid: `collectionId`, `bidPriceSol`, `maxEscrowSol`. Optional: `mintAddress`/`assetId` (item bid), `quantity`, `expiresAt`.
- Cancel bid: optional `bidId` (required when multiple bids exist) and optional `collectionId`.
- Sweep: `collectionId`, `maxItems` (≤ 10), `maxTotalSol`, `maxPricePerItemSol`. Optional: `requiredMintAddresses`, `excludeMintAddresses`.
- Optional across all: `dueAt` for delayed inbox readiness; `note` for free-form context.

Ask concise questions when fields are missing:

- "Which Tensor collection should I use?"
- "Which NFT mint or compressed asset id should I act on?"
- "What is the maximum SOL price you will pay?"
- "What is the maximum SOL the wallet may lock in Tensor escrow?"

## Required Facts

- Tensor collection id, floor price, and listed count before any buy or sweep review.
- Current listing price, seller, marketplace, and compressed flag before buy and cancel-listing prepares.
- Wallet ownership of the mint (`getNftDetail.owner === walletAddress`) before list prepares.
- Wallet margin escrow balance before bid prepares.
- Exact sweep items with per-item expected price and a homogeneous compressed flag.
- Royalty and fee preview from the Tensor SDK build for every prepared action.

## Deny Or Ask

Deny any request that:

- Asks for autonomous trading, unlimited bid escrows, or delegated escrow authorities.
- Promises rarity, profitability, wash-trade detection, or guaranteed-safe sweeps.
- Targets devnet, testnet, or localnet.
- Mixes legacy and compressed NFTs in one sweep.
- Asks the agent to sweep more than 10 items in one prepared action.
- Asks the agent to buy at or below a cap that the current Tensor listing exceeds.
- Asks the agent to list, cancel listing, or cancel bid for an NFT or bid the wallet does not own.
- Asks the agent to bid such that escrow + delta would exceed `maxEscrowSol`.
- Asks the agent to sign, submit, or claim ownership of the on-chain transaction.

Ask when collection id, mint or asset id, price cap, escrow cap, or sweep items are missing.

## User Approval

Tensor writes create prepared actions. They do not sign, submit, or grant delegated authority. At execution time the adapter refreshes listing and bid state, re-validates caps and ownership, rebuilds the unsigned transaction via the host-wired Tensor client, and routes through `signAndBroadcast`. Sweep transactions are always rebuilt at execute — the prepared `transactionBase64` is never reused — so race conditions surface as `state_changed` errors instead of silently sweeping different items.

## API Key And Redaction

`TENSOR_API_KEY` is the only secret the adapter touches and the adapter routes every error message through `redactApiKey` before throwing. Receipts, prepared-action params, and warnings never include the key. Tests assert that the env value cannot appear in thrown messages.
