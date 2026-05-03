# STATUS: solana-agent-wallet-adapter

> Snapshot for the next coding agent (Codex or otherwise) picking this project up cold.
> Generated 2026-05-03 at commit `4e11377`. Update this file when the state below changes.

## Project in one paragraph

This repo is a two-layer SDK that lets AI agents transact on Solana through the user's actual wallet without ever holding the user's keys. Layer one is a small protocol library (types, errors, polling client) plus an MCP server (stdio and HTTP) that exposes Solana signing as MCP tools to Claude Desktop, Cursor, and any other MCP-aware client. Layer two is a set of pluggable `WalletBackend` implementations that route signing requests to a real wallet: Wallet Standard for browser wallets (shipped), iOS deeplink (planned, blocks on the iOS repo), Android MWA (planned). Layer three is framework integrations on top of the protocol library: Vercel AI SDK and Solana Agent Kit have shipped; LangChain, CrewAI, Pydantic AI are next.

The project is past Phase 1 scaffold. Five commits, five workspace packages, all packages compile and typecheck. Zero test coverage and zero CI. The Phase 2 priority is wiring tests, completing the approval-resource UX work, smoke-testing through real Claude Desktop, and shipping the `solana_simulate_transaction` tool. Phase 3 is the additional framework integrations and the cross-platform wallet backends.

## Snapshot

| Package | Status | Source files | Has tests? |
|---------|--------|--------------|-----------|
| `@solana-agent-wallet-adapter/core` | wired | `types.ts`, `backend.ts`, `errors.ts`, `ids.ts`, `client.ts`, `index.ts` | no |
| `@solana-agent-wallet-adapter/mcp-server` | wired (5 of 6 spec'd tools) | `server.ts`, `httpServer.ts`, `mockBackend.ts`, `bin/server.ts`, `bin/serverHttp.ts`, `index.ts`, `tools.ts` (placeholder) | no |
| `@solana-agent-wallet-adapter/wallet-standard-web` | wired | `backend.ts`, `discovery.ts`, `index.ts` | no |
| `@solana-agent-wallet-adapter/vercel-ai` | wired | (read source for current shape) | no |
| `@solana-agent-wallet-adapter/solana-agent-kit` | wired | (read source for current shape) | no |
| `apps/` | empty | none | n/a |

The five most recent commits, oldest at the bottom:

```
4e11377  B2f: Solana Agent Kit BaseWallet adapter + Vite browser smoke + sendaifun RFC
333b9d2  Add prior-art audit (research note 06)
12b6d7d  B2b/B2d/B2e: HTTP transport, Claude Desktop smoke prep, Vercel AI tools
3bdb94a  Add wallet-standard-web backend + humanize MCP approval output
a1aeeb6  Initial scaffold: Solana Agent Wallet Adapter
```

## What is wired and stable

### `core`

Read this first. It is the protocol library every other package depends on.

- `types.ts`: enums and interfaces only, no runtime code. Defines `Cluster`, `SigningRequestId`, `SigningKind`, `ApprovalStatus`, `RiskLevel`, `SigningPayload`, `SimulationResult`, `SigningDisplayHints`, `SigningRequest`, `SigningResult`, `AdapterCapabilities`, `ApprovalResource`, `ProtocolErrorPayload`, `ErrorCode`. Match these shapes exactly, the MCP tool surface is built around them.
- `backend.ts`: the `WalletBackend` interface every wallet integration must implement. Methods: `capabilities()`, `getAddress()`, `submit(request)`, `poll(requestId)`, optional `cancel(requestId)`. The whole point of the project is that everything routes through this single interface.
- `errors.ts`: `ProtocolError` class, with `toPayload()` and `fromPayload()` for round-tripping over the wire. Maps each `ErrorCode` to a `recoverable` boolean.
- `ids.ts`: `newSigningRequestId()`. Returns `sar_` + 12 random hex bytes. Cryptographically random via `node:crypto.randomBytes`. Stable format, do not change without updating downstream string parsing.
- `client.ts`: `SolanaSigningClient` class plus `SignRequestOptions`. This is the consumer-facing client. It wraps a `WalletBackend` and exposes `capabilities()`, `getAddress()`, `signMessage()`, `signTransaction()`, `signAndSendTransaction()`, `cancel()`. Internally it implements the polling loop, timeout enforcement, and cancellation. Default poll interval 500ms, default timeout 120s.
- `index.ts`: re-export barrel.

### `mcp-server`

The MCP bridge. Two transports (stdio for Claude Desktop, HTTP for everything else) and one mock backend for development.

- `server.ts`: registers five MCP tools. `solana_get_address`, `solana_sign_message`, `solana_sign_transaction`, `solana_sign_and_send_transaction`, `solana_check_approval`. Each tool's input schema is validated with Zod. Each returns JSON text content plus an `isError` flag. Approval rendering goes through `renderApproval()` which produces both human-readable and machine-readable output. Sixth spec'd tool (`solana_simulate_transaction`) is not wired (P2-4 below).
- `httpServer.ts`: `createHttpServer()`. Wraps the MCP server in `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk`. POST endpoint at `/:path` (default `/mcp`). Optional stateful mode (per-client session id via UUID) when `MCP_STATEFUL=1`.
- `mockBackend.ts`: `createMockBackend()` returns a fake `WalletBackend`. `capabilities()` returns devnet-only with `signMessage` / `signTransaction` / `signAndSendTransaction` enabled and `multiSign` / `simulationPreview` disabled. `getAddress()` returns `11111111111111111111111111111111`. `submit()` creates a pending approval with `mock://approve/{requestId}` as the URI. `poll()` returns the same approval object every call: **the mock never auto-resolves**. A real backend overrides `poll()` to actually flip status when the wallet replies.
- `bin/server.ts`: stdio CLI entry point. `solana-agent-wallet-mcp` (registered in `package.json:bin`). Hardcoded to use the mock backend; not yet configurable.
- `bin/serverHttp.ts`: HTTP CLI entry point. Reads env vars `PORT` (default 8723), `HOST` (default 127.0.0.1), `MCP_STATEFUL` (default false). Logs the URL to stderr, handles SIGINT and SIGTERM cleanly. Not in the `bin` map; invoke via `node ./packages/mcp-server/dist/bin/serverHttp.js`.
- `tools.ts`: empty placeholder file. All tool registration currently lives in `server.ts`. Splitting them out is not on the roadmap.
- `index.ts`: re-exports `createServer`, `CreateServerOptions`, `createMockBackend`.

### `wallet-standard-web`

Real backend. Routes signing through any Wallet Standard compliant browser wallet: Phantom extension, Solflare extension, Backpack web.

- `backend.ts`: `WalletStandardWebBackend implements WalletBackend`. Constructor validates the wallet supports the target cluster, throws `cluster_mismatch` if not. `getAddress()` calls `ensureConnected()` which uses the Wallet Standard `StandardConnect` feature, returns the first matching account. `submit()` spawns an async task via `AbortController`, returns a pending `ApprovalResource` immediately. The async task uses `SolanaSignMessage` / `SolanaSignTransaction` / `SolanaSignAndSendTransaction` features depending on the request kind. On success or failure, the task mutates the in-flight approval map so subsequent `poll()` calls return the resolved status. `cancel()` aborts via the controller. Bs58 used for signature encoding, base64 (Buffer plus Uint8Array) used for transaction wire-format.
- `discovery.ts`: `listAvailableWallets()` returns the wallets currently registered in the page's Wallet Standard registry. `requireWallet(name)` errors if a named wallet is not found. `DiscoveredWallet` type captures the icon, the name, and the available chains.
- `index.ts`: re-exports.

### `vercel-ai`

Vercel AI SDK tools that wrap `SolanaSigningClient`. Read `packages/vercel-ai/src/` for the exact tool shapes; the package's `description` says "with built-in needsApproval HITL" so the tools surface the approval flow directly through Vercel AI's human-in-the-loop hooks.

### `solana-agent-kit`

A `BaseWallet` adapter for sendaifun's `SolanaAgentKit`. Lets users plug user-approval signing into the kit alongside its Privy / Turnkey / Phantom backends without holding keys. Read `packages/solana-agent-kit/src/` for exact shape. The companion RFC document is at `docs/outreach/sendaifun-rfc.md`.

## What is stubbed or missing

- **No tests anywhere.** Five packages, zero `*.test.ts` files. P2-1, P2-2, P2-3 below.
- **No CI.** No `.github/workflows/`. P2-8 below.
- **`solana_simulate_transaction` MCP tool.** Spec lists it; server omits it. P2-4 below.
- **`apps/` is empty.** No reference agent demo. P3-7 below.
- **iOS deeplink backend.** Blocked on `ios-solana-wallet-adapter` Phase 2 (NaCl box layer). P3-5 below.
- **Android MWA backend.** Not started. P3-6 below.
- **LangChain JS, LangChain Python, CrewAI, Pydantic AI.** Not started. P3-1 through P3-4 below.
- **Approval-resource UX.** The MCP server returns plain JSON text content. We have not yet experimented with markdown-resource shapes that Claude Desktop renders better. P2-5 below.
- **Real Claude Desktop end-to-end smoke.** `docs/claude-desktop-setup.md` exists with the registration block, but no documented round-trip with screenshots. P2-6 below.
- **Real browser-extension smoke.** `pnpm smoke:web` (Vite dev server) runs, but no documented round-trip against the actual Phantom or Solflare extensions on devnet. P2-7 below.
- **Mock backend never resolves.** This is intentional, not a bug; document it more clearly in the package README. (Trivial; do alongside any P2 work in `mcp-server`.)

## Build, test, run

Top-level scripts (run from repo root):

```sh
pnpm install                            # install workspace deps
pnpm build                              # tsc -b across all packages
pnpm typecheck                          # tsc --noEmit across all packages
pnpm test                               # currently a no-op, no test runners wired
pnpm lint                               # currently a no-op, no linter wired
pnpm smoke:web                          # vite dev server for the browser smoke runner
pnpm clean                              # rm dist/, .turbo/, node_modules/.cache/
```

Per-package builds (the `-F` filter is `--filter`):

```sh
pnpm -F @solana-agent-wallet-adapter/core build
pnpm -F @solana-agent-wallet-adapter/mcp-server build
pnpm -F @solana-agent-wallet-adapter/wallet-standard-web build
pnpm -F @solana-agent-wallet-adapter/vercel-ai build
pnpm -F @solana-agent-wallet-adapter/solana-agent-kit build
```

Run the MCP server:

```sh
# stdio (this is what Claude Desktop registers):
node packages/mcp-server/dist/bin/server.js

# HTTP, default 127.0.0.1:8723:
node packages/mcp-server/dist/bin/serverHttp.js

# HTTP with a public bind and stateful sessions:
HOST=0.0.0.0 PORT=9000 MCP_STATEFUL=1 node packages/mcp-server/dist/bin/serverHttp.js
```

Smoke the HTTP server with curl (replace `<id>` with a UUID for stateful mode):

```sh
curl -s -X POST http://127.0.0.1:8723/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Browser smoke (real wallet extensions):

```sh
pnpm smoke:web                          # opens vite at http://localhost:5173
```

## Phase 2 task queue

Top-down. Codex should do them in order unless a blocker forces reordering. Each task should produce one commit; reference the task ID in the commit subject (for example, `P2-1: add core test suite`).

### P2-1. Add a Vitest test suite to `core/`

**Why.** Every other package depends on `core`. Polling, timeout, and cancellation in `client.ts` are subtle and untested.

**Files to touch.**

- `packages/core/vitest.config.ts` (new)
- `packages/core/src/__tests__/client.test.ts` (new)
- `packages/core/src/__tests__/errors.test.ts` (new)
- `packages/core/src/__tests__/ids.test.ts` (new)
- `packages/core/package.json` (add `test` and `test:watch` scripts, add `vitest` to devDependencies, add `vitest` to root `pnpm test` filter once at least one package has tests)

**Cases to cover.**

- `ProtocolError.fromPayload` and `toPayload` round-trip every `ErrorCode`.
- `ProtocolError.recoverable` matches the spec table.
- `newSigningRequestId()` returns `sar_` + 24 lowercase hex chars; calling it 1000 times produces 1000 unique values.
- `SolanaSigningClient.signMessage` resolves on `status: 'approved'`.
- `SolanaSigningClient.signMessage` rejects with `ProtocolError(user_rejected)` on `status: 'rejected'`.
- `SolanaSigningClient.signMessage` rejects with `ProtocolError(expired)` after the timeout, default 120s, override to 50ms in test.
- `SolanaSigningClient.cancel(requestId)` aborts an in-flight wait without error and the waiter rejects with a `cancelled` error.

**Success.**

```sh
pnpm -F @solana-agent-wallet-adapter/core test
```

prints a green Vitest summary with at least 15 assertions across the three files.

**Scope.** small.

### P2-2. Test the MCP server against the mock backend

**Why.** Tool input schemas drift silently; a typo in a Zod schema breaks Claude Desktop without any compile-time warning.

**Files.**

- `packages/mcp-server/src/__tests__/server.test.ts` (new)
- `packages/mcp-server/vitest.config.ts` (new)
- `packages/mcp-server/package.json` (add test script)

**Cases.**

- Call `tools/list`. Assert exactly the five expected tool names appear (or six after P2-4 lands).
- For each tool, call with a valid input and assert the response shape matches what `core/types.ts` says.
- For each tool, call with malformed input. Assert the response carries `isError: true` and a Zod-validation message.
- `solana_check_approval` for an unknown id returns a structured `protocol_error` with code `invalid_request`.

**Success.**

```sh
pnpm -F @solana-agent-wallet-adapter/mcp-server test
```

passes. Server is exercised in-memory (use the SDK's in-process transport, not the stdio bin).

**Scope.** medium.

### P2-3. Test `wallet-standard-web` with a fake Wallet Standard wallet

**Why.** The only real-wallet path right now. We are about to plug it into Claude Desktop and Vercel AI SDK; regressions here are user-visible.

**Files.**

- `packages/wallet-standard-web/src/__tests__/backend.test.ts` (new)
- `packages/wallet-standard-web/vitest.config.ts` (new)
- `packages/wallet-standard-web/package.json` (add test script)
- A small `__tests__/fakeWallet.ts` that exposes `StandardConnect`, `SolanaSignMessage`, `SolanaSignTransaction`, `SolanaSignAndSendTransaction` features against in-memory keypairs.

**Cases.**

- Cluster mismatch: construct backend for `mainnet-beta`, give it a wallet that only supports `devnet`, assert the constructor throws `cluster_mismatch`.
- `getAddress()` calls `ensureConnected()` exactly once across two consecutive calls.
- `submit(signMessage)` returns a pending resource, then `poll()` flips to `approved` once the fake wallet's pending promise resolves.
- `submit(signTransaction)` round-trips: bytes in, signed bytes out.
- `submit(signAndSendTransaction)` returns `txid` (the fake wallet returns a deterministic 64-byte signature; verify base58 of it).
- `cancel(id)` aborts an in-flight task; the waiter sees a `cancelled` resolution.

**Success.**

```sh
pnpm -F @solana-agent-wallet-adapter/wallet-standard-web test
```

passes.

**Scope.** medium.

### P2-4. Wire the `solana_simulate_transaction` MCP tool

**Why.** Spec lists it. Without simulation the agent has no way to surface a "this transaction would fail" warning before asking the user to approve.

**Files.**

- `packages/core/src/backend.ts` (add optional `simulate?(tx: SigningRequest): Promise<SimulationResult>` to `WalletBackend`)
- `packages/core/src/client.ts` (add `simulateTransaction()` method on `SolanaSigningClient`)
- `packages/mcp-server/src/server.ts` (register the sixth tool with Zod schema, route to `backend.simulate?` if present, return a structured error if the backend does not implement it)
- `packages/mcp-server/src/mockBackend.ts` (add a no-op simulate that returns `{err: null, logs: ['mock simulation'], unitsConsumed: 0}`)
- `packages/wallet-standard-web/src/backend.ts` (call the wallet's simulate feature if exposed; otherwise return `unsupported_method`)

**Success.**

```sh
node packages/mcp-server/dist/bin/server.js
# from another terminal, list tools, expect 6, call the simulate tool, get a SimulationResult
```

**Scope.** small.

### P2-5. Approval-resource UX prototype

**Why.** Claude Desktop renders MCP resources differently depending on shape. Right now `server.ts` emits plain JSON text. Markdown resources, or hybrid JSON-plus-markdown, may render with a real approve / reject affordance and a simulation summary. This is the difference between "agent prints JSON" and "user sees a real approval card."

**Files.**

- `packages/mcp-server/src/server.ts` (add a `renderApprovalMarkdown(approval)` helper, expose a flag to switch between renderers)
- `docs/research/note-07-approval-ux.md` (new): document the four shapes tried, the one that won, screenshots from Claude Desktop.

**Success.** A real Claude Desktop screenshot in the research note showing the approval panel with a transaction summary, simulation result, risk badge, and approve / reject buttons. The selected renderer becomes the default in `server.ts`.

**Scope.** medium. Requires manual smoke through Claude Desktop, no way to automate.

### P2-6. End-to-end Claude Desktop smoke

**Why.** The whole project is designed around this surface. We need a documented round-trip.

**Files.**

- `docs/smoke/claude-desktop.md` (new): registration block, walk-through of each tool call, screenshots, failure modes hit.
- `docs/claude-desktop-setup.md` (existing): cross-link to the smoke walk-through.

**Success.** A reader of `docs/smoke/claude-desktop.md` can follow the steps, register the stdio bin with their Claude Desktop install, prompt the agent to "sign hello on devnet," see the approval card, click approve in the mock backend, and see the (mock) signature returned to the agent. Failure modes encountered (Claude Desktop renderer quirks, schema rejections, transport timeouts) are documented.

**Scope.** medium. Manual.

### P2-7. Real browser-extension smoke

**Why.** `wallet-standard-web` has only been compiled and unit-tested. We need to run it against an actual Phantom or Solflare extension on devnet at least once.

**Files.**

- Extend the existing Vite smoke runner from commit `4e11377`.
- `docs/smoke/browser-wallet-standard.md` (new): walk-through, screenshots, devnet signature ids.

**Success.** Two screenshots per wallet (Phantom and Solflare): one of the connect flow, one of a signed devnet message visible on Solana explorer. Note any wallet-specific quirks.

**Scope.** small.

### P2-8. CI

**Why.** Codex will create regressions; humans will create regressions. CI catches them at PR time.

**Files.**

- `.github/workflows/ci.yml` (new). Run on push to master and on PR. Steps: checkout, setup-node@v4 with Node 20, setup pnpm@10, `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm -r test`, `pnpm build`. Cache the pnpm store.
- README badge (added in P3-8).

**Success.** First push has a green check.

**Scope.** small.

## Phase 3 task queue

Lower priority than Phase 2. These can be picked up out of order; the framework integrations are independent of each other.

### P3-1. LangChain JS tool package

New package `packages/langchain-js`. Wraps `SolanaSigningClient` as one or more LangChain `Tool` instances. Probably one tool per signing kind, plus one for `getAddress`. Sample usage script in `examples/langchain-js/sign-message.ts` that talks to the mock backend.

**Scope.** small.

### P3-2. LangChain Python tool package

New package `packages/langchain-py`. Python is outside the pnpm workspace; needs a `pyproject.toml`. Calls the MCP server over HTTP rather than the TypeScript client (cleanest cross-language path). Example notebook signs devnet via the mock backend.

**Scope.** small.

### P3-3. CrewAI tool package

New package `packages/crewai`. Python, HTTP-only. Same pattern as P3-2.

**Scope.** small.

### P3-4. Pydantic AI tool package

New package `packages/pydantic-ai`. Python, HTTP-only. Same pattern as P3-2.

**Scope.** small.

### P3-5. iOS deeplink `WalletBackend`

New package `packages/ios-deeplink`. **Blocked on `ios-solana-wallet-adapter` Phase 2** (the NaCl box layer must be wired in the Swift package before this TypeScript bridge has anything to talk to). When unblocked, this package exposes a `WalletBackend` whose `submit()` opens an iWA universal link from a small SwiftUI host process and returns the redirect-URL response. Likely needs a tiny Swift companion binary that the Node side spawns.

**Scope.** medium. Pause on this until iOS Phase 2 ships.

### P3-6. Android MWA `WalletBackend`

New package `packages/mwa-android`. JNI bridge to the official MWA clientlib (`mobile-wallet-adapter-clientlib-ktx`), exposed as `WalletBackend`. Mirrors the architecture the user already shipped in Cocos / Godot / Unity / Capacitor SDKs.

**Scope.** large.

### P3-7. Reference agent demo

New `apps/reference-agent`. An autonomous agent (trading, prediction-market, NFT-mint, pick one) that runs in Claude Desktop and uses only the user's actual wallet via the MCP server plus `wallet-standard-web` backend. Goal: a 3-minute video demo.

**Scope.** large.

### P3-8. Update the agent README

The current `README.md` says "early scaffolding." That is no longer true. Once P2-5 and P2-6 land (so the README can claim a verified Claude Desktop round-trip), rewrite the README in the same style as `~/Desktop/projects/ios-solana-wallet-adapter/README.md`. Add a CI badge once P2-8 lands.

**Scope.** trivial. Hold until earlier P2 tasks land.

## Known issues and gotchas

1. **Mock backend never auto-resolves.** `mockBackend.poll()` returns the same pending approval every call. This is by design (it lets you observe the polling loop), but it confuses people the first time. Document this in `mockBackend.ts` and in `docs/claude-desktop-setup.md`.
2. **`tools.ts` is empty.** It was originally intended to host tool registration; everything ended up in `server.ts`. Don't waste time refactoring; it is a 0-byte placeholder we kept so an old import path still resolves if anyone added one.
3. **The HTTP bin is not in `package.json:bin`.** Only the stdio bin is. If you want the HTTP bin globally invokable, you need to either add it to `bin` or invoke it via `node ./packages/mcp-server/dist/bin/serverHttp.js`. The reason it is not in `bin` is that npm bin scripts get one name; we picked the stdio one because it is what Claude Desktop registers.
4. **`pnpm test` and `pnpm lint` are no-ops at the root** until at least one package has a `test` or `lint` script. Do not assume they ran successfully if they print nothing.
5. **`StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk` is the right choice for HTTP**, not `SSEServerTransport`. The streamable transport is the post-2025 standard; SSE was the legacy path.
6. **Bs58 vs base64.** Signatures are bs58, transaction wire-format is base64. Do not mix these up; both `wallet-standard-web/backend.ts` and `mcp-server/server.ts` carefully separate them.

## Open questions for the human

These need your judgment, do not guess:

1. **LangChain JS or Python first (P3-1 vs P3-2)?** They are similar effort. JS is closer to the existing TypeScript stack; Python is closer to the agent-framework center of gravity (CrewAI, Pydantic AI are Python).
2. **Where does the iOS deeplink package live?** Cleanest architecturally to keep it in this repo (it implements `WalletBackend` from this repo). It will need a Swift companion that talks to the iWA Swift package; that companion can either be a thin script in this repo's `tools/` directory or a separate published binary.
3. **Public framing.** The repo description currently says "MWA for AI agents." The framing memo from the gap session says drop the MWA claim from public copy because MWA is Android-only. Should the README and `package.json:description` be rewritten to "Solana wallet adapter for AI agents" (per the memo) or stay as-is (per the user's stated preference for keeping the repo name)? Codex should not change this without confirmation.
4. **Should `solana_simulate_transaction` always run before `solana_sign_*`** (a guardrail), or only on agent request (a tool the agent chooses to call)? Two valid UX paths; spec is silent.

## Pointers

- Spec: [`spec/protocol.md`](spec/protocol.md)
- Research notes:
  - [`docs/research/01-mcp-client-ux.md`](docs/research/01-mcp-client-ux.md)
  - [`docs/research/02-mcp-approval-prior-art.md`](docs/research/02-mcp-approval-prior-art.md)
  - [`docs/research/03-mcp-spec-streaming.md`](docs/research/03-mcp-spec-streaming.md)
  - [`docs/research/04-sendaifun-coordination.md`](docs/research/04-sendaifun-coordination.md)
  - [`docs/research/05-framework-signer-shapes.md`](docs/research/05-framework-signer-shapes.md)
  - [`docs/research/06-prior-art-audit.md`](docs/research/06-prior-art-audit.md)
- Outreach: [`docs/outreach/sendaifun-rfc.md`](docs/outreach/sendaifun-rfc.md)
- Claude Desktop setup: [`docs/claude-desktop-setup.md`](docs/claude-desktop-setup.md)
- Master plan (long form survey, picks, full reasoning): `~/.claude/plans/so-we-were-able-tidy-newell.md`
- Sibling project (iOS Wallet Adapter): `~/Desktop/projects/ios-solana-wallet-adapter`
- Sibling project (Unreal MWA): `~/Desktop/projects/unreal-solana-mwa`

## Conventions to follow

1. **TypeScript strict.** `tsconfig.base.json` enables `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`. Do not loosen.
2. **ESM with NodeNext resolution.** Every package is `"type": "module"`, exports `dist/index.js`. Do not commit CJS.
3. **No dependencies on `node` builtins from packages that may run in a browser.** `wallet-standard-web` is a browser package; do not import `crypto` or `buffer` from `node:`. Use `globalThis.crypto` and `Uint8Array`.
4. **Workspace deps use `workspace:*`.** Never use a fixed version inside the repo.
5. **One commit per task.** Reference the task ID (`P2-1`, `P2-4`, etc.) in the commit subject. Use HEREDOC for multi-line bodies.
6. **No em-dashes or en-dashes** in any prose, in any file. Use commas, colons, periods, parentheses, semicolons.
7. **No AI attribution in commit messages or public copy.** No "Generated with Claude," no "Co-Authored-By," no signed-off-by lines that point at a model. Internal docs are fine; public output is not.
8. **No grant precedent framing.** Do not write copy that asserts a prior or expected grant unless you have direct confirmation; it is the user's reputation, not yours.
9. **Don't replace the spec without versioning.** `spec/protocol.md` is at draft v0.1. If you change the wire shape, bump to v0.2 and add a `## Changelog` entry at the top.
10. **Every research note gets a number.** New notes are `docs/research/NN-slug.md` where NN is the next free number (after `06`, that is `07`).
11. **Mock backend stays simple.** Do not add real state to it. If you need a richer fake, build a separate `fakeWalletStandardBackend.ts` for tests.

## Changelog

- **2026-05-03**: initial STATUS.md. Snapshot at commit `4e11377`. P2 and P3 task queues defined.
