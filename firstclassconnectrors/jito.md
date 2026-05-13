# Jito First-Class Connector Plan

## Goal

Add a first-class Agentic connector for JitoSOL liquid staking workflows.

V1 scope:

- Read JitoSOL stake pool facts.
- Read wallet JitoSOL balance.
- Read wallet stake accounts that may be eligible for deposit into JitoSOL.
- Prepare stake SOL to receive JitoSOL.
- Prepare deposit existing stake account into JitoSOL when supported.
- Prepare unstake/withdraw JitoSOL to SOL when supported by official integration path.

Do not include Jito restaking, MEV strategy management, validator set changes, governance, bundle sending, searcher APIs, or JTO token actions in v1.

## Current Repo State

Jito is not in the current connector catalog.

Implementation will need to add it to:

- `apps/browser-demo/src/connectedDapps.ts`
- `packages/mcp-server/src/connectorRegistry.ts`
- `packages/mcp-server/src/adapters/types.ts`
- `packages/mcp-server/src/adapters/registry.ts`
- `packages/mcp-server/src/preparedActions.ts`
- `spec/connectors/jito.connector.json`
- `docs/connectors/README.md`

Jito should appear as `First-class liquid staking connector`.

## External Source Of Truth

Use official Jito docs:

- JitoSOL staking integration docs: https://www.jito.network/docs/jitosol/jitosol-liquid-staking/for-developers/staking-integration/
- JitoSOL stake bot docs: https://www.jito.network/docs/jitosol/jitosol-liquid-staking/stake-bot/
- JitoSOL risk/disclaimers: https://www.jito.network/docs/jitosol/

Important protocol facts to preserve:

- JitoSOL is the Jito liquid staking token.
- Official integration docs use `@solana/spl-stake-pool` for deposit and withdrawal instruction helpers.
- Stake-account deposit can use Jito's stake deposit interceptor SDK.
- Official docs list:
  - JitoSOL mint: `J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn`
  - Jito stake pool: `Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb`

## Dependencies

Shared runtime worker should add optional dependencies:

- `@solana/spl-stake-pool`
- `@jito-foundation/stake-deposit-interceptor-sdk` if stake-account deposit is implemented.

Config:

- `JITO_CONNECTOR_ENABLED`: optional feature flag during rollout.

No Jito API key is required for basic on-chain stake-pool reads and prepares.

## Proposed MCP Tools

Read tools:

- `solana_jito_stake_pool_snapshot`
- `solana_jito_wallet_positions`
- `solana_jito_wallet_stake_accounts`
- `solana_jito_quote`

Prepare tools:

- `solana_prepare_jito_stake_sol`
- `solana_prepare_jito_deposit_stake_account`
- `solana_prepare_jito_unstake_jitosol`
- `solana_prepare_jito_withdraw_sol`

Prepared action kinds:

- `jito_stake_sol`
- `jito_deposit_stake_account`
- `jito_unstake_jitosol`
- `jito_withdraw_sol`

If unstake/withdraw support requires a delayed stake-pool path, expose the prepare action but make the preview explicit about timing and liquidity.

## Inputs

Stake pool snapshot:

- `includeValidators`: optional boolean, default false.
- `includeExchangeRate`: optional boolean, default true.

Wallet positions:

- `walletAddress`: optional. Defaults to connected wallet.
- `includeStakeAccounts`: optional boolean, default true.

Wallet stake accounts:

- `walletAddress`: optional. Defaults to connected wallet.
- `delegatedOnly`: optional boolean, default true.
- `eligibleForJitoDepositOnly`: optional boolean, default true.

Quote:

- `operation`: required enum `stake_sol | unstake_jitosol | deposit_stake_account`.
- `amount`: optional decimal string.
- `stakeAccount`: optional public key.

Stake SOL:

- `solAmount`: required decimal string.
- `minJitoSolAmount`: optional decimal string.

Deposit stake account:

- `stakeAccount`: required public key.
- `minJitoSolAmount`: optional decimal string.

Unstake JitoSOL:

- `jitoSolAmount`: required decimal string.
- `minSolAmount`: optional decimal string.
- `allowDelayedWithdraw`: optional boolean, default true.

Withdraw SOL:

- `ticketAccount` or `stakeAccount`: required when withdrawal is delayed.
- `minSolAmount`: optional decimal string.

## Adapter Design

Files:

```text
packages/mcp-server/src/adapters/jito/constants.ts
packages/mcp-server/src/adapters/jito/client.ts
packages/mcp-server/src/adapters/jito/pool.ts
packages/mcp-server/src/adapters/jito/wallet.ts
packages/mcp-server/src/adapters/jito/actions.ts
packages/mcp-server/src/adapters/jito/index.ts
```

`constants.ts` responsibilities:

- Store JitoSOL mint and stake pool address.
- Store supported cluster and known stake-pool program ids.
- Store stale quote and output-cap defaults.

`client.ts` responsibilities:

- Load stake-pool account data from RPC.
- Dynamic import `@solana/spl-stake-pool`.
- Dynamic import interceptor SDK only for stake-account deposit.
- Return typed unavailable reasons.

`pool.ts` responsibilities:

- Read pool state, exchange rate, total SOL, JitoSOL supply, reserve stake, validators, fees, and lockup/warmup facts where available.

`wallet.ts` responsibilities:

- Read JitoSOL token balances.
- Read stake accounts owned by wallet.
- Mark stake accounts eligible or ineligible for deposit based on state and delegation facts.

`actions.ts` responsibilities:

- Build unsigned stake-pool deposit/withdraw instructions.
- Include associated token account creation when needed.
- Refresh stake-pool exchange rate before execution.

## Prepared Action Payload

Store:

- `connectorId: "jito"`
- `operation`
- `walletAddress`
- `cluster`
- `jitoSolMint`
- `stakePoolAddress`
- `solAmount`
- `jitoSolAmount`
- `stakeAccount`
- `minJitoSolAmount`
- `minSolAmount`
- `poolSnapshot`
- `exchangeRateSnapshot`
- `feePreview`
- `programIds`
- `transactionBase64` only if reusable
- `refreshAtExecution: true`

## Safety Checks

- Reject unsupported clusters.
- Reject stake SOL below rent/fee-safe minimum.
- Reject stake-account deposit if stake account is inactive, not delegated, locked, already deactivating, or not wallet-owned.
- Reject if refreshed output falls below user minimum.
- Warn about stake-pool exchange-rate changes.
- Warn about warmup, cooldown, delayed withdrawal, or liquidity limits.
- Warn that JitoSOL yield is variable and not guaranteed.
- Do not support restaking or JTO actions in this connector.
- Do not create delegated authorities outside official stake-pool instructions.

## Tests

Unit tests:

- Stake pool snapshot reads configured addresses.
- Wallet positions normalize JitoSOL balance.
- Stake-account read marks inactive account ineligible.
- Stake SOL prepare rejects below minimum.
- Deposit stake account rejects non-owned stake account.
- Unstake execute refresh blocks worse-than-min output.
- Missing optional SDK reports unavailable for stake-account deposit only.

Mock tests:

- Stake pool account decode.
- Wallet token balance success.
- Wallet stake accounts success.
- Stake SOL transaction serialization.
- Deposit stake account transaction serialization.

Smoke prompts:

- "Show the current JitoSOL stake pool exchange rate."
- "Show my JitoSOL and Jito-eligible stake accounts."
- "Prepare staking 1 SOL into JitoSOL. Do not sign."
- "Prepare depositing this stake account into JitoSOL."
- "Prepare unstaking 0.5 JitoSOL with at least this SOL output."

## Completion Checklist

- Jito appears in `/app` preferences as first-class.
- Stake-pool and wallet reads work.
- Stake SOL prepare works end-to-end into Needs Approval.
- Stake-account deposit is enabled only if SDK support is installed and tested.
- No Jito path signs before wallet approval.
