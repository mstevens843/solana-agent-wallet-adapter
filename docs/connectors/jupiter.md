# Jupiter Connector

Jupiter is first-class for Swap API v2 previews, prepared swaps, wallet-approved swap execution, Jupiter Lend Earn / Borrow (reads plus prepare-only actions), Jupiter Trigger V2 (disabled by default), Jupiter Recurring native DCA (disabled by default), beta read-only Prediction, read-only Perps research, and read-only Token API V2 / Price API V3 evidence in MCP. Token and price reads are review evidence only; they are not oracle guarantees and they never approve or prepare transactions.

## Ask / Check Endpoint Catalog

Agents can inspect `solana_market_endpoint_catalog` and call `solana_jupiter_review_read` for cataloged Jupiter Pro endpoints marked `review_evidence`. This catalog is intentionally separate from transaction preparation: build, submit, execute, verification craft transaction, Trigger deposit/order writes, Recurring create/cancel writes, Send craft transactions, Studio transaction creation/submission, and Transaction API submit are listed as `approval_only`, `existing_tool`, or `unavailable` and are blocked from generic Ask/Check reads.

Browser-local and cloud Check flows may use these reads as extra evidence before the agent returns `approve`, `deny`, or `needs_input`. An `approve` result still only moves the draft toward Needs Approval; the user must still click sign/approve in the wallet flow.

## What It Can Read

- `solana_jupiter_order_preview` returns a read-only Swap API v2 `/order` preview with input/output mints, raw amounts, expected output, minimum output threshold, slippage, price impact, router/mode metadata, route-plan summary, manual/RFQ routing warnings, fee fields, request id, and transaction availability.
- `solana_get_swap_quote` is a compatibility alias that returns the same normalized connector facts.
- `solana_jupiter_token_search` searches token metadata by symbol, name, mint, or comma-separated mints.
- `solana_jupiter_token_by_tag` reads Jupiter token tags: `lst`, `verified`, and `stocks`.
- `solana_jupiter_token_category` reads top organic score, top traded, and top trending token categories by interval.
- `solana_jupiter_token_recent` reads tokens by first pool creation recency.
- `solana_jupiter_price` and `solana_jupiter_price_batch` read Price API V3 USD prices, decimals, block id, liquidity, and 24h change when Jupiter returns reliable price data.
- `solana_jupiter_token_risk_evidence` returns compact token metadata, verification, audit, holder, liquidity, organic score, price, risk labels, and warnings for planner reviews. Requested mint evidence requires an exact mint match; non-exact search hits are surfaced only as candidates.
- `solana_jupiter_lend_earn_tokens` / `solana_jupiter_lend_earn_token_detail` return Jupiter Earn markets with APY, reward APY, exchange price, liquidity, utilization, and withdrawal-smoothing facts.
- `solana_jupiter_lend_earn_positions` returns a wallet's Earn positions with shares, underlying amount, and APY.
- `solana_jupiter_lend_earn_earnings` rolls up Earn earnings over an optional ISO range.
- `solana_jupiter_lend_borrow_vaults` / `solana_jupiter_lend_borrow_vault_detail` return Borrow vaults with LTV, liquidation threshold, supply/borrow rates, oracle facts, and capacity.
- `solana_jupiter_lend_borrow_positions` returns a wallet's Borrow positions with collateral, debt, health ratio, and liquidation status.
- `solana_jupiter_lend_borrow_health_preview` projects health for a candidate collateral or debt delta and reports the gate verdict against the configured minimum borrow health ratio.
- `solana_jupiter_trigger_auth_challenge` / `_verify` / `_status` handle Trigger V2 wallet authentication without returning or storing JWTs in user-visible artifacts.
- `solana_jupiter_trigger_vault`, `_orders`, `_order_detail`, and `_order_history` read Trigger V2 vault and order state when Trigger is enabled and authenticated.
- `solana_jupiter_recurring_orders`, `_order_detail`, and `_quote` read or locally preview Jupiter Recurring native DCA orders when Recurring is enabled.
- `solana_connector_capabilities jupiter` reports Swap, Token, Price, Lend Earn, Lend Borrow, Prediction, Perps, Trigger, and Recurring readiness plus other Jupiter product groups.

## What It Can Prepare Or Execute

- `solana_prepare_swap` prepares a capped Jupiter swap inbox item. It stores normalized mints, raw input amount, slippage, configured caps, and `refreshAtExecution: true`; it does not store raw transaction bytes.
- `solana_swap` requests wallet approval immediately, simulates first, then executes the signed transaction through Jupiter `/execute`.
- `solana_prepare_jupiter_lend_earn_deposit` / `_withdraw` / `_mint` / `_redeem` prepare Earn actions. Withdraw and redeem refresh pool state at execution.
- `solana_prepare_jupiter_lend_borrow_create_position` opens a Borrow position with optional initial collateral and borrow amounts; the health gate runs before approval.
- `solana_prepare_jupiter_lend_borrow_deposit_collateral` / `_borrow` / `_repay` / `_withdraw_collateral` prepare Borrow lifecycle actions. Borrow and withdraw-collateral run a fresh health preview before approval and again at execution.
- `solana_prepare_jupiter_trigger_register_vault`, `_single_order`, `_oco_order`, `_otoco_order`, `_edit_order`, `_cancel_order`, and `_withdraw_order_funds` prepare Trigger V2 actions when Trigger is enabled and the wallet has a valid volatile JWT. Deposit-bearing actions refresh the Jupiter-built deposit transaction at execution and hand the signed blob back to Jupiter for broadcast.
- `solana_prepare_jupiter_recurring_create_time_order`, `_cancel_order`, `_deposit_price_order`, and `_withdraw_price_order` prepare Jupiter Recurring native DCA setup/cancel/deprecated price-management actions when Recurring is enabled. Setup/cancel transactions are refreshed at execution and handed to Jupiter `/execute`.
- `solana_execute_prepared_action` executes any prepared Jupiter item by refreshing market, health, or Jupiter-built transaction data before wallet signing.

## Required Inputs

Swap: amount, input token or mint, output token or mint, optional slippage in basis points.

Earn: `assetMint`. Use `amount` for deposit/withdraw, `shares` for mint/redeem; optional `minSharesOut` / `minUnderlyingOut` slippage floors.

Borrow: `vaultId`, with `positionId` for everything except `create_position`. Use `collateralAmount` / `borrowAmount` for create, `amount` plus optional `repayAll` for the rest. Optional `minHealthRatio` and `maxLtvBps` override the policy defaults.

Trigger: authenticate first, then use wallet-scoped vault/order inputs. Create-order inputs require mints, amount/amountRaw, USD trigger prices, expiration, and explicit slippage policy acceptance when above warning thresholds.

Recurring: enable `connectors.jupiter.recurring.enabled=true` first. Time-order setup requires input/output mints, `totalAmountRaw` (or `totalAmount` when input mint decimals are configured), `numberOfOrders`, `intervalSeconds`, and `automationWarningAccepted=true`. Deprecated price-order deposit/withdraw requires `priceOrderDeprecationAccepted=true`.

Ask:

- "How much do you want to swap, deposit, or borrow?"
- "Which Earn token (mint) or Borrow vault id should I use?"
- "Should I cap the borrow health ratio?"
- "Have you authenticated Jupiter Trigger for this wallet, and do you accept the Privy custody and external automation warnings?"

## Required Facts

- Jupiter Swap API v2 order preview.
- Minimum output and slippage cap.
- Router/mode, manual/RFQ routing warnings, and fee fields when Jupiter reports them.
- Price impact when reported.
- Mint/decimal resolution for unknown token mints.
- Connected wallet for wallet-specific previews.
- Token verification, tags, audit flags, holder concentration, liquidity, organic score, and price freshness for token-risk reviews.
- Price API missing-price reason when Jupiter does not return a reliable price.
- Earn snapshot (APY, exchange price, liquidity, withdrawal smoothing) before any Earn prepare.
- Borrow vault snapshot (LTV, liquidation threshold, oracle freshness, capacity) plus health preview before any Borrow prepare.
- Recurring amount-per-cycle, interval, number of orders, fee warning, and explicit note that Jupiter automation handles future fills after setup approval.

## Deny Or Ask

Deny swaps above configured max input, slippage above the configured cap, unsupported clusters, missing API-key execution, and requests to guarantee exact output. Reject Token or Price reads when `connectors.jupiter.tokenPrice.enabled=false`, when the API key is missing, when price batches exceed the configured cap, or when search requests exceed the configured comma-separated mint cap. Deny borrow or withdraw-collateral whose projected health drops below `connectors.jupiter.minBorrowHealthRatio` (default 1.25) or whose projected LTV exceeds `connectors.jupiter.maxBorrowLtvBps` (default 8500). Reject Borrow writes when the optional `@jup-ag/lend` SDK is unavailable. Reject flashloan, multiply, unwind, vault swap, or liquidation flows. Reject Trigger V2 requests when the surface is disabled, the wallet is unauthenticated, the vault is unregistered, order value is below Jupiter's minimum, expiration/slippage policy fails, or the user asks for fills to return to the Agentic approval inbox. Reject Recurring when disabled, missing `automationWarningAccepted`, over configured amount/order/lifetime/interval policy, or when deprecated price-order management lacks explicit deprecation acceptance. For Jupiter Perps, route to the read-only research surface (`solana_jupiter_perps_status`) and deny every write or leverage-recommendation request.

## User Approval

Jupiter previews and Token/Price/Lend/Prediction/Perps reads are read-only. Prepared swaps and prepared Lend actions remain manual-approval items until the user sends them to the wallet. Trigger auth requires a wallet message signature; Trigger order deposits are wallet-signed locally, then handed back to Jupiter for broadcast and future automation from the Privy vault. Recurring setup/cancel/deprecated price-management transactions are wallet-signed locally, then handed to Jupiter Recurring `/execute`; future native DCA fills after setup do not return to the Agentic approval inbox. The wallet signs; Jupiter `/execute`, Trigger submit, or the Lend SDK landing path handles broadcast after the signed transaction is returned.

## Prediction Markets (Beta, Read-Only)

Jupiter Prediction is exposed as a **beta, read-only** capability under `connectorId: "jupiter"`, capability `prediction`. It is **disabled by default** and must be opted into via `connectors.jupiter.prediction.enabled = true` in `agent-wallet.config.json` (or the equivalent host policy).

The agent can read (each response includes `beta: true` and a beta warning):

- `solana_jupiter_prediction_events` — list events with filters for provider (`polymarket | kalshi`), category, filter (`new | live | trending`), and sort.
- `solana_jupiter_prediction_search_events` — search events by text query.
- `solana_jupiter_prediction_event_detail` and `solana_jupiter_prediction_event_markets` — event detail and attached markets.
- `solana_jupiter_prediction_market_detail` — single market with normalized status (`open | closed | resolved | paused | unknown`), YES/NO prices, volume, rules link, and resolve/close times.
- `solana_jupiter_prediction_orderbook` — YES/NO orderbook with best bid/ask and depth.
- `solana_jupiter_prediction_orders`, `solana_jupiter_prediction_order_status` — wallet orders (default owner is the connected wallet).
- `solana_jupiter_prediction_positions`, `solana_jupiter_prediction_history`, `solana_jupiter_prediction_vault_info` — wallet positions, history, and vault info.

The agent cannot:

- Create prediction orders, close positions, close all positions, or claim payouts. These remain reserved future actions (`jupiter_prediction_create_order`, `jupiter_prediction_close_position`, `jupiter_prediction_close_all_positions`, `jupiter_prediction_claim_position`) until beta writes are explicitly approved.
- Claim that Jupiter Prediction odds imply truth or guaranteed outcomes — outcomes are resolved by external providers (e.g. Polymarket, Kalshi) and can change.

Warnings included with every response: beta banner, external-provider banner, status-specific banner when a market is closed/paused/resolved/unknown, and a stale-price banner for orderbooks.

## Perps (Read-Only Research, Work In Progress)

Jupiter Perps is exposed as a strictly **read-only research** capability under `connectorId: "jupiter"`, capability `perps`. The official Jupiter Perps API is marked work in progress in upstream docs, so this pass does not expose any write surface and does not decode pool, custody, or position accounts. The single fully-implemented read returns docs-backed status; the three account-snapshot reads validate inputs then return `unsupported_method` with a structured reason until the official API stabilizes.

Config flags live under `connectors.jupiter.perps` and default to `{ enabled: false, readOnly: true }`. The optional `JUPITER_PERPS_BASE_URL` env var has no default and is only consumed once official endpoints stabilize.

The agent can read:

- `solana_jupiter_perps_status` — readiness, the five official documentation links (overview, position, position-request, pool, custody accounts), leverage and liquidation warnings, and the perps policy flags. Does not require a Jupiter API key.
- `solana_jupiter_perps_pool_snapshot` — requires `poolAddress`. Validates the address, then returns `unsupported_method`.
- `solana_jupiter_perps_custody_snapshot` — requires `custodyAddress`. Validates the address, then returns `unsupported_method`.
- `solana_jupiter_perps_position_snapshot` — optional `walletAddress`, `positionAddress`, `market`. Validates any provided addresses and falls back to the connected wallet, then returns `unsupported_method`.

Every status response is shaped as `{ connectorId: "jupiter", product: "perps", readOnly: true, apiStatus, officialDocsStatus, data, warnings, facts }`. Warnings always include leverage risk, liquidation risk, and the work-in-progress notice.

The agent cannot:

- Open, close, increase, decrease, add or remove collateral, or otherwise modify any Jupiter Perps position.
- Recommend leverage or imply Perps liquidation is safe.
- Take any JLP write action (mint, redeem, deposit, withdraw).
- Decode pool, custody, position, or position-request accounts via unofficial Anchor IDL for money-moving decisions.

Source of truth and pointers:

- Plan: [firstclassconnectrors/jupiter-perps.md](../../firstclassconnectrors/jupiter-perps.md)
- Official docs: [developers.jup.ag/docs/perps](https://developers.jup.ag/docs/perps)
- Account layouts: [position](https://developers.jup.ag/docs/perps/position-account), [position-request](https://developers.jup.ag/docs/perps/positionrequest-account), [pool](https://developers.jup.ag/docs/perps/pool-account), [custody](https://developers.jup.ag/docs/perps/custody-account)

## Trigger V2

Jupiter Trigger V2 is a first-class adapter surface under `connectorId: "jupiter"`, capability `trigger`. It is **disabled by default**; set `connectors.jupiter.trigger.enabled=true` in `agent-wallet.config.json` or `CONNECTORS_JUPITER_TRIGGER_ENABLED=true` in the environment to opt in. Config also accepts `maxDepositUsd`, `maxOrderLifetimeDays` (default 30), `maxStopLossSlippageBps`, `maxSlippageBps`, and `highSlippageWarnBps` (default 300). The optional `JUPITER_TRIGGER_BASE_URL` env var defaults to `https://api.jup.ag/trigger/v2`.

Trigger orders deposit funds into a **Jupiter-managed Privy custody vault**, not the user's wallet. Future fills execute through **Jupiter automation outside the Agentic approval inbox**. Cancel and withdrawal are separate steps; expired or cancelled funds stay in the vault until the user completes the withdrawal flow. Output is not guaranteed at trigger time.

### Authentication

Authentication uses a wallet challenge flow. JWTs live only in **volatile process memory**, are clamped to a 23-hour TTL (one hour below Jupiter's 24h), and are never returned to any caller, never persisted to receipts or prepared actions, and never logged unredacted.

1. `solana_jupiter_trigger_auth_challenge` — request a wallet challenge. Returns `{ challenge, challengeType, expiresAt, apiHost }` with a 5-minute challenge TTL.
2. The wallet signs the challenge via `solana_sign_message` (for `challengeType: 'message'`) or `solana_sign_transaction` (for the fallback `'transaction'`).
3. `solana_jupiter_trigger_auth_verify` — submit the signature. On success, caches a JWT in memory and returns `{ authenticated, walletAddress, cluster, apiHost, expiresAt }`. **Never returns the JWT itself.**
4. `solana_jupiter_trigger_auth_status` — check whether the wallet has a live JWT. Returns the same shape as verify (no JWT).

If the JWT is missing or expired, every Trigger read and prepared action throws `unauthorized` and prompts re-authentication.

### What It Can Read

- `solana_jupiter_trigger_vault` — read the wallet's Privy vault: registration status, vault address, vault id, and balances. Custody is marked `privy`.
- `solana_jupiter_trigger_orders` — list orders for the wallet. Defaults to `state=open` at the tool surface and maps that to Jupiter's active order-history state. Supports `limit`/`offset`.
- `solana_jupiter_trigger_order_detail` — read a single order including type, state, trigger fields, slippage, expiration, cancellability, and withdrawal eligibility.
- `solana_jupiter_trigger_order_history` — list order history across all states (filled, expired, cancelled, ready_to_cancel) by default.

### What It Can Prepare Or Execute

Each prepared action stores `connectorId: 'jupiter'`, `product: 'trigger'`, the operation, wallet address, cluster, mints, trigger fields, vault snapshot, `automationWarningAccepted: true`, `custodyWarningAccepted: true`, the next-step transaction base64 (if any), and `refreshAtExecution: true`. Prepared actions never store the JWT, signed challenges, signed transaction blobs, or the Jupiter API key.

- `solana_prepare_jupiter_trigger_register_vault` — register the Privy vault for the wallet (one-time per wallet). If Jupiter returns a registration transaction, it is signed at execute time; otherwise the refreshed register response is submitted without storing a transaction.
- `solana_prepare_jupiter_trigger_single_order` — single limit/trigger order with a USD price condition. Enforces the 10 USD minimum, expiration ≤ `maxOrderLifetimeDays`, and slippage caps.
- `solana_prepare_jupiter_trigger_oco_order` — take-profit + stop-loss pair where one cancels the other. Validates pairing direction (sells require TP > SL; buys require TP < SL).
- `solana_prepare_jupiter_trigger_otoco_order` — entry trigger then OCO take-profit/stop-loss. Same pairing validation as OCO.
- `solana_prepare_jupiter_trigger_edit_order` — edit an existing order's trigger price, slippage, or expiration through Trigger V2 `PATCH /orders/price/{orderId}`. No on-chain signature when Jupiter does not require one; the prepared action still surfaces the automation warning and the "expired funds stay in vault" warning.
- `solana_prepare_jupiter_trigger_cancel_order` — cancel an open or pending order. Confirms cancellability before submission, signs Jupiter's cancel transaction when returned, and confirms the signed cancel with Jupiter.
- `solana_prepare_jupiter_trigger_withdraw_order_funds` — withdraw cancelled or expired order funds from the Privy vault back to the authenticated wallet. Custom destinations are not supported; Jupiter's cancel/confirm-cancel transaction flow is signed when returned.

At `execute()` time, deposit-bearing actions re-fetch a fresh deposit transaction from Jupiter (to avoid blockhash expiry), sign it locally via `ctx.signTransaction`, then POST the signed base64 to Jupiter's submit endpoint. Cancel/withdraw flows likewise use Jupiter's cancel and confirm-cancel endpoints when Jupiter returns a transaction to sign. Jupiter broadcasts the signed transaction; the agent does **not** call `signAndBroadcast` for Trigger submission.

### Required Inputs

| Field | Where | Required | Notes |
| --- | --- | --- | --- |
| `walletAddress` | All auth/vault/order tools | optional | Defaults to the connected wallet. |
| `challengeType` | auth_challenge / auth_verify | optional / required | `'message'` (default) or `'transaction'`. |
| `signature` | auth_verify | required for message | Returned from `solana_sign_message`. |
| `signedTransaction` | auth_verify | required for transaction | Returned from `solana_sign_transaction`. |
| `orderId` | order_detail / edit / cancel / withdraw | required | |
| `state` | orders / order_history | optional | `open` default for orders, `all` default for history. |
| `inputMint`, `outputMint`, `triggerMint`, `amount`, `triggerPriceUsd`, `triggerCondition`, `expiresAt` | single_order | required | |
| `takeProfitPriceUsd`, `stopLossPriceUsd` | oco_order, otoco_order | required | |
| `entryCondition`, `entryPriceUsd` | otoco_order | required | |
| `acceptHighSlippage` | order prepares | optional | Required when slippage exceeds `highSlippageWarnBps` or `maxStopLossSlippageBps`. |

### Deny Or Ask

The agent denies and explains when:

- Trigger is disabled in config (`unsupported_method`).
- No live JWT for the wallet (`unauthorized`).
- Connected wallet does not match the JWT wallet (`unauthorized`).
- The vault is not registered (`invalid_request`); the user must run `solana_prepare_jupiter_trigger_register_vault` first.
- Order value falls below the Jupiter 10 USD minimum.
- `expiresAt` is in the past or beyond `maxOrderLifetimeDays`.
- Slippage exceeds `maxSlippageBps`, or `stopLossSlippageBps` exceeds `maxStopLossSlippageBps`, without `acceptHighSlippage: true`.
- OCO/OTOCO trigger pairings are mis-ordered (e.g., sell with TP ≤ SL).
- Cancel is requested for an order that is not in a cancellable state.
- Withdraw is requested for an order that has no withdrawable balance.

### User Approval

Trigger flows surface **two** wallet approval boundaries:

1. **Auth message signature** via `solana_sign_message` for the auth challenge. Used to exchange for a JWT that lives in memory only.
2. **Deposit / cancel / withdrawal / vault transaction signature** via `solana_sign_transaction` when Jupiter returns a transaction. Signed bytes are POSTed back to Jupiter, which broadcasts them on-chain.

Edit paths do not request an on-chain signature when Jupiter does not require one; cancel and withdrawal paths sign Jupiter-built transactions when returned. They still go through the Agentic approval inbox so the user can review the change and the safety warnings before submission. Once an order is live, **Jupiter automation handles all future fills directly** — they do not return to the Agentic approval inbox per fill.

Source of truth and pointers:

- Plan: [firstclassconnectrors/jupiter-trigger.md](../../firstclassconnectrors/jupiter-trigger.md)
- Trigger overview: [developers.jup.ag/docs/trigger](https://developers.jup.ag/docs/trigger)
- Authentication: [developers.jup.ag/docs/trigger/authentication](https://developers.jup.ag/docs/trigger/authentication)
- Create order: [developers.jup.ag/docs/trigger/create-order](https://developers.jup.ag/docs/trigger/create-order)
- Manage orders: [developers.jup.ag/docs/trigger/manage-orders](https://developers.jup.ag/docs/trigger/manage-orders)
- Order history: [developers.jup.ag/docs/api-reference/trigger/order-history](https://developers.jup.ag/docs/api-reference/trigger/order-history)

## Recurring Native DCA

Jupiter Recurring is a first-class adapter surface under `connectorId: "jupiter"`, capability `recurring`. It is **disabled by default**; set `connectors.jupiter.recurring.enabled=true` in `agent-wallet.config.json` or `CONNECTORS_JUPITER_RECURRING_ENABLED=true` in the environment to opt in. The optional `JUPITER_RECURRING_BASE_URL` env var defaults to `https://api.jup.ag/recurring/v1`.

This is **not** Agentic recurring payments. Agentic recurring schedules materialize future approval inbox items. Jupiter Recurring asks the wallet to approve setup or cancellation, then Jupiter automation runs future DCA fills without returning to the Agentic approval inbox each cycle.

### What It Can Read

- `solana_jupiter_recurring_orders` — list active/history Jupiter Recurring orders for the wallet.
- `solana_jupiter_recurring_order_detail` — read one order account from the first active/history pages.
- `solana_jupiter_recurring_quote` — locally preview per-cycle amount, total duration, fee note, and automation warnings before creating an order.

### What It Can Prepare Or Execute

- `solana_prepare_jupiter_recurring_create_time_order` — create a time-based DCA order. Requires `automationWarningAccepted=true`.
- `solana_prepare_jupiter_recurring_cancel_order` — cancel a time-based order and reclaim remaining funds.
- `solana_prepare_jupiter_recurring_deposit_price_order` / `_withdraw_price_order` — manage existing deprecated price-based orders only when `priceOrderDeprecationAccepted=true`.

Prepared actions store `connectorId: 'jupiter'`, `product: 'recurring'`, operation, wallet, cluster, mints, amount fields, number of orders, interval, request id, warnings, and `refreshAtExecution: true`. They never store API keys or signed setup/cancel transaction blobs.

Source of truth and pointers:

- Plan: [firstclassconnectrors/jupiter-recurring.md](../../firstclassconnectrors/jupiter-recurring.md)
- Create order: [developers.jup.ag/docs/recurring/create-order](https://developers.jup.ag/docs/recurring/create-order)
- Execute order: [developers.jup.ag/docs/recurring/execute-order](https://developers.jup.ag/docs/recurring/execute-order)
- Cancel order: [developers.jup.ag/docs/recurring/cancel-order](https://developers.jup.ag/docs/recurring/cancel-order)
- Get recurring orders: [developers.jup.ag/docs/recurring/get-recurring-orders](https://developers.jup.ag/docs/recurring/get-recurring-orders)
