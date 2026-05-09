# STATUS: solana-agent-wallet-adapter

> Snapshot for the next coding agent picking this project up cold.
> Updated 2026-05-07. The worktree intentionally contains uncommitted feature and documentation work.

## Project in one paragraph

This repo is a real-wallet signing bridge for Solana AI agents. Agents can ask for addresses, message signatures, transaction signatures, transaction submission, approval polling, and transaction simulation through one `WalletBackend` contract. The agent never holds the private key. Browser wallets are live through Wallet Standard, the MCP server is live for Claude-style clients, and Vercel AI plus Solana Agent Kit adapters sit on top of the same core client.

## Current state

- Eight publishable packages are present: `core`, `mcp-server`, `wallet-standard-web`, `mwa-mobile-web`, `ios-link`, `vercel-ai`, `solana-agent-kit`, and `cli`.
- Three app surfaces are present: `apps/browser-demo`, `apps/reference-agent`, and `apps/desktop-shell`.
- Unit tests exist for `core`, `mcp-server`, and `wallet-standard-web`.
- CI exists at `.github/workflows/ci.yml` and runs install, build, typecheck, and tests. Build runs before typecheck so workspace package exports can resolve from `dist` in fresh CI checkouts.
- Browser smoke passed with Backpack on devnet for message signing, transaction signing, and sign-and-send broadcast. Phantom and Solflare remain useful follow-ups.
- Demo MP4s are local posting assets and intentionally ignored by git.
- The repo has a small dirty worktree from demo polish. Do not revert unrelated edits. Stabilize them, then let the user stage and commit.

## Package table

| Package | Status | Tests | Notes |
| --- | --- | --- | --- |
| `@solana-agent-wallet-adapter/core` | wired | yes | Protocol types, errors, browser-safe request IDs, polling client, optional simulation call. |
| `@solana-agent-wallet-adapter/mcp-server` | wired | yes | Stdio and HTTP server, mock backend, base wallet tools, bridge action tools, and `solana_simulate_transaction`. |
| `@solana-agent-wallet-adapter/wallet-standard-web` | wired | yes | Browser backend for installed Wallet Standard providers. Uses browser-native base64 and crypto APIs. |
| `@solana-agent-wallet-adapter/mwa-mobile-web` | wired | not yet | Android mobile web registration helpers for Solana Mobile Wallet Standard. |
| `@solana-agent-wallet-adapter/ios-link` | wired | yes | iOS wallet link backend plus Jupiter WalletConnect/Reown path. |
| `@solana-agent-wallet-adapter/vercel-ai` | wired | not yet | AI SDK 5 tools that block at the wallet boundary through `SolanaSigningClient`. |
| `@solana-agent-wallet-adapter/solana-agent-kit` | wired | not yet | `BaseWallet` adapter for Solana Agent Kit. |
| `@solana-agent-wallet-adapter/cli` | wired | yes | Standalone terminal app for bridge lifecycle, wallet host launch, inbox approval, schedules, plans, research artifacts, receipts, transfers, and swaps. |

## Apps

- `apps/browser-demo`: primary public command center. Runs on `127.0.0.1:5174`, discovers Wallet Standard providers, connects, signs a message, creates a devnet memo transaction, signs transaction bytes, sign-and-sends on devnet, connects the local bridge, manages the Approval Inbox, and queues a capped Agent Plan into the inbox.
- `apps/reference-agent`: richer agent-plan demo. The Vite dev server exposes `/api/agent-plan`, uses `OPENAI_API_KEY` and `OPENAI_MODEL` when present, and falls back to deterministic demo output when absent.
- `apps/desktop-shell`: Tauri bridge orchestrator for local bridge lifecycle, diagnostics, logs, health, wallet-host launch, Approval Inbox, and receipts.
- Recurring production upgrade is in progress: cloud schedules now have expiry, spend views, occurrence-history hydration, pause/resume routes, policy caps, and webhook delivery queue support. See `plan.md` and `docs/smoke/recurring-production.md`.

## Build, test, run

```sh
pnpm install
pnpm typecheck
pnpm -r test
pnpm build
```

Browser surfaces:

```sh
pnpm dev             # bridge plus browser demo
pnpm smoke:web       # simple harness at http://localhost:5173/test.html
pnpm demo:browser    # polished demo at http://127.0.0.1:5174
pnpm desktop:dev     # desktop bridge orchestrator at http://127.0.0.1:5175
pnpm cli -- doctor   # terminal bridge health
```

MCP surfaces:

```sh
node packages/mcp-server/dist/bin/server.js
node packages/mcp-server/dist/bin/serverHttp.js
```

## Recent local changes

- Core request IDs now use `globalThis.crypto.getRandomValues()` instead of `node:crypto`, so the core package can be imported from Vite browser code.
- `WalletBackend` has optional `simulate(request)` support.
- `SolanaSigningClient` has `simulateTransaction()`.
- MCP server now advertises and handles `solana_simulate_transaction`.
- Mock backend returns a deterministic simulation preview.
- Wallet Standard backend reports `unsupported_method` for simulation instead of pretending it can simulate.
- Tests were added for core errors, IDs, client polling, MCP tool behavior, and Wallet Standard backend behavior.
- Public demo and reference-agent app scaffolds were added.
- Browser demo toast styling was enlarged and lowered for screen recording readability.
- Wallet Standard sign-and-send now handles Backpack with sign-then-RPC-send and Phantom native sign-and-send with `minContextSlot`.
- CI was added and then reordered so package build output exists before typecheck.
- Competitive positioning was refreshed in `STANDOUT_FEATURES.MD`.
- Public documentation is being cleaned up around a builder-first, evidence-first story.

## Still outstanding

1. Phantom and Solflare browser smokes, using `pnpm smoke:web` or `pnpm demo:browser`.
2. CLI smoke against a running bridge: `doctor`, `balances`, `prepare`, `inbox approve`, and `receipts`.
3. SPL transfer, Jupiter quote, and Jupiter swap smokes with tiny configured amounts.
4. Claude Desktop GUI smoke and screenshots.
5. Real Vercel AI model call using the Vercel adapter.
6. Solana Agent Kit end-to-end smoke with the `BaseWallet` adapter.
7. npm namespace publish at `0.0.1`.
8. ElizaOS, LangChain JS, LangChain Python, CrewAI, and Pydantic AI wrappers.

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
