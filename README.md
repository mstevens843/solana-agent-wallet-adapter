# solana-agent-wallet-adapter

A Solana wallet adapter for AI agents. No custody, no env-var private keys, no Phantom-only lock-in. The user's real wallet signs every action, the agent never sees the private key, and the same protocol works whether your agent runs in Claude Desktop, in a Vercel AI app, on Android, or in a browser tab.

[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![packages: 5](https://img.shields.io/badge/packages-5-green)](./packages)
[![status: phase 1](https://img.shields.io/badge/status-phase%201-yellow)](./PROGRESS.md)
[![ci](https://github.com/mstevens843/solana-agent-wallet-adapter/actions/workflows/ci.yml/badge.svg)](https://github.com/mstevens843/solana-agent-wallet-adapter/actions/workflows/ci.yml)

```
                    agent calls a signing tool
                              │
                              ▼
   ┌──────────────────────────────────────────────────────┐
   │  MCP server   /   Vercel AI tool   /   SAK BaseWallet │
   └──────────────────────────────────────────────────────┘
                              │
                              ▼
                core protocol: SigningRequest
              ApprovalResource, WalletBackend
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
   Wallet Standard      MWA (Android)    Deeplinks (iOS)
        (web)
              │               │                │
              └───────────────┼────────────────┘
                              ▼
            user approves in their actual wallet
                  signature returns to agent
```

Three transports converge on one `WalletBackend` interface. Every framework integration sits on the same protocol, every backend speaks the same shape, every signing call surfaces an explicit approval in the wallet the user already trusts.

## Why this exists

Today every Solana MCP server falls into one of two buckets, and neither covers the use case most builders actually want.

The first bucket is **read only**. Servers like `solana-foundation/solana-dev-mcp` and `openSVM/solana-mcp-server` expose RPC methods so an agent can query balances, fetch accounts, or simulate transactions. They cannot sign anything. Useful for analysis, useless for action.

The second bucket is **custodial**. Servers like `sendaifun/solana-mcp` and `paulfruitful/WalletMCP` accept a private key in environment variables, hold it in process memory, and sign whatever the agent asks for. Useful for backends and demos, dangerous for end users, fundamentally wrong if the user already owns Phantom and just wants their agent to use it.

The same shape repeats one layer up in the AI agent toolkits. `sendaifun/solana-agent-kit` ships excellent embedded wallet backends (Privy, Turnkey, Phantom hot swap), and `ai16z/eliza` plugins lean on PDA delegate keys. These work great for one-tap onboarding flows where the user does not yet have a wallet and you want to mint one for them. They are the wrong choice for the user who already owns a self-custody wallet and wants to authorize their agent action by action, in the wallet they already use, with no key handoff.

This project closes that gap. One protocol, multiple transports, multiple wallet backends, every signing call surfaces an approval in the user's actual wallet popup. Your agent gets the signature it needs, the user keeps custody, the model never touches the key.

## The protocol in one minute

The flow is deliberately simple. Seven steps from agent call to signed result.

1. The agent (Claude in Claude Desktop, a Vercel AI agent, a `SolanaAgentKit` instance, anything that can call a tool) calls a signing tool with a UTF-8 message or a base64 transaction and a target cluster.
2. The host adapter (MCP server, Vercel AI tool, SAK `BaseWallet`) builds a `SigningRequest` with a fresh `requestId` and submits it to the configured `WalletBackend`.
3. The backend opens the user's wallet popup. On the web that is a Wallet Standard event the wallet extension intercepts. On Android it will be an Android Intent dispatched to the wallet app via real MWA. On iOS it will be a universal link bouncing into the wallet's deeplink handler.
4. The user approves or rejects in the wallet they already trust. The agent and the model see nothing of the user's private key at any point.
5. The backend resolves the pending `ApprovalResource` with either a `SigningResult` (signature, optional txid) or a `ProtocolError` (`user_rejected`, `expired`, `cluster_mismatch`, etc).
6. The host adapter polls or, on transports that support push, listens for the resolution.
7. The agent receives the signed result and continues its workflow.

The whole approval sequence lives in `SolanaSigningClient.run()` at `packages/core/src/client.ts`. Every framework adapter sits on top of that one method. Every backend implements the same five-method `WalletBackend` interface at `packages/core/src/backend.ts`. If you understand those two files you understand the project.

## Quick start

Three minutes, mock backend, no real wallet required for the first pass.

### Install and build

```bash
git clone git@github.com:mstevens843/solana-agent-wallet-adapter.git
cd solana-agent-wallet-adapter
pnpm install
pnpm build
```

All five packages and both demo apps should report `Done`.

### Register the MCP server with Claude Code

```bash
claude mcp add --scope user solana-agent-wallet \
  node /absolute/path/to/solana-agent-wallet-adapter/packages/mcp-server/dist/bin/server.js
```

Exit your current `claude` session, start a fresh one, and ask:

```
What is my Solana wallet address? Use the solana-agent-wallet tool.
```

Expected response: Claude calls `solana_get_address` and returns the mock address `11111111111111111111111111111111`. The mock backend always returns this base58 zero address. Real backends return real addresses.

### Browser smoke against an installed wallet

In a second terminal:

```bash
pnpm smoke:web
```

Vite serves `http://localhost:5173/test.html`. With Phantom or Solflare unlocked in the same browser, click **List wallets** to see them appear, click **Get address** to authorize a connection, click **Sign hello on devnet** to round-trip a real signing flow.

That is the full happy path. Five packages built, MCP server live, browser backend live, real wallet popup confirms a signature.

### Polished browser demo

For the public demo surface:

```bash
pnpm demo:browser
```

Open `http://127.0.0.1:5174`, choose Phantom, Solflare, Backpack, or any discovered Wallet Standard provider, connect, and sign the demo message. The Wallet Flow tab also creates a devnet memo transaction, signs transaction bytes without broadcasting, and can sign plus broadcast on devnet. The Agent Plan tab is simulated for now, but it signs a real off-chain approval proof with the selected wallet.

This is the fastest way to show the core difference against Phantom MCP and custodial agent wallets: the agent asks, but the user's existing installed wallet makes the signing decision.

## Three usage flavors

### A. MCP server in Claude Code or Claude Desktop

For Claude Desktop, drop this into the config file:

```jsonc
// macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
// Linux:   ~/.config/Claude/claude_desktop_config.json
// Windows: %APPDATA%\Claude\claude_desktop_config.json
{
  "mcpServers": {
    "solana-agent-wallet": {
      "command": "node",
      "args": [
        "/absolute/path/to/solana-agent-wallet-adapter/packages/mcp-server/dist/bin/server.js"
      ]
    }
  }
}
```

For Claude Code, register through the CLI:

```bash
claude mcp add --scope user solana-agent-wallet \
  node /absolute/path/to/packages/mcp-server/dist/bin/server.js
claude mcp list
```

Six tools become available to the agent:

- `solana_get_address` returns the connected wallet address.
- `solana_sign_message` requests a UTF-8 message signature.
- `solana_sign_transaction` requests a transaction signature without broadcasting.
- `solana_sign_and_send_transaction` signs and broadcasts in one approval.
- `solana_simulate_transaction` returns a simulation preview when the backend supports it.
- `solana_check_approval` polls the status of a pending approval.

The mock backend ships with the binary, so the server runs with no real wallet attached and is ideal for first-time registration plus protocol smoke. Swap to a real backend (`wallet-standard-web` in a custom host today, `mwa-android` and `ios-deeplink` later) when you want the popup to actually fire.

### B. Vercel AI SDK agent

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

`createSolanaTools` returns four tools: `solanaGetAddress`, `solanaSignMessage`, `solanaSignTransaction`, `solanaSignAndSendTransaction`. The model picks the right one based on the prompt, the tool calls flow into `SolanaSigningClient`, the client blocks until the wallet popup resolves. Approval enforcement is at the wallet boundary, not the model boundary. The model never sees the signing material in the clear and the agent never gains the private key.

### C. Solana Agent Kit BaseWallet

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

// Every action that calls signTransaction or signMessage now pops the
// user's wallet popup. The agent inherits the full SAK action library.
```

This is the most leveraged integration in the repo. `SolanaAgentKit` ships fifty-plus prebuilt actions (swap on Jupiter, mint NFTs, stake SOL, transfer SPL tokens, mint cNFTs) and our adapter swaps out the wallet underneath while leaving every action untouched. The user keeps custody, the agent keeps the action library.

## Package ecosystem

| Package | What it does | Status |
| --- | --- | --- |
| [`@solana-agent-wallet-adapter/core`](./packages/core) | Protocol types, error model, `SolanaSigningClient` submit and poll wrapper | builds clean |
| [`@solana-agent-wallet-adapter/mcp-server`](./packages/mcp-server) | MCP server with five signing tools, stdio + Streamable HTTP transports, mock backend for local smoke | builds clean, smoked |
| [`@solana-agent-wallet-adapter/wallet-standard-web`](./packages/wallet-standard-web) | Browser `WalletBackend` over `@wallet-standard/app`, talks to any Solana Wallet Standard wallet | builds clean, smoked with Backpack |
| [`@solana-agent-wallet-adapter/vercel-ai`](./packages/vercel-ai) | Vercel AI SDK 5 tool definitions, four tools wrapping the core client | builds clean |
| [`@solana-agent-wallet-adapter/solana-agent-kit`](./packages/solana-agent-kit) | `BaseWallet` adapter for sendaifun's `SolanaAgentKit` constructor | builds clean |

Planned but not built yet:

- `mwa-android`, the real MWA backend wrapping `@solana-mobile/mobile-wallet-adapter-protocol`.
- `ios-deeplink`, the deeplink session bridge for Phantom, Solflare, Backpack on iOS (a stripped version of the spec being shipped in the sibling `ios-solana-wallet-adapter` repo).
- `langchain-js`, `langchain-py`, `crewai`, `pydantic-ai` framework integration packages.
- `elizaos`, a userwallet plugin replacing the custodial `plugin-solana-v2`.
- `cli`, a local testing harness so you can drive the protocol from a terminal without spinning up an MCP client.

The full Phase 2 backlog with file paths and acceptance criteria lives in [`PROGRESS.md`](./PROGRESS.md).

## How it compares

The category is contested but the specific wedge is genuinely empty. Every shipped Solana competitor uses a non-user wallet for signing, or covers only one wallet, or runs only on desktop.

| Project | Solana? | Non custodial? | Multi wallet? | Mobile native? |
| --- | --- | --- | --- | --- |
| `solana-agent-wallet-adapter` (this repo) | yes | yes | yes | yes (planned Android + iOS) |
| `nikicat/mcp-wallet-signer` | EVM only | yes | yes | no |
| `@phantom/mcp-server` | yes | partial (Phantom embedded only) | no | partial |
| `sendaifun/solana-mcp` | yes | no (env var private key) | no | no |
| `solana-foundation/solana-dev-mcp` | yes | n/a (read only) | n/a | no |
| `openSVM/solana-mcp-server` | yes | n/a (read only) | n/a | no |
| `paulfruitful/WalletMCP` | yes | no (custodial vault) | no | no |
| `hifriendbot/agentwallet-mcp` | yes | no (delegate + guards) | no | no |

Three durable differentiators come out of that grid:

1. **Multi-wallet by design.** Phantom, Solflare, Backpack, Glow today through Wallet Standard. Phantom's own MCP server is Phantom-only and will not pivot.
2. **Mobile-native via real MWA.** No shipped competitor covers mobile. SeekerClaw is Seeker-only.
3. **Standards aligned.** Wallet Standard for browser, MCP SEP-1036 URL elicitation for approval UX, the `BaseWallet` interface for sendaifun parity. Protocol-level moves age better than vendor-specific ones.

The full audit, including ten ranked competitors, the per-framework integration matrix, the standards tailwinds, and the things we explicitly are not trying to do, lives at [`docs/research/06-prior-art-audit.md`](./docs/research/06-prior-art-audit.md).

## Concepts and glossary

The protocol is small enough to memorize. Six types do all the work.

- **`WalletBackend`** (`packages/core/src/backend.ts`). The core interface every transport implements: `capabilities`, `getAddress`, `submit`, `poll`, optional `cancel`, optional `simulate`. If you can implement this against your wallet, every framework integration in the repo works for free.
- **`SigningRequest`** (`packages/core/src/types.ts`). The shape every signing call submits. Carries `id`, `kind` (one of `sign_message`, `sign_transaction`, `sign_and_send_transaction`), `payload` (utf8 or base64), `cluster`, optional human-readable `display` metadata, optional `expiresAt`.
- **`ApprovalResource`** (`packages/core/src/types.ts`). What the backend returns immediately after `submit`. Status starts at `pending`. Resolves to `approved` (with `result`), `rejected`, `expired`, or `failed` (with `error`). Carries an optional `approvalUri` the host can render to the user.
- **`SigningResult`** (`packages/core/src/types.ts`). The signed payload: base64 signature for messages and signed transactions, optional `txid` for `sign_and_send_transaction`.
- **`ProtocolError`** (`packages/core/src/errors.ts`). Nine error codes (`user_rejected`, `user_no_response`, `wallet_unreachable`, `invalid_request`, `simulation_failed`, `cluster_mismatch`, `expired`, `unauthorized`, `unsupported_method`) with a `recoverable` flag so callers can retry the right ones.
- **`SolanaSigningClient`** (`packages/core/src/client.ts`). The async wrapper that submits a request, polls until resolution (default 500ms interval, 2-minute timeout, both configurable), and returns a `SigningResult` or throws a `ProtocolError`. Every framework integration sits on top of this one class.

The full draft v0.2 protocol spec (open questions included) is at [`spec/protocol.md`](./spec/protocol.md).

## Roadmap

Honest status as of 2026-05-03 (commit `4e11377`).

**Done.** Core protocol, MCP server with six tools and stdio plus HTTP transports, `wallet-standard-web` browser backend, Vercel AI SDK tools, Solana Agent Kit `BaseWallet` adapter, six research notes including the full prior-art audit, end-to-end stdio smoke confirmed in a real Claude Code client, browser smoke confirmed with Backpack through Wallet Standard, Backpack devnet sign-and-send confirmed, unit tests, CI, and two browser demo apps.

**Next near term.** Phantom and Solflare browser smokes, Vercel AI agent smoke, SAK adapter smoke, npm publish at 0.0.1 to lock the package slugs, sendaifun RFC posted, ElizaOS userwallet plugin, LangChain JS, LangChain Python, CrewAI, Pydantic AI integration packages.

**Farther out.** `mwa-android` real MWA backend wrapping `@solana-mobile/mobile-wallet-adapter-protocol`, `ios-deeplink` package wrapping the protocol shipped in the sibling `ios-solana-wallet-adapter` repo, reference autonomous agent demo doing one Jupiter swap end to end, React Native sample app hosting the MCP server locally on Android, submission to the official MCP Registry, mainnet safety review.

The full ordered backlog with task scopes, files to touch, acceptance criteria, and dependencies lives in [`PROGRESS.md`](./PROGRESS.md).

## Project layout

```
solana-agent-wallet-adapter/
├── apps/
│   ├── browser-demo          polished Wallet Standard browser demo
│   └── reference-agent       richer agent-plan browser demo
├── packages/
│   ├── core/                 protocol types, error model, SolanaSigningClient
│   ├── mcp-server/           MCP server, stdio + HTTP transports, mock backend
│   ├── wallet-standard-web/  browser WalletBackend over @wallet-standard/app
│   ├── vercel-ai/            Vercel AI SDK 5 tool definitions
│   └── solana-agent-kit/     BaseWallet adapter for SolanaAgentKit
├── docs/
│   ├── claude-desktop-setup.md   smoke procedure for Claude Desktop GUI
│   ├── research/                 six research notes (MCP UX, prior art, etc)
│   └── outreach/                 sendaifun RFC draft
├── examples/
│   └── claude-desktop-config.json   drop-in MCP config
├── spec/
│   └── protocol.md           draft v0.2 of the agent wallet adapter protocol
├── test.html                 browser smoke harness loaded by `pnpm smoke:web`
├── vite.config.js            dev server config for the browser smoke
├── pnpm-workspace.yaml
├── tsconfig.base.json        strict TypeScript
├── package.json
├── PROGRESS.md               handoff doc with exact state and next tasks
└── README.md                 this file
```

## Contributing

The protocol spec lives at [`spec/protocol.md`](./spec/protocol.md). Read it before adding a new wallet backend or framework adapter; the contract there is the one piece every other package depends on.

To add a new wallet backend, implement `WalletBackend` from `@solana-agent-wallet-adapter/core`. Five methods: `capabilities()`, `getAddress()`, `submit()`, `poll()`, optional `cancel()`. The browser backend at `packages/wallet-standard-web/src/backend.ts` is the canonical reference. Declare honest `AdapterCapabilities`: do not claim `supports.signAndSendTransaction` if you only have separate sign and broadcast paths.

To add a new framework adapter, write a thin wrapper around `SolanaSigningClient`. The Vercel AI tools at `packages/vercel-ai/src/tools.ts` are about a hundred and twenty lines, the SAK adapter at `packages/solana-agent-kit/src/adapter.ts` is about a hundred and seventy. Most of the real work happens inside `SolanaSigningClient.run()` in `packages/core/src/client.ts`, which submits a request and blocks until the backend resolves.

To run the existing smokes:

```bash
pnpm install
pnpm typecheck
pnpm -r test
pnpm build                                  # packages and demo apps must report Done
pnpm demo:browser                           # polished demo on 127.0.0.1:5174
pnpm demo:agent                             # reference agent demo on 127.0.0.1:5174
pnpm smoke:web                              # browser harness (open Phantom)
node packages/mcp-server/dist/bin/server.js # stdio MCP server (no output, awaits JSON-RPC)
node packages/mcp-server/dist/bin/serverHttp.js   # HTTP MCP server on :8723
```

For Claude Code MCP registration:

```bash
claude mcp add --scope user solana-agent-wallet \
  node /absolute/path/to/packages/mcp-server/dist/bin/server.js
claude mcp list   # confirms the registration
```

## License

[Apache-2.0](./LICENSE).

## Status

As of 2026-05-03, all five packages and both demo apps build clean under strict TypeScript. Stdio MCP smoke confirmed end to end in a real MCP client. Browser Wallet Standard smoke confirmed with Backpack on devnet. Phantom and Solflare browser smokes remain useful follow-ups. Sibling repo `ios-solana-wallet-adapter` has scaffold pushed, sibling repo `unreal-solana-mwa` exists as an empty folder. Ship target for all three projects is 2026-05-31.
