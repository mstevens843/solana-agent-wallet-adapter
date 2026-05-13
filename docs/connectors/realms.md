# Realms Connector

Realms is the first-class SPL Governance connector. The MCP runtime owns the adapter for realm, governance, proposal, vote-record, and wallet-governance reads, and for prepare-only cast vote, relinquish vote, and deposit/withdraw governance token approvals. Voting records weight on a proposal; it does not by itself execute the proposal.

## What It Can Read

- `solana_realms_wallet_governance` returns token-owner records for the connected wallet across realms: deposit amount, outstanding proposals, unrelinquished votes, governance delegate, and plugin-detection flags.
- `solana_realms_realm_snapshot` returns realm metadata (name, authority, community and council mints with decimals), the realm's governances, and detected voting-power plugins (e.g., VSR).
- `solana_realms_governance_snapshot` returns governance config (vote threshold type and pct, voting base seconds, cool-off seconds, min weights to create proposals) plus a proposal header list.
- `solana_realms_proposal_list` returns proposals for a realm filtered by state (default `voting`, capped at 100 entries).
- `solana_realms_proposal_snapshot` returns the proposal's state, vote type, choices, vote tally, voting and cool-off timestamps, and a decoded-where-known instruction preview. Unknown instructions are flagged.
- `solana_realms_vote_record` returns the wallet's vote record for a proposal: vote kind, weight, choice index, and relinquishment status.

## What It Can Prepare

- `solana_prepare_realms_cast_vote` prepares a `realms_cast_vote` inbox item. Rejects non-voting proposals, no voting power, already-voted records, council-mint-required veto attempts from a community wallet, and plugin-controlled realms (raw token-owner-record voting power is not authoritative under plugins).
- `solana_prepare_realms_relinquish_vote` prepares a `realms_relinquish_vote` inbox item. Allowed on both voting (to change vote) and finalized proposals (to refund the vote deposit).
- `solana_prepare_realms_deposit_governance_tokens` prepares a `realms_deposit_governance_tokens` inbox item against the realm's community or council mint at the mint's decimals.
- `solana_prepare_realms_withdraw_governance_tokens` prepares a `realms_withdraw_governance_tokens` inbox item. Blocked by outstanding proposals, unrelinquished votes, or a non-self governance delegate.
- `solana_execute_prepared_action` sends the prepared item to the wallet. It refreshes proposal, vote-record, and wallet-governance state before only the wallet signs.

## Required Inputs

- Cast vote: `proposalAddress`, `vote` (`approve` | `deny` | `abstain` | `veto`). Pass `choiceIndex` only for multi-choice proposals.
- Relinquish vote: `proposalAddress`. Optionally `beneficiaryAddress`.
- Deposit governance tokens: `realmAddress`, `governingTokenMint` (must be community or council), `amount` (human decimal).
- Withdraw governance tokens: `realmAddress`, `governingTokenMint`, either `amount` or `withdrawAll: true`.
- Optional schedule: `dueAt` for delayed inbox readiness.

Ask concise questions when fields are missing:

- "Which proposal address?"
- "Which realm and governing mint (community or council)?"
- "Withdraw the full deposit, or a specific amount?"

## Required Facts

- Realm community / council mint and decimals; plugin detection result and plugin names if any.
- Proposal state, vote type, vote tally, voting expiry, cool-off window.
- Wallet's token-owner record: deposit amount, outstanding proposals, unrelinquished votes, governance delegate, mint role (community or council).
- Existing vote record (if any) and relinquishment status.
- Realm's SPL Governance program id at prepare time; refreshed and re-checked at execute time.

## Deny Or Ask

Deny: treasury/upgrade/governance-config proposal construction, auto-vote based on AI recommendation, cast vote when a voting-power plugin is detected (e.g., VSR), cast vote on a non-voting proposal, cast vote with no voting power, cast vote when a non-relinquished vote already exists, cast approve during cool-off, veto from a wallet whose governing mint is not the council mint, withdraw while votes are unrelinquished or proposals are outstanding, withdraw while a third-party governance delegate is set, deposit a mint that is neither community nor council, action on non-mainnet clusters, signing without wallet approval.

Ask for input when `proposalAddress`, `realmAddress`, `governingTokenMint`, vote kind, or amount/withdrawAll is missing.

## User Approval

Realms writes create prepared actions only. They do not sign, submit, or grant delegated authority. The user still reviews and signs in the wallet. Cast vote is not execution — even a vote that tips the threshold does not guarantee proposal execution; the proposal still needs to be executed separately when its hold-up time and execution conditions are met.
