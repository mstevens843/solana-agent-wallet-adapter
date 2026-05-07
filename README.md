# solana-agent-wallet-adapter

A Solana real-wallet adapter for AI agents. Agents can request addresses, message signatures, transaction signatures, and signed sends, but the user's installed wallet remains the signing boundary. No env-var private keys, no agent-owned wallet requirement, and no Phantom-only lock-in.

[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![packages: 8](https://img.shields.io/badge/packages-8-green)](./packages)
[![status: mainnet proof](https://img.shields.io/badge/status-mainnet%20proof-green)](./PROGRESS.md)
[![ci](https://github.com/mstevens843/solana-agent-wallet-adapter/actions/workflows/ci.yml/badge.svg)](https://github.com/mstevens843/solana-agent-wallet-adapter/actions/workflows/ci.yml)

```text
agent or MCP client
      |
      v
MCP server / Vercel AI tool / Solana Agent Kit BaseWallet / CLI
      |
      v
SolanaSigningClient -> SigningRequest -> WalletBackend
      |
      +-- Wallet Standard web wallet
      +-- Android Mobile Wallet Adapter web path
      +-- iOS wallet link or WalletConnect path
      +-- mock backend for smoke tests
      |
      v
user approves in their wallet
      |
      v
signature or transaction id returns to the agent
```

The core idea is simple: keep the agent useful, but keep custody with the user. Every framework adapter sits on the same `WalletBackend` protocol, so a wallet transport only needs to be implemented once.

## Why This Exists

Solana agents usually fall into one of these signing models:

- **Read-only MCP servers** query chain state but cannot sign.
- **Private-key MCP servers** sign with an env-var key, local wallet file, embedded wallet, or server wallet.
- **Agent-wallet systems** give the agent its own wallet, PDA, delegate key, or vault with policy limits.
- **Protocol-specific handoffs** send the user to one product flow, such as a bridge or swap page.

Those are valid models, but they do not cover the builder who wants an agent to use the user's existing Phantom, Solflare, Backpack, Seed Vault Wallet, or other Solana wallet with explicit approval for each real action.

This repo fills that gap. The model is:

1. The agent asks for a Solana wallet operation.
2. The host adapter creates a `SigningRequest`.
3. A wallet backend opens the approval surface.
4. The user approves or rejects in the wallet they already trust.
5. The agent receives only the approved result.

The private key never enters the agent process.

## Current Proof

The project has crossed the main product milestone:

> An AI agent can request a real mainnet SOL transfer, the user approves in an existing browser wallet, the private key never leaves the wallet, and the agent receives the confirmed transaction id.

See [PROGRESS.md](./PROGRESS.md) for confirmed mainnet transfers, safety caps, and remaining release-gate smokes.

## Launch Positioning

Buy `agenticwalletadapter.com` first. If budget allows, also buy `agenticapprove.com` and redirect it to the same site.

- Domain: `agenticwalletadapter.com`
- Hero copy: "Agentic approval for Solana wallets"
- Product name: `Agentic`
- Technical phrase: `Agentic Wallet Adapter` or `Solana Agent Wallet Adapter`

## Quick Start

### 1. Install and build

```bash
git clone git@github.com:mstevens843/solana-agent-wallet-adapter.git
cd solana-agent-wallet-adapter
pnpm install
pnpm build
```

### 2. Smoke the MCP server with the mock wallet

Register the bundled MCP server with Claude Code:

```bash
claude mcp add --scope user solana-agent-wallet -- \
  node /absolute/path/to/solana-agent-wallet-adapter/packages/mcp-server/dist/bin/server.js
```

Restart Claude Code and ask:

```text
What is my Solana wallet address? Use the solana-agent-wallet tool.
```

Expected result: the mock backend returns `11111111111111111111111111111111`. This confirms the MCP surface before a real wallet is attached.

### 3. Run the real-wallet bridge

For local real-wallet use with Codex or Claude-style MCP clients:

```bash
cp .env.example .env
cp agent-wallet.config.example.json agent-wallet.config.json
pnpm mcp:codex:add
pnpm dev
```

Then open `http://127.0.0.1:5174`, discover wallets, connect the wallet that should approve agent actions, and click `Connect bridge`.

Terminal-first flow:

```bash
pnpm cli -- app
```

The terminal app checks or starts the local bridge, checks or starts the browser wallet host, opens the host with the bridge token, and gives slash commands for `/connect`, `/wallet`, `/inbox`, `/inspect`, `/approve`, `/schedule`, `/plan`, `/research`, `/receipts`, and `/doctor`. The terminal controls the approval flow; the real wallet popup still performs the signature.

Optional AI planning uses BYOK. Agentic works without an AI key through templates; for smarter natural-language planning,
set `AGENTIC_AI_API_KEY`, `AGENTIC_AI_MODEL`, and `AGENTIC_AI_BASE_URL` on the local bridge, or use the browser session
key field for Android/browser-only testing. See [docs/ai-byok.md](./docs/ai-byok.md).

Restart Codex after MCP registration and ask:

```text
Use solana-agent-wallet to show my wallet status.
```

For real mainnet actions, edit `.env` and `agent-wallet.config.json` first. The default config keeps mainnet disabled until you choose RPC settings and caps.

### 4. Run the public browser demo

```bash
pnpm demo:browser
```

Open `http://127.0.0.1:5174`, choose a Wallet Standard provider, connect, sign a message, sign transaction bytes, or sign and send a devnet memo transaction. The demo uses the same `WalletStandardWebBackend` and `SolanaSigningClient` used by the framework adapters.

## Wallet Transports

| Transport | Package | Current role |
| --- | --- | --- |
| Browser Wallet Standard | [`@solana-agent-wallet-adapter/wallet-standard-web`](./packages/wallet-standard-web) | Works with installed Solana browser wallets that register Wallet Standard features. |
| Android mobile web MWA | [`@solana-agent-wallet-adapter/mwa-mobile-web`](./packages/mwa-mobile-web) | Registers Solana Mobile's Mobile Wallet Standard implementation so Android Chrome can discover mobile wallets. |
| iOS wallet links | [`@solana-agent-wallet-adapter/ios-link`](./packages/ios-link) | Experimental bridge path for Phantom, Solflare, Backpack encrypted links, and Jupiter Mobile WalletConnect/Reown QR approvals. |
| Mock backend | [`@solana-agent-wallet-adapter/mcp-server`](./packages/mcp-server) | Deterministic smoke backend for MCP registration, tests, and examples. |

Android and iOS are intentionally separate. Solana Mobile Wallet Adapter is an Android path. iOS requires wallet-specific links, WalletConnect/Reown, or wallet hosts that inject Wallet Standard providers.

## Agent Integrations

### MCP server

The MCP package exposes the low-level signing tools:

- `solana_get_address`
- `solana_connect_wallet`
- `solana_sign_message`
- `solana_sign_transaction`
- `solana_sign_and_send_transaction`
- `solana_simulate_transaction`
- `solana_check_approval`

When connected to the local bridge, it also exposes product-level tools for wallet status, balances, capped transfers, SPL transfers, swap quotes, swaps, prepared actions, recurring payments, receipts, and approval inbox management.

See [`packages/mcp-server`](./packages/mcp-server).

### Vercel AI SDK

```ts
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { SolanaSigningClient } from '@solana-agent-wallet-adapter/core';
import {
  WalletStandardWebBackend,
  requireWallet,
} from '@solana-agent-wallet-adapter/wallet-standard-web';
import { createSolanaTools } from '@solana-agent-wallet-adapter/vercel-ai';

const backend = new WalletStandardWebBackend({
  wallet: requireWallet('Phantom'),
  cluster: 'devnet',
});

const client = new SolanaSigningClient({ backend });
const tools = createSolanaTools({ client });

const result = await generateText({
  model: openai('gpt-4o'),
  tools,
  prompt: 'Sign the message "hello solana" on devnet using my wallet.',
});
```

The model can choose the tool. The wallet still controls approval.

See [`packages/vercel-ai`](./packages/vercel-ai).

### Solana Agent Kit

```ts
import { SolanaAgentKit } from 'solana-agent-kit';
import {
  WalletStandardWebBackend,
  requireWallet,
} from '@solana-agent-wallet-adapter/wallet-standard-web';
import { AgentWalletAdapterBackend } from '@solana-agent-wallet-adapter/solana-agent-kit';

const backend = new WalletStandardWebBackend({
  wallet: requireWallet('Phantom'),
  cluster: 'devnet',
});

const wallet = await AgentWalletAdapterBackend.create({
  backend,
  cluster: 'devnet',
});

const agent = new SolanaAgentKit(
  wallet,
  'https://api.devnet.solana.com',
  { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
);
```

Solana Agent Kit keeps its action library. This adapter replaces the signer with the user's installed wallet.

See [`packages/solana-agent-kit`](./packages/solana-agent-kit).

## Package Map

| Package | Purpose | Status |
| --- | --- | --- |
| [`@solana-agent-wallet-adapter/core`](./packages/core) | Protocol types, errors, `WalletBackend`, `SolanaSigningClient`. | Built and unit-tested. |
| [`@solana-agent-wallet-adapter/mcp-server`](./packages/mcp-server) | MCP stdio and HTTP server, mock backend, bridge client, high-level action tools. | Built, tested, mainnet bridge proof complete. |
| [`@solana-agent-wallet-adapter/wallet-standard-web`](./packages/wallet-standard-web) | Browser wallet backend over Wallet Standard. | Built, unit-tested, Backpack smoke passed. |
| [`@solana-agent-wallet-adapter/mwa-mobile-web`](./packages/mwa-mobile-web) | Android mobile web MWA registration helpers. | Built, additive mobile path. |
| [`@solana-agent-wallet-adapter/ios-link`](./packages/ios-link) | iOS wallet link and Jupiter WalletConnect/Reown approval backend. | Experimental, tested at the package level. |
| [`@solana-agent-wallet-adapter/vercel-ai`](./packages/vercel-ai) | Vercel AI SDK tool definitions. | Built, model-call smoke pending. |
| [`@solana-agent-wallet-adapter/solana-agent-kit`](./packages/solana-agent-kit) | Solana Agent Kit `BaseWallet` adapter. | Built, full action smoke pending. |
| [`@solana-agent-wallet-adapter/cli`](./packages/cli) | Standalone terminal app plus scriptable bridge status, balances, inbox, schedules, receipts, plans, research artifacts, transfers, and swaps. | Built, typechecked, bridge doctor/inbox smoke passed. |

## Competitive Position

The market is not empty. Pay.sh, y0, Trust Wallet Agent Kit, VaultPilot, Phantom MCP, SeekerClaw, deBridge MCP, AgentWallet-style systems, and private-key MCP servers all overlap parts of the story.

Pay.sh is the clearest adjacent Solana project to call out. It helps agents discover and pay for APIs through HTTP 402, x402, MPP, a CLI, MCP tools, and a provider catalog. This repo solves a different trust boundary: it lets agents request Solana wallet actions while the user's installed wallet remains the signer. Pay.sh is for agent API payments. This project is for agent wallet authority.

The defensible difference is the combination:

- existing user wallet signs
- Solana Wallet Standard on web
- Android MWA path
- iOS wallet-link compatibility path
- one reusable `WalletBackend` protocol
- MCP, Vercel AI, Solana Agent Kit, CLI, local bridge, and demo surfaces on top of the same signing boundary
- local approval inbox, caps, receipts, and confirmed mainnet transfer proof

Use this positioning:

> The Solana real-wallet adapter for AI agents.

Avoid broad "first" or "only" claims. The detailed competitive scan lives in [STANDOUT_FEATURES.md](./STANDOUT_FEATURES.MD).

## Safety Model

The architecture avoids key custody, but the product also includes workflow controls:

- mainnet is disabled by default in the example config
- capped SOL transfers and swaps
- SPL transfer allowlists
- arbitrary mainnet transaction signing disabled unless explicitly enabled
- approval inbox for prepared and recurring actions
- receipts for executed actions
- direct balance preflight before wallet approval
- optional transaction simulation through backends that support it
- explicit protocol errors for rejection, timeout, cluster mismatch, unsupported methods, and unreachable wallets

Wallet approval remains mandatory for real signing and sending.

## Project Layout

```text
solana-agent-wallet-adapter/
  apps/
    browser-demo/       public Wallet Standard and bridge demo
    desktop-shell/      Tauri bridge orchestrator and health console
    reference-agent/    prompt-to-signing-plan demo
  packages/
    core/               shared protocol and signing client
    mcp-server/         MCP tools, bridge, action service
    wallet-standard-web/
    mwa-mobile-web/
    ios-link/
    vercel-ai/
    solana-agent-kit/
    cli/
  docs/
    smoke/              manual smoke guides
    research/           dated research notes
    outreach/           public coordination drafts
  spec/
    protocol.md         draft protocol
```

Start with [docs/README.md](./docs/README.md) for the full documentation map.

## Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm -r test
```

Useful local commands:

```bash
pnpm dev             # local bridge plus browser demo
pnpm dev:mobile      # LAN bridge plus mobile browser demo URL
pnpm dev:stop        # stop stuck local bridge/demo ports
pnpm demo:browser    # browser command center
pnpm demo:agent      # reference agent demo
pnpm smoke:web       # minimal Wallet Standard smoke harness
pnpm desktop:dev     # desktop bridge orchestrator web shell
pnpm cli -- app      # standalone terminal approval app
pnpm cli -- doctor   # CLI bridge health
```

To add a wallet backend, implement `WalletBackend` from [`@solana-agent-wallet-adapter/core`](./packages/core) and keep capabilities honest. To add an agent framework, wrap `SolanaSigningClient` and let the wallet backend enforce approval.

## Roadmap

Done:

- core protocol and error model
- MCP stdio and HTTP transports
- local browser bridge
- Wallet Standard web backend
- Android mobile web MWA registration
- iOS link backend package
- Vercel AI SDK tools
- Solana Agent Kit `BaseWallet` adapter
- CLI surface and desktop bridge orchestrator
- browser command center
- approval inbox, caps, receipts, transfers, and swaps
- unit tests and CI
- confirmed mainnet SOL transfer through an agent request

Near-term release gates:

- Phantom and Solflare browser smokes
- SPL transfer smoke
- Jupiter quote and swap smoke
- CLI end-to-end bridge smoke
- Vercel AI real model-call smoke
- Solana Agent Kit runtime action smoke
- native Tauri packaging smoke
- npm namespace publish

See [PROGRESS.md](./PROGRESS.md) and [STATUS.md](./STATUS.md) for current operational state.

## License

[Apache-2.0](./LICENSE).
