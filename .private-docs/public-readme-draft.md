# Agentic

Agentic is a Solana wallet approval workspace for AI agents.

The short version:

> Agents prepare. Your wallet signs.

Agentic lets chat agents, MCP clients, local CLIs, desktop apps, mobile shells, and developer SDKs prepare Solana actions without taking custody of the user's private key. The user keeps using the wallet they already trust, reviews the exact action, and signs only when they choose.

The original technical name is `Solana Agent Wallet Adapter`. The public product name is `Agentic`.

## What It Is

Agentic is no longer only a signing adapter. It is an app and protocol layer around human-approved agent actions:

- Chat interface for wallet-aware questions, token research, market data, wallet history, and action preparation.
- Wallet action builders for sends, swaps, proofs, recurring payments, DCA, and connector actions.
- Decision planner that turns human conditions into pass, fail, warn, needs-input, or wallet-required results.
- Deterministic policy pipeline for fact routing, atom extraction, fact resolution, rule evaluation, evidence gates, and post-AI validation.
- Approval Inbox for queued one-time and recurring wallet actions.
- Signed proofs and evidence receipts for intent, review, rejection, policy, MPP, streaming sessions, and settlement artifacts.
- Agentic Cloud for signed-in workflow sync without localhost.
- Browser workflow fallback for no-login use.
- Private local mode for CLI, desktop, MCP, and local bridge flows.
- MCP server, HTTP server, CLI, desktop shell, Android, iOS, Vercel AI SDK adapter, Solana Agent Kit adapter, and Wallet Standard backend.

The core boundary does not change: the AI can explain, research, draft, and recommend. It cannot sign or silently move funds. The wallet user remains the signing authority.

## Architecture

```text
human intent
  |
  v
Chat / MCP / CLI / app surface
  |
  +-- fact-category routing
  +-- connector and market reads
  +-- policy atom extraction
  +-- deterministic rule evaluation
  +-- evidence gate and AI decision validation
  |
  v
prepared action or decision result
  |
  v
Approval Inbox / review card / proof card
  |
  v
user wallet approval
  |
  v
signature, txid, denial, proof, receipt, or audit record
```

Agentic supports three separate layers:

- `WalletBackend`: transport-agnostic signing contract.
- `Workflow`: unsigned plans, approvals, recurring schedules, evidence receipts, audit events, and policy decisions.
- `App`: Chat, wallet actions, connector controls, proofs, positions, skills, sessions, and Agentic Cloud.

## Why It Matters

Most agent wallet systems choose one of these models:

- read-only chain data
- server-side private key
- agent-owned wallet
- embedded wallet
- protocol-specific handoff
- broad multi-chain hub

Agentic is focused on a different model: let agents use the user's existing Solana wallet, but keep every real action human-approved.

That gives builders a useful middle ground. Agents can be productive, but they do not become uncontrolled signers.

## Current App Surface

The `/app` workspace is the main product:

- `Home`: wallet state, storage mode, AI route, cloud status, connector status, and next actions.
- `Chat`: ChatGPT-style wallet assistant with live Solana data tools, research cards, action builders, Decision Planner, pending approval resurfacing, citations, and chat history.
- `New Request`: template and connector action creation for one-time plans, proofs, reads, and queueable actions.
- `Sign Approval`: active approval inbox for one-time, recurring, connector, proof, and chat-originated actions.
- `Done`: completed approvals, denials, finalization records, receipts, and history.
- `More`: Repeat Payments, Save Proof, Address Book, Positions, Agent Payments, Skills, Spending Sessions, and optional dev surfaces.

The public top-level tab layout changes by surface. The workflow model does not.

## Chat

Chat is the app's front door. It can:

- answer general questions
- use wallet context for balances and portfolio summaries
- call Solana token, market, wallet, connector, and transaction tools
- search or resolve token mints when a user names a token
- prepare SOL and SPL transfers
- prepare swaps
- sign proof messages
- stage recurring payments and DCA schedules
- stage connector actions by reusing the same forms as New Request
- run deterministic research cards for token safety, rug scans, wallet X-ray, market regime, trending tokens, smart money, new listings, and top traders
- run the Agent Decision Planner
- surface pending approvals from the current chat

The assistant can prepare a card. It cannot approve the card. The user still reviews and signs in the wallet.

## Decision System

Agentic's strongest technical pattern is the decision pipeline around chat and wallet actions:

1. The user writes messy intent or policy text.
2. The app routes the request into fact categories.
3. The policy layer decomposes rules into verifiable atoms.
4. Resolvers fetch authoritative facts from wallet state, RPC, Helius, BirdEye, CoinGecko, Jupiter, DEX Screener, protocol connectors, current web research, or simulation.
5. The deterministic evaluator checks pass, fail, warn, or unresolved.
6. The evidence gate blocks unsupported approvals before the AI can approve.
7. The AI explains the decision.
8. The post-AI validator can downgrade unsafe approvals to deny or needs-input.
9. Human approval remains separate from the AI recommendation.

This pattern is domain-portable. In another workflow, Solana token facts could become SKU facts, wallet state could become account state, market data could become competitor pricing, and token safety gates could become margin, availability, contract, or compliance gates.

## Quick Start

Install and build:

```bash
git clone git@github.com:mstevens843/solana-agent-wallet-adapter.git
cd solana-agent-wallet-adapter
pnpm install
pnpm build
```

Run the browser app:

```bash
pnpm demo:browser
```

Open `http://127.0.0.1:5174`.

Run the cloud API locally in a second terminal if you need sign-in, cloud workflow, and chat sync:

```bash
pnpm -F @solana-agent-wallet-adapter/browser-demo dev:cloud
pnpm demo:browser
```

Run the local bridge path:

```bash
cp .env.example .env
cp agent-wallet.config.example.json agent-wallet.config.json
pnpm cli -- setup
pnpm mcp:codex:add
pnpm dev
```

Then connect a browser wallet in the app and register the MCP client.

## Storage Modes

- `Agentic Cloud`: signed-in, same-origin API path. Stores unsigned workflow records and verified evidence for the wallet.
- `Browser workflow`: signed-out fallback. Stores local drafts, approvals, receipts, and preferences in the browser.
- `Private local mode`: local bridge/desktop/CLI path. Keeps workflow storage on the user's machine.

Agentic Cloud sign-in proves wallet ownership. It does not grant spending authority.

## AI Routes

Agentic works without an AI key through templates and deterministic app controls.

AI-enabled routes include:

- Hosted BYOK relay
- Local bridge BYOK
- Browser session BYOK
- Browser-native Device Agent
- Android-native Device Agent
- Plan Connector through local subscription CLIs such as Codex, Gemini, or Claude
- Operator-managed hosted AI where configured

AI output is a draft or decision. It is not a wallet signature.

## Wallet Transports

- Browser Wallet Standard
- Android Mobile Wallet Adapter
- Android native app wallet bridge
- iOS wallet links
- Jupiter Mobile WalletConnect/Reown path
- Ledger wallet path
- embedded wallet surfaces
- local bridge backend
- mock backend for tests

## Developer Packages

- `@solana-agent-wallet-adapter/core`
- `@solana-agent-wallet-adapter/workflow`
- `@solana-agent-wallet-adapter/mcp-server`
- `@solana-agent-wallet-adapter/wallet-standard-web`
- `@solana-agent-wallet-adapter/mwa-mobile-web`
- `@solana-agent-wallet-adapter/ios-link`
- `@solana-agent-wallet-adapter/vercel-ai`
- `@solana-agent-wallet-adapter/solana-agent-kit`
- `@solana-agent-wallet-adapter/cli`
- `@solana-agent-wallet-adapter/streaming-sessions`
- `@solana-agent-wallet-adapter/ap2-adapter`
- `@solana-agent-wallet-adapter/acp-adapter`
- `@solana-agent-wallet-adapter/mpp-adapter`
- `@solana-agent-wallet-adapter/a2a-agent-card`
- `@solana-agent-wallet-adapter/skills-runtime`
- `@solana-agent-wallet-adapter/signals-runtime`

## Safety Rules

- The agent process does not receive the private key.
- Wallet approval remains the signing boundary.
- Mainnet is gated by config and caps.
- Transaction simulation and policy review inform the decision, but do not replace wallet approval.
- Recurring Agentic schedules create due approval items; they do not silently auto-sign.
- Jupiter native automation products are called out separately when they involve product-managed automation outside the Agentic approval inbox.
- Cloud workflow validation rejects private keys, seed phrases, delegated signers, and unlimited approval authority.
- Evidence receipts are verified against the wallet before being stored as verified.

## License

Apache-2.0.

Private note: this draft is intentionally more complete than the current public README should be. Run the redaction plan before publishing.

