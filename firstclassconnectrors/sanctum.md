# Sanctum First-Class Connector Plan

## Goal

Add a first-class Agentic connector for Sanctum LST and Infinity workflows.

V1 scope:

- Read supported LST metadata.
- Read Sanctum Infinity pool facts.
- Read wallet LST balances and INF exposure.
- Prepare LST swaps.
- Prepare add liquidity to Infinity.
- Prepare remove liquidity from Infinity.
- Prepare simple SOL-to-LST and LST-to-SOL flows only if the official SDK/API path is stable.

Do not include validator management, LST issuer admin actions, custom pool creation, delegated staking automation, or recurring LST rebalancing in v1.

## Current Repo State

Sanctum is not in the current connector catalog.

Implementation will need to add it to:

- `apps/browser-demo/src/connectedDapps.ts`
- `packages/mcp-server/src/connectorRegistry.ts`
- `packages/mcp-server/src/adapters/types.ts`
- `packages/mcp-server/src/adapters/registry.ts`
- `packages/mcp-server/src/preparedActions.ts`
- `spec/connectors/sanctum.connector.json`
- `docs/connectors/README.md`

Sanctum should appear as `First-class LST connector`.

## External Source Of Truth

Use official Sanctum docs:

- Sanctum docs: https://learn.sanctum.so/docs
- Infinity technical docs: https://learn.sanctum.so/docs/technical-documentation/infinity
- Sanctum Profiles and token docs when wallet balance metadata is needed.

Important protocol facts to preserve:

- Sanctum Infinity is an LST liquidity pool with SOL value priced through internal LST/SOL valuations.
- Infinity has instructions for adding liquidity, removing liquidity, and swapping.
- Official Sanctum S Controller program id: `5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx`.
- Infinity positions use INF and underlying LST exposure.
- LST valuation, pool fees, and liquidity availability must be shown as current-state facts, not guarantees.

## Dependencies

Use official Sanctum SDK/API packages if stable at implementation time. If no stable package covers a needed action, implement read-first and leave write tools unregistered.

Config:

- `SANCTUM_API_KEY`: required for live API reads, quotes, and prepared actions.
- `SANCTUM_API_BASE_URL`: optional, defaults to `https://sanctum-api.ironforge.network`.
- `SANCTUM_CONNECTOR_ENABLED`: optional feature flag; `false`, `0`, or `off` disables the connector.

The API key must never be persisted in prepared-action params, receipts, notes, warnings, or browser state.

## Proposed MCP Tools

Read tools:

- `solana_sanctum_lst_list`
- `solana_sanctum_lst_snapshot`
- `solana_sanctum_infinity_pool_snapshot`
- `solana_sanctum_wallet_positions`
- `solana_sanctum_quote`

Prepare tools:

- `solana_prepare_sanctum_swap_lst`
- `solana_prepare_sanctum_add_infinity_liquidity`
- `solana_prepare_sanctum_remove_infinity_liquidity`
- `solana_prepare_sanctum_stake_sol_to_lst`
- `solana_prepare_sanctum_unstake_lst_to_sol`

Prepared action kinds:

- `sanctum_swap_lst`
- `sanctum_add_infinity_liquidity`
- `sanctum_remove_infinity_liquidity`
- `sanctum_stake_sol_to_lst`
- `sanctum_unstake_lst_to_sol`

## Inputs

LST list:

- `includeDisabled`: optional boolean, default false.
- `includePoolStats`: optional boolean, default true.

LST snapshot:

- `lstMint`: required.
- `includeLiquidity`: optional boolean, default true.
- `includeValidatorFacts`: optional boolean, default false.

Infinity pool snapshot:

- `includeComposition`: optional boolean, default true.
- `includeFees`: optional boolean, default true.

Wallet positions:

- `walletAddress`: optional. Defaults to connected wallet.
- `includeSmallBalances`: optional boolean, default false.

Quote:

- `inputMint`: required.
- `outputMint`: required.
- `amount`: required decimal string.
- `exactIn`: optional boolean, default true.

Swap LST:

- `inputMint`: required.
- `outputMint`: required.
- `amount`: required decimal string.
- `minOutputAmount`: optional decimal string.
- `maxFeeBps`: optional, default connector risk config.
- `slippageBps`: optional, default connector risk config.

Add Infinity liquidity:

- `inputMint`: required.
- `amount`: required decimal string.
- `minInfAmount`: optional decimal string.
- `maxFeeBps`: optional.

Remove Infinity liquidity:

- `infAmount`: required decimal string.
- `outputMint`: required.
- `minOutputAmount`: optional decimal string.
- `maxFeeBps`: optional.

Stake SOL to LST:

- `lstMint`: required.
- `solAmount`: required decimal string.
- `minLstAmount`: optional decimal string.

Unstake LST to SOL:

- `lstMint`: required.
- `lstAmount`: required decimal string.
- `minSolAmount`: optional decimal string.
- `allowDelayedUnstake`: optional boolean, default false.

## Adapter Design

Files:

```text
packages/mcp-server/src/adapters/sanctum/constants.ts
packages/mcp-server/src/adapters/sanctum/client.ts
packages/mcp-server/src/adapters/sanctum/lsts.ts
packages/mcp-server/src/adapters/sanctum/infinity.ts
packages/mcp-server/src/adapters/sanctum/wallet.ts
packages/mcp-server/src/adapters/sanctum/actions.ts
packages/mcp-server/src/adapters/sanctum/index.ts
```

`constants.ts` responsibilities:

- Store Infinity program id.
- Store known action caps and stale quote limits.
- Store supported clusters.

`client.ts` responsibilities:

- Build Sanctum API/SDK client.
- Dynamic import SDK packages if used.
- Load LST metadata and Infinity pool state.
- Return structured unavailable reasons.

`lsts.ts` responsibilities:

- Normalize LST mint, symbol, protocol, SOL value, liquidity, and enabled state.
- Mark whether an LST is supported for swaps, add liquidity, and remove liquidity.

`infinity.ts` responsibilities:

- Read INF supply, pool composition, fees, LST weights, valuation, and paused states.
- Produce quote snapshots for swaps and liquidity operations.

`wallet.ts` responsibilities:

- Read wallet LST balances and INF balance.
- Normalize exposure into SOL value and underlying mint facts.

`actions.ts` responsibilities:

- Build unsigned swap/add/remove/stake/unstake transactions.
- Refresh pool and quote state at execution.
- Block if output falls below user caps.

## Prepared Action Payload

Store:

- `connectorId: "sanctum"`
- `operation`
- `walletAddress`
- `cluster`
- `inputMint`
- `outputMint`
- `inputAmount`
- `inputAmountRaw`
- `minOutputAmount`
- `maxFeeBps`
- `slippageBps`
- `quoteSnapshot`
- `poolSnapshot`
- `lstSnapshot`
- `programIds`
- `transactionBase64` only if reusable
- `refreshAtExecution: true`

## Safety Checks

- Reject unsupported clusters.
- Reject disabled or unsupported LST mints.
- Reject stale quotes.
- Reject output below `minOutputAmount`.
- Reject fee above `maxFeeBps`.
- Reject remove liquidity if INF balance is insufficient.
- Warn when output liquidity is shallow.
- Warn when LST valuation changed since prepare.
- Warn when delayed unstake is required.
- Warn when pool is paused, capped, or in a degraded state.
- Do not claim LST yield, SOL value, or liquidity is guaranteed.
- Do not create recurring LST rebalance actions in v1.

## Tests

Unit tests:

- LST snapshot rejects unknown mint.
- Infinity snapshot includes program id and composition.
- Quote rejects unsupported input/output pair.
- Add liquidity rejects stale quote.
- Remove liquidity rejects insufficient INF balance.
- Swap execute refresh blocks worse-than-cap output.
- Missing SDK/API returns structured readiness reason.

Mock tests:

- LST list success.
- Infinity pool snapshot success.
- Wallet INF/LST balances success.
- Swap transaction serialization.
- Add/remove liquidity transaction serialization.

Smoke prompts:

- "Show Sanctum Infinity pool composition."
- "Show my Sanctum LST and INF positions."
- "Quote swapping this LST to JitoSOL through Sanctum."
- "Prepare adding 1 SOL worth of JitoSOL to Sanctum Infinity. Do not sign."
- "Prepare removing 10 INF to SOL with at least this minimum output."

## Completion Checklist

- Sanctum appears in `/app` preferences as first-class.
- LST and Infinity reads work.
- Swap/add/remove prepare actions create approval inbox items.
- Quote and pool state refresh before execution.
- No Sanctum path signs before wallet approval.
