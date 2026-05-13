# Orca First-Class Connector Plan

## Goal

Replace Orca's current Blink-backed connector status with a first-class Orca Whirlpools adapter for pool/position reads and prepare-only liquidity actions.

V1 focuses on Whirlpools:

- Read Whirlpool pool facts.
- Read wallet-owned position facts.
- Prepare increase liquidity.
- Prepare decrease liquidity.
- Prepare collect fees and rewards.

Do not include Orca legacy pools, vault products, or automated LP strategy management in v1.

## Current Repo State

Orca currently appears in:

- `apps/browser-demo/src/connectedDapps.ts`
- `packages/mcp-server/src/connectorRegistry.ts`
- `spec/connectors/orca.connector.json`
- `docs/connectors/planned-connectors.md`

Current runtime mode is Blink-backed. First-class work should make Orca an owned adapter with Whirlpool-specific facts.

## External Source Of Truth

Use official Orca docs:

- Developer overview: https://docs.orca.so/developers/overview
- Whirlpool parameters: https://docs.orca.so/developers/architecture/whirlpool-parameters
- Adjust liquidity: https://docs.orca.so/developers/sdks/positions/adjust-liquidity
- TypeScript SDK docs: https://dev.orca.so/ts/modules/_orca-so_whirlpools.html

Key facts to preserve:

- Orca Whirlpools is a concentrated liquidity AMM.
- The official docs describe high-level SDKs for swaps, positions, and pool management.
- Whirlpool positions are tokenized positions.
- The Whirlpool program id is a fixed known program id and should be shown in previews.

## Dependencies

Shared runtime worker should decide exact dependency strategy:

- Prefer `@orca-so/whirlpools` for high-level flows where compatible.
- Some Orca packages use Solana Kit/web3 v2 concepts. The adapter must isolate those from repo packages using web3.js v1.
- If compatibility is too costly, v1 can use lower-level transaction builders or read-only REST/API facts, but still must keep write paths prepare-only.

The adapter must dynamically import optional Orca packages and return `sdkUnavailable` if missing.

## Proposed MCP Tools

Read tools:

- `solana_orca_whirlpool_snapshot`
- `solana_orca_wallet_positions`
- `solana_orca_position_detail`

Prepare tools:

- `solana_prepare_orca_increase_liquidity`
- `solana_prepare_orca_decrease_liquidity`
- `solana_prepare_orca_collect_fees`
- `solana_prepare_orca_collect_rewards`

Prepared action kinds:

- `orca_increase_liquidity`
- `orca_decrease_liquidity`
- `orca_collect_fees`
- `orca_collect_rewards`

## Inputs

Whirlpool snapshot:

- `whirlpoolAddress`: required Solana public key.

Wallet positions:

- `walletAddress`: optional. Defaults to connected wallet.
- `whirlpoolAddress`: optional filter.

Increase liquidity:

- `whirlpoolAddress`: required.
- `positionMint`: optional when increasing an existing position.
- `tokenAAmount`: optional decimal string.
- `tokenBAmount`: optional decimal string.
- `maxTokenAAmount`: optional decimal string.
- `maxTokenBAmount`: optional decimal string.
- `lowerTick` and `upperTick`: required when opening a new position.
- `slippageBps`: optional.

Decrease liquidity:

- `whirlpoolAddress`: required.
- `positionMint`: required.
- `liquidityPercent` or `liquidityAmount`: required.
- `minTokenAAmount`: optional decimal string.
- `minTokenBAmount`: optional decimal string.
- `slippageBps`: optional.

Collect fees/rewards:

- `positionMint`: required.
- `whirlpoolAddress`: optional if derivable from position.

## Adapter Design

Files:

```text
packages/mcp-server/src/adapters/orca/constants.ts
packages/mcp-server/src/adapters/orca/client.ts
packages/mcp-server/src/adapters/orca/whirlpools.ts
packages/mcp-server/src/adapters/orca/positions.ts
packages/mcp-server/src/adapters/orca/liquidity.ts
packages/mcp-server/src/adapters/orca/fees.ts
packages/mcp-server/src/adapters/orca/index.ts
```

`constants.ts`:

- Known Whirlpool program id.
- Known config addresses from official docs.
- Feature flags for mainnet/devnet support.

`client.ts`:

- Dynamic import Orca SDK.
- Normalize SDK transaction outputs into base64 transactions for Agentic approval.
- Build a read-only owner context.

`whirlpools.ts`:

- Fetch pool address, token mints, vaults, tick spacing, current price/tick, fee tier, liquidity, and program id.
- Return stable facts for agent review.

`positions.ts`:

- Find wallet tokenized positions.
- Return position range, current status, liquidity, claimable fees/rewards, token mints, and warning flags.

`liquidity.ts`:

- Build increase/decrease transactions.
- Include quote preview and min/max token amounts.

`fees.ts`:

- Build collect fee/reward transactions.
- Prefer one transaction per position unless SDK safely batches.

## Prepared Action Payload

Store:

- `connectorId: "orca"`
- `operation`
- `whirlpoolAddress`
- `positionMint`
- `tokenMints`
- `tokenAmounts`
- `tickRange`
- `priceRange`
- `slippageBps`
- `programIds`
- `quote`
- `transactionBase64` if safe
- `refreshAtExecution: true`

Refresh is recommended because pool price, tick arrays, fees, and rewards can change.

## Safety Checks

- Reject missing position for decrease/collect actions.
- Reject new position without lower and upper ticks.
- Reject invalid tick ordering.
- Warn if current tick is outside selected range.
- Warn if narrow range is likely active-management heavy.
- Warn if collect rewards includes unfamiliar reward mints.
- Block slippage over configured max.
- Block unknown Whirlpool program id.
- Do not create delegated managers or recurring LP automation in v1.

## Tests

Unit tests:

- Snapshot validates public key.
- Position detail returns stable normalized JSON.
- Increase liquidity blocks missing range.
- Decrease liquidity blocks missing position.
- Collect fees prepares a transaction without signing.
- Unsupported SDK state returns `unsupported_method`.

Mock tests:

- Mock position in range.
- Mock position out of range.
- Mock fees available and no fees available.
- Mock transaction serialization for legacy or versioned output.

Smoke prompts:

- "Show my Orca Whirlpool positions."
- "Check this Orca pool and tell me if my range is active."
- "Prepare increasing liquidity on this Orca position by 0.01 SOL. Do not sign."
- "Prepare removing 25 percent of this Orca position."
- "Claim Orca fees for this position."

## Completion Checklist

- Orca row in Protocol Connectors says first-class.
- Orca read facts return pool and wallet position facts.
- Increase/decrease liquidity produce prepared actions.
- Fee/reward collection produces prepared actions.
- Wallet approval remains the only signing path.
