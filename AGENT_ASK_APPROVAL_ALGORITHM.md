# Agent Ask Approval Algorithm

This document is the implementation handoff for making Ask AI approval/denial decisions industry-grade. The goal is to keep provider and connector calls available on demand, but make approvals deterministic, evidence-bound, fail-closed, connector-aware, testable, and auditable.

## Goal

When a user drafts a plan and enables Ask agent after draft, the agent must decide `approve`, `deny`, or `needs_input` from a formal evidence flow:

1. Identify the connected public key immediately.
2. Classify the draft, user question, wallet scope, token scope, and selected connector.
3. Select only the provider and connector facts needed for that decision.
4. Gather those facts through existing endpoint utilities.
5. Normalize facts into compact evidence rows.
6. Run a deterministic pre-AI evidence gate.
7. Ask AI for a structured verdict that cites evidence ids.
8. Run a deterministic post-AI validator.
9. Store an audit receipt that explains exactly why the approval or denial happened.

The system must fail closed: if wallet, position, connector, price, quote, token security, transfer history, or current-data facts are required but missing/stale/failed, the agent must not approve.

## Non-Negotiable Rules

- The connected wallet public key is always included in review context before any approval decision.
- The agent never approves a wallet-scoped action without matching wallet evidence.
- The agent never approves a connector-scoped action without connector readiness and required connector read facts.
- The agent never approves a token/market/quote question using model opinion alone.
- The AI cannot override a deterministic blocking gate.
- Provider failures are evidence, not invisible errors.
- Approvals must cite real evidence ids from the normalized fact set.
- Unknown required facts result in `needs_input` or `deny`, never `approve`.
- The agent can prepare endpoints for Helius, BirdEye, CoinGecko, Jupiter, and connector reads, but calls them only when the route planner says they are needed.

## Current Repo Starting Point

The repo already has the right foundation:

- `packages/workflow/src/agentFactRouter.ts` plans provider routes.
- `apps/browser-demo/src/main.ts` gathers deterministic facts and provider facts.
- Helius transfer history is routed through `helius.getTransfersByAddress`.
- BirdEye wallet/token facts, CoinGecko token/global facts, Jupiter swap facts, and connector read facts are partially wired.
- `facts.evidenceRoutes` records route selection.
- Connector read facts can call cloud `/api/connector/read-facts` or local bridge `/bridge/action/connector-read-facts`.

The main missing pieces are:

- No formal evidence requirement contract.
- No deterministic pre-AI gate.
- No structured AI decision contract requiring fact ids.
- No deterministic post-AI approval validator.
- No TTL/freshness enforcement.
- No normalized evidence row set shared across all providers.
- No golden scenario suite for approval/denial behavior.
- No hashable audit receipt for the full decision.

## Target Data Contracts

Add these contracts in workflow so browser, cloud, bridge, and tests can share them.

```ts
type AgentEvidenceSeverity = 'info' | 'warn' | 'block';
type AgentEvidenceRequirementStatus = 'required' | 'optional';
type AgentEvidenceFreshness = 'fresh' | 'stale' | 'missing';
type AgentEvidenceGateDecision = 'pass' | 'block' | 'needs_input';

interface AgentEvidenceRequirement {
  id: string;
  routeId: string;
  need: AgentFactNeed;
  provider: AgentFactProvider;
  endpoint: string;
  status: AgentEvidenceRequirementStatus;
  ttlMs: number;
  blocking: boolean;
  reason: string;
  connectorProfile?: AgentConnectorProfileKind;
  connectorId?: string;
}

interface AgentEvidenceFact {
  id: string;
  requirementId?: string;
  routeId?: string;
  label: string;
  value: string;
  tone: 'good' | 'neutral' | 'warn' | 'fail';
  source: 'deterministic' | 'wallet' | 'helius' | 'birdeye' | 'coingecko' | 'jupiter' | 'connector' | 'ai';
  checkedAt: string;
  expiresAt?: string;
  freshness: AgentEvidenceFreshness;
  severity: AgentEvidenceSeverity;
  detail?: Record<string, unknown>;
}

interface AgentEvidenceGateResult {
  decision: AgentEvidenceGateDecision;
  checkedAt: string;
  requirements: AgentEvidenceRequirement[];
  facts: AgentEvidenceFact[];
  missingRequired: AgentEvidenceRequirement[];
  staleRequired: AgentEvidenceRequirement[];
  blockingFacts: AgentEvidenceFact[];
  warnings: AgentEvidenceFact[];
  reason: string;
}

interface AgentDecisionContract {
  decision: 'approve' | 'deny' | 'needs_input';
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  summary: string;
  evidenceFactIds: string[];
  missingFactIds?: string[];
  blockingFactIds?: string[];
  warnings?: string[];
  questions?: AgentReviewQuestion[];
}

interface AgentDecisionAuditReceipt {
  schemaVersion: 1;
  receiptId: string;
  planFingerprint: string;
  walletAddress: string;
  cluster: string;
  connectorId?: string;
  connectorProfile?: AgentConnectorProfileKind;
  routePlanHash: string;
  evidenceHash: string;
  aiDecisionHash: string;
  finalDecision: 'approve' | 'deny' | 'needs_input';
  gateDecision: AgentEvidenceGateDecision;
  checkedAt: string;
  providerRoutes: string[];
  evidenceFactIds: string[];
  blockingFactIds: string[];
  missingRequirementIds: string[];
}
```

## Decision Flow

### 1. Build Review Input

Before any provider call, assemble:

- plan action type, route, risk, approval, user notes, prompt, parameters
- connected public key and wallet source
- draft wallet address if present
- cluster
- selected connector id/name/action kind/read readiness
- ask-agent question or review instruction
- enabled user policies
- prior answers and prior attempts

If a connected wallet exists, the route planner must include `wallet.connected_public_key` as required evidence.

### 2. Plan Evidence Routes

Use `planAgentReviewFactRoutes(...)` as the deterministic router. Extend it so each selected route also produces an `AgentEvidenceRequirement`.

Required route examples:

- `wallet.connected_public_key`: any wallet-scoped approval.
- `helius.getTransfersByAddress`: duplicate payment, transfer history, recipient history, recent wallet activity.
- `birdeye.wallet_token_list`: balance, holdings, affordability, exposure, positions, wallet token list.
- `birdeye.token_metadata`: token identity or mint verification.
- `birdeye.token_security`: scam/rug/mint authority/freeze authority/token age/safety questions.
- `birdeye.price_multi`: token price, liquidity, threshold, output value.
- `coingecko.token_evidence`: market cap, volume, 24h change, broader token market evidence.
- `coingecko.global`: BTC dominance, total crypto market cap, global market conditions.
- `alternative_me.fear_greed`: Fear & Greed or sentiment questions.
- `jupiter.swap_order_preview`: swap quote, amount out, price impact, route readiness.
- `jupiter.swap_route`: executable swap route/venue context.
- `protocol_connector.read_facts`: selected connector positions, health, vault, pool, NFT, governance, bridge, oracle, or protocol-specific facts.
- `external_research.current_web`: current events, news, docs, status pages, incidents, or facts not covered by deterministic provider endpoints.

### 3. Assign TTLs

Every required evidence requirement must have a TTL. Stale required evidence blocks approval.

| Provider/Fact | TTL |
| --- | ---: |
| Connected public key | current session only |
| Helius transfers | 120 seconds |
| BirdEye wallet holdings | 60 seconds |
| BirdEye token metadata | 24 hours |
| BirdEye token security | 10 minutes |
| BirdEye token price/liquidity | 30 seconds |
| CoinGecko token evidence | 5 minutes |
| CoinGecko global market | 5 minutes |
| alternative.me Fear & Greed | 15 minutes |
| Jupiter quote/order preview | 20 seconds |
| Jupiter route plan | 20 seconds |
| Connector read facts | 60 seconds by default |
| Oracle connector facts | max of 30 seconds or connector-provided max age |
| External research | 10 minutes unless source timestamp is older |

### 4. Gather Provider Facts

Provider calls are on demand only. Do not call all providers by default.

Helius:

- Use `getTransfersByAddress` for parsed transfer history in one call.
- Required for duplicate payment, recipient history, recent transfer, wallet activity, or "did I already send/receive" questions.
- Normalize transfers into facts with signature, type, mint/SOL, from, to, amount, timestamp, and direction relative to connected wallet.

BirdEye:

- Use wallet token list for holdings/affordability/exposure questions.
- Use token metadata/security/price routes for token identity, scam risk, liquidity, market value, and threshold questions.
- Token security failures such as suspicious mint authority, freeze authority on non-stable tokens, extreme age risk, or missing security on required safety checks must produce blocking facts.

CoinGecko:

- Use token evidence for market cap, volume, 24h change, and cross-provider market confirmation.
- Use global for BTC dominance, total market cap, and market-wide conditions.
- CoinGecko supplements BirdEye; it should not replace a required Solana wallet/provider fact.

Jupiter:

- Use Jupiter only for swap-like drafts and Jupiter connector actions.
- Required facts include quote freshness, route availability, input/output tokens, slippage, price impact, amount in/out, and minimum received.
- A missing or stale quote blocks swap approval.

Connector reads:

- Use when a connector is selected and Ask agent after draft is enabled.
- Use the selected connector only; do not switch protocols.
- If the connector is disabled, not read-ready, or requires a missing key/session, block approval for connector-required actions.
- Connector reads produce normalized facts from protocol-specific snapshots.

External research:

- Use only for current facts outside deterministic provider coverage.
- If web/current research is required but unavailable in the selected AI mode, return `needs_input`.

### 5. Normalize Evidence

Convert every deterministic/provider/connector result into `AgentEvidenceFact[]`.

Rules:

- One fact row must answer one concrete question.
- Each fact has an id such as `fact.helius.transfer_history.0` or `fact.connector.marginfi.health_factor`.
- Keep rows compact; avoid passing raw large provider payloads to AI.
- Raw details can be stored in `detail`, but the AI context should use bounded summaries.
- Use `tone: fail` and `severity: block` for facts that should deny/block.
- Use `tone: warn` and `severity: warn` for incomplete optional context.
- Use `freshness: stale` if `checkedAt + ttlMs < now`.

### 6. Run Pre-AI Evidence Gate

Run `evaluateAgentEvidenceGate(requirements, facts, context)` before calling AI.

Gate rules:

- Missing required requirement -> `block` for wallet/action safety facts, otherwise `needs_input`.
- Stale required requirement -> `block`.
- Required provider returned `warn`, `missing`, or `fail` -> `block`.
- Any blocking fact -> `block`.
- No connected public key on wallet-scoped approval -> `block`.
- Wallet mismatch between connected public key and draft wallet -> `block`.
- Selected connector disabled/read-unready for connector action -> `block`.
- Required current outside fact unavailable -> `needs_input`.
- Optional missing facts -> `pass` with warnings.

Pre-AI gate output must be included in AI context even when it blocks. If it blocks, the AI may still summarize the issue, but the final post-AI validator cannot allow approval.

### 7. Ask AI With Structured Contract

Update the AI review prompt to require:

- `decision`
- `confidence`
- `reason`
- `summary`
- `evidenceFactIds`
- `blockingFactIds`
- `missingFactIds`
- optional `questions`

Prompt rule:

> You may only approve if `context.evidenceGate.decision` is `pass`, all required facts are fresh, and your `evidenceFactIds` cite real facts from `context.evidenceFacts`. If the gate blocks, return `deny` or `needs_input`.

The AI should explain the decision in plain English, but the deterministic validator owns final authority.

### 8. Run Post-AI Validator

Run `validateAgentReviewDecision(aiResult, evidenceGate, evidenceFacts)`.

Validator rules:

- If AI decision is `approve` and gate is not `pass`, convert to `deny` or `needs_input`.
- If AI cites a nonexistent evidence id, convert to `needs_input`.
- If AI omits required evidence ids, convert to `needs_input`.
- If AI approves while any required fact is stale/missing/failed, convert to `deny`.
- If AI approves while a blocking fact exists, convert to `deny`.
- If AI denies with blocking evidence, preserve denial.
- If AI asks for input that deterministic facts already answer, auto-resolve only if all required facts pass.

Final severity precedence:

1. deterministic block -> `deny`
2. missing required user-supplied fact -> `needs_input`
3. invalid AI contract -> `needs_input`
4. AI deny -> `deny`
5. AI needs_input -> `needs_input`
6. AI approve + passing gate -> `approve`

### 9. Store Audit Receipt

Every final decision must produce an audit receipt.

Receipt includes:

- schema version
- receipt id
- plan fingerprint
- connected wallet public key
- cluster
- connector id/profile if selected
- route plan hash
- evidence hash
- AI decision hash
- final decision
- gate decision
- provider route ids
- cited evidence ids
- blocking fact ids
- missing requirement ids
- checked timestamp

Receipt should be stored in `agentReview.evidence.auditReceipt` and surfaced in review details.

## Connector Risk Profiles

Use risk profiles in v1. Do not write custom decision logic for every connector unless a profile cannot express the risk.

| Connector | Profile | Required Evidence |
| --- | --- | --- |
| Jupiter | `swap_dex` / `jupiter_product` | quote, route, token market, slippage, connector facts for trigger/recurring/lend/perps when selected |
| Drift Vaults | `vault_yield` or `perps_margin` | vault position, deposit/withdraw state, market health, exposure, wallet holdings |
| Kamino Finance | `lending_borrow` / `vault_yield` | wallet holdings, reserve/vault facts, position health, collateral/borrow exposure |
| MarginFi | `lending_borrow` | wallet holdings, account position, health factor, bank/reserve facts |
| Project 0 | `lending_borrow` | wallet holdings, account position, health/collateral facts |
| Save | `lending_borrow` | wallet holdings, reserve facts, obligation/position health |
| Lulo | `yield_earn` | wallet holdings, earn position, withdrawal state, market/rate facts |
| Raydium | `liquidity_pool` | pool facts, LP position, token pair, liquidity, slippage/price impact if swapping |
| Orca | `liquidity_pool` | whirlpool/pool facts, LP position, token pair, liquidity, slippage/price impact if swapping |
| Meteora | `liquidity_pool` | pool/DLMM position, bin/range facts, fees/rewards, token pair |
| Jito | `staking_lst` | stake/LST position, exchange rate, withdrawal/unstake state |
| Marinade | `staking_lst` | mSOL/stake account facts, delayed unstake/ticket state |
| Sanctum | `staking_lst` | LST pool facts, quote/exchange rate, wallet position |
| Magic Eden | `nft_marketplace` | collection/listing/bid facts, wallet NFT ownership, price/floor evidence |
| Tensor | `nft_marketplace` | collection/listing/bid facts, wallet NFT ownership, price/floor evidence |
| Realms | `governance` | proposal/governance/realm facts, voting power, treasury facts when money-moving |
| Squads Multisig | `multisig` | multisig threshold, signer membership, transaction index, vault/treasury facts |
| Wormhole | `bridge` | source/destination chain, recipient, token, fees, transfer status, VAA/redeem state |
| Pyth | `oracle` | price, confidence, publish time, max age, feed id |

Profile behavior:

- `swap_dex`: require Jupiter quote/route and token market facts.
- `lending_borrow`: require wallet holdings and protocol health/position facts.
- `vault_yield`: require wallet holdings, vault position, vault liquidity/withdrawal state.
- `yield_earn`: require wallet holdings and earn position/withdrawal state.
- `liquidity_pool`: require pool/position facts and token pair market facts.
- `staking_lst`: require stake/LST position and exchange/withdrawal facts.
- `nft_marketplace`: require listing/bid/collection facts and ownership where relevant.
- `governance`: require proposal/realm/vote/treasury facts.
- `multisig`: require signer/threshold/transaction/vault facts.
- `bridge`: require route/destination/status/recipient facts.
- `oracle`: require price/confidence/freshness facts.
- `perps_margin`: require margin account, custody/market, leverage, liquidation/health facts.

## Endpoint Routing Algorithm

Pseudocode:

```ts
function reviewDraft(record, questionOrInstruction) {
  const wallet = connectedWalletPublicKey(record);
  const connector = selectedConnector(record.plan);
  const routePlan = planAgentReviewFactRoutes({
    actionType: record.plan.actionType,
    intent: record.plan.intent,
    route: record.plan.route,
    risk: record.plan.risk,
    approval: record.plan.approval,
    userNotes: record.plan.userNotes,
    instruction: questionOrInstruction,
    prompt: record.prompt,
    parameters: record.plan.parameters,
    hasWallet: Boolean(wallet),
    hasTokenMints: hasResolvedMints(record.plan),
    hasProtocolConnector: connector?.readReady === true,
    connector,
  });

  const requirements = buildEvidenceRequirements(routePlan, record, wallet, connector);
  const providerFacts = gatherOnlySelectedRoutes(routePlan);
  const evidenceFacts = normalizeEvidenceFacts(requirements, providerFacts);
  const gate = evaluateAgentEvidenceGate(requirements, evidenceFacts, { wallet, connector });

  const aiResult = askAiForDecisionContract({
    plan: record.plan,
    walletAddress: wallet,
    context: { routePlan, requirements, evidenceFacts, evidenceGate: gate },
  });

  const finalResult = validateAgentReviewDecision(aiResult, gate, evidenceFacts);
  const receipt = createDecisionAuditReceipt(finalResult, routePlan, requirements, evidenceFacts, gate);

  return { finalResult, receipt };
}
```

## Golden Eval Suite

Add deterministic tests before or alongside implementation.

Required scenarios:

1. Safe swap approve: fresh Jupiter quote, acceptable slippage, token facts present.
2. Stale swap quote deny: quote older than TTL.
3. Missing public key deny: wallet-scoped draft without connected wallet.
4. Duplicate payment needs input or deny: Helius transfer shows same recipient/amount recently.
5. Trusted recipient transfer approve: Helius transfer history and recipient policy pass.
6. Unknown recipient needs input: transfer to new recipient when known-recipient policy is enabled.
7. Scam token deny: BirdEye token security has blocking mint/freeze/true-token risk.
8. Market threshold approve: CoinGecko/BirdEye fact satisfies user threshold.
9. Market threshold deny: provider fact fails threshold.
10. Connector disabled deny: selected connector is disabled/read-unready.
11. Connector read unavailable deny: required connector facts fail.
12. Lending health deny: MarginFi/Kamino health/collateral facts fail.
13. Vault withdrawal needs input: vault facts unavailable or withdrawal state unknown.
14. LP position approve: pool and wallet LP position facts pass.
15. NFT listing deny: listing/floor/ownership facts conflict with draft.
16. Multisig signer mismatch deny: connected wallet is not valid signer.
17. Bridge destination mismatch deny: connector destination differs from draft recipient.
18. Oracle stale deny: Pyth publish time exceeds max age.
19. AI hallucinated source needs input: AI cites nonexistent evidence id.
20. AI approve despite gate block deny: post-AI validator overrides approval.

## Implementation Steps

1. Add this document at repo root.
2. Add shared evidence contract types in workflow.
3. Extend `planAgentReviewFactRoutes` to emit requirements and connector risk profile metadata.
4. Add TTL helpers and route-to-requirement mapping.
5. Add evidence fact normalizers for wallet, Helius, BirdEye, CoinGecko, Jupiter, and connector reads.
6. Add `evaluateAgentEvidenceGate`.
7. Update browser review context to include `evidenceRequirements`, `evidenceFacts`, and `evidenceGate`.
8. Update AI review prompts in browser/session, hosted, and local bridge paths to require `AgentDecisionContract`.
9. Add `validateAgentReviewDecision`.
10. Add audit receipt creation and attach receipt to `agentReview.evidence`.
11. Add UI findings from normalized evidence rows.
12. Add golden unit tests for route planning, gate behavior, validator behavior, connector profiles, and audit receipts.
13. Run workflow tests, browser-demo typecheck/tests, and mcp-server AI planner tests.

## Acceptance Criteria

- A wallet-scoped approval always includes the connected public key in context.
- Helius `getTransfersByAddress` is selected for transfer-history/duplicate-payment questions.
- BirdEye, CoinGecko, Jupiter, and connector reads are selected only when relevant.
- Missing required facts block approval.
- Stale required facts block approval.
- Connector-selected drafts use connector risk profiles.
- The AI must cite evidence ids.
- The post-AI validator rejects invalid or unsafe approvals.
- Every decision records an audit receipt.
- Golden evals cover approve, deny, and needs-input paths.
- No approval can be produced from AI text alone when wallet, connector, quote, market, token, or transfer facts are required.

