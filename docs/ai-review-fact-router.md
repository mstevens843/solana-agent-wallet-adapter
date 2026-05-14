# AI Review Fact Router

This document defines how the Ask/Check agent decides which provider endpoint to use before it approves, denies, or asks for more input.

The agent should not guess blindly, and it should not call every endpoint on every review. It should first build a fact-route plan from the draft, the user's question, the connected wallet public key, and the already-known deterministic facts. Only routes selected by that plan should be fetched.

## Goals

- Always scope wallet-related decisions to the connected or draft wallet public key.
- Use deterministic provider facts before asking the user for information the app can fetch.
- Keep approval/denial latency reasonable by selecting only relevant endpoints.
- Prefer wallet-scoped endpoints only when the connected wallet or draft wallet is available.
- Keep transaction-building endpoints out of generic Ask/Check research unless they are already part of an approval-safe existing tool.

## Router Contract

The shared implementation is `planAgentReviewFactRoutes()` in `packages/workflow/src/agentFactRouter.ts`.

Input:

- Plan fields: `actionType`, `intent`, `route`, `risk`, `approval`, `userNotes`, and `parameters`.
- Review prompt fields: `instruction`, `question`, and `prompt`.
- Availability flags: `hasWallet`, `hasTokenMints`, and `hasProtocolConnector`.

Output:

- `routes`: provider endpoints to fetch.
- `skipped`: facts that were relevant but unavailable because a prerequisite was missing.
- `routeText`: short human-readable summary for evidence/debugging.

Each route has:

- `need`: the fact category, such as `wallet_transfers`, `token_security`, or `global_market`.
- `provider`: wallet, Helius, BirdEye, CoinGecko, Jupiter, DEX Screener, alternative.me, protocol connector, or external research.
- `endpoint`: the exact app/backend endpoint family to use.
- `status`: `required` if the answer depends on it, `optional` if it is useful supporting context.
- `reason`: concise reason the route was selected.
- `params`: optional route metadata, used by connector routes for `connectorId`, connector profile, and read capability.

## Endpoint Matrix

| Fact need | Primary provider | Endpoint | Use when |
| --- | --- | --- | --- |
| Wallet identity | Wallet session | `connected_public_key` | Any approval/denial needs wallet scope. |
| Transfer history | Helius | `getTransfersByAddress` via `/api/helius/transfers-by-address` or `/bridge/action/helius-history` | Transfers, payments, duplicates, recent activity, recipient history. |
| Wallet holdings | BirdEye | `wallet-token-list` via `/api/birdeye/wallet-token-list` or `/bridge/birdeye/wallet-token-list` | Balances, holdings, exposure, affordability, money-moving action context. |
| Token metadata | BirdEye | `token-meta` | Token identity, mint, symbol, or verification questions. |
| Token security | BirdEye | `token-security` | Unknown token, safety, scam risk, mint authority, freeze authority, token age. |
| Token market | BirdEye | `price-multi` | Price, liquidity, or threshold checks. |
| Token market support | CoinGecko | `token-evidence` | Market cap, 24h volume/change, on-chain price, secondary market evidence. |
| Token market fallback | DEX Screener | `token-pairs/v1/solana/{mint}` | BirdEye/CoinGecko have no usable market row. |
| Swap quote | Jupiter | `swap.order existing tool` | Swap output, slippage, executable quote, or amount-out questions. |
| Swap route | Jupiter | `swap.order routePlan` | Venue/path questions for swaps. Jupiter selects this at quote time. |
| Protocol positions | Protocol connector | `connector-read-facts` | Rewards, positions, health, collateral, vaults, protocol-specific reads. |
| Global market | CoinGecko | `global` | BTC dominance, total crypto market cap, market conditions. |
| Sentiment | alternative.me | `fng` | Fear & Greed or broad sentiment questions. |
| Current research | AI/web research path | `ai-native-current-research` | Latest news, docs, outages, incidents, exploit status, announcements. |

## Connector Profiles

Connector-drafted reviews use the general router plus a connector-specific profile. The profile decides which safe `connector-read-facts` capability should be fetched. It does not allow transaction-building endpoints in Ask/Check.

| Profile | Connectors | Primary read capability |
| --- | --- | --- |
| Lending/borrow | Kamino, MarginFi, Project 0, Save, Drift, Lulo | `positions`, `markets`, `earn`, `borrow`, `withdraw`, `repay`, or `rewards` depending on operation. |
| LP/AMM | Raydium, Orca, Meteora | `positions` for LP state; `rewards` for collect/harvest/fee checks. |
| Staking/LST | Jito, Marinade, Sanctum | `earn`, `withdraw`, `swap`, `markets`, or `positions`. |
| NFT marketplace | Tensor, Magic Eden | `marketplace` for bid/list/buy/sweep; `positions` for wallet NFT state. |
| Governance/multisig | Realms, Squads | `governance` or `treasury`. |
| Bridge/cross-chain | Wormhole | `bridge` for quote/status/redeem; `positions` for bridge exposure. |
| Oracle/read-only | Pyth | `oracle`. |
| Jupiter special | Jupiter Swap/Lend/Trigger/Recurring/Prediction/Perps | `swap`, `earn`, `positions`, `trigger`, `recurring`, `prediction`, or `perps`. |

When a connector is selected and read-ready, the router emits `protocol_connector.read_facts` with profile metadata. The browser records the fetched response as `facts.connectorRead`. If the connector is disabled or its read APIs are not ready, the router records a skipped `protocol_position` need instead.

## Selection Algorithm

1. Normalize all available text into one lowercased planning string:
   plan intent, route, risk, approval, notes, user question, instruction, prompt, and parameters.

2. Add wallet identity if a wallet is available:
   the public key is always included in review context so wallet-specific approval/denial can be scoped without follow-up.

3. Select wallet transfer history when:
   action type is `transfer_sol`, `transfer_spl`, or `recurring_payment`, or the text mentions sent/received transfers, payments, duplicate payments, transaction history, recent activity, or recipient history.

4. Select wallet holdings when:
   the text asks about balances, holdings, portfolio, positions, exposure, ownership, affordability, or enough funds. Also select it as optional support for money-moving actions such as swaps, transfers, deposits, withdrawals, lending, collateral, DCA, and recurring actions.

5. Select token metadata/security/market routes when:
   token mints are resolved and the question references token identity, safety, authorities, price, liquidity, market cap, volume, 24h change, or threshold conditions.

6. Select Jupiter quote/route routes when:
   the plan is a swap or the question mentions quote, route, slippage, minimum received, output amount, price impact, DEX, aggregator, or Jupiter.

7. Select protocol connector facts when:
   a connector is selected or the question mentions protocol positions, rewards, collateral, vault health, pool/LP state, staking, lending, borrowing, governance, bridge, NFT marketplace, or oracle evidence. For selected connectors, choose the connector profile capability before fetching.

8. Select global market routes when:
   the question mentions Fear & Greed, sentiment, BTC/ETH dominance, global market cap, market conditions, or broad crypto market state.

9. Select external research when:
   the question depends on latest/current/today/news/docs/status/incidents/exploits/announcements. This is intentionally separate from deterministic wallet/provider facts.

10. Record skipped needs when:
   the question needs wallet, token, or connector data, but the prerequisite public key, token mint, or connector is unavailable.

## Required vs Optional

Required routes are needed to answer the approval question. If a required route fails, the review should either deny if risk is clear or ask for input if the missing fact blocks a responsible decision.

Optional routes are supporting context. Failure to fetch an optional route should not block the review by itself, but the failed route should be visible in evidence if it affects confidence.

Examples:

- "Did I already pay this recipient?" requires Helius transfer history.
- "Do I have enough USDC?" requires BirdEye wallet holdings.
- "Is this unknown token safe?" requires BirdEye token security.
- "Approve only if market cap is above $10M" requires token market evidence from BirdEye/CoinGecko.
- "Is slippage acceptable?" requires Jupiter swap quote/route context.
- "Is BTC dominance above 55%?" requires CoinGecko global data.

## Execution Flow

1. Browser gathers local deterministic facts.
2. Browser calls `planAgentReviewFactRoutes()`.
3. Browser records the route plan as `facts.evidenceRoutes`.
4. Browser executes selected deterministic provider routes:
   Helius for transfers, BirdEye for wallet/token facts, CoinGecko for token/global evidence, protocol connector read-facts for selected connector drafts, alternative.me for Fear & Greed, and DEX Screener fallback only when token-market routing selected it.
5. The AI review receives:
   connected wallet public key, selected route plan, fetched facts, skipped facts, connector read evidence, draft parameters, user policies, and connector context.
6. The AI decides approve, deny, or needs_input from those facts. It should not ask the user for facts that were successfully fetched.

## Safety Boundaries

- Wallet-scoped facts require a matching signed-in cloud session or connected local bridge.
- Approval-only endpoints that produce transaction bytes stay in the approval flow, not generic research.
- Connector Ask/Check uses only `/api/connector/read-facts` or `/bridge/action/connector-read-facts`.
- Jupiter route/quote evidence should come from the existing swap/order preview path.
- Current news or docs are not treated as deterministic provider facts.
- Private keys and seed phrases are never requested or routed.

## Test Coverage

The router has focused unit coverage in `packages/workflow/src/__tests__/agentFactRouter.test.ts` for:

- duplicate-payment transfer history,
- wallet holdings/affordability,
- unknown token security,
- token market evidence,
- Jupiter swap routing,
- global market/sentiment routing,
- connector profile routing,
- disabled or unready connector skips,
- skipped wallet-scoped routes when no wallet is available.
