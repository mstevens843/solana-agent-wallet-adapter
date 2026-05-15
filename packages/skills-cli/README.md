# `@solana-agent-wallet-adapter/skills-cli`

CLI for authoring Agentic Layer 2 Skills. Three commands:

- `agentic-skill init <skill-id>` — scaffold a manifest + vitest test.
- `agentic-skill test` — validate the manifest locally, run a no-signing
  dry-run executor, and preview the next 3 scheduled runs.
- `agentic-skill publish` — POST a validated manifest to
  `/api/skills/manifests` on the cloud server.

The CLI is part of the Layer 2 Skills Hub plan
(`/Users/devlegacy/.claude/plans/ok-please-plan-out-purrfect-squirrel.md`,
Phase 1 Agent 3).

## Install

From npm:

```bash
npm install -g @solana-agent-wallet-adapter/skills-cli
agentic-skill help

# One-off usage:
npx -p @solana-agent-wallet-adapter/skills-cli agentic-skill help
```

From the workspace:

```bash
pnpm install
pnpm -F @solana-agent-wallet-adapter/skills-cli build
```

Invoke via the workspace filter:

```bash
pnpm -F @solana-agent-wallet-adapter/skills-cli start help
```

## Commands

### `init <skill-id>`

```bash
pnpm -F @solana-agent-wallet-adapter/skills-cli start \
  init friday-dca \
  --author-wallet 4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd \
  --category dca \
  --out ./my-skills/friday-dca
```

Writes two files in `--out` (default `./skills/<skill-id>`):

- `manifest.json` — a minimal `SkillManifest` with conservative USDC-only
  starter caps and explicit TODO placeholders. **You must replace the TODO
  description and connector action before `test` or `publish` will succeed.**
- `manifest.test.ts` — a vitest file that asserts the manifest
  round-trips through `validateSkillManifest`.

Flags:

| Flag | Notes |
|---|---|
| `--author-wallet <pubkey>` | Required. Or set `AGENTIC_AUTHOR_WALLET`. |
| `--category <name>` | One of `dca`, `yield`, `stops`, `bridge`, `donation`, `custom`. Default `custom`. |
| `--out <dir>` | Default `./skills/<skill-id>`. |
| `--force` | Overwrite an existing directory. |
| `--dry-run` | Print to stdout, don't write files. |

### `test`

```bash
pnpm -F @solana-agent-wallet-adapter/skills-cli start \
  test ./my-skills/friday-dca/manifest.json
```

Runs:

1. `skills.validateSkillManifest(...)` from
   `@solana-agent-wallet-adapter/workflow/dev`.
2. Recursive safety checks that reject `delegatedSigner`, `privateKey`,
   `seedPhrase`, and `approvalAuthority: "unlimited"` anywhere in the manifest.
3. Coherence checks (CLI-local):
   - `perRunMaxAmount <= lifetimeMaxAmount` using the same decimal comparison
     helper as the skills runtime.
   - `allowlistedTokens.length >= 1`.
   - `maxExecutions > 0` if set.
   - `expiresAt` is a future ISO-8601 timestamp if set.
   - `monetization.payoutWallet` non-empty when `monetization` is set.
   - scaffold TODO placeholders have been replaced.
   - Schedule must not run faster than once per minute.
4. A no-signing dry run using `@solana-agent-wallet-adapter/skills-runtime`:
   cap evaluation, template binding, and approval request construction. This
   confirms the skill can propose an approval without delegated signing.
5. Previews the next 3 fire times for runtime `interval` schedules (`15m`,
   `2h`, `7d`, ISO-8601 like `PT15M` or `P1W`) and recognized `cron` patterns
   (`0 0 * * *` daily, `0 0 * * <0-6>` weekly).

Returns `{ ok: true, manifestId, manifestPath, nextRuns, warnings, dryRun }`.

### `publish`

```bash
AGENTIC_API_URL=https://agentic-signer.com \
AGENTIC_COOKIE='session=…' \
pnpm -F @solana-agent-wallet-adapter/skills-cli start \
  publish ./my-skills/friday-dca/manifest.json
```

Re-runs the strict local validation and dry-run pipeline (won't transmit
invalid manifests), then POSTs JSON to
`${AGENTIC_API_URL}/api/skills/manifests` with the `cookie` header set.

Flags:

| Flag | Notes |
|---|---|
| `--manifest <path>` | Default: positional path argument or `./manifest.json`. |
| `--api-url <url>` | Default `http://localhost:3000`. Or `AGENTIC_API_URL`. |
| `--cookie <value>` | Or `AGENTIC_COOKIE`. |

#### How to get a session cookie

The cloud server gates `/api/skills/manifests` to dev-allowlisted wallets
via session cookie. To grab yours:

1. Open the Agentic UI in Chrome and connect your wallet.
2. DevTools → Application → Cookies → `agentic-signer.com` (or
   `localhost:3000`).
3. Copy the session cookie's `Name=Value` pair into `AGENTIC_COOKIE` or
   `--cookie`.

A 401/403 response triggers a hint pointing to this flow.

## Global options

| Flag | Notes |
|---|---|
| `--json` | Print structured JSON (defaults to stable, sorted JSON anyway). |
| `--no-color` | Disable ANSI output. `NO_COLOR=1` also works. |
| `-h, --help` | Show usage. |

## Known limitations

- `agentic-skill publish` POSTs to `/api/skills/manifests`. That route
  is owned by Layer 2 Agent 5 (`apps/render-web/src/cloud/skillsRoutes.ts`);
  until it ships, expect a 404 from a live server. The CLI surfaces a
  hint when this happens.
- `validateSkillManifest` itself may lag behind the cloud route validator.
  The CLI therefore keeps local safety checks for forbidden authority fields
  and dry-runs the runtime before publishing.

## Tests

```bash
pnpm -F @solana-agent-wallet-adapter/skills-cli test
```
