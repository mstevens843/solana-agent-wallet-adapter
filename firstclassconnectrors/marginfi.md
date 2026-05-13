# MarginFi First-Class Connector Plan

## Goal

Replace MarginFi's current Blink-backed connector status with a first-class lending adapter that can read account/bank facts and prepare deposit, withdraw, borrow, and repay actions.

MarginFi v1 must be risk-preview heavy. Borrow and withdraw should never be prepared without a visible health preview.

## Current Repo State

MarginFi currently appears in:

- `apps/browser-demo/src/connectedDapps.ts`
- `packages/mcp-server/src/connectorRegistry.ts`
- `spec/connectors/marginfi.connector.json`
- `docs/connectors/planned-connectors.md`

Current runtime mode is planned/Blink-backed.

## External Source Of Truth

Use official MarginFi docs:

- TypeScript SDK docs: https://docs.marginfi.com/ts-sdk
- marginfi v2 program docs: https://docs.marginfi.com/mfi-v2

Key facts:

- Official TypeScript SDK packages include `@mrgnlabs/marginfi-client-v2` and `@mrgnlabs/mrgn-common`.
- `MarginfiClient.fetch` creates the high-level client.
- MarginFi accounts are the entrypoint for user interactions.
- Banks represent asset pools.
- Borrow/withdraw/repay/deposit all need account and bank context.
- Health/risk is central and must be displayed before wallet approval.

## Dependencies

Shared runtime worker should add optional dependencies:

- `@mrgnlabs/marginfi-client-v2`
- `@mrgnlabs/mrgn-common`

Adapter should dynamically import both and return `sdkUnavailable` if absent.

## Proposed MCP Tools

Read tools:

- `solana_marginfi_bank_snapshot`
- `solana_marginfi_wallet_accounts`
- `solana_marginfi_account_detail`
- `solana_marginfi_health_preview`

Prepare tools:

- `solana_prepare_marginfi_deposit`
- `solana_prepare_marginfi_withdraw`
- `solana_prepare_marginfi_borrow`
- `solana_prepare_marginfi_repay`

Prepared action kinds:

- `marginfi_deposit`
- `marginfi_withdraw`
- `marginfi_borrow`
- `marginfi_repay`

## Inputs

Bank snapshot:

- `bankMint` or `bankAddress`: required.

Wallet accounts:

- `walletAddress`: optional. Defaults to connected wallet.

Account detail:

- `marginfiAccount`: optional. Defaults to primary account if exactly one exists.

Health preview:

- `marginfiAccount`: required unless unique default exists.
- `operation`: enum `deposit | withdraw | borrow | repay`.
- `bankMint` or `bankAddress`: required.
- `amount`: required decimal string.

Deposit:

- `bankMint` or `bankAddress`: required.
- `amount`: required.
- `marginfiAccount`: optional. Create-account behavior must be explicit.
- `createAccountIfMissing`: optional boolean, default false.

Withdraw:

- `bankMint` or `bankAddress`: required.
- `amount`: required or `withdrawAll: true`.
- `marginfiAccount`: required unless unique default exists.

Borrow:

- `bankMint` or `bankAddress`: required.
- `amount`: required.
- `marginfiAccount`: required unless unique default exists.

Repay:

- `bankMint` or `bankAddress`: required.
- `amount`: required or `repayAll: true`.
- `marginfiAccount`: required unless unique default exists.

## Adapter Design

Files:

```text
packages/mcp-server/src/adapters/marginfi/constants.ts
packages/mcp-server/src/adapters/marginfi/client.ts
packages/mcp-server/src/adapters/marginfi/banks.ts
packages/mcp-server/src/adapters/marginfi/accounts.ts
packages/mcp-server/src/adapters/marginfi/health.ts
packages/mcp-server/src/adapters/marginfi/actions.ts
packages/mcp-server/src/adapters/marginfi/index.ts
```

`client.ts`:

- Dynamic import MarginFi SDK.
- Build read-only wallet shim with connected public key.
- Fetch production config for mainnet.
- Normalize account and bank lookup.

`banks.ts`:

- Return mint, bank address, deposit APY, borrow APR, asset weight, liability weight, oracle price, liquidity, and caps where SDK exposes them.

`accounts.ts`:

- Return positions by bank, supplied, borrowed, net value, health, liquidation threshold, and warnings.

`health.ts`:

- Simulate or preview health impact for proposed action.
- Required for borrow and withdraw.
- Strongly recommended for deposit and repay.

`actions.ts`:

- Build transactions for deposit, withdraw, borrow, repay.
- Store health before/after preview in prepared action.
- Recompute health before execution.

## Prepared Action Payload

Store:

- `connectorId: "marginfi"`
- `operation`
- `marginfiAccount`
- `bankAddress`
- `bankMint`
- `amount`
- `amountRaw`
- `healthPreview`
- `oraclePrice`
- `assetWeight`
- `liabilityWeight`
- `programIds`
- `transactionBase64`
- `refreshAtExecution: true`

Borrow and withdraw must always refresh at execution.

## Safety Checks

- Reject borrow/withdraw without health preview.
- Block if projected health is below configured threshold.
- Warn if oracle data is stale or unavailable.
- Warn on isolated/risky bank if SDK exposes risk flag.
- Warn if account has existing borrows before new borrow.
- Reject `createAccountIfMissing` unless user explicitly requested it.
- Reject `withdrawAll` if it would create unhealthy account.
- Do not enable account delegation in v1.
- Do not liquidate other users in v1.

## Tests

Unit tests:

- Missing SDK returns unavailable.
- Missing bank rejects.
- Borrow without health preview rejects.
- Withdraw projected unhealthy blocks.
- Deposit prepares transaction and stores preview.
- Repay all stores repay mode safely.

Mock tests:

- Healthy borrow.
- Unhealthy borrow.
- Withdraw all blocked by health.
- Missing marginfi account with create disabled.
- Create account explicit flag path if implemented.

Smoke prompts:

- "Show my MarginFi positions."
- "Check the health impact of borrowing 5 USDC on MarginFi."
- "Prepare depositing 0.01 SOL to MarginFi. Do not sign."
- "Prepare repaying all USDC debt on MarginFi."
- "Do not prepare this borrow if it makes my account risky."

## Completion Checklist

- MarginFi row says first-class.
- Bank and account reads work.
- Deposit/repay prepare paths work.
- Borrow/withdraw require health preview.
- Wallet approval remains mandatory.
