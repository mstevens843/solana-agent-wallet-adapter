# Marinade First-Class Connector Plan

## Goal

Add a first-class Agentic connector for Marinade liquid staking and basic native staking visibility.

V1 scope:

- Read Marinade state and mSOL pool facts.
- Read wallet mSOL balance.
- Read wallet Marinade delayed-unstake tickets where supported.
- Read wallet native stake accounts for review.
- Prepare liquid stake SOL to mSOL.
- Prepare liquid unstake mSOL to SOL.
- Prepare delayed unstake mSOL and claim delayed unstake when supported by SDK.

Do not include validator delegation strategy editing, stake auction/validator manager flows, DAO governance, MNDE actions, or automated stake rebalancing in v1.

## Current Repo State

Marinade is not in the current connector catalog.

Implementation will need to add it to:

- `apps/browser-demo/src/connectedDapps.ts`
- `packages/mcp-server/src/connectorRegistry.ts`
- `packages/mcp-server/src/adapters/types.ts`
- `packages/mcp-server/src/adapters/registry.ts`
- `packages/mcp-server/src/preparedActions.ts`
- `spec/connectors/marinade.connector.json`
- `docs/connectors/README.md`

Marinade should appear as `First-class liquid staking connector`.

## External Source Of Truth

Use official Marinade sources:

- Marinade TypeScript SDK: https://github.com/marinade-finance/marinade-ts-sdk
- Marinade docs: https://docs.marinade.finance/
- Marinade liquid staking docs: https://docs.marinade.finance/marinade-protocol/system-overview

Important protocol facts to preserve:

- Marinade liquid staking uses mSOL.
- Marinade offers liquid unstake and delayed unstake style workflows.
- Marinade SDK can build transactions for common staking and unstaking actions.
- Native stake accounts and mSOL positions are different user surfaces and must not be collapsed into one balance.

## Dependencies

Shared runtime worker should add optional dependency:

- `@marinade.finance/marinade-ts-sdk`

Config:

- `MARINADE_CONNECTOR_ENABLED`: optional feature flag during rollout.

No Marinade API key is required for core SDK/on-chain flows.

## Proposed MCP Tools

Read tools:

- `solana_marinade_state_snapshot`
- `solana_marinade_wallet_positions`
- `solana_marinade_wallet_stake_accounts`
- `solana_marinade_unstake_tickets`
- `solana_marinade_quote`

Prepare tools:

- `solana_prepare_marinade_liquid_stake`
- `solana_prepare_marinade_liquid_unstake`
- `solana_prepare_marinade_delayed_unstake`
- `solana_prepare_marinade_claim_delayed_unstake`

Prepared action kinds:

- `marinade_liquid_stake`
- `marinade_liquid_unstake`
- `marinade_delayed_unstake`
- `marinade_claim_delayed_unstake`

Native stake delegation/editing should stay read-only in v1 unless a separate native-stake action plan is approved.

## Inputs

State snapshot:

- `includeValidators`: optional boolean, default false.
- `includeFees`: optional boolean, default true.

Wallet positions:

- `walletAddress`: optional. Defaults to connected wallet.
- `includeStakeAccounts`: optional boolean, default true.
- `includeUnstakeTickets`: optional boolean, default true.

Wallet stake accounts:

- `walletAddress`: optional. Defaults to connected wallet.
- `state`: optional enum `active | activating | deactivating | inactive | all`, default `all`.

Unstake tickets:

- `walletAddress`: optional. Defaults to connected wallet.
- `claimableOnly`: optional boolean, default false.

Quote:

- `operation`: required enum `liquid_stake | liquid_unstake | delayed_unstake`.
- `amount`: required decimal string.

Liquid stake:

- `solAmount`: required decimal string.
- `minMsolAmount`: optional decimal string.

Liquid unstake:

- `msolAmount`: required decimal string.
- `minSolAmount`: optional decimal string.
- `maxFeeBps`: optional.

Delayed unstake:

- `msolAmount`: required decimal string.
- `expectedClaimableAt`: optional ISO timestamp.

Claim delayed unstake:

- `ticketAccount`: required public key.
- `minSolAmount`: optional decimal string.

## Adapter Design

Files:

```text
packages/mcp-server/src/adapters/marinade/constants.ts
packages/mcp-server/src/adapters/marinade/client.ts
packages/mcp-server/src/adapters/marinade/state.ts
packages/mcp-server/src/adapters/marinade/wallet.ts
packages/mcp-server/src/adapters/marinade/tickets.ts
packages/mcp-server/src/adapters/marinade/actions.ts
packages/mcp-server/src/adapters/marinade/index.ts
```

`constants.ts` responsibilities:

- Store known mSOL mint and mainnet support.
- Store stale quote, minimum amount, and fee defaults.

`client.ts` responsibilities:

- Dynamic import Marinade SDK.
- Build SDK context with connection and readonly wallet.
- Return typed unavailable reasons.

`state.ts` responsibilities:

- Read Marinade state, mSOL price, liquidity, fees, validators when requested, and pause/degraded states.

`wallet.ts` responsibilities:

- Read mSOL token balance.
- Read native stake accounts and classify by state.
- Keep liquid staking and native staking facts separate.

`tickets.ts` responsibilities:

- Read delayed unstake tickets.
- Mark claimable, pending, expired, or unknown states.

`actions.ts` responsibilities:

- Build unsigned liquid stake, liquid unstake, delayed unstake, and claim transactions.
- Refresh mSOL price and liquidity before execution.

## Prepared Action Payload

Store:

- `connectorId: "marinade"`
- `operation`
- `walletAddress`
- `cluster`
- `solAmount`
- `msolAmount`
- `minMsolAmount`
- `minSolAmount`
- `maxFeeBps`
- `ticketAccount`
- `stateSnapshot`
- `quoteSnapshot`
- `feePreview`
- `claimableAt`
- `programIds`
- `transactionBase64` only if reusable
- `refreshAtExecution: true`

## Safety Checks

- Reject unsupported clusters.
- Reject if SDK unavailable.
- Reject stake/unstake below minimum.
- Reject liquid unstake if refreshed fee exceeds `maxFeeBps`.
- Reject if refreshed SOL or mSOL output is below user minimum.
- Reject claim if delayed-unstake ticket is not claimable.
- Warn when liquid unstake liquidity is low.
- Warn about delayed unstake timing.
- Warn that mSOL price and yield are variable and not guaranteed.
- Do not merge native stake-account balances into liquid mSOL without explanation.
- Do not automate validator delegation changes in v1.

## Tests

Unit tests:

- Missing SDK returns unavailable.
- State snapshot includes mSOL and liquidity facts.
- Wallet positions keep mSOL and native stake separate.
- Liquid stake prepare rejects below minimum.
- Liquid unstake rejects fee above cap.
- Claim delayed unstake rejects non-claimable ticket.
- Execute path refreshes quote/state before approval.

Mock tests:

- Marinade state success.
- Wallet mSOL balance success.
- Stake account classification.
- Unstake ticket classification.
- SDK transaction serialization.

Smoke prompts:

- "Show Marinade mSOL state and fees."
- "Show my Marinade positions and stake accounts."
- "Prepare liquid staking 1 SOL into mSOL. Do not sign."
- "Prepare liquid unstaking 0.5 mSOL with at least this SOL output."
- "Prepare claiming my Marinade delayed unstake ticket."

## Completion Checklist

- Marinade appears in `/app` preferences as first-class.
- State, wallet, and ticket reads work.
- Liquid stake and unstake prepare actions work.
- Delayed unstake claim is enabled only after ticket checks.
- No Marinade path signs before wallet approval.
