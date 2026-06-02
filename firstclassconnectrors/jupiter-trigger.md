# Jupiter Trigger V2 Connector Plan

## Goal

Add first-class Jupiter Trigger V2 support with explicit vault, JWT, and external-automation safety treatment.

V1 scope:

- Authenticate to Trigger V2 with wallet challenge flow.
- Read auth status without exposing JWT.
- Read or register the user's Trigger vault.
- Read active, historical, expired, ready-to-cancel, and cancelled orders.
- Prepare vault deposit and create single trigger orders.
- Prepare OCO and OTOCO only after single-order flow is complete and tested.
- Prepare edit order where no wallet signature is required, but still require explicit user confirmation in Agentic.
- Prepare cancel and withdrawal flows for cancelled/expired orders.

Do not hide the fact that Trigger orders execute later through Jupiter automation. Do not present Trigger as Agentic recurring approval-per-run work.

## Current Repo State

Current Jupiter Trigger launch behavior is documented in
[`docs/connectors/jupiter.md`](../docs/connectors/jupiter.md#trigger-v2).
- Multi-step deposit-sign-create flow.
- Safety copy that distinguishes external automation from Agentic manual approvals.

## External Source Of Truth

Use official Jupiter Trigger docs:

- Trigger overview: https://developers.jup.ag/docs/trigger
- Trigger authentication: https://developers.jup.ag/docs/trigger/authentication
- Trigger create order: https://developers.jup.ag/docs/trigger/create-order
- Trigger manage orders: https://developers.jup.ag/docs/trigger/manage-orders
- Trigger order history: https://developers.jup.ag/docs/api-reference/trigger/order-history

Important protocol facts:

- Trigger V2 base URL is `https://api.jup.ag/trigger/v2`.
- All endpoints require `x-api-key`.
- Authenticated endpoints require `Authorization: Bearer <token>`.
- Auth uses wallet challenge-response.
- Challenge TTL is 5 minutes.
- JWT TTL is 24 hours.
- Each wallet has a single vault.
- The vault is a Privy-managed custodial account.
- Orders deposit funds from the wallet into the vault.
- Orders are stored off-chain and private until execution.
- Supported order types include single, OCO, and OTOCO.
- V2 uses USD price triggers, not V1 pool-rate triggers.
- Output is not guaranteed at trigger time.
- Minimum order size is 10 USD equivalent.
- Stop-loss and buy-above defaults can use high slippage because execution certainty is prioritized.
- Cancellation and withdrawal are separate steps.
- Official create-order docs included a field-change note for Wednesday, May 13, 2026; implementation must re-check docs before hardcoding deposit fields.

## Dependencies

No Jupiter-specific package is required in v1.

Required runtime capabilities:

- Message-signing support for standard Trigger challenge flow, or transaction-challenge signing support as fallback.
- Secure in-memory JWT cache keyed by wallet, cluster, and API host.
- Redaction helper for JWT/challenge/signed transaction values.

Config:

- `JUPITER_API_KEY` or `JUP_API_KEY`: required.
- `JUPITER_TRIGGER_BASE_URL`: optional, default `https://api.jup.ag/trigger/v2`.
- `connectors.jupiter.trigger.enabled`: default false until auth UX is wired.
- `connectors.jupiter.trigger.maxDepositUsd`: optional.
- `connectors.jupiter.trigger.maxOrderLifetimeDays`: optional, default 30.
- `connectors.jupiter.trigger.maxStopLossSlippageBps`: optional.

Never store JWTs in local storage, prepared actions, receipts, traces, or connector facts.

## Proposed MCP Tools

Read/auth tools:

- `solana_jupiter_trigger_auth_challenge`
- `solana_jupiter_trigger_auth_verify`
- `solana_jupiter_trigger_auth_status`
- `solana_jupiter_trigger_vault`
- `solana_jupiter_trigger_orders`
- `solana_jupiter_trigger_order_detail`
- `solana_jupiter_trigger_order_history`

Prepare/confirm tools:

- `solana_prepare_jupiter_trigger_register_vault`
- `solana_prepare_jupiter_trigger_single_order`
- `solana_prepare_jupiter_trigger_oco_order`
- `solana_prepare_jupiter_trigger_otoco_order`
- `solana_prepare_jupiter_trigger_edit_order`
- `solana_prepare_jupiter_trigger_cancel_order`
- `solana_prepare_jupiter_trigger_withdraw_order_funds`

Prepared action kinds:

- `jupiter_trigger_register_vault`
- `jupiter_trigger_single_order`
- `jupiter_trigger_oco_order`
- `jupiter_trigger_otoco_order`
- `jupiter_trigger_edit_order`
- `jupiter_trigger_cancel_order`
- `jupiter_trigger_withdraw_order_funds`

## Inputs

Auth challenge:

- `walletAddress`: optional. Defaults to connected wallet.
- `challengeType`: optional enum `message | transaction`, default `message`.

Auth verify:

- `walletAddress`: optional. Defaults to connected wallet.
- `challengeType`: required enum `message | transaction`.
- `signature`: required for message challenge, never stored.
- `signedTransaction`: required for transaction challenge, never stored.

Vault:

- `walletAddress`: optional. Defaults to connected wallet.
- `registerIfMissing`: optional boolean, default false.

Orders/history:

- `walletAddress`: optional. Defaults to connected wallet.
- `state`: optional enum `open | pending | filled | expired | cancelled | ready_to_cancel | all`, default `open`.
- `limit`: optional integer, default 20.
- `offset`: optional integer.

Single order:

- `inputMint`: required.
- `outputMint`: required.
- `amount`: required decimal string.
- `triggerMint`: required.
- `triggerCondition`: required enum `above | below`.
- `triggerPriceUsd`: required decimal number.
- `slippageBps`: optional.
- `expiresAt`: required ISO timestamp.
- `maxDepositUsd`: optional cap.

OCO order:

- `inputMint`: required.
- `outputMint`: required.
- `amount`: required decimal string.
- `triggerMint`: required.
- `takeProfitPriceUsd`: required decimal number.
- `stopLossPriceUsd`: required decimal number.
- `takeProfitSlippageBps`: optional.
- `stopLossSlippageBps`: optional.
- `expiresAt`: required ISO timestamp.

OTOCO order:

- `inputMint`: required.
- `outputMint`: required.
- `amount`: required decimal string.
- `triggerMint`: required.
- `entryCondition`: required enum `above | below`.
- `entryPriceUsd`: required decimal number.
- `takeProfitPriceUsd`: required decimal number.
- `stopLossPriceUsd`: required decimal number.
- `slippageBps`: optional.
- `takeProfitSlippageBps`: optional.
- `stopLossSlippageBps`: optional.
- `expiresAt`: required ISO timestamp.

Edit/cancel/withdraw:

- `orderId`: required.
- `newTriggerPriceUsd`: optional for edit.
- `newSlippageBps`: optional for edit.
- `reason`: optional local note.

## Adapter Design

Files:

```text
packages/mcp-server/src/adapters/jupiter/triggerAuth.ts
packages/mcp-server/src/adapters/jupiter/triggerVault.ts
packages/mcp-server/src/adapters/jupiter/triggerOrders.ts
packages/mcp-server/src/adapters/jupiter/triggerActions.ts
packages/mcp-server/src/adapters/jupiter/triggerSafety.ts
```

`triggerAuth.ts` responsibilities:

- Request challenges.
- Verify signed message or signed transaction.
- Store JWT only in volatile process memory.
- Return readiness without returning JWT.
- Expire JWT before official TTL to avoid edge failures.

`triggerVault.ts` responsibilities:

- Read existing vault.
- Register vault if user explicitly requests it.
- Normalize vault pubkey, Privy vault id, user pubkey, balances, and custody facts.

`triggerOrders.ts` responsibilities:

- Read active orders, order details, and history.
- Normalize order type, state, trigger price, input/output mints, deposits, fills, cancellation status, and withdrawal eligibility.

`triggerActions.ts` responsibilities:

- Craft deposit transaction.
- Request wallet signature for deposit transaction.
- Submit signed deposit transaction and order parameters to create order.
- Prepare edit/cancel/withdraw transaction steps.

`triggerSafety.ts` responsibilities:

- Generate user-facing warnings for vault custody, future automation, non-guaranteed output, slippage, expiration, cancellation, and withdrawal.

## Prepared Action Payload

Trigger prepared actions should store:

- `connectorId: "jupiter"`
- `product: "trigger"`
- `operation`
- `walletAddress`
- `cluster`
- `inputMint`
- `outputMint`
- `triggerMint`
- `amount`
- `amountRaw`
- `orderType`
- `triggerCondition`
- `triggerPriceUsd`
- `takeProfitPriceUsd`
- `stopLossPriceUsd`
- `slippageBps`
- `expiresAt`
- `vaultSnapshot`
- `orderSnapshot`
- `automationWarningAccepted: true`
- `custodyWarningAccepted: true`
- `programIds`
- `transactionBase64` only for the next wallet-signed step
- `refreshAtExecution: true`

Never store:

- JWT.
- Signed challenge.
- Signed deposit transaction after submission.
- API key.
- Raw bearer header.

## Safety Checks

- Reject unsupported clusters.
- Reject missing API key.
- Reject missing or expired JWT for authenticated calls.
- Reject if wallet address does not match JWT wallet.
- Reject order below Jupiter minimum order size.
- Reject expiration beyond configured max lifetime.
- Reject slippage above configured cap.
- Reject stop-loss or buy-above slippage above high-risk cap unless user explicitly accepts.
- Reject create order if vault facts cannot be read.
- Warn that vault is Privy-managed custody.
- Warn that future Trigger execution does not come back to Agentic approval inbox.
- Warn that output is not guaranteed when trigger fires.
- Warn that cancel and withdraw are separate steps.
- Warn that expired funds remain in vault until withdrawal flow completes.
- Do not claim Trigger orders are reversible.
- Do not store JWT anywhere durable.

## Tests

Unit tests:

- Auth challenge supports message and transaction types.
- Auth verify stores JWT only in volatile cache.
- Auth status never returns JWT.
- Missing JWT blocks vault/order reads.
- Create order rejects missing vault.
- Create order rejects below minimum USD value.
- Create order stores automation and custody acceptance flags.
- Stop-loss high slippage warns or blocks based on policy.
- Cancel order explains withdrawal requirement.
- JWT/API key/signed challenge values are redacted from errors.

Mock API tests:

- Challenge success.
- Verify success.
- Vault get/register success.
- Deposit craft success.
- Single order create success.
- OCO create success.
- OTOCO create success.
- Order history success.
- Cancel and withdrawal flow success.

Smoke prompts:

- "Authenticate Jupiter Trigger for my wallet."
- "Show my Jupiter Trigger vault."
- "Show my active Jupiter Trigger orders."
- "Prepare a Jupiter limit order to sell 1 SOL if SOL goes above 250 USD."
- "Prepare an OCO order with take profit and stop loss, and explain vault custody."
- "Cancel this Jupiter Trigger order and withdraw funds if ready."
- "Can this Trigger order run later without Agentic asking me each time?" Expected: yes, Jupiter automation warning.

## Completion Checklist

- Trigger capabilities are listed under Jupiter.
- Auth flow works without durable JWT storage.
- Vault reads clearly identify Privy-managed custody.
- Single order create works end-to-end.
- OCO/OTOCO are gated until tests pass.
- Cancel and withdrawal states are explicit.
- Planner copy never says future Trigger fills require Agentic approval.
