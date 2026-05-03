# PROGRESS, handoff for the next agent

This document is for whoever picks this project up next. It captures the exact state of the repo as of the last commit, plus the current dirty worktree that landed after `4e11377`. For the short current-state snapshot, read `STATUS.md` after this file.

If you are an agent reading this cold: read this file from top to bottom before writing any code. Then read the plan file referenced under "Where the deep context lives." Then read the six research notes in `docs/research/`. Then start on the next task in the priority list.

## Snapshot

- **Date:** 2026-05-03
- **Branch:** `master`
- **HEAD:** `4e11377` (B2f: Solana Agent Kit BaseWallet adapter + Vite browser smoke + sendaifun RFC)
- **Remote:** `git@github.com:mstevens843/solana-agent-wallet-adapter.git`
- **Commits ahead of `origin/master`:** verify with `git status` before pushing
- **Total commits:** 5
- **Packages:** 5 plus 2 demo apps in the current worktree
- **Build status:** `pnpm build` should report Done across packages and apps
- **Type check status:** `pnpm typecheck` was clean after the demo and test work
- **Test status:** `pnpm -r test` was clean after the core, MCP server, and Wallet Standard suites landed
- **MCP smoke status:** confirmed end to end in real Claude Code client (CLI), three prompts exercised every signing tool

## Repo tree, annotated

```
solana-agent-wallet-adapter/
├── .gitignore
├── LICENSE                       Apache-2.0
├── README.md                     public facing pitch and quick start
├── PROGRESS.md                   this file
├── package.json                  pnpm workspace root, smoke:web script
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.base.json            strict TS, exactOptionalPropertyTypes intentionally off
├── vite.config.js                browser smoke dev server config
├── test.html                     browser smoke harness, served by vite
├── apps/
│   ├── browser-demo              polished Wallet Standard browser demo
│   └── reference-agent           agent-plan browser demo with OpenAI fallback
├── docs/
│   ├── claude-desktop-setup.md   step by step for the GUI app smoke
│   ├── outreach/
│   │   └── sendaifun-rfc.md      RFC draft, not yet posted on GitHub
│   └── research/
│       ├── 01-mcp-client-ux.md             how Claude Desktop / Cursor / Inspector render tool results
│       ├── 02-mcp-approval-prior-art.md    survey of MCP servers with approval flows
│       ├── 03-mcp-spec-streaming.md        MCP spec on push notifications, sampling, resources
│       ├── 04-sendaifun-coordination.md    SAK roadmap signal + adapter shape
│       ├── 05-framework-signer-shapes.md   exact tool/signer shape for each AI framework
│       └── 06-prior-art-audit.md           pre push category audit (the wedge that's empty)
├── examples/
│   └── claude-desktop-config.json   drop in MCP config for the GUI app
├── packages/
│   ├── core/                     protocol types + SolanaSigningClient
│   ├── mcp-server/               MCP server, stdio + HTTP, mock backend, two bins
│   ├── wallet-standard-web/      browser WalletBackend over @wallet-standard/app
│   ├── vercel-ai/                Vercel AI SDK 5 tool definitions
│   └── solana-agent-kit/         BaseWallet adapter for sendaifun's SolanaAgentKit
└── spec/
    └── protocol.md               draft v0.2 of the agent wallet adapter protocol
```

## Package status

| Package | Source files | Builds | Smoked | Notes |
| --- | --- | --- | --- | --- |
| `@solana-agent-wallet-adapter/core` | 6 (`types.ts`, `errors.ts`, `backend.ts`, `ids.ts`, `client.ts`, `index.ts`) | yes | yes (via tests and mcp-server stdio smoke) | `SolanaSigningClient.run()` is the central submit + poll loop; `simulateTransaction()` delegates to optional backend simulation. |
| `@solana-agent-wallet-adapter/mcp-server` | 6 source files plus tests | yes | yes (raw JSON-RPC + Claude Code) | Six tools including `solana_simulate_transaction`. Two bins: stdio and Streamable HTTP. Mock backend ships in the bin so first registration works without any wallet. |
| `@solana-agent-wallet-adapter/wallet-standard-web` | 3 source files plus tests | yes | yes (Backpack, browser harness) | Implements `WalletBackend` over `@wallet-standard/app` `getWallets()`. Browser only by design and no longer imports Node builtins. |
| `@solana-agent-wallet-adapter/vercel-ai` | 2 source files, 124 lines total | yes | not yet | Four `tool()` definitions wrapping `SolanaSigningClient`. AI SDK 5 dropped `needsApproval`, approval enforcement lives in the underlying client which blocks until the wallet resolves. |
| `@solana-agent-wallet-adapter/solana-agent-kit` | 2 source files, 175 lines total | yes | not yet | `AgentWalletAdapterBackend` implements the minimal `BaseWallet` from `solana-agent-kit` v2. Static `create()` lazily fetches the address. Supports `Transaction` and `VersionedTransaction`. |

Total source: roughly 1400 lines of TypeScript, distributed across the five packages.

## Verification done

These have all been confirmed by running them, not by inspection.

- `pnpm install` clean from a fresh clone (verified after the last commit; pnpm 10.33.0 expected per `packageManager` field).
- `pnpm build` reports Done for packages and apps.
- `pnpm typecheck` reports clean.
- `pnpm -r test` reports clean for core, mcp-server, and wallet-standard-web.
- Stdio MCP smoke via raw JSON-RPC: `initialize` returns capabilities, `tools/list` returns six tools with correct JSON Schema, `tools/call` for `solana_get_address` returns the mock address, `tools/call` for `solana_sign_message` returns a humanized pending `ApprovalResource` with the request id and approval URI.
- HTTP MCP smoke via `curl`: in stateful mode (`MCP_STATEFUL=1`), `initialize` returns an `mcp-session-id` header, follow up requests with that header succeed, `tools/list` advertises all six tools, server stays up across requests.
- Claude Code MCP smoke (real CLI client): three prompts exercised the full happy path. Prompt 1 ("What's my Solana wallet address?") triggered `solana_get_address` and Claude correctly identified the response as the mock address. Prompt 2 ("Sign the message 'hello' on devnet, summary: test") triggered `solana_sign_message`, returned a pending state, Claude correctly extracted the request id, then auto called `solana_check_approval` to poll. Prompt 3 explicit poll on the request id returned still-pending. The mock backend never resolves on its own, that's intentional and correct.
- Browser Wallet Standard smoke via Backpack: `pnpm smoke:web --host 127.0.0.1` served `http://localhost:5173/test.html`, `List wallets` discovered seven Wallet Standard providers, `Get address` returned `9W6pmAzjQGxNiu3yQAZ4dE1FwmvHexWEuWGdYZnnyEu1`, and `Sign 'hello' on devnet` returned signature `AfVhSRZmGuomfo4P6Pop2h2tB4ZgRq17bCMQ1gbkUUid1AdWoRHpekWnRYGdiEsx4MBhE4dt94i3QcHjuoQwziV`. Details are recorded in `docs/smoke/browser-wallet-standard.md`.

## Verification outstanding

Ordered by importance.

1. **Claude Desktop GUI smoke.** The user already merged the MCP config into `~/Library/Application Support/Claude/claude_desktop_config.json` (entry name `solana-agent-wallet`). Quit and relaunch the GUI app, run the same three prompts. Validates that the humanized text renders the same way in the GUI client as it did in the CLI.
2. **Phantom and Solflare browser smoke.** Backpack passed the real Wallet Standard path. Repeat `pnpm smoke:web`, choose Phantom and then Solflare from the wallet dropdown, click Get address, then Sign hello on devnet.
3. **Vercel AI agent end to end.** Tiny Node script: instantiate `WalletStandardWebBackend`, wrap with `SolanaSigningClient`, pass to `createSolanaTools`, call `generateText` from `ai` with an OpenAI or Anthropic model, prompt "sign hello on devnet." Confirms the AI SDK 5 tool wiring works in a real model call, not just type check.
4. **Solana Agent Kit end to end.** Wrap the same client with `AgentWalletAdapterBackend.create({ backend, cluster: 'devnet' })`, instantiate `SolanaAgentKit`, call something light like `agent.getBalance()` or a no-op signMessage. Confirms the `BaseWallet` interface mapping is correct in practice and not just at the type level.
5. **Android Saga emulator smoke.** Blocked on the `mwa-android` package which has not been built yet.
6. **iOS Phantom deeplink smoke.** Blocked on the `ios-deeplink` package which has not been built yet (sibling repo `ios-solana-wallet-adapter` has the scaffold for the spec piece).

## Coordination outstanding

- **Sendaifun RFC.** Drafted at `docs/outreach/sendaifun-rfc.md`. Title and body are ready to paste into a new GitHub issue at <https://github.com/sendaifun/solana-agent-kit/issues/new>. Replace `[your-handle]` at the bottom with the actual GitHub username before posting. Recommended sequence: validate the SAK adapter end to end (item 4 above) first, then post the RFC so the body links to a working commit.
- **MCP Registry submission.** Not yet submitted. Wait until the package is published to npm and the Android backend lands.
- **Solana Mobile docs listing request.** Not yet sent. Their docs site lists Flutter, Unity, Unreal community SDKs but no MCP-shaped entry. Worth opening a separate conversation once we have one published version on npm and one demo video.

## Reservations outstanding

- **npm namespace `@solana-agent-wallet-adapter/*` is unclaimed.** Per the prior art audit (`docs/research/06-prior-art-audit.md`), this slug is empty on npm and on GitHub. The repo is now public on GitHub at `mstevens843/solana-agent-wallet-adapter`, so the GitHub side is reserved. npm is still wide open and should be locked next. Publish each package at `0.0.1` even if pre-stable, the names are what we are protecting, the version can churn.
- **Sibling repo names.** `ios-solana-wallet-adapter` is reserved on GitHub at `mstevens843/ios-solana-wallet-adapter`, scaffolded with 25 files in an initial commit. `unreal-solana-mwa` exists locally at `~/Desktop/projects/unreal-solana-mwa` but the folder is empty and the repo has not been pushed to GitHub yet.

## Sibling top-3 projects

The agent project is one of three SDKs the user committed to shipping by 2026-05-31. The full ranking and reasoning live at `~/Desktop/projects/SDK_GAP_RANKING.md`.

| Repo | Path | Status | Impact rating |
| --- | --- | --- | --- |
| `solana-agent-wallet-adapter` (this) | `~/Desktop/projects/solana-agent-wallet-adapter/` | Phase 1 mostly done, see this file | 88/100 |
| `ios-solana-wallet-adapter` | `~/Desktop/projects/ios-solana-wallet-adapter/` | Scaffold pushed, 25 files including Phantom + Solflare + Backpack adapter stubs and per-wallet research notes | 92/100 |
| `unreal-solana-mwa` | `~/Desktop/projects/unreal-solana-mwa/` | Empty folder. No GitHub remote yet | 80/100 |

## Where the deep context lives

Read in this order if you are starting cold:

1. **`~/.claude/plans/so-we-were-able-tidy-newell.md`**. The master plan file. Contains the full gap hunt narrative (~15 categories surveyed across 7 explore agents), the filter that narrowed to top 3, the architecture for this project, and three continuation sections covering everything that has happened in this and prior sessions. Long, but every section is dense.
2. **`~/Desktop/projects/SDK_GAP_RANKING.md`**. The 32 row impact ranking out of 100, four tier breakdown, MWA vs not reframe, top 3 commitment with 2026-05-31 target.
3. **`~/Desktop/projects/RESEARCH_SUMMARY.md`**. One page survey overview. Five highlights worth remembering.
4. **This file (`PROGRESS.md`)**. Exact state plus next tasks.
5. **`spec/protocol.md`**. Protocol design draft v0.2. Read before touching the wallet backend or core types.
6. **`docs/research/01-` through `06-`**. The six research notes. Each is one page. Read 04 (sendaifun coordination), 05 (framework signer shapes), and 06 (prior art audit) before touching the next set of integration packages.

## Next tasks ordered by leverage

Each task has a number, a short description, expected outcome, files to create or modify, and a rough scope (small under 2 hours, medium 2 to 8 hours, large 8 plus).

### 1. Real wallet end to end smoke (small, your hand on the keyboard)

Outcome: confirm the entire pending → approved → signature lifecycle through a real wallet, not just the protocol shape.

Steps:
- `pnpm smoke:web`
- click List wallets, Get address, Sign hello on devnet
- record any errors in the browser console (F12)

If it works, mark `wallet-standard-web` as smoked. If it fails, file an issue or fix in place. Common failure modes: wallet locked, no Solana wallet installed, popup blocked.

### 2. ElizaOS userwallet plugin (medium)

Outcome: a non custodial alternative to ElizaOS `plugin-solana-v2` (which uses a flat custodial keypair). Plugs `WalletBackend` into the ElizaOS plugin slot so an Eliza agent can act through the user's real wallet.

Files to create:
- `packages/elizaos/package.json`, `tsconfig.json`, `src/index.ts`, `src/plugin.ts`, `README.md`

Reuse: `SolanaSigningClient` from core, the `BaseWallet` mapping pattern from `packages/solana-agent-kit/src/adapter.ts`. Read the ElizaOS plugin interface first (their `Plugin` type, action handler signatures), do not assume it matches LangChain or Vercel AI shapes.

Estimated scope: medium (2 to 8 hours), most of which is reading their plugin interface and matching it.

### 3. npm namespace stubs published at 0.0.1 (small, requires user's npm credentials)

Outcome: `@solana-agent-wallet-adapter/*` is locked on npm so nobody else can grab it.

Steps:
- Verify `pnpm whoami` (or `npm whoami`) returns the expected account.
- For each of the five built packages, `cd packages/<name> && pnpm publish --access public`.
- `core` first, then `wallet-standard-web` (depends on core), then `mcp-server`, then `vercel-ai`, then `solana-agent-kit`.
- Bump version to 0.0.2 if 0.0.1 fails because of a name dispute.

User must run this themselves; the npm token is their account, not Codex's.

### 4. LangChain JS adapter (medium)

Outcome: third framework integration after Vercel AI and SAK. LangChain has the largest community of the AI agent toolkits.

Files to create:
- `packages/langchain-js/package.json`, `tsconfig.json`, `src/index.ts`, `src/tools.ts`, `README.md`

Reuse: read `docs/research/05-framework-signer-shapes.md` for the exact `StructuredTool` signature LangChain expects. Mirror the shape of `packages/vercel-ai/src/tools.ts` but emit `StructuredTool` instances instead of `tool()` results. Schema is Zod, return type is string (or stringified JSON), async via `_call`.

### 5. LangChain Python adapter (medium)

Outcome: parity with LangChain JS for Python users.

Files to create:
- `packages/langchain-py/pyproject.toml`, `solana_agent_wallet_adapter_langchain/__init__.py`, `solana_agent_wallet_adapter_langchain/tool.py`, `README.md`

This package is Python, not TypeScript, so it sits outside the pnpm workspace. The Python side talks to the MCP server over HTTP transport (B2b is the bin already shipped) rather than to `SolanaSigningClient` directly, since the client is TypeScript. Implement `BaseTool` from `langchain-core`, async via `_arun`, schema via Pydantic.

### 6. CrewAI tool wrapper (small to medium)

Same shape as LangChain Python but using `crewai.tools.BaseTool`. Return type must be `str`, not arbitrary JSON. Schema via Pydantic. See `docs/research/05-framework-signer-shapes.md` for the gotchas.

### 7. Pydantic AI tool wrapper (small to medium)

Same approach. Pydantic AI uses decorator-driven tool registration (`@agent.tool`), schema is auto inferred from the Python function signature plus docstring. Read their docs at <https://pydantic.dev/docs/ai/tools-toolsets/tools/> first.

### 8. Reference autonomous agent (medium to large)

Outcome: `apps/reference-agent` script that does one Jupiter swap end to end on devnet, signed through Phantom, narrated in Vercel AI or LangChain. The hackathon submission video material lives here.

Files to create:
- `apps/reference-agent/package.json`, `tsconfig.json`, `src/agent.ts`, `README.md`

Reuse: existing Vercel AI integration, `SolanaSigningClient`, `WalletStandardWebBackend`. The Jupiter API is straightforward, see `https://dev.jup.ag/`.

### 9. React Native sample app (large)

Outcome: `apps/mobile-sample` Expo or bare RN app that hosts the MCP server locally, exposes it to Claude over HTTP transport (B2b bin), and routes signing through the device's installed wallets.

Blocked on: the Android backend (`mwa-android` package) which does not exist yet. Either build that first or run the mobile sample with the mock backend until the real one ships.

### 10. Android backend (large)

Outcome: `packages/mwa-android` wrapping `@solana-mobile/mobile-wallet-adapter-protocol`. Implements `WalletBackend` over real MWA. Talks to a connected Saga or Seeker, or to an Android emulator with Phantom installed.

Reuse: the Android SDK part of `@solana-mobile/mobile-wallet-adapter-protocol`. The user has shipped four MWA wrappers already (Cocos, Godot, Unity, Capacitor), this one is the same shape applied to a TypeScript package layer.

### 11. iOS deeplink backend (large)

Outcome: `packages/ios-deeplink` wraps the protocol shipped in the sibling `ios-solana-wallet-adapter` repo. Phantom + Solflare + Backpack universal links, AES-GCM session, signature decoding.

Blocked on: the sibling repo's spec being stable. The sibling repo has scaffold pushed (Sources/SolanaWalletAdapterPhantom/, etc) but the implementations are stubs. This package wraps whatever the sibling repo eventually publishes.

## Hard rules for the next agent

These are non negotiable. Violating any of them creates rework or contradicts prior decisions.

- **No em-dashes (U+2014) or en-dashes (U+2013).** Use commas, periods, parentheses, colons. The user's feedback memory is explicit on this. Visual scan the docs you generate before saving.
- **No AI attribution in public-facing copy.** README, package descriptions, marketing copy, GitHub issue text. Internal docs and commit messages are fine. The user's feedback memory `feedback_no_ai_attribution.md` is explicit.
- **Public framing is "Solana wallet adapter for AI agents," not "MWA for AI agents."** MWA is Android-only by protocol. Only the future `mwa-android` package is real MWA. The cocos / godot / unity / capacitor work the user has already shipped is real MWA. This project is adjacent infrastructure, not MWA itself, even though the repo name retains the historical phrasing.
- **No grant or Unity or Godot framing as a credential.** The user's feedback memory `feedback_no_grant_precedent_framing.md` is explicit. Do not lead with "after funded grants for Unity and Godot" anywhere public.
- **License is Apache-2.0.** All packages, no exceptions.
- **`exactOptionalPropertyTypes` is intentionally off in `tsconfig.base.json`.** It produced too much friction with third party SDK type definitions (MCP transport types, Vercel AI 5 tool overloads, Wallet Standard optional props). Do not turn it back on without converting every use site to conditional spreads. The relaxation is documented in commit `12b6d7d`.
- **AI SDK 5 dropped the `needsApproval` flag from `tool()`.** Approval enforcement lives in `SolanaSigningClient.run()` in `packages/core/src/client.ts`, which polls until the wallet resolves. Do not try to reintroduce `needsApproval` on the Vercel AI tools, it does not exist on the v5 Tool type.
- **Claude Code (CLI, `claude` binary) and Claude Desktop (GUI app at `/Applications/Claude.app`) read different MCP configs.** Claude Code uses `claude mcp add` and stores in user settings. Claude Desktop reads `~/Library/Application Support/Claude/claude_desktop_config.json`. The user has both registered as of commit `4e11377`. If you add new MCP-shaped infrastructure, register it in both.
- **Mock backend never resolves to approved on its own.** That is intentional and correct. Real backends (`wallet-standard-web` today, `mwa-android` and `ios-deeplink` later) flip the status when the wallet popup completes. Do not patch the mock to auto resolve, that defeats the smoke test.
- **`SolanaSigningClient` blocks until the wallet resolves.** It polls `WalletBackend.poll(requestId)` every `pollIntervalMs` (default 500ms) up to `timeoutMs` (default 120000ms, 2 minutes). On timeout it cancels the request via the optional `WalletBackend.cancel()` method. The polling shape is the contract every framework adapter relies on. Do not change it without updating all five packages.

## Smoke recipes

Copy and paste blocks for every smoke procedure that exists today.

### Build everything

```bash
cd ~/Desktop/projects/solana-agent-wallet-adapter
pnpm install
pnpm -r --filter "./packages/*" build
```

All packages and apps should report `Done`. If any fail, fix before moving on.

### Type check

```bash
pnpm typecheck
```

Should produce no output (success). The strict TypeScript settings catch most regressions before they hit a build.

### Stdio MCP smoke (manual JSON-RPC)

```bash
(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
 sleep 0.2
 echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
 sleep 0.2
 echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
 sleep 0.5) | node packages/mcp-server/dist/bin/server.js | head -3
```

Expected: three lines of JSON, one for `initialize`, one for `tools/list` (with six tools), one trailing.

### HTTP MCP smoke (curl)

In one terminal:

```bash
PORT=8723 MCP_STATEFUL=1 node packages/mcp-server/dist/bin/serverHttp.js
```

In another:

```bash
curl -D /tmp/h.txt -s -X POST http://127.0.0.1:8723/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  >/dev/null

SID=$(grep -i 'mcp-session-id' /tmp/h.txt | awk -F': ' '{print $2}' | tr -d '\r\n')

curl -s -X POST http://127.0.0.1:8723/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

curl -s -X POST http://127.0.0.1:8723/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

Expected: `tools/list` response advertises six tools.

### Browser smoke (Vite)

```bash
pnpm smoke:web
```

Opens `http://localhost:5173/test.html` automatically. With Phantom or Solflare unlocked: List wallets, Get address, Sign hello on devnet. Watch for popup, approve, see signature.

### Claude Code MCP registration

```bash
claude mcp add --scope user solana-agent-wallet \
  node /Users/devlegacy/Desktop/projects/solana-agent-wallet-adapter/packages/mcp-server/dist/bin/server.js
claude mcp list
# expect to see solana-agent-wallet in the output
```

Then exit the current `claude` session, start a fresh one, ask the smoke prompts.

### Claude Desktop GUI registration

The user's config at `~/Library/Application Support/Claude/claude_desktop_config.json` already includes the `solana-agent-wallet` entry. Quit and relaunch the GUI app (Cmd+Q, then reopen from Applications), open a new chat, ask the smoke prompts.

Setup doc with screenshots for what to expect: `docs/claude-desktop-setup.md`.

## Known gotchas

Things that already burned an hour during the build session, listed so the next agent does not repeat the mistake.

- **`@wallet-standard/app` provides `getWallets()`, not `@wallet-standard/base`.** The base package is types only. Easy to misimport, builds fail with "no exported member."
- **Stateful HTTP transport requires `mcp-session-id` header echoed on every follow up call after init.** Without it, the server returns 400 `Mcp-Session-Id header is required`. Stateless mode (the default) bypasses this but has its own quirks (every request needs a fresh init).
- **`vite.config.js` `optimizeDeps.include` must list every bare specifier.** Browser smoke 404s in dev if a transitive bare import is missing from the include list. Current list covers `@solana-agent-wallet-adapter/core`, `@solana-agent-wallet-adapter/wallet-standard-web`, `@wallet-standard/app`, `@wallet-standard/base`, `@wallet-standard/features`, `@solana/wallet-standard-features`, `bs58`. Add new bare specifiers here when you add new browser-side packages.
- **Several SDK type definitions have optional-property variance issues with strict TypeScript.** We relaxed `exactOptionalPropertyTypes` to ship. Reintroducing it requires either upstream fixes or pervasive conditional spreads.
- **`solana-agent-kit` v2 dropped raw `KeypairWallet` for security.** The `BaseWallet` contract still includes it, the adapter does not need to special case anything. Just implement `BaseWallet` and let SAK route through whatever wallet you pass.
- **`McpServer.registerTool` from MCP SDK 1.x is the recommended API.** The older `Server.setRequestHandler(CallToolRequestSchema, ...)` is the low level form and has stricter return type constraints (the new task-shape variant). Use `registerTool`, type inference works through Zod schemas, no casts needed.
- **Mock backend address is the System Program (all 1s base58).** This is correct, not a bug. Claude will sometimes flag it as "not a real address," that is the model reasoning correctly about what it sees.
- **`pnpm smoke:web` requires `dist/` to exist for both `core` and `wallet-standard-web`.** Run `pnpm build` first.
- **Claude Desktop config edits do not take effect until the GUI app is fully quit (Cmd+Q).** Just closing the window keeps the app alive.
- **MCP server stderr is hidden when registered via `claude mcp add` or `claude_desktop_config.json`.** If the server fails to start, you see "tool not available" in the chat with no clue why. Run the bin directly (`node packages/mcp-server/dist/bin/server.js`) for a moment first to confirm it boots.

## Style and writing constraints

When the next agent generates docs, READMEs, commit messages, or marketing copy, honor these constraints carried over from the user's feedback memory.

- No em-dashes (U+2014). No en-dashes (U+2013). Use commas, periods, parentheses, colons. The user finds AI-generated em-dashes a tell. Visual scan plus a `grep -P '[\x{2013}\x{2014}]'` before saving.
- No AI attribution. Even when forms ask for tooling disclosure on submission pages, public copy stays human framed.
- No "third engine after Unity and Godot grants" framing in public copy. Internal context is fine.
- Tone: confident, technical, no hype. Read like an SDK README, not a launch announcement.
- Sentences over bullet salad where the prose reads better. The five research notes use sentences, the API docs use bullets, both work in context.

## How to validate the docs themselves

```bash
# em-dash and en-dash check
grep -P '[\x{2013}\x{2014}]' README.md PROGRESS.md
# expect no output

# Markdown render sanity
# render README.md and PROGRESS.md in any GitHub-compatible viewer, confirm tables, code fences, and headings all parse
```

If you generated new docs and either of those checks fails, fix before commit.

## Last user direction received

The user is hitting their weekly token allowance and is handing off to a different agent (Codex) to continue work. They asked for two beautifully written docs at the repo root: a public README rewrite (this commit's `README.md`) and a progress / handoff doc (this file). They explicitly said "no AI em-dashes or anything either" and that "tokens extra usage too expensive here," so the next agent should be efficient and avoid filler.

After this commit lands the user is stepping away. The next agent has full context to continue with task #1 (browser smoke) or task #2 (ElizaOS plugin) without further user input.
