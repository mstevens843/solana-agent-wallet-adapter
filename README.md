# solana-agent-wallet-adapter

**MWA for AI agents.** A two-layer SDK that lets AI agents transact on Solana through the user's actual wallet, with no key custody.

1. **MCP server** — exposes Solana signing as MCP tools (Claude Desktop, Cursor, Anthropic Agents). Returns approval-pending resources rather than signed transactions.
2. **Wallet backend bridge** — pluggable: MWA on Android (real protocol), deeplinks on iOS (Phantom + Solflare + Backpack), Wallet Standard on web.
3. **Framework integrations** — LangChain (JS + Py), CrewAI, Vercel AI SDK, Solana Agent Kit, Pydantic AI.

Status: **early scaffolding**. See `spec/protocol.md` for the in-progress protocol design.

## Why

Existing Solana MCP servers (`sendaifun/solana-mcp`, `openSVM/solana-mcp-server`, `solana-foundation/solana-dev-mcp`) are either read-only or require key custody. No published MCP server today routes signing through the user's actual wallet with an approval step. Agents that want to act on-chain end up either holding keys (insecure) or staying read-only (useless).

This project closes that gap. The same protocol works on Saga/Seeker via real MWA, on iOS via wallet deeplinks, and on desktop via Wallet Standard or any MCP-aware client.

## Repo layout

```
packages/
  core/                  Protocol types + helpers (TypeScript)
  mcp-server/            Reference MCP server (stdio + HTTP)
  mwa-android/           MWA backend for Android (planned)
  ios-deeplink/          Phantom + Solflare + Backpack deeplink bridge (planned)
  wallet-standard-web/   Browser wallet-adapter backend
  langchain-js/          LangChain JS tool (planned)
  langchain-py/          LangChain Python tool (planned)
  vercel-ai/             Vercel AI SDK provider (planned)
  solana-agent-kit/      Adapter for sendaifun's kit (planned)
  crewai/                CrewAI tool (planned)
  pydantic-ai/           Pydantic AI tool (planned)
  cli/                   Local testing CLI (planned)
apps/
  reference-agent/       Demo trading + prediction-market agent (planned)
  mobile-sample/         React Native sample hosting MCP server (planned)
spec/                    Protocol spec markdown
docs/                    Docs site (Docusaurus, planned)
```

## License

Apache-2.0.
