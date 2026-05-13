# Jupiter Complete Connector Roadmap

## Goal

Make Jupiter complete as the primary first-class connector in Agentic.

The repo already supports Jupiter swaps. This plan expands Jupiter into a full product-surface connector while preserving Agentic's safety model:

- Swaps stay wallet-approved and refreshed at approval time.
- Lend becomes first-class for Earn and Borrow reads/actions.
- Trigger and Recurring are supported as explicit Jupiter-native automation flows.
- Token and Price APIs become read-only evidence used by all connector reviews.
- Prediction starts read-first because the API is beta.
- Perps stays research/read-only because official docs mark the API as work in progress.

## Current Repo State

Jupiter currently appears in:

- `apps/browser-demo/src/connectedDapps.ts`
- `packages/mcp-server/src/connectorRegistry.ts`
- `packages/mcp-server/src/actionTools.ts`
- `packages/mcp-server/src/actionService.ts`
- `spec/connectors/jupiter.connector.json`
- `docs/connectors/jupiter.md`

Current shipped runtime surface:

- `solana_jupiter_order_preview`
- `solana_get_swap_quote`
- `solana_prepare_swap`
- `solana_swap`
- `solana_execute_prepared_action` for prepared swaps

Current shipped behavior:

- Quote/order preview.
- Prepared swap inbox item.
- Direct wallet-approved swap.
- Approval-time quote and transaction refresh.
- Jupiter API-key readiness checks.

Current gaps:

- Jupiter Lend.
- Jupiter Trigger V2.
- Jupiter Recurring API.
- Jupiter Token API V2.
- Jupiter Price API V3.
- Jupiter Prediction API beta.
- Jupiter Perps research/read-only surface.
- Swap config/docs still use legacy Ultra naming while official docs now center on Swap API v2.

## External Source Of Truth

Use official Jupiter docs:

- Developer docs: https://developers.jup.ag/docs/
- Swap API: https://developers.jup.ag/docs/swap
- Swap order/execute: https://developers.jup.ag/docs/swap/order-and-execute
- Lend API vs SDK: https://developers.jup.ag/docs/lend/api-vs-sdk
- Lend program addresses: https://developers.jup.ag/docs/lend/program-addresses
- Trigger V2: https://developers.jup.ag/docs/trigger
- Trigger auth: https://developers.jup.ag/docs/trigger/authentication
- Recurring API: https://developers.jup.ag/docs/recurring
- Token API V2: https://developers.jup.ag/docs/tokens/token-information
- Price API V3: https://developers.jup.ag/docs/price
- Prediction API beta: https://developers.jup.ag/docs/api-reference/prediction/get-events
- Perps overview: https://developers.jup.ag/docs/perps

Current facts confirmed from official docs:

- One Jupiter Developer Platform API key unlocks the product APIs.
- Swap API v2 lives at `https://api.jup.ag/swap/v2`.
- Swap `/order` returns a quote plus assembled transaction when `taker` is supplied; `/execute` receives the signed transaction and request id.
- Lend has REST, `@jup-ag/lend-read`, and `@jup-ag/lend`; Borrow REST transactions are marked coming soon, so Borrow writes should use SDK paths.
- Trigger V2 uses API key plus wallet challenge JWT, a Privy-managed vault, deposit transactions, and off-chain private orders.
- Recurring API creates automated DCA orders and has a Jupiter fee.
- Token API V2 returns token metadata, organic score, holder/audit data, market cap, liquidity, and trading stats.
- Price API V3 returns USD price, decimals, block id, and 24-hour change for up to 50 token ids.
- Prediction API is beta.
- Perps API is marked work in progress.

## Parallel Plan Docs

Agents should work from these docs:

- `jupiter-swap-v2.md`
- `jupiter-lend.md`
- `jupiter-trigger.md`
- `jupiter-recurring.md`
- `jupiter-token-price.md`
- `jupiter-prediction.md`
- `jupiter-perps.md`

Keep the connector id `jupiter`. Do not split into separate protocol connector ids unless the UI later needs separate toggle rows. Use connector capability groups instead:

- `swap`
- `lend_earn`
- `lend_borrow`
- `trigger`
- `recurring`
- `tokens`
- `price`
- `prediction`
- `perps_readonly`

## Shared Runtime Work

One Jupiter shared worker should own common runtime files before product-surface workers land large patches:

- `packages/mcp-server/src/config.ts`
- `packages/mcp-server/src/connectorRegistry.ts`
- `packages/mcp-server/src/preparedActions.ts`
- `packages/mcp-server/src/actionTools.ts`
- `packages/mcp-server/src/actionService.ts`
- `packages/mcp-server/src/connectorFacts.ts`
- `spec/connectors/jupiter.connector.json`
- `docs/connectors/jupiter.md`
- `apps/browser-demo/src/connectedDapps.ts`

Shared runtime changes:

- Keep `JUPITER_API_KEY` and `JUP_API_KEY` as supported API-key env names.
- Add product base URL config with safe defaults:
  - `JUPITER_SWAP_BASE_URL`, default `https://api.jup.ag/swap/v2`
  - `JUPITER_LEND_BASE_URL`, default `https://api.jup.ag/lend/v1`
  - `JUPITER_TRIGGER_BASE_URL`, default `https://api.jup.ag/trigger/v2`
  - `JUPITER_RECURRING_BASE_URL`, default `https://api.jup.ag/recurring/v1`
  - `JUPITER_TOKENS_BASE_URL`, default `https://api.jup.ag/tokens/v2`
  - `JUPITER_PRICE_BASE_URL`, default `https://api.jup.ag/price/v3`
  - `JUPITER_PREDICTION_BASE_URL`, default `https://api.jup.ag/prediction/v1`
- Add shared `jupiterFetch` helper:
  - Adds `x-api-key`.
  - Adds JWT bearer only for Trigger authenticated calls.
  - Redacts API keys, JWTs, signatures, and signed transaction bodies from errors.
  - Enforces JSON response size limits.
  - Normalizes Jupiter API error bodies.
- Add common Jupiter readiness shape:
  - `ready.swap`
  - `ready.lendEarn`
  - `ready.lendBorrow`
  - `ready.trigger`
  - `ready.recurring`
  - `ready.tokens`
  - `ready.price`
  - `ready.prediction`
  - `ready.perpsReadonly`
- Add common Jupiter fact labels so planner output can show exact product surface, not just "Jupiter".

## Parallel Ownership Rules

- Shared Jupiter worker: config, common fetch helper, capability registry, prepared-action kind unions, common tests, shared docs index.
- Swap worker: `jupiter-swap-v2.md` implementation, swap API v2 migration, swap tests, swap connector pack updates.
- Lend worker: `jupiter-lend.md` implementation, SDK dependencies, Earn/Borrow adapter, lend tests.
- Trigger worker: `jupiter-trigger.md` implementation, JWT auth flow, vault/order adapter, trigger tests.
- Recurring worker: `jupiter-recurring.md` implementation, native DCA adapter, recurring tests.
- Token/Price worker: `jupiter-token-price.md` implementation, read-only evidence adapter, token/price tests.
- Prediction worker: `jupiter-prediction.md` implementation, beta read-only adapter, prediction tests.
- Perps worker: `jupiter-perps.md` research/read-only adapter, no write actions.
- Browser UI worker: connector capability chips, warnings for Jupiter-native automation, and preference-tab copy.
- QA worker: scenario prompts, safety language, smoke matrix, and connector evals.

Workers should not edit shared config or union types unless the shared Jupiter worker has not completed those changes.

## Completion Definition

Jupiter is complete when:

- Swap uses the current Swap API v2 base URL and still passes existing swap tests.
- `solana_connector_capabilities jupiter` reports all Jupiter product groups and readiness reasons.
- Lend reads and safe Earn/Borrow prepared actions are first-class.
- Trigger V2 can create, inspect, edit, cancel, and withdraw orders with explicit vault/JWT warnings.
- Recurring can create, inspect, execute setup, and cancel Jupiter-native DCA orders with explicit automation warnings.
- Token and Price facts are available to any agent review.
- Prediction reads are available and marked beta.
- Perps reads are either implemented from stable official data or clearly unavailable with the official work-in-progress reason.
- No Jupiter path signs, stores secrets, or claims future automated executions still require Agentic approval when they do not.

## Suggested Execution Order

1. Shared Jupiter runtime and config pass.
2. Token and Price read-only evidence.
3. Swap API v2 alignment.
4. Lend Earn reads and deposit/withdraw.
5. Lend Borrow reads and health preview, then borrow/repay/write actions.
6. Recurring native DCA, because it is simpler automation than Trigger.
7. Trigger V2, because JWT and vault custody need stricter review.
8. Prediction beta reads.
9. Perps read-only research.
10. Browser UI and full QA matrix.

## Global Jupiter Safety Rules

- Never request private keys or seed phrases.
- Never store `JUPITER_API_KEY`, `JUP_API_KEY`, JWTs, challenges, bearer tokens, signed challenges, or signed transaction bodies in receipts or prepared actions.
- Never describe Trigger or Recurring as approval-per-run Agentic automation. They are Jupiter-native automation products after setup.
- Never hide vault custody, cancellation, withdrawal, fees, liquidation, slippage, or beta status.
- Never support Perps leverage writes until official docs mark the API stable and a separate leverage-risk policy is approved.
- Never claim Jupiter output, yield, liquidation safety, trigger execution, DCA fills, prediction outcomes, or perps outcomes are guaranteed.

## Test Commands

After each Jupiter product surface lands:

```sh
pnpm -F @solana-agent-wallet-adapter/mcp-server test
pnpm -F @solana-agent-wallet-adapter/mcp-server typecheck
pnpm -F @solana-agent-wallet-adapter/browser-demo test
pnpm -F @solana-agent-wallet-adapter/browser-demo typecheck
```

Full release verification:

```sh
pnpm typecheck
pnpm -r test
pnpm build
```

## Smoke Prompts

- "Show every Jupiter capability this app supports."
- "Quote 0.1 SOL to USDC through Jupiter and explain the route."
- "Show Jupiter token risk facts for this mint."
- "Show my Jupiter Earn positions."
- "Prepare depositing 5 USDC into Jupiter Earn. Do not sign."
- "Show my Jupiter Borrow vault health."
- "Prepare borrowing 2 USDC from Jupiter Lend only if health stays safe."
- "Create a Jupiter Trigger order only after explaining vault custody."
- "Show my active Jupiter Trigger orders and cancellation status."
- "Create a Jupiter native DCA order, but explain that future fills are automated by Jupiter."
- "Show live Jupiter prediction markets for crypto."
- "Can you open a Jupiter Perps trade?" Expected: deny write, explain Perps API is work in progress.
