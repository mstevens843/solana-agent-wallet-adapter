# Project 0 First-Class Connector Plan

Add Project 0 as a first-class lending connector while keeping MarginFi available as its own connector. MarginFi's app migration copy points users to Project 0, but runtime support should expose both connector ids so existing MarginFi workflows do not disappear.

## Runtime Surface

- Adapter id: `project0`
- Website: `https://app.0.xyz`
- API base URL default: `https://ai.0.xyz`
- SDK optional dependency: `@0dotxyz/p0-ts-sdk`
- Supported cluster: `mainnet-beta`
- Policy: `connectors.project0.minHealthRatio`, default `1.1`

## Reads

- `solana_project0_banks`
- `solana_project0_strategies`
- `solana_project0_wallet`
- `solana_project0_account_detail`
- `solana_project0_health_preview`
- `solana_connector_read_facts` with `connectorId: "project0"`

## Prepared Actions

- `project0_create_account`
- `project0_deposit`
- `project0_withdraw`
- `project0_borrow`
- `project0_repay`

Every action prepares wallet approval work only. Borrow and withdraw require a health preview and recheck health at execution time.

## Denials

- Refuse borrow or withdraw when projected health is blocked or unavailable.
- Refuse non-mainnet requests.
- Refuse delegated authority, unlimited approvals, liquidation, flash loan, and authority-transfer flows.
- Never claim liquidation safety, execution without wallet approval, or migration of funds without the user's signature.

## Acceptance Notes

- Browser Protocol Connectors lists Project 0 next to MarginFi.
- MarginFi remains present with its existing first-class adapter and docs.
- Connector pack mirrors `apps/browser-demo/src/connectedDapps.ts`.
- Tests cover registry discovery, read facts, prepare-only actions, and wallet approval boundaries.
