# Wormhole First-Class Connector Plan

## Goal

Add a first-class Agentic connector for Wormhole cross-chain bridge facts and prepare-only Solana-source bridge actions.

V1 scope:

- Read supported chains, tokens, routes, and bridge modes.
- Preview Wormhole token-transfer routes from Solana.
- Prepare Solana-source token transfers through official Wormhole SDK paths.
- Track transfer status and redemption facts.
- Support manual redeem/finalize where the destination chain or route requires it and the wallet path is Solana-compatible.

Do not include arbitrary EVM signing, automated destination-chain signing, NFT bridge, governance VAAs, relayer operator actions, NTT admin actions, or custom bridge deployment in v1.

## Current Repo State

Wormhole is not in the current connector catalog.

Implementation will need to add it to:

- `apps/browser-demo/src/connectedDapps.ts`
- `packages/mcp-server/src/connectorRegistry.ts`
- `packages/mcp-server/src/adapters/types.ts`
- `packages/mcp-server/src/adapters/registry.ts`
- `packages/mcp-server/src/preparedActions.ts`
- `spec/connectors/wormhole.connector.json`
- `docs/connectors/README.md`

Wormhole should appear as `First-class bridge connector`.

## External Source Of Truth

Use official Wormhole docs:

- Wormhole docs: https://wormhole.com/docs/
- Wormhole TypeScript SDK: https://wormhole.com/docs/tools/typescript-sdk/get-started/
- Wormhole transfer guides: https://wormhole.com/docs/products/token-transfers/

Important protocol facts to preserve:

- Wormhole supports multiple transfer products and SDK integrations.
- Token transfers can involve wrapped token transfers, native token transfers, CCTP routes, NTT routes, relayers, and manual redemption depending on asset and chain.
- A Solana connector can prepare only the Solana-side transaction. Destination-chain signing must be separate.
- Fees, finality, relayer behavior, and redemption requirements vary by route.

## Dependencies

Shared runtime worker should add optional dependency:

- `@wormhole-foundation/sdk`

Optional platform packages should be added only as needed for Solana routes.

Config:

- `WORMHOLE_CONNECTOR_ENABLED`: optional feature flag during rollout.
- `WORMHOLE_NETWORK`: optional enum `Mainnet | Testnet`, default inferred from Solana cluster.
- `WORMHOLE_RPC_BASE_URL`: optional, only if official SDK route requires a specific service endpoint.

No private destination-chain key should ever be accepted by this connector.

## Proposed MCP Tools

Read tools:

- `solana_wormhole_supported_routes`
- `solana_wormhole_token_snapshot`
- `solana_wormhole_quote`
- `solana_wormhole_transfer_status`
- `solana_wormhole_wallet_bridge_exposure`

Prepare tools:

- `solana_prepare_wormhole_transfer`
- `solana_prepare_wormhole_redeem`
- `solana_prepare_wormhole_recover_or_resume`

Prepared action kinds:

- `wormhole_transfer`
- `wormhole_redeem`
- `wormhole_recover_or_resume`

## Inputs

Supported routes:

- `sourceChain`: optional, default `Solana`.
- `destinationChain`: optional.
- `mintAddress`: optional.
- `routeType`: optional enum `token_bridge | cctp | ntt | automatic | manual`.

Token snapshot:

- `mintAddress`: required.
- `destinationChain`: optional.
- `includeWrappedAssets`: optional boolean, default true.

Quote:

- `sourceMint`: required.
- `amount`: required decimal string.
- `destinationChain`: required.
- `destinationAddress`: required.
- `routeType`: optional enum `auto | token_bridge | cctp | ntt`.
- `nativeGasDropoff`: optional decimal string.

Transfer status:

- `txid`, `vaa`, or `sequence`: required.
- `sourceChain`: optional, default `Solana`.
- `destinationChain`: optional.

Wallet bridge exposure:

- `walletAddress`: optional. Defaults to connected wallet.
- `includePendingTransfers`: optional boolean, default true.

Transfer:

- `sourceMint`: required.
- `amount`: required decimal string.
- `destinationChain`: required.
- `destinationAddress`: required.
- `routeType`: optional enum `auto | token_bridge | cctp | ntt`.
- `minDestinationAmount`: optional decimal string.
- `maxBridgeFee`: optional decimal string.
- `nativeGasDropoff`: optional decimal string.
- `recipientMemo`: optional string.

Redeem:

- `vaa` or `transferId`: required.
- `destinationChain`: required and must be Solana for this connector to sign.
- `expectedMint`: optional public key.

Recover or resume:

- `sourceTxid` or `transferId`: required.
- `destinationChain`: optional.

## Adapter Design

Files:

```text
packages/mcp-server/src/adapters/wormhole/constants.ts
packages/mcp-server/src/adapters/wormhole/client.ts
packages/mcp-server/src/adapters/wormhole/routes.ts
packages/mcp-server/src/adapters/wormhole/quotes.ts
packages/mcp-server/src/adapters/wormhole/status.ts
packages/mcp-server/src/adapters/wormhole/actions.ts
packages/mcp-server/src/adapters/wormhole/index.ts
```

`constants.ts` responsibilities:

- Store supported source chain as Solana.
- Store supported destination-chain names and SDK chain ids.
- Store stale quote limits, fee caps, and route risk labels.

`client.ts` responsibilities:

- Dynamic import Wormhole SDK.
- Build SDK context for configured network and Solana RPC.
- Normalize chain ids, token ids, native addresses, wrapped addresses, and SDK route errors.

`routes.ts` responsibilities:

- List supported routes and explain whether the route is token bridge, CCTP, NTT, manual, or relayed.
- Distinguish read support from prepare support.

`quotes.ts` responsibilities:

- Produce amount, fee, finality, destination, native gas, wrapped/native asset, and redemption facts.
- Never hide route-specific assumptions.

`status.ts` responsibilities:

- Resolve transfer state from txid, sequence, VAA, or SDK transfer id.
- Show source transaction, VAA availability, destination redemption, pending/redeemed/error state.

`actions.ts` responsibilities:

- Build unsigned Solana-source transfer transactions.
- Build unsigned Solana redeem transaction only when destination chain is Solana.
- Refresh quote and route status before execution.

## Prepared Action Payload

Store:

- `connectorId: "wormhole"`
- `operation`
- `walletAddress`
- `cluster`
- `wormholeNetwork`
- `sourceChain`
- `destinationChain`
- `sourceMint`
- `destinationToken`
- `amount`
- `amountRaw`
- `destinationAddress`
- `routeType`
- `minDestinationAmount`
- `maxBridgeFee`
- `nativeGasDropoff`
- `quoteSnapshot`
- `routeSnapshot`
- `statusSnapshot`
- `programIds`
- `vaa`
- `sequence`
- `transactionBase64` only if reusable
- `refreshAtExecution: true`

## Safety Checks

- Reject unsupported clusters and networks.
- Reject destination address that fails destination-chain validation.
- Reject unsupported route or token.
- Reject transfer if refreshed fee exceeds `maxBridgeFee`.
- Reject transfer if destination amount falls below `minDestinationAmount`.
- Reject if source mint maps to an unexpected wrapped/native destination asset.
- Warn when route requires manual redemption.
- Warn when finality or transfer ETA is uncertain.
- Warn when relayer or gas-dropoff assumptions are used.
- Warn when destination transaction cannot be signed by the Solana wallet.
- Do not ask for destination-chain private keys.
- Do not claim bridge transfers are reversible or guaranteed.

## Tests

Unit tests:

- Route read normalizes chain ids.
- Quote rejects invalid destination address.
- Transfer prepare rejects unsupported route.
- Transfer prepare rejects fee above cap.
- Execute refresh blocks changed destination token mapping.
- Redeem prepare rejects non-Solana destination signing.
- Missing SDK returns structured unavailable reason.

Mock tests:

- Wormhole SDK route list success.
- Token bridge quote success.
- CCTP route quote success.
- Transfer transaction serialization.
- Status pending/redeemed/error states.

Smoke prompts:

- "Show Wormhole routes for USDC from Solana to Ethereum."
- "Quote bridging 10 USDC from Solana to Base through Wormhole."
- "Prepare a Wormhole transfer of 5 USDC to this destination address. Do not sign."
- "Check status of this Wormhole transfer."
- "Prepare redeeming this Wormhole transfer on Solana."

## Completion Checklist

- Wormhole appears in `/app` preferences as first-class.
- Route and quote reads work.
- Solana-source transfer prepare creates approval inbox items.
- Status tracking works from txid or transfer id.
- No Wormhole path signs before wallet approval.
