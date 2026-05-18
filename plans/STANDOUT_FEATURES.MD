# Standout Features

Research date: 2026-05-07

## Short Thesis

This project is not the only Solana agent-wallet or agent-payment story anymore. `pay.sh` validates the agent-to-API payment lane. `y0.exchange`, Trust Wallet Agent Kit, deBridge MCP, and VaultPilot validate parts of the "AI proposes, user signs" lane.

The defensible standout claim is narrower and stronger:

`solana-agent-wallet-adapter` is a Solana-native real-wallet adapter layer for AI agents. It routes MCP and framework signing requests through the user's existing installed Solana wallet, with no env-var private key, no agent-owned embedded wallet requirement, and no single-wallet lock-in. The unique combination found in this scan is:

- existing user wallet signs
- Solana Wallet Standard for browser wallets
- Android Mobile Wallet Adapter path
- iOS wallet-link compatibility path
- one shared `WalletBackend` protocol
- MCP, Vercel AI SDK, Solana Agent Kit, CLI, and bridge surfaces on top of that same protocol
- local approval inbox, caps, receipts, and confirmed mainnet transfer proof

I did not find another public project shipping that exact combination.

## What This Repo Ships

Local source of truth:

- [README.md](./README.md)
- [PROGRESS.md](./PROGRESS.md)
- [STATUS.md](./STATUS.md)
- [spec/protocol.md](./spec/protocol.md)

Current local state as documented in the repo:

- The agent never receives the user's private key.
- Browser wallets are live through Wallet Standard.
- The local bridge can request real wallet approvals.
- The MCP server exposes signing, sending, status, balance, and approval polling tools.
- The repo has packages for `core`, `mcp-server`, `wallet-standard-web`, `mwa-mobile-web`, `ios-link`, `vercel-ai`, `solana-agent-kit`, and `cli`.
- The project has confirmed mainnet SOL transfers where the agent requested the action, the user approved in an existing browser wallet, and the agent received the confirmed transaction id.

## The Core Difference

Most Solana agent-wallet projects pick one of four models:

1. **Read-only Solana MCP.** The agent can query Solana, but cannot sign.
2. **Private-key or server-wallet MCP.** The agent/server signs with an env-var key, local key file, API wallet, embedded wallet, or KMS wallet.
3. **Agent-owned PDA/delegate wallet.** The user funds an agent wallet or vault, sets rules, and the agent acts autonomously within those rules.
4. **Protocol-specific handoff.** The agent builds a bridge/swap/payment link, and the user signs inside that product's flow.

This repo is different because it is an adapter for the user's existing Solana wallet. It lets an agent ask for signatures, but the wallet the user already trusts remains the signing boundary.

That is the product wedge:

> "Let AI agents use Solana without giving them a wallet."

## Closest Competitors

### 1. pay.sh

Sources:

- https://pay.sh/
- https://solana.com/uk/news/solana-foundation-launches-pay-sh-in-collaboration-with-google-cloud
- https://github.com/solana-foundation/pay
- https://github.com/solana-foundation/pay-skills

Pay.sh is the highest-attention adjacent project right now because it launched with Solana Foundation and Google Cloud as an agent-commerce layer. Its public story is: agents discover APIs, inspect pricing, make HTTP calls, pay per request with Solana stablecoins, and avoid normal account, API key, and subscription setup. The product includes a CLI, MCP server, HTTP 402 handling, x402 and MPP support, a gateway for providers, debugging tools, and an open `pay-skills` provider registry.

Why it is close:

- Solana stablecoin payments for AI agents.
- MCP and CLI surfaces.
- Local wallet authorization for payment proofs.
- Open source repo and provider catalog.
- Strong launch distribution through Solana Foundation and Google Cloud.

How this repo differs:

- Pay.sh is about paid API access. This repo is about generic Solana wallet authority for agents.
- Pay.sh wraps HTTP calls and retries payment challenges. This repo exposes wallet signing, sending, balances, swaps, prepared actions, receipts, and framework wallet adapters.
- Pay.sh's catalog is its distribution advantage. This repo's advantage is the reusable `WalletBackend` approval boundary across Wallet Standard, Android MWA, iOS links, MCP, Vercel AI, Solana Agent Kit, CLI, bridge, and desktop surfaces.
- Pay.sh should be treated as a future integration target for agent API payments, not as a product to clone.

Verdict: Pay.sh can own the "agents pay for APIs" narrative. This repo should own "agents use the user's existing Solana wallet" and later integrate x402 or MPP only if it strengthens that signing boundary.

### 2. y0.exchange

Source: https://y0.exchange/

y0 is the closest public competitor found in this scan. Its page says "AI proposes. You sign," supports MCP-compatible agents, connects to existing wallets including Phantom, supports WalletConnect, and lists Solana among 15 supported chains. It also describes a hub where pending transactions appear for review and approval, and states that private keys and transaction signing stay in the user's wallet.

Why it is close:

- Non-custodial.
- User approves transactions.
- MCP-native.
- Wallet-agnostic through WalletConnect.
- Supports Phantom and Solana.
- Has web/mobile hub and hosted connector flow.

How this repo differs:

- y0 is a broad multi-chain AI-to-crypto app/service with a hub, API key, and WalletConnect signing path.
- This repo is a Solana adapter/protocol package set that plugs into agent frameworks and Solana wallet standards directly.
- I did not find y0 docs showing a Solana Wallet Standard backend, Android MWA backend, iOS Solana wallet-specific link backend, or Solana Agent Kit `BaseWallet` adapter.
- y0 competes most on product UX and distribution. This repo stands out on Solana-native wallet transport coverage and developer composability.

Verdict: Treat y0 as the closest direct market threat. Do not claim the "AI proposes, you sign" lane is empty.

### 3. Trust Wallet Agent Kit

Source: https://trustwallet.com/uk/blog/announcements/introducing-the-trust-wallet-agent-kit-twak-your-ai-agent-can-now-act-on-crypto

Trust Wallet Agent Kit is another very close competitor. Trust describes two modes: agent wallet mode, where the agent operates within preconfigured rules, and WalletConnect mode, where an AI agent connects to a user's existing Trust Wallet and the user reviews and approves each transaction. The launch post lists Solana among 25+ supported chains and says TWAK supports CLI and MCP.

Why it is close:

- Existing-wallet approval mode.
- MCP and CLI.
- Solana support.
- Strong wallet distribution.

How this repo differs:

- TWAK is Trust Wallet-centered.
- This repo is designed for Solana wallet pluralism: Phantom, Solflare, Backpack, Seed Vault Wallet, and any compatible Wallet Standard or MWA wallet path.
- TWAK is a wallet-vendor infrastructure strategy. This repo is an open adapter layer that can sit under MCP, Vercel AI, Solana Agent Kit, CLI, and other frameworks.

Verdict: Strong competitor for user-approved wallet actions, but vendor-scoped rather than Solana-wallet-standard scoped.

### 4. VaultPilot

Source: https://vaultpilot-mcp.ai/

VaultPilot is a security-first MCP product where the agent prepares transactions and the user approves on Ledger. It supports Solana via Ledger USB HID and emphasizes hardware-screen verification, payload fingerprints, independent decoding, and strict compromise modeling.

Why it is close:

- Agent proposes, user approves.
- No private key exposure to the agent.
- Solana support.
- Strong security story.

How this repo differs:

- VaultPilot is hardware-wallet first. This repo targets the wallets Solana users already use daily: browser wallets, mobile wallets, Android MWA wallets, and iOS wallet-link flows.
- VaultPilot is an MCP product with a Ledger trust boundary. This repo is a reusable wallet backend protocol and framework adapter set.
- VaultPilot is stronger for high-value hardware-wallet DeFi. This repo is stronger for broad Solana wallet compatibility and agent-framework integration.

Verdict: Best security-positioned adjacent competitor, not the same consumer-wallet adapter wedge.

### 5. Phantom MCP Server

Source: https://docs.phantom.com/phantom-mcp-server

Phantom's MCP server gives agents wallet, swap, transfer, message-signing, Solana transaction, EVM, BTC, Sui, and perp tools. The docs say agents receive a new dedicated wallet on authentication and must fund that wallet before transacting. The docs also describe KMS-backed signing for agent wallets.

Why it is close:

- Biggest Solana wallet brand.
- MCP-native.
- Strong action surface.
- Multichain support.

How this repo differs:

- Phantom MCP currently gives the agent a dedicated Phantom agent wallet, not the user's existing personal Phantom account.
- Phantom is Phantom-only by design.
- This repo routes signing to the user's installed wallet and is intentionally multi-wallet.

Verdict: Phantom owns brand mindshare, but this repo owns the "use my existing Solana wallet, not a new agent wallet" wedge.

### 6. SeekerClaw

Source: https://seekerclaw.xyz/

SeekerClaw turns Android or Solana Seeker phones into 24/7 AI agents with Telegram/Discord, device control, memory, scheduling, web research, and Solana wallet actions secured by Seed Vault. Its page lists Solana wallet integration, Jupiter swaps, DCA, limit orders, and NFT tracking.

Why it is close:

- Solana-first AI agent.
- Mobile-native.
- Wallet actions.
- Seed Vault security.
- Strong Solana Mobile story.

How this repo differs:

- SeekerClaw is an agent application that runs on a phone.
- This repo is a wallet-signing adapter for many agent hosts.
- SeekerClaw's public positioning is Seed Vault and device-control centered. This repo is Wallet Standard, MWA, iOS link, MCP, and framework adapter centered.

Verdict: Closest mobile-native Solana agent project, but not a general-purpose installed-wallet adapter for external AI agents.

### 7. deBridge MCP

Source: https://docs.debridge.com/dln-details/mcp/mcp-server

deBridge MCP lets agents get quotes and generate deBridge app links for cross-chain and same-chain swaps. Its docs say the MCP server never touches private keys or signs transactions, and that the user opens a generated link, connects a wallet, reviews, and signs.

Why it is close:

- Non-custodial.
- User-sign handoff.
- Solana included.
- MCP-native.

How this repo differs:

- deBridge MCP is scoped to deBridge swaps and bridges.
- It generates a product link rather than exposing a reusable Solana wallet-signing backend.
- This repo handles generic Solana signing requests and framework wallet interfaces.

Verdict: Good validation for URL handoff security, but not a general wallet adapter.

### 8. Solana Agent Kit and SendAI Solana MCP

Sources:

- https://docs.sendai.fun/docs/v2/introduction
- https://github.com/sendaifun/solana-mcp

Solana Agent Kit v2 is the dominant Solana action framework. The docs emphasize embedded wallet support, Privy, Turnkey, React Native, plugin architecture, and optional human-in-the-loop confirmation. SendAI's Solana MCP server, however, still documents `SOLANA_PRIVATE_KEY` configuration for wallet operations.

Why it is close:

- Dominant Solana agent action ecosystem.
- Lots of useful Solana actions.
- MCP server exists.
- Wallet abstraction exists.

How this repo differs:

- This repo is not trying to replace Solana Agent Kit. It plugs into its wallet layer.
- The `@solana-agent-wallet-adapter/solana-agent-kit` package lets existing SAK actions route through the user's wallet approval flow.
- SendAI's public MCP setup is private-key based, while this repo's core premise is no private key handoff.

Verdict: More partner than competitor. The strongest integration story is "keep SAK actions, replace the signer."

### 9. AgentWallet Protocol and hifriendbot AgentWallet MCP

Sources:

- https://agentwallet.fun/
- https://pypi.org/project/agentwallet-mcp/
- https://mcpservers.org/servers/hifriendbot/agentwallet-mcp

AgentWallet Protocol focuses on agent-owned wallets, PDA wallets, on-chain spending limits, escrow, analytics, compliance, and MCP tools. hifriendbot's AgentWallet MCP exposes wallet creation, transfers, signing, x402 payments, guards, and API-key-based wallet infrastructure across EVM and Solana.

Why it is close:

- Solana agent wallets.
- MCP tools.
- Spending limits and guardrails.
- Agent commerce and x402 payments.

How this repo differs:

- AgentWallet models give agents their own wallet, PDA, server wallet, or wallet-as-a-service object.
- This repo keeps the user's existing wallet as the signer and does not require moving funds to an agent wallet first.
- AgentWallet is better for autonomous agents that need bounded spending without per-transaction approvals. This repo is better for users who want every real action to surface in their wallet.

Verdict: Adjacent but different trust model.

### 10. Fuin, HumanRail Agent Vault, and Metaplex Agent Registry

Sources:

- https://www.fuinlabs.xyz/docs
- https://www.humanrail.org/
- https://www.metaplex.com/docs/agents/what-is-an-agent
- https://www.metaplex.com/docs/agents/run-an-agent

These projects are important because they show where the Solana ecosystem is moving: on-chain agent identity, PDA wallets, vaults, delegation, spending limits, receipts, and revocation. Fuin has users create a vault, fund it, issue a delegate key, and configure an MCP server with the delegate private key. HumanRail Agent Vault focuses on registered agents, bounded capabilities, emergency freeze, and on-chain receipts. Metaplex Agent Registry defines autonomous agents as MPL Core assets with PDA-derived wallets and delegated execution.

Why they are close:

- Solana-native.
- Agent identity or agent wallet primitives.
- Delegation and guardrails.
- Stronger autonomous-agent story than a wallet popup flow.

How this repo differs:

- These systems are agent-wallet or delegated-execution systems.
- This repo is a user-wallet approval system.
- They reduce per-action friction by granting bounded authority. This repo preserves per-action user approval in the wallet.

Verdict: Important adjacent infrastructure. They may become integration targets rather than direct enemies.

### 11. Coinbase AgentKit, Crossmint GOAT, Crossmint Wallets, and MoonPay OWS

Sources:

- https://docs.cdp.coinbase.com/agent-kit
- https://docs.cdp.coinbase.com/agent-kit/core-concepts/wallet-management
- https://www.crossmint.com/announcement/introducing-goat-great-onchain-agent-toolkit
- https://docs.crossmint.com/sdk-reference/wallets/overview
- https://docs.openwallet.sh/

These are larger agent-wallet or action-tooling layers. Coinbase AgentKit supports Solana and multiple wallet providers, with CDP wallets as a recommended/default path. GOAT is a broad open onchain action toolkit across many chains, frameworks, and wallet architectures. Crossmint Wallets lets developers create and manage wallets on Solana and EVM chains. MoonPay's Open Wallet Standard defines local wallet storage, delegated agent access, and policy-gated signing.

Why they are close:

- Developer infrastructure for onchain agents.
- Wallet abstractions.
- Solana support in some cases.
- Framework compatibility.

How this repo differs:

- This repo is narrower and sharper: Solana existing-wallet signing for agents.
- It does not try to be the action catalog, wallet provider, embedded wallet vendor, or cross-chain app layer.
- It can complement action frameworks by replacing their signing backend.

Verdict: Compete for developer mindshare, but not exact same signing boundary.

### 12. Read-Only Solana MCP Servers

Sources:

- https://github.com/solana-foundation/solana-dev-mcp
- https://github.com/solana-foundation/solana-mcp-official
- https://opensvm.github.io/solana-mcp-server/
- https://github.com/openSVM/solana-mcp-server

These servers are useful for Solana data, docs, RPC queries, and developer workflows. openSVM documents broad RPC coverage. Solana Foundation's developer MCPs focus on docs, development context, and simple RPC methods.

Why they are close:

- Solana MCP category.
- Useful to AI agents.

How this repo differs:

- Read-only MCP servers do not solve signing.
- This repo is specifically about user-approved wallet signing and sending.

Verdict: Complementary, not direct competition.

### 13. Private-Key MCP Servers and Local Wallet-File MCP Servers

Sources:

- https://github.com/sendaifun/solana-mcp
- https://fozagtx.github.io/SolanaAiTerminal/
- https://portalsprotocol.com/docs/mcp-server

Several Solana MCP products require a private key or create/manage a local wallet file. SendAI's Solana MCP documents `SOLANA_PRIVATE_KEY`. SolanaAiTerminal documents `AGENT_SECRET_KEY`. Portals Protocol creates a local Solana wallet at `~/.portals/wallet.json` and warns that it contains the private key.

Why they are close:

- Solana MCP with signing or payments.
- Useful for bots, test wallets, and fully automated flows.

How this repo differs:

- This repo does not ask users to put a private key in MCP config.
- It uses the installed wallet as the signing authority.
- The approval boundary is outside the agent process.

Verdict: The easiest category to differentiate against.

### 14. Additional Adjacent Watchlist

Sources:

- https://docs.aawp.ai/
- https://docs.x84.ai/
- https://docs.solana-agent.com/
- https://chat.mcp.so/zh/server/clawpay-mcp/up2itnow0822?tab=tools

These are less direct, but worth tracking because they compete for the "agent wallet" narrative.

AAWP is an AI-exclusive wallet protocol. Its docs say only the AI agent can be the signer, with a human guardian able to freeze or recover but not sign. It supports Solana alongside EVM chains. This is almost the opposite trust model from this repo: AAWP proves an AI owns the wallet; this repo keeps the human's existing wallet as the signing boundary.

x84 is Solana-native infrastructure for autonomous agents: identity, reputation, delegation, x402 settlement, hosting, A2A, and MCP tools. It is not a wallet-popup adapter, but it may become important ecosystem infrastructure for agent identity and delegated spending.

Solana Agent is a local-first AGI x402 runtime with bundled Solana tools, including Jupiter, Kamino, MCP, Privy, transfer, swap, and x402 helpers. Its public docs list `x402_private_key` and `x402_privy` funded paths. That makes it closer to a runtime/tool layer than an installed-wallet approval adapter.

AgentPay MCP, formerly ClawPay MCP, is a spend-limited x402 payment MCP around an agent wallet model. The current public page is Base-focused and uses an `AGENT_PRIVATE_KEY` hot-wallet signer, so it is not a direct Solana wallet competitor, but it is relevant for x402 and spend-limit positioning.

Verdict: Watch these for narrative and integration opportunities. They do not replace the real-wallet Solana signing adapter.

## Comparison Matrix

| Project | Existing user wallet signs? | Multi Solana wallet? | Solana Wallet Standard / MWA focus? | Generic signing adapter? | Main difference |
| --- | --- | --- | --- | --- | --- |
| `solana-agent-wallet-adapter` | Yes | Yes | Yes | Yes | Solana real-wallet adapter across MCP and frameworks |
| pay.sh | Local pay wallet for API payments | No, not wallet-adapter focused | No | No, payment client/gateway | HTTP 402, x402, MPP, API catalog, and provider gateway |
| y0.exchange | Yes | Via WalletConnect | Not found in public docs | Partial, MCP/service | Broader multi-chain hub and connector |
| Trust Wallet Agent Kit | Yes in WalletConnect mode | No, Trust Wallet centered | No | Partial, TWAK CLI/MCP | Wallet vendor infrastructure |
| VaultPilot | Yes, Ledger | Hardware wallet focused | No | MCP product | Strong hardware verification, narrower wallet coverage |
| Phantom MCP | No, dedicated agent wallet per docs | No, Phantom only | No | MCP product | Brand and action surface, but new agent wallet |
| SeekerClaw | Seed Vault path | Seeker/Android focused | Not as adapter layer | No | Full phone agent, not external agent signer |
| deBridge MCP | User signs in deBridge link | Wallet connected in deBridge app | No | No | Bridge/swap-specific handoff |
| Solana Agent Kit | Depends on backend | Not by default | No | Action framework | Needs a wallet backend like this project |
| AgentWallet Protocol | Agent/PDA wallet | No | No | Agent wallet API/MCP | Autonomous agent wallet, not user popup |
| Fuin | Delegate key signs | No | No | Vault/delegate MCP | User grants bounded authority to delegate |
| Metaplex Agent Registry | Executive delegates | No | No | Protocol primitive | Agent identity and PDA wallet model |
| AAWP | AI agent signer | No | No | Agent wallet protocol | AI-exclusive wallet, not human-wallet approval |
| x84 Protocol | Delegated spending | No | No | Agent infrastructure | Identity, reputation, delegation, and x402 |
| Solana Agent | Private key or Privy path | No | No | Runtime/tool layer | AGI x402 runtime with bundled Solana tools |
| AgentPay MCP | Agent hot-wallet key | No | No | Payment MCP | Base-focused spend-limited x402 wallet |
| Read-only Solana MCPs | No signing | N/A | No | No | Data and docs only |
| Private-key MCPs | No, key in env/file | No | No | No | Custodial or local key-file signing |

## Standout Features To Emphasize

### 1. The user's real wallet remains the signer

The project should keep repeating this because it is the clearest product contrast:

- no env-var private key
- no local wallet JSON as the user's main signer
- no server wallet
- no embedded agent wallet requirement
- no funded PDA vault required before first use

The agent asks. The wallet approves. The key stays in the wallet.

### 2. Solana wallet standards instead of one vendor path

Solana Mobile documents MWA as a generic protocol for Solana transaction and message signing, with Android and Android Chrome support, and no iOS support. Phantom documents Wallet Standard as the foundation for standardized Solana wallet-dapp interaction.

Sources:

- https://docs.solanamobile.com/developers/mobile-wallet-adapter
- https://docs.solanamobile.com/get-started/web/apps
- https://docs.phantom.com/developer-powertools/wallet-standard

This repo maps those Solana wallet standards into an AI-agent signing boundary.

That is different from:

- Phantom-only MCP
- Trust Wallet-only agent kit
- WalletConnect-only hub
- Ledger-only hardware path
- Seed Vault-only mobile product

### 3. One wallet backend protocol across many hosts

The `WalletBackend` contract is the quiet moat. If a backend implements `capabilities`, `getAddress`, `submit`, `poll`, and optional `simulate` or `cancel`, every higher-level integration can share it.

That means the same signing model can sit behind:

- MCP tools
- Vercel AI SDK tools
- Solana Agent Kit `BaseWallet`
- CLI commands
- local browser bridge
- desktop shell
- future LangChain, CrewAI, Pydantic AI, ElizaOS, or React Native hosts

Competitors often ship a product surface. This repo ships a signing boundary that other product surfaces can reuse.

### 4. It turns Solana Agent Kit into a real-wallet toolkit

Solana Agent Kit already owns the action library. This repo does not need to beat that.

The better story:

> "Use Solana Agent Kit's actions, but make the user's installed wallet the signer."

That separates the action layer from the custody layer.

### 5. Mobile is not hand-waved

Many agent-wallet projects say "mobile" because they have a mobile app or WalletConnect flow. This repo has a Solana-specific mobile map:

- Android Chrome mobile web through MWA registration
- Android app path planned through native MWA
- iOS compatibility through wallet-specific links and injected wallet hosts, because MWA is not available on iOS

The docs should be honest that iOS is a separate path, not MWA.

### 6. The approval model aligns with MCP URL Mode Elicitation

MCP URL Mode Elicitation is now a final standards-track pattern for sensitive out-of-band interactions. The MCP spec says URL mode is for sensitive interactions that must not pass through the MCP client, including payments and credential-style flows.

Source: https://modelcontextprotocol.io/seps/1036-url-mode-elicitation-for-secure-out-of-band-intera

This is exactly the right shape for wallet approvals:

- agent requests a signature
- MCP host shows an approval URL or opens a wallet approval surface
- user approves outside the LLM context
- agent receives only the result

### 7. Safety is product-level, not just architecture-level

The repo has product safety controls that make the story stronger than "the wallet popup saves us":

- configured caps for SOL transfers and swaps
- arbitrary transactions disabled by config
- approval inbox
- prepared actions
- receipts
- direct balance preflight
- transaction simulation hook where supported
- explicit protocol errors like `user_rejected`, `wallet_unreachable`, `cluster_mismatch`, `expired`, and `unsupported_method`

These make the adapter usable for real agent workflows, not just demos.

## Best Positioning

Use:

> The Solana real-wallet adapter for AI agents.

Use:

> MCP and AI framework signing through the wallet users already trust.

Use:

> Keep the agent's tools. Replace the signer with the user's wallet.

Use:

> Wallet Standard on web, MWA on Android, wallet links on iOS, one backend protocol everywhere.

Use when comparing against pay.sh:

> Pay.sh helps agents pay APIs. This project helps agents use the Solana wallet users already trust.

Avoid:

- "first AI wallet"
- "first non-custodial MCP"
- "first AI proposes, user signs"
- "only user-approved agent wallet"
- "agentic wallet"

Those claims are now too broad because y0, TWAK, deBridge, VaultPilot, and other agent-wallet projects exist.

## Competitive Risks

### pay.sh can own agent-commerce distribution

Pay.sh has the strongest mainstream launch story in this scan: Solana Foundation, Google Cloud, pay-per-request APIs, HTTP 402, x402, MPP, and a provider catalog agents can search.

Counter-positioning:

- Pay.sh is for API payment access.
- This repo is for Solana wallet signing authority.
- Future x402 or MPP support should reuse this repo's approval boundary rather than turn the project into a provider catalog clone.

### y0 can own the simple user story

y0 has the crispest mainstream line: "AI proposes. You sign." It is multi-chain, productized, and hosted. The project should not pretend y0 is not close.

Counter-positioning:

- y0 is an app/service.
- This repo is a Solana-native adapter layer.
- This repo should win developers who want to embed real-wallet Solana signing into their own agent stack.

### Trust Wallet and Phantom can out-distribute

Trust Wallet and Phantom have massive wallet distribution.

Counter-positioning:

- Their agent products are necessarily vendor-centered.
- This repo is wallet-standard centered.
- Solana builders usually need Phantom, Solflare, Backpack, Seed Vault Wallet, and future wallets, not one vendor.

### PDA/delegate systems are better for autonomy

AgentWallet, Fuin, HumanRail, and Metaplex Agent Registry are better fits when a user wants an agent to keep operating without manual approvals.

Counter-positioning:

- This repo is for high-trust user-mediated actions.
- It can later integrate with PDA or delegation systems for optional bounded autonomy, but it should not lead with that.

### VaultPilot can own high-value security

VaultPilot has the strongest hardware-wallet threat model.

Counter-positioning:

- This repo is for broad Solana wallet reach.
- Hardware verification can be a future backend, not the whole product.

## Final Standout Claim

The market has competition. The strongest honest claim is:

> `solana-agent-wallet-adapter` is the open Solana adapter that lets AI agents request signatures from the user's existing wallet across Solana-native wallet transports, then reuse that same approval boundary from MCP, Vercel AI, Solana Agent Kit, CLI, and future agent frameworks.

That is what makes it different from pay.sh's API payment gateway and catalog, y0's multi-chain approval hub, Phantom's dedicated agent wallet, Trust Wallet's vendor-scoped kit, SeekerClaw's phone agent, VaultPilot's Ledger-first MCP, deBridge's swap-specific links, and PDA/delegate-based agent wallets.
