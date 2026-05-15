# Agentic App Feature Analysis

Last updated: 2026-05-13

## Quick Rundown

Agentic is a Solana wallet approval workspace for AI agents. The simple pitch is:

> Agents prepare. Your wallet signs.

The app lets a user connect an existing Solana wallet, create or receive agent-prepared plans, check the details, approve or deny the request, and keep receipts or signed proofs. The agent can draft, explain, quote, queue, and prepare work, but it does not get the user's private key and it does not become an unlimited signer.

The main `/app` workspace is the product hub. It includes:

- `Home`: shows the trust boundary, wallet state, workflow state, and next step.
- `New Request`: creates one-time plans from templates or BYOK AI.
- `Repeat Payments`: creates recurring payment or recurring swap/DCA schedules, where each due run still returns to review.
- `Needs Approval`: the approval inbox for one-time and recurring prepared actions.
- `Done`: completed approvals, denials, receipts, finalization records, and history.
- `Save Proof`: wallet-signed evidence receipts, including intent, policy, risk review, rejection, and tool trace proofs.

The app also has setup surfaces for AI, cloud storage, private local mode, protocol connectors, safety rules, custom tokens, CLI, desktop, Android, iOS, MCP, Vercel AI SDK, and Solana Agent Kit integrations.

## Status Legend

- `Shipped`: implemented in the repo and part of the current product surface.
- `Partial`: implemented for some paths, but limited by config, runtime mode, release state, or connector coverage.
- `Planned`: documented or scaffolded, but not a complete first-class runtime capability.
- `Needs verification`: code or docs exist, but the release gate or real external smoke still needs to be repeated.

## Product Position

Agentic is not just a chat app and not just a wallet demo. It is a signing boundary and workflow layer for Solana agents.

The core product claim:

- The user keeps using their existing wallet.
- The agent never receives the user's seed phrase or private key.
- The app can queue and review plans before any wallet popup.
- Every real signing or send action still requires explicit wallet approval.
- Receipts and proofs create an audit trail for what was requested, reviewed, approved, denied, or archived.

The strongest wedge is Solana-native existing-wallet approval for agents, across web wallets, local MCP clients, CLI, desktop, Android MWA, iOS wallet paths, and developer SDK adapters.

## Main App Features

| Feature area | Status | What it does |
| --- | --- | --- |
| `/app` command hub | Shipped | Main approval workspace with Home, New Request, Repeat Payments, Needs Approval, Done, and Save Proof. |
| Wallet connection | Shipped | Connects user-controlled Solana wallets through Wallet Standard in the browser. |
| Local bridge connection | Shipped | Connects MCP, CLI, desktop, and browser wallet host through localhost for private local approvals. |
| Agentic Cloud workflow | Partial | Signed-in cloud path stores unsigned plans, approvals, recurring schedules, completed records, evidence receipts, and audit events. Production live endpoint still needs release verification based on current repo notes. |
| Browser workflow | Shipped | Signed-out fallback where drafts, approvals, recurring fallback data, receipts, and preferences stay in the browser. |
| Private local mode | Shipped | Optional mode where workflow storage routes through the local CLI or desktop bridge. |
| Connect AI | Shipped | Lets users choose keyless templates, Hosted BYOK, Local Bridge AI, or Browser Session AI. |
| Keyless templates | Shipped | Common Solana plan templates work without an AI key. |
| BYOK AI planning | Shipped | Supports OpenAI, Claude/Anthropic, Gemini, OpenRouter, and OpenAI-compatible gateways depending on mode. AI drafts only. |
| One-time plans | Shipped | Create, review, save, queue, archive, and complete plan drafts. |
| Agent review decisions | Shipped | Agent review can return approve, deny, or needs input before a request is sent to approval. |
| Approval Inbox | Shipped | Queue of prepared actions waiting for approve, deny, cancel, execution, or archive. |
| Done tab | Shipped | Shows completed work, terminal decisions, receipts, and completed records. |
| Recurring payments | Shipped | Manual-approval schedules where each due occurrence becomes a Needs Approval item. |
| Recurring swaps/DCA | Partial | Browser and local workflow support recurring swap setup. Cloud recurring execution is more limited and currently favors SOL payment flows. |
| Proof receipts | Shipped | Wallet-signed receipts for intent, policy, risk review, rejection, and tool trace records. |
| Advanced evidence labs | Shipped as experimental | Includes concepts like flight recorder, intent auctions, risk co-signers, semantic firewall, non-action proof, reputation, reviewed links, time capsules, sub-agent delegation, outcome signatures, request insurance, personal constitution, and apprenticeship mode. |
| Workspace backup | Shipped | Browser workspace export and restore for local state. |
| System health | Partial | Dev and runtime health checks cover RPC, Jupiter, wallet, cluster, AI, bridge status, and debug snapshots. Some checks depend on runtime mode. |

## Plan And Action Types

The planner supports both templates and AI-generated drafts. Current template coverage includes:

| Category | Status | Examples |
| --- | --- | --- |
| Payments | Shipped | Send SOL, send SPL token. |
| Trading | Shipped | Swap tokens, limit-order review, portfolio rebalance review. |
| Recurring | Shipped | DCA review proof, vendor or recurring payment setup. |
| Portfolio | Shipped | Balance summary, NFT holdings review. |
| Staking | Proof-oriented | Stake SOL review, unstake/deactivate review. |
| Governance | Proof-oriented | Proposal summary and vote review proof. |
| Security | Shipped | Transaction simulation review, authority audit, token risk check. |
| DeFi | Partial | Lending/borrow review, liquidity position review, protocol position checks, Kamino deposit/withdraw, Kamino earnings proof, Blink action review. |
| NFT | Proof-oriented | NFT transfer review, marketplace listing review. |
| Developer | Shipped | Devnet smoke test, custom transaction review. |
| Mobile | Shipped as planning path | Android MWA or Seed Vault signing path planning. |
| dApp interaction | Shipped as review path | Third-party dApp request review before signing. |
| Bridge | Shipped as review path | Bridge or cross-chain link review while keeping signing in the wallet flow. |
| Receipts | Shipped | Receipt and tax note records. |
| Custom | Shipped | Plain-English request to visible review plan. |

Important boundary: proof-oriented templates can create review plans or signed evidence, but they do not imply the app has a complete first-class transaction executor for every protocol or strategy.

## Approval And Execution Flow

The core loop is:

1. User connects a wallet.
2. User or agent creates a plan.
3. Plan is reviewed for route, amount, recipient, policy, risk, and required fields.
4. If executable, the plan is sent to `Needs Approval`.
5. User approves, denies, cancels, or archives.
6. If a transaction is required, the wallet signs the actual transaction.
7. Agentic records a receipt, proof, or finalization state.

Supported approval behavior:

- One-time approvals can be queued through Agentic Cloud, browser workflow, or private local mode depending on action type.
- Recurring approvals never silently auto-sign. Each due run becomes an approval item.
- Denials can produce rejection receipts.
- Cloud approve and deny decisions require wallet-verifiable decision proofs.
- Cloud evidence receipts are verified against the signed-in wallet before being stored as verified.
- Private local mode keeps receipts and approvals off Agentic Cloud.

## Wallet And Runtime Support

| Surface | Status | Role |
| --- | --- | --- |
| Browser Wallet Standard | Shipped | Works with installed Solana browser wallets that expose Wallet Standard features. |
| Phantom, Solflare, Backpack, and other tested wallets | Shipped / user-verified | Wallet Standard path supports the tested wallet set. Keep wallet smokes as release regression checks, not open product gaps. |
| Android Mobile Wallet Adapter | Shipped path | Android mobile web registration helpers and Android app surface. |
| iOS wallet links | Experimental | Phantom, Solflare, Backpack encrypted links, plus Jupiter Mobile WalletConnect/Reown path. |
| Local bridge | Shipped | Localhost approval bridge for MCP clients, CLI, desktop, and browser wallet host. |
| MCP stdio and HTTP server | Shipped | Exposes wallet tools and product-level action tools to clients such as Codex, Claude Code, and Claude Desktop. |
| CLI | Shipped | Terminal app for bridge lifecycle, wallet host launch, approval inbox, schedules, plans, receipts, transfers, swaps, and health. |
| Desktop app | Shipped as Tauri shell | Starts and monitors local bridge and wallet host, shows health, inbox, receipts, and logs. |
| Android app | Shipped / RC-gated | Bundled native shell with Android native MWA signing; release/trust setup still depends on signing config and asset links when hosted web/TWA fallback is enabled. |
| iOS Capacitor/native paths | Partial | iOS app and bridge packages exist, but iOS wallet-link paths remain experimental. |

## MCP And Developer Features

Base MCP wallet tools:

- `solana_get_address`
- `solana_connect_wallet`
- `solana_sign_message`
- `solana_sign_transaction`
- `solana_sign_and_send_transaction`
- `solana_simulate_transaction`
- `solana_check_approval`

Bridge/product tools include:

- Wallet status, health, balances, and portfolio summary.
- Connector capability and fact reads.
- Prepare SOL transfer, SPL transfer, swap, Blink action, Kamino deposit, and Kamino withdraw.
- Execute, reject, archive, and list prepared actions.
- Create, list, pause, resume, and delete recurring payments.
- Export receipts.
- Direct capped SOL transfer, SPL transfer, Jupiter quote, Jupiter order preview, and Jupiter swap.

Developer packages and adapters:

- `@solana-agent-wallet-adapter/core`: shared wallet protocol and signing client.
- `@solana-agent-wallet-adapter/mcp-server`: stdio, HTTP, bridge, mock backend, action service, connectors.
- `@solana-agent-wallet-adapter/wallet-standard-web`: browser wallet backend.
- `@solana-agent-wallet-adapter/mwa-mobile-web`: Android mobile web wallet registration.
- `@solana-agent-wallet-adapter/ios-link`: iOS wallet-link and Jupiter WalletConnect/Reown path.
- `@solana-agent-wallet-adapter/vercel-ai`: Vercel AI SDK tools.
- `@solana-agent-wallet-adapter/solana-agent-kit`: Solana Agent Kit wallet adapter.
- `@solana-agent-wallet-adapter/cli`: local terminal runtime.

## Protocol And dApp Connectors

Agentic has a connector catalog so agents know what each protocol can read, prepare, or refuse.

| Connector | Status | Current capability |
| --- | --- | --- |
| Kamino | Partial, strongest first-class connector | Positions, reserve snapshots, earnings proof, prepared deposit, prepared withdraw. Requires runtime adapter/config availability. |
| Jupiter | Shipped for swaps | Swap quote/order preview, prepared swap, direct wallet swap, and approval-time quote refresh. Requires a configured Jupiter API key for live quote and execution paths. |
| Meteora | First-class DLMM connector | Pool snapshots, wallet positions, position detail, fee/reward claims, add/remove liquidity, and close empty position through prepared wallet approval items. |
| Raydium | Planned/Blink-backed | AMM, CLMM, farm, and Stake RAY actions through Blink planned. |
| Orca | Planned/Blink-backed | Whirlpool liquidity and fee actions through Blink planned. |
| MarginFi | Planned/Blink-backed | Lending deposit, withdraw, borrow, repay through Blink planned. |
| Drift | Planned/Blink-backed | Strategy vault deposit and withdraw through Blink planned. Does not cover perp orders. |
| Lulo | Planned/Blink-backed | Deposit, withdraw, and rewards paths through Blink planned. |
| Save | Planned/Blink-backed | Deposit, withdraw, and rewards paths through Blink planned. |

Connector rule: reads can inform a plan, but they do not authorize movement of funds. Writes prepare approval-bound actions only. The wallet still signs separately.

## Safety And Controls

Current safety features include:

- No private key in the agent process.
- Wallet remains the signing boundary.
- Mainnet actions are gated by local config.
- Default config keeps mainnet disabled until explicitly enabled.
- Caps for SOL transfers, swap input, slippage, arbitrary transactions, and allowlisted SPL transfers.
- Direct SOL/SPL balance preflight before wallet approval.
- Prepared actions cannot be executed from invalid terminal states such as already approved, rejected, blocked, scheduled, or pending.
- Duplicate wallet prompts are reduced by claiming pending bridge requests once.
- Secret redaction for AI provider keys, bearer tokens, OpenAI-style keys, JWT-like strings, and token/secret fields.
- Browser, cloud, and local workflow storage are separated.
- Cloud workflow validation rejects private keys, seed phrases, delegated signers, and unlimited approval authority payloads.
- Recurring schedules have pause, resume, delete, expiry, spend estimates, history, and notification/webhook fields.

## Proofs And Receipts

Public receipt types:

| Receipt | Status | Use |
| --- | --- | --- |
| Intent | Shipped | Sign the requested action and constraints before approval. |
| Approval Decision / Policy | Shipped | Sign that a wallet rule or personal policy was checked. |
| Risk Review | Shipped | Sign the risks reviewed before a wallet decision. |
| Rejection | Shipped | Sign why a request was refused. |
| Tool Trace | Shipped | Sign which tools, data, or checks an agent used before wallet approval. |

Why this matters competitively:

- It turns approvals and denials into portable audit records.
- It helps explain why an agent request was accepted or blocked.
- It gives future product ideas a common evidence layer.
- It supports demos, support, policy review, accounting notes, and agent evaluation.

## Storage Modes

| Mode | Status | Best for |
| --- | --- | --- |
| Agentic Cloud | Partial | Signed-in users who want plans, approvals, completed records, recurring schedules, and proofs synced without localhost. |
| Browser workflow | Shipped | Users who want a no-login, no-localhost fallback on the current device. |
| Private local mode | Shipped | CLI/desktop/MCP users who want workflow storage and approvals to stay on their machine. |

Agentic Cloud sign-in uses a wallet-signed login message to prove ownership. It does not grant spending authority.

## What Is Already Strong

- Clear product wedge: AI can prepare, but the existing wallet signs.
- Broad Solana wallet intent: browser wallets, Android MWA, iOS links, Jupiter WalletConnect/Reown, mock backends.
- Multiple runtime surfaces: web app, MCP, CLI, desktop, Android, iOS, Vercel AI SDK, Solana Agent Kit.
- Approval Inbox gives the product a real workflow, not just a raw signing API.
- Recurring workflows are designed safely: future runs still return to approval.
- BYOK planner is flexible and does not require AI for basic templates.
- Proofs and receipts create a differentiated audit layer.
- There is confirmed mainnet transfer proof in repo docs.
- The codebase has tests across core, MCP, browser demo, workflow, render web, and related services.

## Current Gaps And Follow-Ups

Highest priority verification:

- Re-run production live smoke after deployment so `/api/session`, `/api/auth/nonce`, `/api/plans`, and cloud workflow APIs return JSON on `https://agentic-signer.com`.
- Smoke CLI end-to-end against a running bridge: `doctor`, balances, prepare, inbox approve, receipts.
- Smoke SPL transfer with tiny configured amounts if not already captured in the latest release notes.
- Smoke Vercel AI SDK and Solana Agent Kit end-to-end.
- Verify desktop release packaging and advertised download assets.
- Verify Android release assets, asset links, and Play listing assets.

Already user-tested and no longer treated as open gaps:

- Wallet coverage across the tested wallet set, including Phantom-class browser wallet flows.
- Jupiter quote/swap flow, assuming the required Jupiter API key and RPC config are present.

Product gaps or strategic opportunities:

- Convert more planned connectors into first-class adapters.
- Add a clearer in-app feature/status matrix for users and judges.
- Build better batch approval and team payout flows.
- Make recurring notifications/webhooks easier to configure and explain.
- Expand mobile-first approval flows, especially Android MWA and iOS wallet-specific paths.
- Add stronger public demo data for proofs, denials, recurring, and connector actions.
- Add a simple competitive comparison page inside docs or the app.

## Competitive Snapshot

This section is a practical positioning summary, not a full market report.

| Product | What they appear to own | Agentic comparison |
| --- | --- | --- |
| pay.sh | Agent-to-API payments with Solana payment rails and a catalog of pay-per-use APIs. | More partner than direct competitor. Agentic is generic wallet approval for Solana actions, not primarily API metering. |
| y0.exchange | Closest direct category competitor: AI proposes, user signs, existing wallets, MCP, swaps, bridges, portfolio, multi-chain. | Agentic should emphasize Solana-native wallet transports, Wallet Standard, Android MWA, iOS wallet paths, local bridge, developer adapters, recurring approvals, and proof receipts. |
| Trust Wallet Agent Kit | Strong wallet distribution, CLI/MCP, 25+ chains, agent wallet mode, WalletConnect mode, DCA, limit orders, risk scoring, on/off-ramp direction. | Strong competitor. Agentic differs by being open Solana approval infrastructure across many Solana wallets rather than Trust Wallet-centered infrastructure. |
| Phantom MCP | Strong brand, MCP-native wallet, swaps, transfers, perps, multichain tools. Current docs describe dedicated agent wallets rather than the user's existing personal Phantom account. | Agentic should keep pushing "use your existing wallet, no new funded agent wallet, no Phantom-only lock-in." |
| VaultPilot | Hardware-wallet first approval for AI agents, strong Ledger safety story. | Agentic is broader consumer-wallet and Solana-app infrastructure. VaultPilot is strongest for Ledger/security-first DeFi. |
| deBridge MCP | Cross-chain swaps and bridge flows for agents, with generated links or intent execution around deBridge. | Agentic is a generic Solana approval layer. deBridge is protocol-specific and can be an integration or connector target. |

Useful external references checked for this snapshot:

- pay.sh: https://pay.sh/
- y0.exchange: https://y0.exchange/
- Trust Wallet Agent Kit: https://trustwallet.com/blog/announcements/introducing-the-trust-wallet-agent-kit-twak-your-ai-agent-can-now-act-on-crypto
- Phantom MCP: https://docs.phantom.com/phantom-mcp-server
- VaultPilot: https://vaultpilot-mcp.ai/
- deBridge MCP: https://docs.debridge.com/dln-details/mcp/mcp-server

## Simple Talk Track

Use this when explaining the app quickly:

Agentic is the approval layer between AI agents and Solana wallets. An agent can draft a transfer, swap, dApp action, recurring payment, or review proof, but it cannot take custody or sign alone. The user connects their wallet, checks the request in `/app`, approves or denies it in `Needs Approval`, and the wallet signs only the exact action the user accepts. The app keeps plans, receipts, denials, recurring schedules, and signed proofs so users can audit what happened and compare future requests.

The app matters because most agent-wallet products either give the agent a new wallet, rely on private keys, focus on one wallet vendor, or handle one protocol flow. Agentic is trying to be the Solana-native adapter layer for existing wallets: browser wallet, local MCP, CLI, desktop, Android, iOS, Vercel AI, and Solana Agent Kit all point back to the same approval boundary.

## Source Files Reviewed

Local repo sources used for this analysis:

- `README.md`
- `PROGRESS.md`
- `STATUS.md`
- `apps/browser-demo/README.md`
- `apps/browser-demo/src/main.ts`
- `apps/browser-demo/src/planner.ts`
- `apps/browser-demo/src/connectedDapps.ts`
- `apps/browser-demo/src/protocolActions.ts`
- `apps/render-web/README.md`
- `packages/mcp-server/README.md`
- `packages/mcp-server/src/actionTools.ts`
- `packages/mcp-server/src/actionService.ts`
- `packages/mcp-server/src/connectorRegistry.ts`
- `packages/cli/README.md`
- `apps/desktop-shell/README.md`
- `docs/ai-byok.md`
- `docs/connectors/README.md`
- `spec/connectors/README.md`
- `spec/protocol.md`
- `packages/workflow/README.md`
