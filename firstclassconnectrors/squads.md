# Squads First-Class Connector Plan

## Goal

Add a first-class Agentic connector for Squads multisig and treasury workflows.

V1 scope:

- Read Squads multisigs, members, thresholds, vaults, spending limits, and proposals.
- Read wallet authority across Squads.
- Prepare create proposal actions.
- Prepare approve, reject, cancel, and execute proposal actions.
- Prepare vault transaction proposals for transfers only after strict proposal-preview checks.

Do not include threshold bypassing, direct vault transfer outside Squads, member/threshold admin changes, program upgrades, treasury swaps, or automated proposal execution in v1.

## Current Repo State

Squads is not in the current connector catalog.

Implementation will need to add it to:

- `apps/browser-demo/src/connectedDapps.ts`
- `packages/mcp-server/src/connectorRegistry.ts`
- `packages/mcp-server/src/adapters/types.ts`
- `packages/mcp-server/src/adapters/registry.ts`
- `packages/mcp-server/src/preparedActions.ts`
- `spec/connectors/squads.connector.json`
- `docs/connectors/README.md`

Squads should appear as `First-class multisig connector`.

## External Source Of Truth

Use official Squads docs:

- Squads developer docs: https://docs.squads.so/
- TypeScript accounts docs: https://docs.squads.so/main/development/typescript/accounts/multisig
- Program account and transaction docs from Squads v4 docs.

Important protocol facts to preserve:

- Squads is a multisig protocol.
- A wallet can be a member, proposer, voter, executor, or no authority depending on multisig config.
- Proposal execution must follow Squads threshold and proposal-state rules.
- Creating a proposal is not equivalent to executing treasury movement.

## Dependencies

Shared runtime worker should add optional dependency:

- `@sqds/multisig`

Config:

- `SQUADS_CONNECTOR_ENABLED`: optional feature flag during rollout.

No Squads API key is required for basic on-chain reads.

## Proposed MCP Tools

Read tools:

- `solana_squads_wallet_authority`
- `solana_squads_multisig_snapshot`
- `solana_squads_vault_snapshot`
- `solana_squads_proposal_snapshot`
- `solana_squads_proposal_list`

Prepare tools:

- `solana_prepare_squads_create_transfer_proposal`
- `solana_prepare_squads_approve_proposal`
- `solana_prepare_squads_reject_proposal`
- `solana_prepare_squads_cancel_proposal`
- `solana_prepare_squads_execute_proposal`

Prepared action kinds:

- `squads_create_transfer_proposal`
- `squads_approve_proposal`
- `squads_reject_proposal`
- `squads_cancel_proposal`
- `squads_execute_proposal`

## Inputs

Wallet authority:

- `walletAddress`: optional. Defaults to connected wallet.
- `includeProposals`: optional boolean, default true.

Multisig snapshot:

- `multisigAddress`: required.
- `includeMembers`: optional boolean, default true.
- `includeVaults`: optional boolean, default true.
- `includeProposals`: optional boolean, default false.

Vault snapshot:

- `multisigAddress`: required.
- `vaultIndex` or `vaultAddress`: required.
- `includeBalances`: optional boolean, default true.

Proposal list:

- `multisigAddress`: required.
- `status`: optional enum `draft | active | approved | rejected | executed | cancelled | all`, default `active`.
- `limit`: optional integer, default 20.

Proposal snapshot:

- `multisigAddress`: required.
- `proposalAddress` or `transactionIndex`: required.
- `includeInstructions`: optional boolean, default true.

Create transfer proposal:

- `multisigAddress`: required.
- `vaultIndex` or `vaultAddress`: required.
- `recipient`: required public key.
- `mintAddress`: optional. Omit for SOL.
- `amount`: required decimal string.
- `memo`: optional string.
- `title`: required short string.
- `description`: optional string.

Approve/reject/cancel/execute proposal:

- `multisigAddress`: required.
- `proposalAddress` or `transactionIndex`: required.
- `reason`: optional string for reject/cancel notes.

## Adapter Design

Files:

```text
packages/mcp-server/src/adapters/squads/constants.ts
packages/mcp-server/src/adapters/squads/client.ts
packages/mcp-server/src/adapters/squads/multisigs.ts
packages/mcp-server/src/adapters/squads/vaults.ts
packages/mcp-server/src/adapters/squads/proposals.ts
packages/mcp-server/src/adapters/squads/actions.ts
packages/mcp-server/src/adapters/squads/index.ts
```

`constants.ts` responsibilities:

- Store supported clusters and known program ids from SDK.
- Store action limits for transfer proposal amounts and instruction count.

`client.ts` responsibilities:

- Dynamic import Squads SDK.
- Build readonly on-chain account loader.
- Normalize multisig, vault, member, proposal, and transaction accounts.

`multisigs.ts` responsibilities:

- Read members, threshold, time lock, config authority, rent payer, and permissions.
- Resolve current wallet's role.

`vaults.ts` responsibilities:

- Read vault addresses, balances, token accounts, and spending limit accounts where supported.

`proposals.ts` responsibilities:

- Read proposal state, approvals, rejects, threshold progress, transaction instructions, and execution readiness.
- Decode simple SOL/SPL transfers into user-facing facts.

`actions.ts` responsibilities:

- Build unsigned Squads transactions for proposal create/vote/execute flows.
- Never build a direct vault transfer outside Squads proposal mechanics.
- Refresh proposal state before approve/reject/execute.

## Prepared Action Payload

Store:

- `connectorId: "squads"`
- `operation`
- `walletAddress`
- `cluster`
- `multisigAddress`
- `vaultAddress`
- `vaultIndex`
- `proposalAddress`
- `transactionIndex`
- `recipient`
- `mintAddress`
- `amount`
- `amountRaw`
- `thresholdSnapshot`
- `memberSnapshot`
- `proposalSnapshot`
- `instructionPreview`
- `programIds`
- `transactionBase64` only if reusable
- `refreshAtExecution: true`

## Safety Checks

- Reject unsupported clusters.
- Reject if wallet is not an authorized Squads member for the operation.
- Reject create transfer proposal if vault balance is insufficient.
- Reject execute if proposal is not approved or time lock is not satisfied.
- Reject approve/reject if proposal state no longer allows that vote.
- Warn when proposal contains instructions that cannot be decoded.
- Warn when execution moves treasury funds.
- Warn when threshold is close but not met.
- Do not bypass Squads threshold logic.
- Do not support member or threshold admin changes in v1.
- Do not auto-execute proposals after approval.

## Tests

Unit tests:

- Wallet authority returns no-role cleanly.
- Multisig snapshot normalizes threshold and members.
- Proposal snapshot decodes simple transfer.
- Create transfer proposal rejects insufficient vault balance.
- Approve rejects unauthorized wallet.
- Execute rejects proposal below threshold.
- Execute refresh blocks changed proposal state.
- Missing SDK returns structured unavailable reason.

Mock tests:

- Multisig account decode.
- Vault balance read.
- Active proposal read.
- Create transfer proposal transaction serialization.
- Approve and execute transaction serialization.

Smoke prompts:

- "Show my Squads multisigs and roles."
- "Show this Squads vault balance."
- "Summarize this Squads proposal and threshold progress."
- "Prepare a Squads transfer proposal for 100 USDC. Do not sign."
- "Prepare approving this Squads proposal."
- "Prepare executing this approved Squads proposal."

## Completion Checklist

- Squads appears in `/app` preferences as first-class.
- Wallet authority, multisig, vault, and proposal reads work.
- Proposal create/vote/execute prepare actions create approval inbox items.
- Execute is state-gated by threshold and time lock.
- No Squads path signs before wallet approval.
