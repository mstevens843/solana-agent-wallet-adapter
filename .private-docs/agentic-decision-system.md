# Agentic Decision System

This is the strongest architecture story in the repo.

Agentic is not only a crypto wallet UI. It is a decision-support system where the model is useful but not trusted as the final gate.

## Core Pattern

```text
messy human request
  |
  v
chat routing and context builder
  |
  v
fact route plan
  |
  v
policy atoms
  |
  v
authoritative fact resolution
  |
  v
deterministic evaluator
  |
  v
evidence gate
  |
  v
AI explanation and decision
  |
  v
post-AI validator
  |
  v
human approval
```

The AI can recommend. The deterministic layer can block. The human signs.

## Important Code

- `packages/workflow/src/chatAgent/systemPrompt.ts`: cross-runtime chat grounding, wallet boundaries, tool requirements, and action proposal rules.
- `packages/workflow/src/chatAgent/routing.ts`: maps chat text into fact categories.
- `packages/workflow/src/chatAgent/tools.ts`: provider-neutral read tools and wallet-action proposal schema.
- `packages/workflow/src/agentFactRouter.ts`: review fact routing for wallet, token, market, connector, and current research evidence.
- `packages/workflow/src/agentAtoms.ts`: decomposes policy text into typed decision atoms.
- `packages/workflow/src/agentCapabilityRegistry.ts`: maps atoms to resolver chains.
- `packages/workflow/src/policyOrchestrator.ts`: extract, resolve, evaluate, tx-gate analyze, and return a `PolicyEvaluationBundle`.
- `packages/workflow/src/policyEvaluator.ts`: deterministic pass/fail/warn/unresolved evaluation.
- `packages/workflow/src/txGates.ts`: transaction-gate analysis from simulation digest and expected context.
- `packages/workflow/src/agentEvidenceRequirements.ts`: builds required and optional evidence requirements from route plans.
- `packages/workflow/src/agentEvidenceGate.ts`: pre-AI gate and post-AI decision validator.
- `apps/render-web/src/cloud/policyEnrich.ts`: pre-resolves policy facts for BYOK and device-agent paths before the user's model runs.
- `apps/browser-demo/src/chatDecisionCheck.ts`: Chat Decision Planner plan wrapper.
- `apps/browser-demo/src/agentReviewPresentation.ts`: user-facing evidence, decision, confidence, receipt, and validator output presentation.

## Chat Layer

The chat agent is general-purpose, but wallet-aware. It can answer normal questions, then use wallet and Solana tools when the request is in scope.

The prompt enforces:

- live tool calls for token prices, token facts, market data, wallet intelligence, connector facts, priority fees, transactions, holders, and categories
- wallet balance answers from wallet context, not model memory
- connector reads for protocol facts
- explicit wallet-action preparation only through `propose_wallet_action`
- no signing, submitting, broadcasting, or approval claims
- no guessed prices, mints, balances, addresses, authorities, or safety facts

Supported proposal kinds:

- `transfer_sol`
- `transfer_spl`
- `swap`
- `sign_proof`

## Fact Routing

Chat fact categories include:

- token price, search, safety, market, age, holders, top traders, supply changes, activity
- market regime, trending tokens, trending coins, new listings, coin categories
- wallet history, NFTs, portfolio, PnL, origin, net-worth history
- priority fee and transaction explanation
- connector facts
- current web facts when a provider supports search

Review fact routing includes:

- wallet identity
- transfer history
- wallet holdings
- token metadata
- token security
- token market
- token-market fallback
- Jupiter quote and route
- protocol connector facts
- global market
- sentiment
- current research

## Policy Atoms

Atoms turn natural-language rules into structured checks.

Examples:

- `SOL price > $60`
- `BTC Fear & Greed > 20`
- `mint authority disabled`
- `freeze authority disabled`
- `token age > 24h`
- `market cap > $10M`
- `wallet SOL balance >= 0.1`
- `fee < $1`
- `only requested swap`
- `no extra transfers`
- `no unknown recipients`
- `no unrelated instructions`
- external price or state gates such as a monthly plan price under a threshold

The atom extractor is conservative. Unknown phrasing falls back to the existing reviewer flow or model-assisted canonicalization when configured.

## Resolution

Resolvers fetch facts from:

- wallet state
- Solana RPC
- Helius
- BirdEye
- CoinGecko
- Jupiter
- DEX Screener fallback
- alternative.me
- connector reads
- transaction simulation
- current web/search paths

`runPolicyPipeline()` resolves non-transaction atoms through the capability registry, evaluates them, and separately analyzes tx-gate atoms when simulation is available.

## Evidence Gate

`evaluateAgentEvidenceGate()` decides whether the AI is even allowed to approve.

It blocks or needs-input when:

- required evidence is missing
- required evidence is stale
- required evidence has blocking severity
- wallet-scoped review has no connected public key
- connected wallet does not match the draft wallet
- connector is disabled
- connector read endpoints are required but not ready
- current research is required but unavailable

Optional missing facts can pass with warnings.

## Post-AI Validator

`validateAgentReviewDecision()` enforces deterministic rules after the AI responds.

It can downgrade:

- AI approve while gate blocked -> deny
- AI approve while gate needs input -> needs input
- AI approve while required evidence is missing -> needs input
- AI approve while required evidence is stale or blocked -> deny
- AI approve on deferred web research without actual research -> needs input
- AI citations to unknown evidence ids -> strip or needs input, depending on severity

This is the heart of the safety story: the AI's explanation is useful, but deterministic gates still control unsupported approvals.

## Human Approval

Even an approved decision is not a signature. The user still reviews the card and approves in the wallet.

Outcomes:

- prepare card
- approve and sign
- deny
- needs input
- wallet required
- archive
- finalization record
- evidence receipt

## Portable Mapping

The same architecture maps outside Solana:

| Agentic domain | Generic decision workflow |
| --- | --- |
| Token facts | Product/SKU/catalog facts |
| Wallet state | Account/customer/deal state |
| Market data | Competitor pricing/spec data |
| Connector reads | Internal systems, CRMs, ERPs, supply APIs |
| Token safety gates | Compliance, margin, availability, contract gates |
| Wallet action proposal | Quote, discount, SKU, bundle, order proposal |
| Policy atoms | Business rules and decision criteria |
| Approval Inbox | Human review/approval queue |
| Wallet signature | Final authorized action |

The strong claim is: Agentic is a working skeleton for AI decision support where the model researches and explains, deterministic logic gates the output, and humans retain final authority.

