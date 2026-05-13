# Jupiter Recurring Connector Plan

## Goal

Add first-class Jupiter Recurring API support while clearly separating Jupiter-native DCA automation from Agentic's existing recurring approval-inbox tasks.

V1 scope:

- Read Jupiter Recurring orders for a wallet.
- Prepare time-based Recurring DCA order creation.
- Execute signed Recurring order setup through Jupiter `/execute`.
- Prepare cancel order.
- Support deprecated price-based deposit/withdraw only as management actions for existing orders when the API still exposes them.

Do not replace Agentic recurring tasks. Do not pretend Jupiter-native DCA asks the wallet for approval on every cycle.

## Current Repo State

Agentic already has its own recurring action system:

- It materializes due recurring transfers/swaps into prepared approval items.
- Each occurrence still requires wallet approval.
- Jupiter swaps inside Agentic recurring tasks refresh at approval time.

Jupiter Recurring API is not implemented.

This connector must coexist with Agentic recurring tasks and use distinct language:

- Agentic recurring: approval-per-run.
- Jupiter Recurring: user approves setup/cancel, then Jupiter automation executes scheduled fills.

## External Source Of Truth

Use official Jupiter Recurring docs:

- Recurring overview: https://developers.jup.ag/docs/recurring
- Create order: https://developers.jup.ag/docs/recurring/create-order
- Execute order: https://developers.jup.ag/docs/recurring/execute-order
- Cancel order: https://developers.jup.ag/docs/recurring/cancel-order
- Get recurring orders: https://developers.jup.ag/docs/recurring/get-recurring-orders

Important protocol facts:

- Recurring API base URL is `https://api.jup.ag/recurring/v1`.
- It supports automated DCA with time-based recurring orders.
- Time-based orders use total input amount, number of orders, interval, optional price range, and start time.
- `createOrder` returns a transaction and request id.
- User signs the setup transaction.
- `/execute` submits the signed setup transaction and request id.
- Recurring API has a fee.
- Integrator fees are currently not supported.
- Price-based recurring orders are deprecated, but management endpoints may remain for existing orders.

## Dependencies

No new dependency is required.

Config:

- `JUPITER_API_KEY` or `JUP_API_KEY`: required.
- `JUPITER_RECURRING_BASE_URL`: optional, default `https://api.jup.ag/recurring/v1`.
- `connectors.jupiter.recurring.enabled`: default false until UI copy is updated.
- `connectors.jupiter.recurring.maxDepositAmount`: optional per mint.
- `connectors.jupiter.recurring.maxOrderCount`: optional, default 100.
- `connectors.jupiter.recurring.maxLifetimeDays`: optional.

## Proposed MCP Tools

Read tools:

- `solana_jupiter_recurring_orders`
- `solana_jupiter_recurring_order_detail`
- `solana_jupiter_recurring_quote`

Prepare/action tools:

- `solana_prepare_jupiter_recurring_create_time_order`
- `solana_execute_jupiter_recurring_created_order`
- `solana_prepare_jupiter_recurring_cancel_order`
- `solana_prepare_jupiter_recurring_deposit_price_order`
- `solana_prepare_jupiter_recurring_withdraw_price_order`

Prepared action kinds:

- `jupiter_recurring_create_time_order`
- `jupiter_recurring_cancel_order`
- `jupiter_recurring_deposit_price_order`
- `jupiter_recurring_withdraw_price_order`

The execute tool can reuse the prepared action execution path if the setup transaction is already staged.

## Inputs

Recurring orders:

- `walletAddress`: optional. Defaults to connected wallet.
- `state`: optional enum `active | completed | cancelled | failed | all`, default `active`.
- `limit`: optional integer, default 20.

Recurring quote:

- `inputMint`: required.
- `outputMint`: required.
- `inAmount`: required decimal string.
- `numberOfOrders`: required integer.
- `intervalSeconds`: required integer.
- `minPrice`: optional decimal string.
- `maxPrice`: optional decimal string.

Create time order:

- `inputMint`: required.
- `outputMint`: required.
- `totalAmount`: required decimal string.
- `numberOfOrders`: required integer.
- `intervalSeconds`: required integer.
- `startAt`: optional ISO timestamp.
- `minPrice`: optional decimal string.
- `maxPrice`: optional decimal string.
- `maxFeeBps`: optional.
- `automationWarningAccepted`: required true.

Cancel order:

- `orderId`: required.
- `reason`: optional local note.

Deposit/withdraw price order:

- `orderId`: required.
- `amount`: required decimal string.
- `priceOrderDeprecationAccepted`: required true.

## Adapter Design

Files:

```text
packages/mcp-server/src/adapters/jupiter/recurringOrders.ts
packages/mcp-server/src/adapters/jupiter/recurringActions.ts
packages/mcp-server/src/adapters/jupiter/recurringSafety.ts
```

`recurringOrders.ts` responsibilities:

- Fetch wallet orders.
- Normalize order state, input/output mints, amount per cycle, interval, remaining orders, execution history, fees, and next execution facts.

`recurringActions.ts` responsibilities:

- Call `createOrder`.
- Store returned setup transaction and request id in a prepared action.
- Execute signed setup transaction through `/execute`.
- Build cancel/deposit/withdraw management transactions.

`recurringSafety.ts` responsibilities:

- Generate copy that differentiates Jupiter-native automation from Agentic recurring.
- Calculate total exposure, per-cycle spend, duration, fees, and cancellation facts.

## Prepared Action Payload

Recurring prepared actions should store:

- `connectorId: "jupiter"`
- `product: "recurring"`
- `operation`
- `walletAddress`
- `cluster`
- `inputMint`
- `outputMint`
- `totalAmount`
- `totalAmountRaw`
- `amountPerCycle`
- `amountPerCycleRaw`
- `numberOfOrders`
- `intervalSeconds`
- `startAt`
- `minPrice`
- `maxPrice`
- `feePreview`
- `requestId`
- `orderSnapshot`
- `automationWarningAccepted: true`
- `transactionBase64`
- `refreshAtExecution: false` for setup transaction unless API requires recreation

Do not store API keys or signed setup transaction bodies after submission.

## Safety Checks

- Reject unsupported clusters.
- Reject missing API key.
- Reject missing `automationWarningAccepted`.
- Reject total amount above configured cap.
- Reject order count above configured cap.
- Reject lifetime above configured cap.
- Reject interval below configured minimum.
- Reject deprecated price-order deposit/withdraw unless user explicitly accepts deprecation warning.
- Warn that Jupiter Recurring charges a fee.
- Warn that integrator fees are not currently supported.
- Warn that future fills execute through Jupiter automation without Agentic approval each time.
- Warn that price range can prevent or delay fills.
- Do not describe Jupiter Recurring as Agentic recurring.

## Tests

Unit tests:

- Create time order requires automation warning acceptance.
- Create time order calculates per-cycle amount.
- Create time order rejects cap violations.
- Create time order stores request id and transaction base64.
- Execute sends signed transaction plus request id.
- Cancel order creates management prepared action.
- Price-order deposit/withdraw require deprecation acceptance.
- API errors redact API key and signed transaction.

Mock API tests:

- Get orders success.
- Create order success.
- Execute order success.
- Execute failed response.
- Cancel order success.

Smoke prompts:

- "Show my Jupiter native DCA orders."
- "Create a Jupiter DCA order to buy SOL with 100 USDC over 10 days, but explain future approvals."
- "Cancel this Jupiter Recurring order."
- "Is this the same as Agentic recurring swaps?" Expected: no, explain difference.
- "Deposit more into an old price-based Jupiter recurring order." Expected: deprecation warning.

## Completion Checklist

- Jupiter Recurring appears as a distinct Jupiter capability.
- UI and planner copy distinguish Jupiter-native automation from Agentic recurring tasks.
- Time-based create/cancel flows work.
- Existing Agentic recurring flow is not broken.
- No recurring path stores API keys or signed setup transactions after submission.
