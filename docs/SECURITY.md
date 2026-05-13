# Security

This project routes Solana signing through the user's real wallet. The agent process never sees a private key or seed phrase. This file documents the operator-side hygiene and architectural boundaries that keep that promise true under the May 2026 supply-chain threat family (Mini Shai-Hulud / CVE-2026-45321 and its siblings).

## Reporting a vulnerability

Open a private security advisory on GitHub (`Security` tab → `Report a vulnerability`). Do not file public issues for unfixed flaws.

## Operator hygiene checklist

Run this checklist on any dev machine that ran `pnpm install`, `npm install`, or `yarn install` between **2026-05-11 19:20 UTC** and the date you read this page.

1. Search every `node_modules` directory for the known payload:
   ```sh
   find . -name router_init.js -not -path '*/.git/*' \
     -exec shasum -a 256 {} \;
   ```
   The malicious payload SHA-256 is `ab4fcadaec49c03278063dd269ea5eef82d24f2124a8e15d7b90f2fa8601266c`. Any match is a confirmed compromise — wipe the machine.

2. Inspect AI-tool config dirs for unexpected MCP server entries or recent writes:
   ```sh
   ls -lat ~/.claude ~/.cursor ~/.windsurf ~/.codex 2>/dev/null
   ```
   Compare against your own expected MCP servers. Unknown entries → revoke and rotate.

3. Rotate any of the following secrets that were present on the machine during the window above:
   - `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AGENTIC_AI_API_KEY`
   - `JUPITER_API_KEY`, `JUP_API_KEY`, `BIRDEYE_API_KEY`
   - `NPM_TOKEN` and any GitHub personal access tokens, fine-grained tokens, or OIDC trust relationships
   - Cloud creds (AWS / GCP / Azure / Vault) — the worm scrapes these from `~/.aws/`, GCP metadata, env, etc.

4. Confirm there is no Solana keypair file on disk. This project never requires one — production signing always goes through the user's wallet. If you have an `id.json`, mnemonic file, or `Keypair.fromSecretKey` invocation in code, treat it as a finding.

5. Verify `pnpm-lock.yaml` is clean of the May 2026 compromised package versions:
   ```sh
   grep -E "@(tanstack|uipath|mistralai|opensearch-project)/" pnpm-lock.yaml
   grep -E "raydium-bs58|base-x-64|bs58-basic|ethersproject-wallet|@kodane/patch-manager|solana-transaction-toolkit|solana-stable-web-huks" pnpm-lock.yaml
   ```
   Expected: no output.

## Architectural defenses

These are enforced in code; they protect users even if a contributor's machine is compromised.

### Supply-chain

- **`ignore-scripts=true`** in root `.npmrc` and `--ignore-scripts` in every CI workflow. Compromised packages cannot run `preinstall`/`postinstall` payloads during `pnpm install`. This is the specific vector used by CVE-2026-45321's `router_init.js`.
- **7-day release-age floor** — `minimumReleaseAge: 10080` in `pnpm-workspace.yaml` and `min-release-age=7d` in `.npmrc`. pnpm refuses to install package versions younger than 7 days. This is the highest-leverage defense against near-real-time worms like Mini Shai-Hulud (which spread end-to-end in under 30 minutes); detection services flag malware inside the 7-day window. Emergency override: `pnpm add <pkg> --config.minimumReleaseAge=0`, or list the package in `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`. Lockfile-pinned installs are unaffected.
- **No `pull_request_target`** trigger anywhere — the GitHub Actions Pwn Request vector that compromised TanStack is not present.
- **Minimum-privilege `GITHUB_TOKEN`** — `ci.yml` is `contents: read`. The token cannot push, publish, or alter releases even if a step is compromised.
- **Lockfile-only installs** (`--frozen-lockfile`) in all workflows.
- **`pnpm audit`** runs on every PR (non-blocking initially) plus Dependabot daily.

### Wallet and signing

- The agent process never has access to the private key. The `WalletBackend` interface in `@solana-agent-wallet-adapter/core` is the only path to a signature, and it always routes the request to the user's installed wallet for explicit approval.
- **Pre-flight simulation** runs against the Solana RPC inside `signAndBroadcastTransaction`, `swap`, and `adapterContext.signAndBroadcast` (`packages/mcp-server/src/actionService.ts`). A transaction that the RPC says will fail is rejected *before* the wallet is asked to sign.
- **Allowlist of AI provider hosts** in `aiPlanner.ts`. A stolen `.env` cannot redirect prompts and plan parameters to an attacker-controlled URL without explicit operator opt-in (`AGENTIC_AI_ALLOW_CUSTOM_BASE_URL=1`).
- **Strict JSON parse** on AI responses. The LLM cannot smuggle hostile content past the parser by hiding a JSON object inside attacker-controlled prose.
- **Parameter-vs-prose consistency check** in `aiPlanFromParsed`. If the LLM's prose mentions a different recipient address or amount than the structured `parameters`, the prose is discarded and a deterministic template is used. This defends the wallet UI against prompt injection that aims to display a benign address while the structured field holds a hostile one.
- **`assertPlanGuardrails`** runs on every AI plan-generate, plan-review, and ask path before any output reaches the user.

### Bridge / network

- The local HTTP bridge binds to `127.0.0.1` by default and refuses any non-loopback host unless `AGENT_WALLET_ALLOW_PUBLIC_BIND=1` is set. Never expose port `8787` to the public internet.
- Every bridge endpoint requires a bridge-issued token. Per-agent tokens with tier gating (`bridgeServer.ts`) restrict which MCP methods each agent can reach.
- iOS deeplink and WalletConnect payloads use NaCl box encryption with ephemeral session keys.

## Known unpatched advisories

`pnpm security:audit` may surface the following pre-existing transitive issue. It is tracked here so audit failures are not silently ignored.

- **GHSA-3gc7-fjrx-p6mg** — `bigint-buffer <=1.1.5`: buffer overflow in `toBigIntLE()`. Reaches the tree via `@kamino-finance/klend-sdk → @kamino-finance/kliquidity-sdk → @orca-so/common-sdk → @solana/spl-token → @solana/buffer-layout-utils → bigint-buffer`. No upstream patch is published. `@kamino-finance/klend-sdk` is an optional dependency of `packages/mcp-server` (only used for the Kamino adapter); the vulnerable code path is inside binary-layout decoding and is not reachable on data we do not deserialize ourselves. Status: tracked, audit runs non-blocking in CI until upstream ships a fix.

## What to do if you suspect compromise

1. Stop the bridge: `pnpm dev:stop`.
2. Revoke all tokens listed in the hygiene checklist above.
3. Run a fresh `pnpm install` against the committed `pnpm-lock.yaml` on a clean machine; do not reuse `node_modules`.
4. Inspect git log on `master` for unexpected commits or merged PRs from forks since the window.
5. If your wallet signed a transaction you did not initiate, treat the keypair as compromised, move funds, and rotate.
