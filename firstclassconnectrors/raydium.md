# Raydium First-Class Connector Plan

## Goal

Replace Raydium's current Blink-backed connector status with a first-class Agentic adapter for Raydium reads and prepare-only wallet approval actions.

Raydium scope is broad, so v1 should prioritize high-signal user workflows:

- Read CPMM and CLMM pool facts.
- Read wallet-owned Raydium positions where practical.
- Prepare add liquidity and remove liquidity for CPMM and CLMM.
- Prepare CLMM fee collection.
- Prepare farm/staking stake, unstake, and harvest only if the SDK path is stable enough.

Do not include Raydium perps or LaunchLab in v1.

## Current Repo State

Raydium currently appears in:

- `apps/browser-demo/src/connectedDapps.ts`
- `packages/mcp-server/src/connectorRegistry.ts`
- `spec/connectors/raydium.connector.json`
- `docs/connectors/planned-connectors.md`

Current runtime mode is Blink-backed. First-class work should move it to owned adapter reads/actions.

## External Source Of Truth

Use official Raydium docs and SDK:

- Raydium docs: https://docs.raydium.io/
- Raydium CPMM guide: https://docs.raydium.io/raydium/build/developer-guides/cpmm
- Raydium CLMM guide: https://docs.raydium.io/raydium/build/developer-guides/clmm
- Raydium SDK: `@raydium-io/raydium-sdk-v2`

Important protocol facts to preserve in implementation:

- CPMM uses constant-product pools.
- CLMM uses concentrated liquidity positions with custom ranges.
- Raydium docs list CPMM, CLMM, AMM v4, Farm/Staking, LaunchLab, and Perps as distinct surfaces.
- v1 should focus on CPMM, CLMM, and farm/staking only.

## Dependencies

Shared runtime worker should decide dependency placement:

- Add `@raydium-io/raydium-sdk-v2` as an optional dependency for `@solana-agent-wallet-adapter/mcp-server`.
- Keep the adapter able to report `sdkUnavailable` if the optional dependency is absent.
- Do not import Raydium SDK from browser-reachable code.

## Proposed MCP Tools

Read tools:

- `solana_raydium_pool_snapshot`
- `solana_raydium_wallet_positions`
- `solana_raydium_position_detail`

Prepare tools:

- `solana_prepare_raydium_add_liquidity`
- `solana_prepare_raydium_remove_liquidity`
- `solana_prepare_raydium_collect_fees`
- `solana_prepare_raydium_farm_stake`
- `solana_prepare_raydium_farm_unstake`
- `solana_prepare_raydium_harvest`

Prepared action kinds:

- `raydium_add_liquidity`
- `raydium_remove_liquidity`
- `raydium_collect_fees`
- `raydium_farm_stake`
- `raydium_farm_unstake`
- `raydium_harvest`

If farm/staking work is not stable in v1, keep the MCP tool names reserved but unregistered until implementation.

## Inputs

Pool snapshot:

- `poolId`: required Solana public key.
- `poolType`: optional enum `cpmm | clmm | amm_v4`.

Wallet positions:

- `walletAddress`: optional. Defaults to connected wallet.
- `poolType`: optional enum `cpmm | clmm | farm`.

Add liquidity:

- `poolId`: required.
- `poolType`: required enum `cpmm | clmm`.
- `tokenAAmount`: optional decimal string.
- `tokenBAmount`: optional decimal string.
- `maxTokenAAmount`: optional decimal string.
- `maxTokenBAmount`: optional decimal string.
- `lowerPrice` and `upperPrice`: required for CLMM position open/increase flows unless position id is provided.
- `positionMint`: optional for existing CLMM position.
- `slippageBps`: optional. Default to config max slippage.

Remove liquidity:

- `poolId`: required.
- `poolType`: required enum `cpmm | clmm`.
- `positionMint` or LP token account: required depending on pool type.
- `liquidityPercent` or `liquidityAmount`: required.
- `minTokenAAmount` and `minTokenBAmount`: optional.
- `slippageBps`: optional.

Collect fees:

- `poolId`: required.
- `positionMint`: required for CLMM.

Farm/staking:

- `farmId`: required.
- `amount`: required for stake/unstake.
- `rewardMint`: optional for harvest where SDK needs it.

## Adapter Design

Files:

```text
packages/mcp-server/src/adapters/raydium/constants.ts
packages/mcp-server/src/adapters/raydium/client.ts
packages/mcp-server/src/adapters/raydium/pools.ts
packages/mcp-server/src/adapters/raydium/positions.ts
packages/mcp-server/src/adapters/raydium/liquidity.ts
packages/mcp-server/src/adapters/raydium/farm.ts
packages/mcp-server/src/adapters/raydium/index.ts
```

`client.ts` responsibilities:

- Dynamic import Raydium SDK.
- Build read-only Raydium client with connected wallet public key.
- Load token account data from RPC where SDK requires it.
- Expose helpers for CPMM, CLMM, and farm modules.
- Return a typed `RaydiumUnavailableReason` instead of throwing raw SDK errors.

`pools.ts` responsibilities:

- Fetch pool metadata and reserves.
- Normalize pool type, mints, vaults, fee config, liquidity, price, tick/range data, and program ids.
- Return stable JSON for `solana_connector_read_facts`.

`positions.ts` responsibilities:

- Read wallet-owned CLMM position NFTs and CPMM/farm positions where SDK supports it.
- Normalize token symbols, mints, fee/reward estimate, range status, and position health.

`liquidity.ts` responsibilities:

- Build prepared transactions for add/remove liquidity.
- Include range/slippage preview.
- Include touched program ids.
- Do not sign.

`farm.ts` responsibilities:

- Build prepare transactions for stake, unstake, harvest.
- Defer if SDK support is too unstable.

## Prepared Action Payload

Each Raydium prepared action should store:

- `connectorId: "raydium"`
- `operation`
- `poolType`
- `poolId`
- `positionMint` when present
- `inputMints`
- `inputAmounts`
- `minOutputAmounts` when applicable
- `slippageBps`
- `priceRange` for CLMM
- `programIds`
- `sdkVersion` when available
- `transactionBase64` only if transaction can safely be reused
- `refreshAtExecution: true` for quote/range-sensitive flows

Prefer `refreshAtExecution: true` for add/remove liquidity and farm transactions so execution rebuilds from current pool state.

## Safety Checks

- Reject non-mainnet unless official devnet program ids are explicitly supported.
- Reject missing `poolId`.
- Reject CLMM add liquidity without a range or existing position.
- Reject slippage above configured max.
- Warn if range is out of active price.
- Warn if position is single-sided.
- Warn if pool liquidity is low.
- Warn if touched program id is not a known Raydium program for the requested pool type.
- Do not create lock authority, farm authority, or delegate authority in v1.

## Tests

Unit tests:

- Pool snapshot rejects invalid pool id.
- Missing SDK returns structured unavailable reason.
- Add liquidity prepare rejects missing range for new CLMM position.
- Remove liquidity prepare rejects missing position.
- Slippage over cap is blocked.
- Prepared action uses `raydium_*` kind and stores Raydium metadata.
- Execute path refreshes transaction before signing when `refreshAtExecution` is true.

Mock tests:

- Mock SDK returns CPMM pool facts.
- Mock SDK returns CLMM position facts.
- Mock SDK builds transaction bytes and adapter serializes to base64.

Smoke prompts:

- "Show my Raydium positions."
- "Check this Raydium CLMM pool and explain the range risk."
- "Prepare adding 0.01 SOL and matching USDC liquidity to this Raydium CLMM pool. Do not sign yet."
- "Prepare removing 25 percent of my Raydium position."
- "Claim Raydium fees for this position."

## Completion Checklist

- Raydium row in app says first-class, not Blink connector.
- `solana_connector_capabilities raydium` reports first-class reads/actions.
- `solana_connector_read_facts` works for pool facts.
- At least one liquidity prepare path works end-to-end into Needs Approval.
- No Raydium path signs before wallet approval.
