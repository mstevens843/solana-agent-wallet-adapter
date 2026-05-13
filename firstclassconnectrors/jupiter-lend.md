# Jupiter Lend First-Class Connector Plan

## Goal

Add first-class Jupiter Lend support for Earn and Borrow.

V1 scope:

- Read Earn tokens, token details, user Earn positions, and earnings.
- Read Borrow vaults, vault config/state, user positions, and position health.
- Prepare Earn deposit, withdraw, mint, and redeem.
- Prepare Borrow create position, deposit collateral, borrow, repay, and withdraw collateral.
- Keep flashloans, multiply, unwind, vault swap, liquidation, and advanced leverage flows out of v1.

## Current Repo State

Jupiter Lend is not first-class in MCP runtime.

Current docs and connector pack treat Jupiter lend/borrow as planned or Blink-backed:

- `spec/connectors/jupiter.connector.json`
- `docs/connectors/jupiter.md`
- `packages/mcp-server/src/connectorRegistry.ts`
- `apps/browser-demo/src/connectedDapps.ts`

Implementation should remove the "paste a Blink URL" requirement for supported Lend flows once the adapter ships.

## External Source Of Truth

Use official Jupiter Lend docs:

- Lend overview/API vs SDK: https://developers.jup.ag/docs/lend/api-vs-sdk
- Earn overview: https://developers.jup.ag/docs/lend/earn
- Earn deposit: https://developers.jup.ag/docs/lend/earn/deposit
- Earn withdraw: https://developers.jup.ag/docs/lend/earn/withdraw
- Borrow read vault data: https://developers.jup.ag/docs/lend/borrow/read-vault-data
- Borrow assets: https://developers.jup.ag/docs/lend/borrow/borrow
- Repay: https://developers.jup.ag/docs/lend/borrow/repay
- Program addresses: https://developers.jup.ag/docs/lend/program-addresses

Important protocol facts:

- REST API can provide Earn data, positions, earnings, and unsigned Earn transactions.
- `@jup-ag/lend-read` reads on-chain Earn and Borrow data.
- `@jup-ag/lend` builds Earn and Borrow instructions.
- Borrow REST transaction endpoints are marked coming soon; use SDK for Borrow writes.
- Borrow positions have collateral, debt, liquidation threshold, and risk state.
- Official mainnet program addresses include:
  - Jupiter Lend Earn: `jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9`
  - Jupiter Lend Liquidity: `jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC`
  - Jupiter Rewards Rate Model: `jup7TthsMgcR9Y3L277b8Eo9uboVSmu1utkuXHNUKar`
  - Jupiter Oracle: `jupnw4B6Eqs7ft6rxpzYLJZYSnrpRgPcr589n5Kv4oc`
  - Jupiter Vaults Borrow: `jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi`
  - Jupiter Flashloan: `jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS`

## Dependencies

Shared runtime worker should add optional dependencies:

- `@jup-ag/lend-read`
- `@jup-ag/lend`
- `bn.js` if not already available where needed

Config:

- `JUPITER_API_KEY` or `JUP_API_KEY`: required for REST reads/transactions.
- `JUPITER_LEND_BASE_URL`: optional, default `https://api.jup.ag/lend/v1`.
- `JUPITER_LEND_USE_SDK`: optional boolean, default true for transaction builders.
- `connectors.jupiter.minBorrowHealthRatio`: optional, default 1.25.
- `connectors.jupiter.maxBorrowLtvBps`: optional.

SDKs must be optional. Missing SDK should degrade Borrow writes and SDK reads with `sdkUnavailable`, not break swaps.

## Proposed MCP Tools

Read tools:

- `solana_jupiter_lend_earn_tokens`
- `solana_jupiter_lend_earn_token_detail`
- `solana_jupiter_lend_earn_positions`
- `solana_jupiter_lend_earn_earnings`
- `solana_jupiter_lend_borrow_vaults`
- `solana_jupiter_lend_borrow_vault_detail`
- `solana_jupiter_lend_borrow_positions`
- `solana_jupiter_lend_borrow_health_preview`

Prepare tools:

- `solana_prepare_jupiter_lend_earn_deposit`
- `solana_prepare_jupiter_lend_earn_withdraw`
- `solana_prepare_jupiter_lend_earn_mint`
- `solana_prepare_jupiter_lend_earn_redeem`
- `solana_prepare_jupiter_lend_borrow_create_position`
- `solana_prepare_jupiter_lend_borrow_deposit_collateral`
- `solana_prepare_jupiter_lend_borrow_borrow`
- `solana_prepare_jupiter_lend_borrow_repay`
- `solana_prepare_jupiter_lend_borrow_withdraw_collateral`

Prepared action kinds:

- `jupiter_lend_earn_deposit`
- `jupiter_lend_earn_withdraw`
- `jupiter_lend_earn_mint`
- `jupiter_lend_earn_redeem`
- `jupiter_lend_borrow_create_position`
- `jupiter_lend_borrow_deposit_collateral`
- `jupiter_lend_borrow_borrow`
- `jupiter_lend_borrow_repay`
- `jupiter_lend_borrow_withdraw_collateral`

## Inputs

Earn tokens:

- `includeInactive`: optional boolean, default false.
- `assetMint`: optional.

Earn positions:

- `walletAddress`: optional. Defaults to connected wallet.
- `assetMint`: optional.

Earn earnings:

- `walletAddress`: optional. Defaults to connected wallet.
- `assetMint`: optional.
- `from`: optional ISO timestamp.
- `to`: optional ISO timestamp.

Borrow vaults:

- `vaultId`: optional number.
- `supplyMint`: optional.
- `borrowMint`: optional.
- `includeUnavailable`: optional boolean, default false.

Borrow positions:

- `walletAddress`: optional. Defaults to connected wallet.
- `vaultId`: optional.
- `positionId`: optional number.

Borrow health preview:

- `vaultId`: required.
- `positionId`: required unless creating a new position.
- `collateralDelta`: optional signed decimal string.
- `debtDelta`: optional signed decimal string.

Earn deposit/withdraw:

- `assetMint`: required.
- `amount`: required decimal string in underlying asset units.
- `minSharesOut` or `minUnderlyingOut`: optional decimal string.

Earn mint/redeem:

- `assetMint`: required.
- `shares` or `amount`: required depending on operation.
- `minUnderlyingOut`: optional for redeem.

Borrow create position:

- `vaultId`: required.
- `collateralAmount`: optional decimal string.
- `borrowAmount`: optional decimal string.

Borrow deposit/withdraw collateral:

- `vaultId`: required.
- `positionId`: required.
- `amount`: required decimal string.
- `minHealthRatio`: optional, default config.

Borrow/repay:

- `vaultId`: required.
- `positionId`: required.
- `amount`: required decimal string, or `repayAll: true` for repay.
- `minHealthRatio`: optional, default config.

## Adapter Design

Files:

```text
packages/mcp-server/src/adapters/jupiter/constants.ts
packages/mcp-server/src/adapters/jupiter/client.ts
packages/mcp-server/src/adapters/jupiter/lendEarn.ts
packages/mcp-server/src/adapters/jupiter/lendBorrow.ts
packages/mcp-server/src/adapters/jupiter/lendActions.ts
packages/mcp-server/src/adapters/jupiter/lendHealth.ts
packages/mcp-server/src/adapters/jupiter/index.ts
```

`constants.ts` responsibilities:

- Store official Lend program ids.
- Store product base URLs and action caps.
- Store health threshold defaults.

`client.ts` responsibilities:

- Build Jupiter API client.
- Dynamic import `@jup-ag/lend-read` and `@jup-ag/lend`.
- Redact API keys and signed transaction bodies.
- Normalize missing SDK/API/unavailable errors.

`lendEarn.ts` responsibilities:

- Read Earn tokens, details, positions, and earnings.
- Normalize shares, underlying amount, exchange prices, rewards, APY, wallet balance, and as-of timestamp.

`lendBorrow.ts` responsibilities:

- Read vaults, configs, state, user positions, and position NFTs.
- Normalize collateral, debt, LTV, liquidation threshold, liquidation status, borrow/supply availability, and oracle facts.

`lendHealth.ts` responsibilities:

- Use read SDK preview helpers where available.
- Calculate projected health for borrow/withdraw/repay/deposit.
- Return fail/warn/good facts for planner reviews.

`lendActions.ts` responsibilities:

- Build unsigned transactions or instructions for Earn and Borrow actions.
- Prefer SDK builders for Borrow writes.
- Refresh vault/position state before execution.

## Prepared Action Payload

Every Lend prepared action should store:

- `connectorId: "jupiter"`
- `product: "lend"`
- `operation`
- `walletAddress`
- `cluster`
- `assetMint`
- `vaultId`
- `positionId`
- `amount`
- `amountRaw`
- `shares`
- `sharesRaw`
- `minSharesOut`
- `minUnderlyingOut`
- `minHealthRatio`
- `earnSnapshot`
- `vaultSnapshot`
- `positionSnapshot`
- `healthPreview`
- `oracleSnapshot`
- `programIds`
- `transactionBase64` only when safely reusable
- `refreshAtExecution: true`

Borrow and withdraw-collateral actions must refresh health at execution.

## Safety Checks

- Reject unsupported clusters.
- Reject missing API key for REST paths.
- Reject missing SDK for SDK-backed write paths.
- Reject unknown asset mint or vault id.
- Reject if wallet does not own the Borrow position.
- Reject borrow/withdraw collateral if projected health is below configured threshold.
- Reject action if position is liquidated or liquidation state is unknown.
- Reject stale oracle/vault data.
- Warn when liquidity is low or withdrawal smoothing affects Earn withdrawals.
- Warn when APY/yield/rewards are variable.
- Warn when debt accrues interest.
- Warn when oracle is unavailable or price confidence is weak.
- Do not expose flashloans, liquidations, multiply, unwind, or leverage loops in v1.
- Do not claim yield or borrow safety is guaranteed.

## Tests

Unit tests:

- Missing API key blocks REST reads.
- Missing SDK blocks SDK-backed writes without breaking swaps.
- Earn token read normalizes exchange prices and reward facts.
- Earn position read normalizes shares and underlying amount.
- Borrow vault read normalizes collateral factor and liquidation threshold.
- Borrow positions read filters by owner.
- Borrow health preview blocks unsafe borrow.
- Earn deposit prepare stores min-output and refresh metadata.
- Borrow repay all stores repay mode.
- Execute refresh blocks health regression before signing.
- Errors redact API key and signed transaction bodies.

Mock tests:

- Earn REST tokens success.
- Earn REST positions success.
- `@jup-ag/lend-read` vault list success.
- Borrow position health preview success.
- Earn SDK instruction serialization.
- Borrow SDK v0 transaction serialization with address lookup tables.

Smoke prompts:

- "Show Jupiter Earn markets and rates."
- "Show my Jupiter Earn positions."
- "Prepare depositing 5 USDC into Jupiter Earn. Do not sign."
- "Prepare withdrawing 2 USDC from Jupiter Earn."
- "Show Jupiter Borrow vaults for SOL/USDC."
- "Show my Jupiter Borrow health."
- "Prepare borrowing 2 USDC only if health stays above 1.5."
- "Prepare repaying all of my Jupiter Borrow USDC debt."

## Completion Checklist

- Jupiter Lend reads appear in connector capabilities.
- Earn deposit/withdraw/mint/redeem create prepared actions.
- Borrow create/deposit/borrow/repay/withdraw create prepared actions with health gates.
- Lend no longer requires a pasted Blink URL for supported flows.
- Health and oracle facts are visible in planner review.
- No Lend path signs before wallet approval.
