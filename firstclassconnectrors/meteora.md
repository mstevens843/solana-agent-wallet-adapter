# Meteora First-Class Connector Plan

## Goal

Replace Meteora's current Blink-backed connector status with a first-class Meteora DLMM adapter for pool/position reads and prepare-only DLMM position actions.

V1 focuses on DLMM:

- Read DLMM pool facts.
- Read wallet-owned DLMM positions.
- Prepare claim swap fees and rewards.
- Prepare add liquidity.
- Prepare remove liquidity.
- Prepare close empty position.

Do not include DAMM v1, DAMM v2, DBC, Alpha Vault, presale vault, or Dynamic Fee Sharing in v1.

## Current Repo State

Meteora currently appears in:

- `apps/browser-demo/src/connectedDapps.ts`
- `apps/browser-demo/src/protocolActions.ts`
- `packages/mcp-server/src/connectorRegistry.ts`
- `spec/connectors/meteora.connector.json`
- `docs/connectors/meteora.md`

Browser-side code already has a generic Meteora position read helper through the public DLMM API. First-class MCP work should move core reads and prepared writes into the MCP adapter.

## External Source Of Truth

Use official Meteora docs:

- DLMM overview: https://docs.meteora.ag/developer-guide/guides/dlmm/overview
- DLMM TypeScript SDK getting started: https://docs.meteora.ag/developer-guide/guides/dlmm/typescript-sdk/getting-started
- DLMM SDK functions: https://docs.meteora.ag/developer-guide/guides/dlmm/typescript-sdk/sdk-functions

Key facts:

- Meteora DLMM uses discrete liquidity bins.
- Official SDK package is `@meteora-ag/dlmm`.
- SDK supports creating a DLMM pool client from a pool address.
- SDK exposes position reads, active bin reads, fee info, dynamic fee, and claim/add/remove/close style functions.
- Mainnet and devnet DLMM program id are documented as the same current program id.

## Dependencies

Shared runtime worker should add:

- Optional dependency: `@meteora-ag/dlmm`.
- Keep `@solana/web3.js` v1 compatibility.
- Dynamic import the SDK only inside the MCP adapter.

If SDK import fails, reads that use the existing HTTP API may still work, but write prepares should report SDK unavailable.

## Proposed MCP Tools

Read tools:

- `solana_meteora_dlmm_pool_snapshot`
- `solana_meteora_wallet_positions`
- `solana_meteora_position_detail`

Prepare tools:

- `solana_prepare_meteora_claim_fees`
- `solana_prepare_meteora_claim_rewards`
- `solana_prepare_meteora_add_liquidity`
- `solana_prepare_meteora_remove_liquidity`
- `solana_prepare_meteora_close_position`

Prepared action kinds:

- `meteora_claim_fees`
- `meteora_claim_rewards`
- `meteora_add_liquidity`
- `meteora_remove_liquidity`
- `meteora_close_position`

## Inputs

Pool snapshot:

- `poolAddress`: required.

Wallet positions:

- `walletAddress`: optional. Defaults to connected wallet.
- `poolAddress`: optional filter.

Position detail:

- `positionAddress`: required.
- `poolAddress`: optional if SDK can derive it.

Claim fees/rewards:

- `poolAddress`: required.
- `positionAddress`: optional.
- `claimAll`: optional boolean. If true, claim all user positions in the pool.

Add liquidity:

- `poolAddress`: required.
- `positionAddress`: optional for existing position.
- `tokenXAmount`: optional decimal string.
- `tokenYAmount`: optional decimal string.
- `minBinId`: required for new position or range change.
- `maxBinId`: required for new position or range change.
- `strategyType`: optional enum `spot | curve | bidask`.
- `singleSidedX`: optional boolean.
- `slippageBps`: optional.

Remove liquidity:

- `poolAddress`: required.
- `positionAddress`: required.
- `liquidityPercent` or `binLiquidityBps`: required.
- `slippageBps`: optional.

Close position:

- `poolAddress`: required.
- `positionAddress`: required.
- Must prove zero active liquidity or include remove-liquidity step as separate prepared action.

## Adapter Design

Files:

```text
packages/mcp-server/src/adapters/meteora/constants.ts
packages/mcp-server/src/adapters/meteora/client.ts
packages/mcp-server/src/adapters/meteora/pools.ts
packages/mcp-server/src/adapters/meteora/positions.ts
packages/mcp-server/src/adapters/meteora/liquidity.ts
packages/mcp-server/src/adapters/meteora/claims.ts
packages/mcp-server/src/adapters/meteora/index.ts
```

`client.ts`:

- Dynamic import `@meteora-ag/dlmm`.
- Create a DLMM client for a single pool.
- Normalize SDK transaction arrays into one or more prepared actions.
- Expose helpers for active bin, bins around active bin, positions, and fee info.

`pools.ts`:

- Return pool address, token X/Y mints, active bin id, bin step, dynamic fee, base fee, liquidity, and status flags.

`positions.ts`:

- Return position address, owner, range bins, active/inactive status, liquidity distribution, unclaimed fees, rewards, and warnings.

`liquidity.ts`:

- Prepare add/remove transactions.
- Include bin range and strategy preview.

`claims.ts`:

- Prepare claim swap fee and reward transactions.
- If SDK returns multiple transactions, create either a batch prepared action only if core supports batch, or one prepared action per transaction.

## Prepared Action Payload

Store:

- `connectorId: "meteora"`
- `operation`
- `poolAddress`
- `positionAddress`
- `tokenMints`
- `binRange`
- `activeBinId`
- `strategyType`
- `singleSidedX`
- `slippageBps`
- `claimTypes`
- `transactionBase64` or `transactionsBase64`
- `refreshAtExecution: true`

Meteora actions should usually refresh at execution because active bin, fees, and rewards change.

## Safety Checks

- Reject missing pool address.
- Reject invalid bin range.
- Reject close position when liquidity is not zero.
- Warn when range is far from active bin.
- Warn for single-sided liquidity.
- Warn when claim returns multiple transactions.
- Block slippage above configured max.
- Block unknown DLMM program id.
- Do not create operator/delegated positions in v1.

## Tests

Unit tests:

- Pool snapshot rejects invalid pool.
- Position detail rejects invalid position.
- Add liquidity rejects missing bin range.
- Close rejects non-empty position.
- Claim fees handles zero-fee state as a clean message.
- Multiple transactions are represented safely.

Mock tests:

- Active bin in range.
- Active bin outside range.
- Claim fees transaction array.
- Add/remove transaction serialization.

Smoke prompts:

- "Show my Meteora DLMM positions."
- "Check this Meteora position and tell me if it is near the active bin."
- "Prepare claiming fees for this Meteora position."
- "Prepare adding DLMM liquidity from bin 120 to 140. Do not sign."
- "Prepare removing 25 percent of my Meteora liquidity."

## Completion Checklist

- Meteora row says first-class.
- DLMM pool reads work through MCP.
- DLMM position reads work through MCP.
- Claim fees/rewards prepare approval items.
- Add/remove liquidity prepare approval items.
- Wallet approval remains mandatory.
