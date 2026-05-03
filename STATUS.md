# STATUS: solana-agent-wallet-adapter

> Snapshot for the next coding agent picking this project up cold.
> Updated 2026-05-03. The worktree is intentionally ahead of commit `4e11377`.

## Project in one paragraph

This repo is a real-wallet signing bridge for Solana AI agents. Agents can ask for addresses, message signatures, transaction signatures, transaction submission, approval polling, and transaction simulation through one `WalletBackend` contract. The agent never holds the private key. Browser wallets are live through Wallet Standard, the MCP server is live for Claude-style clients, and Vercel AI plus Solana Agent Kit adapters sit on top of the same core client.

## Current state

- Five publishable packages are present: `core`, `mcp-server`, `wallet-standard-web`, `vercel-ai`, `solana-agent-kit`.
- Two demo apps are present: `apps/browser-demo` and `apps/reference-agent`.
- Unit tests exist for `core`, `mcp-server`, and `wallet-standard-web`.
- CI exists at `.github/workflows/ci.yml` and runs install, typecheck, tests, and build.
- Browser smoke passed with Backpack on devnet. Phantom and Solflare remain useful follow-ups.
- The repo has a dirty worktree from multiple agents. Do not revert unrelated edits. Stabilize them, then let the user stage and commit.

## Package table

| Package | Status | Tests | Notes |
| --- | --- | --- | --- |
| `@solana-agent-wallet-adapter/core` | wired | yes | Protocol types, errors, browser-safe request IDs, polling client, optional simulation call. |
| `@solana-agent-wallet-adapter/mcp-server` | wired | yes | Stdio and HTTP server, mock backend, six tools including `solana_simulate_transaction`. |
| `@solana-agent-wallet-adapter/wallet-standard-web` | wired | yes | Browser backend for installed Wallet Standard providers. Uses browser-native base64 and crypto APIs. |
| `@solana-agent-wallet-adapter/vercel-ai` | wired | not yet | AI SDK 5 tools that block at the wallet boundary through `SolanaSigningClient`. |
| `@solana-agent-wallet-adapter/solana-agent-kit` | wired | not yet | `BaseWallet` adapter for Solana Agent Kit. |

## Apps

- `apps/browser-demo`: primary public demo. Runs on `127.0.0.1:5174`, discovers Wallet Standard providers, connects, signs a message, and exposes transaction-signing controls.
- `apps/reference-agent`: richer agent-plan demo. The Vite dev server exposes `/api/agent-plan`, uses `OPENAI_API_KEY` and `OPENAI_MODEL` when present, and falls back to deterministic demo output when absent.

## Build, test, run

```sh
pnpm install
pnpm typecheck
pnpm -r test
pnpm build
```

Browser surfaces:

```sh
pnpm smoke:web       # simple harness at http://localhost:5173/test.html
pnpm demo:browser    # polished demo at http://127.0.0.1:5174
```

MCP surfaces:

```sh
node packages/mcp-server/dist/bin/server.js
node packages/mcp-server/dist/bin/serverHttp.js
```

## What changed after `4e11377`

- Core request IDs now use `globalThis.crypto.getRandomValues()` instead of `node:crypto`, so the core package can be imported from Vite browser code.
- `WalletBackend` has optional `simulate(request)` support.
- `SolanaSigningClient` has `simulateTransaction()`.
- MCP server now advertises and handles `solana_simulate_transaction`.
- Mock backend returns a deterministic simulation preview.
- Wallet Standard backend reports `unsupported_method` for simulation instead of pretending it can simulate.
- Tests were added for core errors, IDs, client polling, MCP tool behavior, and Wallet Standard backend behavior.
- Public demo and reference-agent app scaffolds were added.
- CI was added.

## Still outstanding

1. Phantom and Solflare browser smokes, using `pnpm smoke:web` or `pnpm demo:browser`.
2. Claude Desktop GUI smoke and screenshots.
3. Real Vercel AI model call using the Vercel adapter.
4. Solana Agent Kit end-to-end smoke with the `BaseWallet` adapter.
5. npm namespace publish at `0.0.1`.
6. ElizaOS userwallet plugin.
7. LangChain JS, LangChain Python, CrewAI, and Pydantic AI wrappers.
8. Android MWA backend and iOS deeplink backend.

## Rules

- No em-dashes or en-dashes in prose. Use commas, periods, colons, or plain hyphens.
- No AI attribution in public-facing copy.
- Public framing is "Solana wallet adapter for AI agents" or "real-wallet adapter," not "MWA for AI agents."
- Do not reintroduce `node:` builtins into browser-reachable packages.
- Do not reintroduce AI SDK v5 `needsApproval` in tool definitions. Approval enforcement lives at the wallet boundary.
- Mock backend never auto-resolves approvals. That is intentional.

## Pointers

- Spec: [`spec/protocol.md`](spec/protocol.md)
- Public README: [`README.md`](README.md)
- Main handoff: [`PROGRESS.md`](PROGRESS.md)
- Browser smoke note: [`docs/smoke/browser-wallet-standard.md`](docs/smoke/browser-wallet-standard.md)
- Prior art audit: [`docs/research/06-prior-art-audit.md`](docs/research/06-prior-art-audit.md)
