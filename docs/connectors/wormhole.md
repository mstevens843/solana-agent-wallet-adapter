# Wormhole Connector

Wormhole is the first-class bridge connector. The MCP runtime owns read tools for Solana-source routes, token bridge metadata, quotes, transfer status, and wallet bridge exposure. Write paths create prepared approval inbox items only.

## What It Can Read

- `solana_wormhole_supported_routes` returns Solana-source destination chains, route types, relayer support, manual redemption requirements, and whether prepare is supported.
- `solana_wormhole_token_snapshot` returns metadata for a Solana mint, supported routes, and wrapped assets when the configured client exposes them.
- `solana_wormhole_quote` returns a fresh transfer quote with destination token, bridge fee, native gas dropoff, estimated destination amount, route mode, and warnings.
- `solana_wormhole_transfer_status` returns status from a txid, VAA, sequence, or transfer id, including VAA availability, redeemed state, next action, and Solana-executable status.
- `solana_wormhole_wallet_bridge_exposure` returns pending and recent transfer exposure for a wallet.

## What It Can Prepare

- `solana_prepare_wormhole_transfer` prepares a `wormhole_transfer` inbox item for a Solana-source token bridge transaction.
- `solana_prepare_wormhole_redeem` prepares a `wormhole_redeem` inbox item only when the destination chain is Solana.
- `solana_prepare_wormhole_recover_or_resume` prepares a `wormhole_recover_or_resume` inbox item only when the next executable step is Solana-compatible.
- `solana_execute_prepared_action` refreshes quote or status data before wallet approval and forwards one wallet-signable Solana transaction.

## Required Inputs

- Transfer: source mint (`native` for SOL), amount, destination chain, and destination address.
- Optional transfer guards: route type, minimum destination amount, maximum bridge fee, native gas dropoff, recipient memo, and due date.
- Redeem: VAA or transfer id, destination chain `Solana`, and optional expected mint.
- Recover or resume: source txid or transfer id, plus optional destination chain.

## Required Facts

- Supported route and route mode for the destination chain.
- Fresh Wormhole quote before prepare and again before execution.
- Destination token mapping, bridge fee, estimated destination amount, and manual redemption requirement.
- Transfer status before redeem/recovery, including `solanaExecutable`, `vaaAvailable`, and `redeemed`.
- Program ids included in the prepared preview.

## Deny Or Ask

Deny: destination-chain signing outside Solana, NFT bridge transfers, governance VAA/admin/operator actions, NTT deployment or configuration, guarantees that bridging cannot fail, and automatic redemption on non-Solana chains.

Ask for input when source mint, amount, destination chain, destination address, VAA, transfer id, or source txid is missing.

## Runtime

The connector uses an injected `WormholeClient` facade. Hosts wire the official Wormhole SDK through `setWormholeClientFactory()`. Without a client, route discovery returns conservative static route facts with `prepareSupported=false`; quote, token, status, exposure, and prepare tools report that the Wormhole SDK client is not configured.

## User Approval

Wormhole writes create prepared actions only. They do not sign, submit, or grant delegated authority. Execution refreshes bridge facts before the wallet review; the user still approves and signs in the wallet.
