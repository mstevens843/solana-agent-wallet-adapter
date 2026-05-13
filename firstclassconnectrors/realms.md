# Realms First-Class Connector Plan

## Goal

Add a first-class Agentic connector for Realms/SPL Governance reads and prepare-only governance actions.

V1 scope:

- Read realms, governances, proposals, votes, token owner records, and wallet voting power.
- Prepare cast vote actions.
- Prepare relinquish vote where useful.
- Prepare deposit governance tokens and withdraw governance tokens where SPL Governance supports it.

Do not include treasury proposal construction, program upgrade proposals, council/member configuration changes, plugin governance logic, or autonomous voting in v1.

## Current Repo State

Realms is not in the current connector catalog.

Implementation will need to add it to:

- `apps/browser-demo/src/connectedDapps.ts`
- `packages/mcp-server/src/connectorRegistry.ts`
- `packages/mcp-server/src/adapters/types.ts`
- `packages/mcp-server/src/adapters/registry.ts`
- `packages/mcp-server/src/preparedActions.ts`
- `spec/connectors/realms.connector.json`
- `docs/connectors/README.md`

Realms should appear as `First-class governance connector`.

## External Source Of Truth

Use official Realms and SPL Governance sources:

- Realms developer resources: https://docs.realms.today/developer-resources/spl-governance
- SPL Governance program repository/docs referenced by Realms.
- Realms UI docs only for user-facing concepts, not transaction builders.

Important protocol facts to preserve:

- Realms is the governance UI and ecosystem around SPL Governance.
- SPL Governance proposals have state machines, vote records, token owner records, realms, and governances.
- Voting power can depend on deposited governance tokens and governance add-ins/plugins.
- A vote is not a guarantee that a proposal executes.

## Dependencies

Shared runtime worker should add optional dependency if stable:

- `@solana/spl-governance`

If the package is unsuitable, implement account decoding through official SPL Governance layouts only.

Config:

- `REALMS_CONNECTOR_ENABLED`: optional feature flag during rollout.

No API key is required for basic on-chain governance reads.

## Proposed MCP Tools

Read tools:

- `solana_realms_wallet_governance`
- `solana_realms_realm_snapshot`
- `solana_realms_governance_snapshot`
- `solana_realms_proposal_list`
- `solana_realms_proposal_snapshot`
- `solana_realms_vote_record`

Prepare tools:

- `solana_prepare_realms_cast_vote`
- `solana_prepare_realms_relinquish_vote`
- `solana_prepare_realms_deposit_governance_tokens`
- `solana_prepare_realms_withdraw_governance_tokens`

Prepared action kinds:

- `realms_cast_vote`
- `realms_relinquish_vote`
- `realms_deposit_governance_tokens`
- `realms_withdraw_governance_tokens`

## Inputs

Wallet governance:

- `walletAddress`: optional. Defaults to connected wallet.
- `realmAddress`: optional.
- `includeInactive`: optional boolean, default false.

Realm snapshot:

- `realmAddress`: required.
- `includeGovernances`: optional boolean, default true.
- `includeTokenMints`: optional boolean, default true.

Governance snapshot:

- `governanceAddress`: required.
- `includeConfig`: optional boolean, default true.
- `includeProposals`: optional boolean, default false.

Proposal list:

- `realmAddress`: required.
- `governanceAddress`: optional.
- `state`: optional enum `draft | signing_off | voting | succeeded | defeated | executing | completed | cancelled | all`, default `voting`.
- `limit`: optional integer, default 20.

Proposal snapshot:

- `proposalAddress`: required.
- `includeInstructions`: optional boolean, default true.
- `includeVoteBreakdown`: optional boolean, default true.

Vote record:

- `proposalAddress`: required.
- `walletAddress`: optional. Defaults to connected wallet.

Cast vote:

- `proposalAddress`: required.
- `vote`: required enum `approve | deny | abstain`.
- `choiceIndex`: optional for multi-choice proposals.
- `comment`: optional local note only.

Relinquish vote:

- `proposalAddress`: required.
- `beneficiaryAddress`: optional if SPL Governance supports release to a specific address.

Deposit governance tokens:

- `realmAddress`: required.
- `governingTokenMint`: required.
- `amount`: required decimal string.

Withdraw governance tokens:

- `realmAddress`: required.
- `governingTokenMint`: required.
- `amount`: optional decimal string.
- `withdrawAll`: optional boolean, default false.

## Adapter Design

Files:

```text
packages/mcp-server/src/adapters/realms/constants.ts
packages/mcp-server/src/adapters/realms/client.ts
packages/mcp-server/src/adapters/realms/realms.ts
packages/mcp-server/src/adapters/realms/proposals.ts
packages/mcp-server/src/adapters/realms/votes.ts
packages/mcp-server/src/adapters/realms/actions.ts
packages/mcp-server/src/adapters/realms/index.ts
```

`constants.ts` responsibilities:

- Store known SPL Governance program ids by cluster if needed.
- Store proposal state names and voting action limits.

`client.ts` responsibilities:

- Dynamic import SPL Governance SDK if used.
- Load realm, governance, proposal, token owner record, vote record, and config accounts.
- Normalize governance-program versions.

`realms.ts` responsibilities:

- Read realm metadata, governing token mints, council/community mint facts, governances, and wallet token owner records.

`proposals.ts` responsibilities:

- Read proposal state, vote type, choices, vote breakdown, instructions, execution status, and lifecycle timestamps.
- Decode proposal instructions when possible and mark unknown instructions clearly.

`votes.ts` responsibilities:

- Read wallet vote records, available voting power, already-cast votes, and relinquishable votes.

`actions.ts` responsibilities:

- Build unsigned cast vote, relinquish vote, deposit, and withdraw transactions.
- Refresh proposal state and wallet voting power before execution.

## Prepared Action Payload

Store:

- `connectorId: "realms"`
- `operation`
- `walletAddress`
- `cluster`
- `realmAddress`
- `governanceAddress`
- `proposalAddress`
- `governingTokenMint`
- `vote`
- `choiceIndex`
- `amount`
- `amountRaw`
- `proposalSnapshot`
- `walletGovernanceSnapshot`
- `votingPowerSnapshot`
- `instructionPreview`
- `programIds`
- `transactionBase64` only if reusable
- `refreshAtExecution: true`

## Safety Checks

- Reject unsupported clusters.
- Reject vote if proposal is not in a voting state.
- Reject vote if wallet has no voting power or already voted when duplicate votes are not allowed.
- Reject withdraw governance tokens if they are locked by active votes.
- Reject deposit if token mint does not match realm governing token mint.
- Warn when governance plugins or add-ins affect voting power and cannot be fully decoded.
- Warn when proposal instructions cannot be decoded.
- Warn that voting does not execute a proposal.
- Do not create treasury, upgrade, or config proposals in v1.
- Do not auto-vote based on AI recommendation.

## Tests

Unit tests:

- Realm snapshot reads token mints.
- Proposal list filters voting proposals.
- Proposal snapshot marks unknown instructions.
- Cast vote rejects non-voting proposal.
- Cast vote rejects no voting power.
- Withdraw rejects active vote lock.
- Execute path refresh blocks changed proposal state.
- Missing SDK returns structured unavailable reason.

Mock tests:

- Realm account decode.
- Token owner record decode.
- Proposal account decode.
- Vote record decode.
- Cast vote transaction serialization.

Smoke prompts:

- "Show my Realms voting power."
- "Summarize this Realms proposal and current vote breakdown."
- "Show proposals currently open for voting in this realm."
- "Prepare voting approve on this proposal. Do not sign."
- "Prepare depositing governance tokens into this realm."
- "Prepare relinquishing my vote if it is safe."

## Completion Checklist

- Realms appears in `/app` preferences as first-class.
- Realm, proposal, vote, and wallet governance reads work.
- Cast vote and token deposit/withdraw prepare actions create approval inbox items.
- Proposal state refreshes before execution.
- No Realms path signs before wallet approval.
