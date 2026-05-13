# Squads Connector

Squads is the first-class multisig + treasury connector. The MCP runtime owns the adapter for multisig, vault, and proposal reads and for prepare-only proposal creation, approval, rejection, cancellation, and execution.

## What It Can Read

- `solana_squads_wallet_authority` returns the connected wallet's role across Squads multisigs (none, proposer, voter, executor, voter_executor, all) with threshold and member-count facts.
- `solana_squads_multisig_snapshot` returns members and permissions, threshold, time-lock, config authority, current transaction index, and vault count.
- `solana_squads_vault_snapshot` returns vault PDA, lamports balance, and SPL token-account balances by vault index or address.
- `solana_squads_proposal_snapshot` returns proposal status, approvals vs threshold, time-lock readiness, and a decoded instruction preview (SOL transfer, SPL transfer, memo, Squads admin instructions, compute-budget). Undecodable instructions surface a warning.
- `solana_squads_proposal_list` returns paged proposals for a multisig filtered by status (default `active`, max 100).

## What It Can Prepare

- `solana_prepare_squads_create_transfer_proposal` prepares a `squads_create_transfer_proposal` inbox item. V1 builds exactly one inner SOL or SPL transfer instruction inside a Squads vault transaction + proposal.
- `solana_prepare_squads_approve_proposal` prepares a `squads_approve_proposal` inbox item against an `active` proposal.
- `solana_prepare_squads_reject_proposal` prepares a `squads_reject_proposal` inbox item against an `active` proposal.
- `solana_prepare_squads_cancel_proposal` prepares a `squads_cancel_proposal` inbox item against an `approved` proposal.
- `solana_prepare_squads_execute_proposal` prepares a `squads_execute_proposal` inbox item once the threshold is met and the time-lock has elapsed.
- `solana_execute_prepared_action` sends the prepared item to the wallet. It rechecks Squads state and only the wallet signs.

## Required Inputs

- Create transfer proposal: multisig address, recipient, amount, mint (omit for SOL), vault index or address, title.
- Approve / reject / cancel / execute: multisig address, proposal address or transactionIndex. Reject and cancel accept an optional reason.
- Optional schedule: `dueAt` for delayed inbox readiness.

Ask concise questions when fields are missing:

- "Which Squads multisig?"
- "Which vault index or address should the proposal spend from?"
- "Should I read the vault balance so '50 percent' resolves to a concrete amount?"

## Required Facts

- Multisig threshold, time-lock, and member list.
- Connected wallet's per-multisig role (proposer / voter / executor).
- Vault PDA and balances for the mint being transferred.
- Current proposal status, approvals vs threshold, rejection count.
- Proposal `lockoutExpiresAt` and `executableAt` before executing.
- Decoded instruction preview before approving, rejecting, cancelling, or executing.

## Deny Or Ask

Deny: member/threshold admin changes, config-authority transfers, program upgrades, treasury swaps, auto-execute after approval, execute before threshold or time-lock, initiate from a non-proposer wallet, action on non-mainnet clusters, signing without wallet approval.

Ask for input when multisig address, vault descriptor, recipient, mint, amount, proposal descriptor, or title is missing.

## User Approval

Squads writes create prepared actions only. They do not sign, submit, or grant delegated authority. The user still reviews and signs in the wallet. Execute moves treasury funds — the wallet review must show the decoded instruction preview and any warnings.
