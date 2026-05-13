# Lulo Connector

Lulo is a first-class lending connector. The MCP runtime owns the adapter for reads (rates, pool metadata, wallet balances) and prepare-only deposit, withdraw, and complete-withdraw actions. Transaction building is delegated to the Lulo REST API; the wallet always signs.

## Requirements

- Mainnet-beta only.
- `LULO_API_KEY` must be set in the host environment for live reads and prepared actions.
- `LULO_API_BASE_URL` is optional; defaults to `https://api.lulo.fi`.
- The API key is sent only as the `x-api-key` request header. It is never stored in receipts, prepared-action params, notes, or browser state, and it is redacted from any error message before the error reaches the agent or user.

## What It Can Read

- `solana_lulo_rates` returns Protected/Boost/Regular APY by mint, optionally filtered by `depositType`, with TVL and liquidity facts when the API exposes them.
- `solana_lulo_pool_meta` returns program ids, supported deposit types, decimals (when reported), and the regular-withdrawal cooldown seconds.
- `solana_lulo_wallet_balances` returns the wallet's Lulo positions, earned interest, withdrawable balance, and any pending regular withdrawals. Returns a structured `balances_unavailable` fact if the Lulo API does not expose balances for the wallet.

## What It Can Prepare

- `solana_prepare_lulo_deposit` prepares a `lulo_deposit` inbox item for Protected, Boost, or Regular deposits.
- `solana_prepare_lulo_withdraw` prepares a `lulo_withdraw` inbox item. Protected withdrawals settle in one transaction. Regular withdrawals are two-step: this prepares the initiation, then `solana_prepare_lulo_complete_withdraw` finalizes after the cooldown.
- `solana_prepare_lulo_complete_withdraw` prepares a `lulo_complete_withdraw` inbox item scoped to a specific `withdrawalId`.
- `solana_execute_prepared_action` sends the prepared item to the wallet. The adapter re-calls the Lulo API for a fresh transaction before signing.

## Required Inputs

- Deposit: `amount` plus `mintAddress`. `depositType` defaults to `protected`.
- Withdraw: `mintAddress` plus either `amount` or `percentage` (defaults to 100 when both are omitted). `withdrawType` defaults to `protected`.
- Complete withdraw: `mintAddress` plus the `withdrawalId` returned by the initiating regular withdraw.
- Optional schedule: `dueAt` for delayed inbox readiness; `note` for free-form context.

Ask concise questions when fields are missing:

- "How much do you want to deposit into Lulo?"
- "Which token mint should Lulo use?"
- "Which Lulo product: Protected, Boost, or Regular?"
- "Which withdrawalId should I complete?"

## Required Facts

- Live rates snapshot for the chosen mint and deposit type.
- Pool metadata: supported deposit types, cooldown seconds, program ids.
- Wallet position and pending-withdrawal state before any withdraw or complete-withdraw.
- Mint decimals before parsing the human amount.

## Deny Or Ask

Deny any request that:

- Claims Lulo Protected, Boost, or Regular yield is risk-free or guaranteed.
- Targets devnet or testnet.
- Asks the agent to move funds without wallet approval or to sign autonomously.
- Initiates a complete-withdraw without a `withdrawalId`.

Ask when amount, mint, deposit type, percentage, or `withdrawalId` is missing.

## User Approval

Lulo writes create prepared actions. They do not sign, submit, or grant delegated authority. At execution time the adapter calls the Lulo API for a fresh transaction, runs the standard preflight simulation, and only the wallet signs and broadcasts.
