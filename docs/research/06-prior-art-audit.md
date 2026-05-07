# 06 - Prior-Art Audit (2026-05-03)

> Superseded context, 2026-05-07: this note is preserved as dated research. The current competitive positioning lives in [STANDOUT_FEATURES.MD](../../STANDOUT_FEATURES.MD). A later scan found closer user-approval competitors, especially y0.exchange, Trust Wallet Agent Kit, VaultPilot, and deBridge MCP, so do not reuse the broad empty-wedge claim without the narrower scope in the updated positioning doc.

## Why this exists

Pre-build sanity check before pushing further on Phase 1. Four parallel research agents covered (1) MCP HITL signing servers, (2) AI-framework Solana signers, (3) cross-chain agent-wallet analogs, (4) deep-web obscure (Colosseum, Twitter, npm namespace claims). Source-of-truth: `~/.claude/plans/2-things-i-need-serene-map.md`.

## Headline finding

**Dated finding:** the category was contested, and this scan judged the specific real-wallet wedge as open at the time. Every shipped Solana competitor found in this pass used a **non-user wallet** for signing:

- Phantom MCP: Phantom **embedded** wallet (Google/Apple SSO)
- Solana Agent Kit v2: embedded / Privy / Turnkey
- AgentWallet Protocol, Cloaked: PDA + delegate key
- solana-clawd: local AES-256 vault
- SeekerClaw: Seeker Seed Vault hardware (single device)
- MoonPay OWS: library-managed AES keys + policy

**No one has shipped:** "user's existing Phantom/Solflare/Backpack pops the approval, agent never holds keys, Android via MWA + iOS via separate link transport + web via Wallet Standard." That triple is open.

**Slug `solana-agent-wallet-adapter` is unclaimed on GitHub + npm.** So is `agent-wallet-adapter`, `solana-mcp-signer`, `solana-hitl`, `solana-agent-bridge`.

## Closest prior art (ranked)

| # | Project | Chain | Pattern | Why close / why not |
|---|---|---|---|---|
| 1 | **nikicat/mcp-wallet-signer** | EVM | MCP server opens local browser sign-page, EIP-6963 wallet discovery | **Structural twin - but EVM only.** 5-tool surface nearly identical to ours |
| 2 | **@phantom/mcp-server** (Feb 18, 2026) | Solana + EVM + BTC + Sui | Phantom *embedded* wallet via SSO | Closest Solana competitor; owns "Phantom + Claude" mindshare but uses embedded wallet |
| 3 | **SeekerClaw** (Feb 27, 2026, Solana Mobile-boosted) | Solana | Foreground service on Seeker, Seed Vault hardware sign | Only mobile competitor with official Solana Mobile mindshare. Seeker-only, not generalized MWA |
| 4 | **Trust Wallet Agent Kit (TWAK)** | Multichain incl. Solana | "WalletConnect mode" + autonomous mode | Exact two-mode framing to lift |
| 5 | **deBridge MCP** (Feb 2026) | Solana + 23 EVM | Returns deBridge App link, user signs in own wallet | Non-custodial but bridge-scoped only |
| 6 | **GOAT SDK** (Crossmint) | Multichain | Wallet-agnostic + framework-agnostic | Biggest framework-layer competitor; `@goat-sdk/wallet-solana` keypair-only today, no MWA |
| 7 | **AgentWallet Protocol** (`hifriendbot/agentwallet-mcp`) | EVM + Solana | PDA vault + delegate key, on-chain spending policies | Different model (delegation), not user-popup |
| 8 | **CloakedAgent/cloaked** | Solana | Owner wallet + agent delegate + Anchor limits + Noir ZK | Different model |
| 9 | **x402agent/solana-clawd** | Solana | Air-gapped local AES vault, 31 MCP tools | Different model (local vault) |
| 10 | **ElizaOS plugin-solana** | Solana | `SOLANA_PRIVATE_KEY` env var | Flat custodial. Clear gap to fill |

## Standards / tailwinds

- **MCP SEP-1036 "URL Mode Elicitation"** - landed in MCP 2025-11-25 spec draft. Server returns `mode: "url"`, client opens URL out-of-band for "auth flows, payment processing, sensitive operations." Adopt this instead of inventing a pending-approval resource.
- **ERC-8004 Trustless Agents** (Draft, 100+ contributors incl. Coinbase, MetaMask, ENS) - formally defines `agentWallet` field. Cite in README.
- **ERC-7710/7715** - delegation/permission standards. Different model, same UX promise.
- **MoonPay Open Wallet Standard** (Mar 23, 2026) - Solana Foundation co-signed. Foundation-level direction signal. Different model (library-managed keys with policy); their type shapes for the policy layer are worth lifting.
- **Google Cloud Feb 2026 blog** - explicitly endorses "MCP-as-tx-builder, user-signs-separately" as the recommended secure architecture for blockchain agents. Pitch-deck validation.
- **Vercel AI SDK v6 native `needsApproval: true`** (Feb 2026) - easiest first framework integration; HITL is built in.

## Per-framework integration matrix

| Framework | Solana? | Custodial? | Notes |
|---|---|---|---|
| Solana Agent Kit (sendaifun) | Dominant | Pluggable; default custodial | `BaseWallet` interface matches our shape - **ship as adapter, not replacement** |
| LangChain JS/Py | via SAK + GOAT | Mostly custodial | |
| Vercel AI SDK | via SAK + GOAT | Custodial in examples | **v6 has native `needsApproval`** - easiest demo |
| CrewAI | via SAK | Custodial typical | |
| ElizaOS plugin-solana | Yes | Flat custodial (env var) | **Clear gap** |
| Pydantic AI / Mastra / AutoGen / LlamaIndex / Smolagents / BeeAI | None | n/a | All open |
| OpenAI Assistants | SAK adapter | Custodial | API deprecating Aug 2026 |
| Coinbase AgentKit | `CdpSolanaWalletProvider` | CDP custodial (TEE) | |

## Competitive risk timeline

- **Phantom MCP** (~11 weeks ago) - biggest threat. They can extend `@phantom/mcp-server` to support extension/mobile-app passthrough at any time. **Multi-wallet + MWA is our durable moat** since Phantom won't ship those for Solflare/Backpack.
- **MoonPay OWS** (6 weeks ago, Solana Foundation-backed) - standards-level competitor.
- **SeekerClaw** (9 weeks ago, Solana Mobile-boosted) - owns "agent on mobile" mindshare today, but Seeker-only.
- **Frontier hackathon** closes **2026-05-11** (8 days from this audit). No public submission matches our exact pitch yet (submissions hidden until close).

## Recommended reframing (positioning)

**Drop:** "First MCP server with user-approval signing for Solana." (nikicat owns the EVM concept; Phantom owns Solana + Claude mindshare.)

**Adopt at the time:** "An open, multi-wallet, mobile-native MCP signing bridge that uses the user's *real installed wallet* - built on Solana standards (MCP URL Elicitation + Wallet Standard + MWA + ERC-8004 wallet-shape compatibility), not a vendor embedded wallet."

**Three durable differentiators** (rank-ordered):
1. **Multi-wallet** - Phantom + Solflare + Backpack + Glow (Phantom MCP is Phantom-only by definition)
2. **Mobile-native via MWA** - Android passthrough to user's real installed wallet (no shipped competitor)
3. **MCP URL-mode elicitation** - adopt SEP-1036 as the approval mechanism (protocol-level, future-proof)

## What to NOT do

- **Don't try to beat Phantom on Phantom-embedded UX.** They will always own that surface. Our pitch is multi-wallet + "user's real wallet."
- **Don't fork sendaifun/solana-agent-kit.** Plug into their `BaseWallet` interface as an adapter.
- **Don't claim "agentic wallet."** The term is captured by Cobo / Coinbase / MoonPay for *agent-owned* wallets. Use "agent wallet adapter" - emphasize *adapter*.
- **Don't roll a custom approval-resource format.** SEP-1036 URL elicitation is landing; align with the spec.
- **Don't spend cycles on MoonPay OWS compatibility yet.** Different model; watch, don't integrate.

## How to keep tracking

- Subscribe to `@phantom`, `@solanamobile`, `@solana`, `@sendaifun`, `@anthropic` on X for first-party MCP/wallet announcements
- Watch `github.com/sendaifun/solana-agent-kit` issues and PRs for any "MWA" or "wallet-standard" PR
- Watch `github.com/modelcontextprotocol/modelcontextprotocol/pull/887` for SEP-1036 merge, then adopt immediately
- Re-run a focused prior-art sweep on 2026-05-11 once Frontier submissions become public

## Sources

- nikicat/mcp-wallet-signer: https://github.com/nikicat/mcp-wallet-signer
- @phantom/mcp-server: https://www.npmjs.com/package/@phantom/mcp-server
- SeekerClaw: https://github.com/sepivip/SeekerClaw
- Trust Wallet TWAK: https://trustwallet.com/blog/announcements/introducing-the-trust-wallet-agent-kit-twak-your-ai-agent-can-now-act-on-crypto
- deBridge MCP: https://docs.debridge.com/dln-details/mcp/mcp-server
- AgentWallet Protocol: https://github.com/hifriendbot/agentwallet-mcp
- GOAT SDK: https://github.com/goat-sdk/goat
- MCP SEP-1036 Elicitation: https://modelcontextprotocol.io/specification/draft/client/elicitation
- SEP-1036 PR: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/887
- ERC-8004 Trustless Agents: https://eips.ethereum.org/EIPS/eip-8004
- MoonPay OWS: https://www.moonpay.com/newsroom/open-wallet-standard
- Google Cloud MCP+Web3: https://cloud.google.com/blog/products/identity-security/using-mcp-with-web3-how-to-secure-blockchain-interacting-agents
- agentwallet.md catalog (34 wallets): https://agentwallet.md/
- Solana Agent Kit: https://github.com/sendaifun/solana-agent-kit
