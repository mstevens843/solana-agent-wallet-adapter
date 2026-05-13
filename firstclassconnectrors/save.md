# Save First-Class Connector Plan

## Goal

Replace Save's current Blink-backed connector status with a first-class Save/Solend lending adapter for reserve/obligation reads and prepare-only lending actions.

V1 scope:

- Read reserves.
- Read user obligation.
- Prepare deposit.
- Prepare withdraw.
- Prepare borrow.
- Prepare repay.

Do not include liquidations, flash loans, pool admin, permissionless pool creation, DAO/governance, leverage loops, or shorting flows in v1.

## Current Repo State

Save currently appears in:

- `apps/browser-demo/src/connectedDapps.ts`
- `packages/mcp-server/src/connectorRegistry.ts`
- `spec/connectors/save.connector.json`
- `docs/connectors/planned-connectors.md`

Current runtime mode is planned/Blink-backed.

## External Source Of Truth

Use official Save/Solend docs:

- Save docs: https://docs.save.finance/
- Solend SDK docs: https://sdk.solend.fi/modules.html

Key facts:

- Save was formerly Solend.
- It is a lending and borrowing protocol on Solana.
- SDK exposes `SolendMarket`, `SolendReserve`, `SolendObligation`, `SolendWallet`, and instruction builders.
- SDK action types include deposit, borrow, withdraw, repay, mint, redeem, and deposit collateral.
- V1 should use reserve/obligation reads and direct instruction builders only for user-facing lending actions.

## Dependencies

Shared runtime worker should add optional dependency:

- `@solendprotocol/solend-sdk`

Dynamic import the SDK inside the adapter. Return `sdkUnavailable` if absent.

## Proposed MCP Tools

Read tools:

- `solana_save_reserve_snapshot`
- `solana_save_wallet_obligation`
- `solana_save_market_snapshot`

Prepare tools:

- `solana_prepare_save_deposit`
- `solana_prepare_save_withdraw`
- `solana_prepare_save_borrow`
- `solana_prepare_save_repay`

Prepared action kinds:

- `save_deposit`
- `save_withdraw`
- `save_borrow`
- `save_repay`

## Inputs

Market snapshot:

- `marketAddress`: optional. Defaults to main Save market.

Reserve snapshot:

- `mintAddress` or `reserveAddress`: required.
- `marketAddress`: optional.

Wallet obligation:

- `walletAddress`: optional. Defaults to connected wallet.
- `marketAddress`: optional.

Deposit:

- `mintAddress` or `reserveAddress`: required.
- `amount`: required decimal string.
- `marketAddress`: optional.
- `depositCollateral`: optional boolean. Default true if needed for obligation collateral.

Withdraw:

- `mintAddress` or `reserveAddress`: required.
- `amount`: required or `withdrawAll: true`.
- `marketAddress`: optional.

Borrow:

- `mintAddress` or `reserveAddress`: required.
- `amount`: required.
- `marketAddress`: optional.

Repay:

- `mintAddress` or `reserveAddress`: required.
- `amount`: required or `repayAll: true`.
- `marketAddress`: optional.

## Adapter Design

Files:

```text
packages/mcp-server/src/adapters/save/constants.ts
packages/mcp-server/src/adapters/save/client.ts
packages/mcp-server/src/adapters/save/markets.ts
packages/mcp-server/src/adapters/save/reserves.ts
packages/mcp-server/src/adapters/save/obligations.ts
packages/mcp-server/src/adapters/save/actions.ts
packages/mcp-server/src/adapters/save/index.ts
```

`client.ts`:

- Dynamic import `@solendprotocol/solend-sdk`.
- Load market and reserve config.
- Build read-only wallet context.
- Normalize errors.

`markets.ts`:

- Return market address, program id, reserve count, total deposits, total borrows, and supported reserves where SDK exposes them.

`reserves.ts`:

- Return reserve address, mint, cToken mint, supply APY, borrow APR, liquidity, collateral factor, liquidation threshold, and utilization where available.

`obligations.ts`:

- Return user's supplied assets, borrowed assets, borrow limit, liquidation threshold, health, and reward facts where SDK exposes them.

`actions.ts`:

- Build transactions/instructions for deposit, withdraw, borrow, repay.
- Rebuild at execution time for health-sensitive actions.

## Prepared Action Payload

Store:

- `connectorId: "save"`
- `operation`
- `marketAddress`
- `reserveAddress`
- `mintAddress`
- `amount`
- `amountRaw`
- `withdrawAll`
- `repayAll`
- `obligationSnapshot`
- `reserveSnapshot`
- `healthPreview`
- `programIds`
- `transactionBase64`
- `refreshAtExecution: true`

Borrow and withdraw must refresh health before execution.

## Safety Checks

- Reject borrow/withdraw without obligation health preview.
- Block borrow/withdraw if projected health is below configured threshold.
- Warn if reserve utilization is high.
- Warn if oracle/price data unavailable.
- Warn if borrowing creates liquidation risk.
- Do not expose liquidation or flash loan tools in v1.
- Do not create leverage loops or automatic recursive borrow/deposit strategies.
- Do not claim APY is guaranteed.

## Tests

Unit tests:

- Missing SDK returns unavailable.
- Reserve snapshot rejects missing reserve/mint.
- Deposit prepares transaction.
- Borrow requires health preview.
- Withdraw all blocks unhealthy outcome.
- Repay all stores repay mode.

Mock tests:

- Healthy obligation.
- No existing obligation.
- Borrow blocked by health.
- Deposit with collateral path.
- SDK instruction serialization.

Smoke prompts:

- "Show Save reserves for USDC."
- "Show my Save obligation and liquidation risk."
- "Prepare depositing 10 USDC into Save. Do not sign."
- "Prepare borrowing 5 USDC from Save only if health stays safe."
- "Prepare repaying all my Save USDC debt."

## Completion Checklist

- Save row says first-class.
- Reserve and obligation reads work.
- Deposit/withdraw/borrow/repay prepare actions work.
- Health checks gate borrow and withdraw.
- Wallet approval remains mandatory.
