# Kamino Connector

Kamino is the first-class lending connector. The MCP runtime owns the adapter for reads and prepared deposit/withdraw actions.

## What It Can Read

- `solana_kamino_reserve_snapshot` returns supply APY, borrow APY, utilization, deposit capacity, withdraw availability, withdrawal delay, reserve mint, and reserve address.
- `solana_kamino_get_positions` returns supplied positions, current value, earned interest, reserve facts, and totals for a wallet.
- `solana_kamino_prepare_earnings_proof` builds a deterministic proof payload that can be signed as a message. It is proof-only and does not build a transaction.

## What It Can Prepare

- `solana_prepare_kamino_deposit` prepares a `kamino_deposit` inbox item.
- `solana_prepare_kamino_withdraw` prepares a `kamino_withdraw` inbox item.
- `solana_execute_prepared_action` sends the prepared item to the wallet. It rechecks adapter state and only the wallet signs.

## Required Inputs

- Deposit: amount plus token or reserve mint.
- Withdraw: amount or `withdrawAll`, plus token or reserve mint.
- Optional schedule: `dueAt` for delayed inbox readiness.

Ask concise questions when fields are missing:

- "How much do you want to deposit or withdraw?"
- "Which Kamino reserve should I use?"
- "Should I read your current position before resolving 'half' or 'all'?"

## Required Facts

- Reserve snapshot for the selected reserve.
- Deposit cap remaining before deposit.
- Withdraw availability and withdrawal delay before withdraw.
- Wallet balance and fee headroom.
- Position facts when the user asks for relative amounts such as half, all, or earned interest.

## Deny Or Ask

Deny claim-rewards, borrow, unsupported reserves, non-mainnet clusters, and any request that says the agent should sign or move funds without wallet approval. Ask for input when amount, reserve, or relative-position facts are missing.

## User Approval

Kamino writes create prepared actions. They do not sign, submit, or grant delegated authority. The user still reviews and signs in the wallet.
