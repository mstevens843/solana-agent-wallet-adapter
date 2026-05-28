# Deploy Agentic on Render

Agentic's public homepage is a Vite build from `apps/browser-demo` served by a small same-origin Node service in
`apps/render-web`. Render serves the website and the hosted BYOK AI planning proxy; the CLI, desktop app, bridge, and
wallet host still run locally on the user's machine after installation. The Android app defaults to a bundled native
shell; the hosted origin is still used for website traffic, release downloads, Digital Asset Links, and optional
web/TWA fallback builds.

## Blueprint Deploy

Use the root `render.yaml` as a Render Blueprint. It defines one Node web service, one Render Postgres database, and
one cron job:

- Service name: `agentic`
- Build command: `pnpm install --frozen-lockfile --ignore-scripts && pnpm render:build`
- Predeploy command: `pnpm -F @solana-agent-wallet-adapter/render-web db:migrate`
- Start command: `pnpm -F @solana-agent-wallet-adapter/render-web start`
- Health check path: `/api/ai/status`
- Custom domain: `agentic-signer.com`
- Database: `agentic-postgres`
- Cron service: `agentic-recurring-materializer`, schedule `* * * * *`
- Environment variable: `SKIP_INSTALL_DEPS=true`
- Database env: `DATABASE_URL` from the Render Postgres internal connection string
- Session env: generated `SESSION_SECRET`
- Public origin env: `AGENTIC_PUBLIC_ORIGIN=https://agentic-signer.com`
- Production UI env: `VITE_AGENTIC_DEV_CONTROLS=false`
- Production analytics env: `VITE_AGENTIC_GA_MEASUREMENT_ID=G-MJ3VZ7VEX7`
- Optional Android trust env: `AGENTIC_ANDROID_SHA256_CERT_FINGERPRINTS`
- Production Android trust guard: `AGENTIC_ANDROID_REQUIRE_TRUST=1`

`pnpm render:build` also writes static fallback files for the known client routes (`/app`, `/docs`, `/cli`,
`/desktop`, `/demo`, `/terms`, `/privacy`, and Android utility routes). The Node server also falls back to
`index.html` for direct visits and hard refreshes on client-side routes.

## Manual Web Service Settings

If configuring Render manually, use:

- Root directory: repository root
- Runtime: Node
- Build command: `pnpm install --frozen-lockfile --ignore-scripts && pnpm render:build`
- Predeploy command: `pnpm -F @solana-agent-wallet-adapter/render-web db:migrate`
- Start command: `pnpm -F @solana-agent-wallet-adapter/render-web start`
- Health check path: `/api/ai/status`
- Custom domain: `agentic-signer.com`
- Environment variable: `SKIP_INSTALL_DEPS=true`
- `DATABASE_URL`: internal connection string from a same-region Render Postgres database
- `SESSION_SECRET`: random 256-bit secret or Render-generated value, at least 32 characters
- `AGENTIC_PUBLIC_ORIGIN=https://agentic-signer.com`
- Production UI env: `VITE_AGENTIC_DEV_CONTROLS=false`
- Production analytics env: `VITE_AGENTIC_GA_MEASUREMENT_ID=G-MJ3VZ7VEX7`
- Optional Android trust env: `AGENTIC_ANDROID_SHA256_CERT_FINGERPRINTS`
- Production Android trust guard: `AGENTIC_ANDROID_REQUIRE_TRUST=1`
- Auto deploy: enabled for the production branch

## Agentic Cloud Persistence

Production must run with `DATABASE_URL`. The server uses the Postgres store whenever that variable exists and only falls
back to memory for local development or tests. The migration command creates these tables:

- `users`, `wallet_sessions`, `nonces`
- `plans`, `approval_requests`, `recurring_schedules`, `recurring_occurrences`
- `completed_records`, `evidence_receipts`, `audit_events`

The schema indexes wallet address, status, due time, created time, and recurring occurrence windows. Expired sessions
and nonces are removed by the store cleanup path. Render should use the database's internal connection string and keep
external database access disabled unless you need temporary admin access.

Session cookies are HTTP-only and same-site for the hosted web app. The bundled Android shell cannot use those cookies
from `https://agentic.local/`, so Android receives a bearer session after wallet verification and stores it in native
encrypted storage. The API allows the Android WebView origin by default; set `AGENTIC_CLOUD_CORS_ORIGINS` only when an
additional trusted bundled origin is needed. Wallet auth messages are bound to `AGENTIC_PUBLIC_ORIGIN`, so use
`https://agentic-signer.com` for final sign-in testing instead of the `.onrender.com` service URL.

## Recurring Cron

Create or sync the `agentic-recurring-materializer` cron service from `render.yaml`.

- Schedule: `* * * * *`
- Build command: `pnpm install --frozen-lockfile --ignore-scripts && pnpm -F @solana-agent-wallet-adapter/render-web build`
- Start command: `pnpm -F @solana-agent-wallet-adapter/render-web recurring:materialize`
- Env: `DATABASE_URL` from `agentic-postgres`

Keep `AGENTIC_ENABLE_WEB_SCHEDULER` unset in production so the web service does not also run an in-process scheduler.
After deploy, manually trigger one cron run and confirm the logs include `Agentic recurring materialization complete`.

If hard-refreshing `/app`, `/docs`, `/cli`, `/desktop`, or `/demo` returns `Not Found`, the deployed service is still
using the old static configuration. Redeploy from the root Blueprint so `apps/render-web` serves the SPA fallback.
If `https://agentic-signer.com/api/ai/status` also returns `404`, the custom domain is still attached to a static
site or stale service; move the domain to the root Blueprint Node web service before debugging client-side routing.

## Production Sanity Checks

After each production deploy, verify:

```sh
curl -i https://agentic-signer.com/api/ai/status
curl -i https://agentic-signer.com/app
curl -i https://agentic-signer.com/docs
curl -i https://agentic-signer.com/demo
```

`/api/ai/status` must return `200` JSON with `mode: "hosted-byok"`. If it returns `text/html`, the domain is serving
the frontend shell for API routes and hosted BYOK AI will fail. The client-side routes must return `200` HTML with the
app shell, not Render's plain-text `Not Found` response.

The live checker performs the same content-type checks:

```sh
pnpm smoke:render-web:live
pnpm smoke:render-web:skills-live
```

`AGENTIC_PUBLIC_ORIGIN` must stay aligned with the production domain
(`https://agentic-signer.com`) so public Skills SSR links and live smoke checks
resolve against the deployed host.

## Google Analytics

The hosted website loads Google Analytics 4 only when `VITE_AGENTIC_GA_MEASUREMENT_ID` is set at build time. The
production Blueprint sets it to `G-MJ3VZ7VEX7`. The client sends sanitized SPA page views and product interaction
events only; it does not send query strings, hashes, wallet addresses, signatures, transaction IDs, AI prompts, AI
keys, or bridge tokens.

In the GA4 Web Stream settings, disable Enhanced Measurement's browser-history page-change tracking if manual SPA
page views show duplicates. The app already sets `send_page_view: false` and emits one route-level page view itself.

## Hosted AI

The deployed app can provide Agentic-managed AI planning from Render env vars. Set `AGENTIC_HOSTED_AI_API_KEY`
or `AGENTIC_MANAGED_AI_API_KEY`, plus optional `AGENTIC_HOSTED_AI_PROVIDER` and `AGENTIC_HOSTED_AI_MODEL`, to let
signed-in web, desktop, Android, and CLI users draft plans without entering their own provider key. User BYOK remains
available as an advanced/request-scoped path; do not add user-owned keys to Render environment variables.

## Device Agent Gate

Device Agent is a gated runtime scaffold, not a Render-hosted AI daemon. To expose the fourth AI path only to the
Seeker test wallets on a deployed Render build, set both build-time and runtime flags:

```text
VITE_AGENTIC_DEVICE_AGENT=1
VITE_AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST=4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd,7etjMSp87AUE135iW5dNeKridbW16rwSFVUN9ivfFm3w
AGENTIC_DEVICE_AGENT=1
AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST=4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd,7etjMSp87AUE135iW5dNeKridbW16rwSFVUN9ivfFm3w
```

The Render API only returns status/control scaffolding for allowlisted signed-in wallets and does not start a cloud
agent worker or execute provider calls. Render Device Agent must stay status/control only even when the Android-native
runtime is enabled elsewhere. Do not store Device Agent API keys in Render environment variables, and do not enable
these flags for a public production build unless a release owner explicitly approves that exposure. Device Agent cannot
approve, sign, submit, or move funds; wallet approval remains the only transaction authority.

## Private Local Mode

Private local mode remains optional. Users who start the desktop app or local bridge can keep workflow state local to
their machine. Normal signed-in web users use Agentic Cloud on `https://agentic-signer.com` and do not need localhost.

## Release Links Used by the Website

The website resolves the newest complete CLI and desktop releases at runtime through `/api/releases/downloads`.
Direct fallback links use product tag prefixes:

```text
https://github.com/mstevens843/solana-agent-wallet-adapter/releases/download/cli-v<version>/<cli-asset>
https://github.com/mstevens843/solana-agent-wallet-adapter/releases/download/desktop-v<version>/<desktop-asset>
https://github.com/mstevens843/solana-agent-wallet-adapter/releases/download/v<version>/<android-asset>
```

Expected CLI assets:

- `solana-agent-wallet-macos-arm64.tar.gz`
- `solana-agent-wallet-macos-x64.tar.gz`
- `solana-agent-wallet-linux-x64.tar.gz`
- `solana-agent-wallet-windows-x64.zip`

Expected desktop assets:

- `agentic-desktop-macos-arm64.dmg`
- `agentic-desktop-macos-x64.dmg`
- `agentic-desktop-windows-x64.msi`
- `agentic-desktop-linux-x64.AppImage`

Expected Android assets:

- `agentic-android.apk`
- `agentic-android.aab`

The release workflows publish those artifacts and the npm CLI package. Before deploying homepage copy that advertises
downloads, run the static verifier:

```sh
pnpm verify:release-links
```

After publishing a public release, run the live verifier against the product tag:

```sh
pnpm verify:release-links:live -- --tag cli-v1.1.2
pnpm verify:release-links:live -- --tag desktop-v0.4.1
```

## Android Trust File

For Android trusted web mode on the production Agentic Cloud domain, the web service must serve Digital Asset Links at:

```text
https://agentic-signer.com/.well-known/assetlinks.json
```

The checked-in file is a safe placeholder until a release signing certificate exists. Render can generate the production
file during build when this environment variable is set:

```sh
AGENTIC_ANDROID_SHA256_CERT_FINGERPRINTS="AA:BB:..."
```

`pnpm render:prepare` writes `apps/browser-demo/public/.well-known/assetlinks.json` from that fingerprint before the
browser build. If the env var is absent, the build keeps the safe placeholder and Android TWA trusted mode will not be
active.

Set `AGENTIC_ANDROID_REQUIRE_TRUST=1` for production Render builds that back an Android release. With that guard
enabled, `pnpm render:prepare` fails instead of deploying the placeholder trust file.

The native Android release workflow builds with `AGENTIC_ANDROID_LAUNCH_URL=https://agentic-signer.com/app`. Local
Android builds still use the bundled fallback default unless that environment variable is provided. The Node web
service handles direct browser visits to client-side routes such as `/app` and `/demo`.

## Local Verification

Before deploying, run:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm render:build
pnpm -F @solana-agent-wallet-adapter/render-web typecheck
pnpm -F @solana-agent-wallet-adapter/render-web test
pnpm -F @solana-agent-wallet-adapter/browser-demo typecheck
pnpm -F @solana-agent-wallet-adapter/browser-demo test
pnpm smoke:render-web
pnpm smoke:render-web:workflow
pnpm smoke:render-web:skills
pnpm verify:release-links
```

Then manually smoke `/docs`, `/cli`, `/desktop`, and `/android` at desktop and mobile widths.

---

## Streaming Sessions

Phase 1–5 added a non-custodial streaming-payments primitive. The render-web
host handles session lifecycle (create / accept-voucher / revoke / settle)
and runs a per-minute cron that materializes settlements. This section is the
operator runbook for the new moving parts.

### Required environment variables

| Variable | Required? | Notes |
|---|---|---|
| `STREAMING_SESSION_ENCRYPTION_KEY` | **Yes** for any streaming session | Master key for AES-256-GCM encryption of session delegate keys. Accept formats: base64-encoded 32 bytes (recommended; `openssl rand -base64 32`) OR passphrase of at least 32 characters (SHA-256-hashed on first read, logs a warning). Shorter values are rejected at first use. |
| `STREAMING_DELEGATE_PREFUND_LAMPORTS` | No (default `5000000` = 0.005 SOL) | Per-session lamports the wallet's `Approve` tx funds into the ephemeral delegate keypair. Covers ~800 settlement signatures after the rent-exempt minimum. The cron sweeps the leftover back to the owner after settlement (`maybeSweepDelegate`). The platform no longer runs a shared fee-payer wallet — each session is self-funded, which eliminates a class of "shared key compromise drains everything" scenarios that the earlier security review flagged. |
| `STREAMING_DEFAULT_CLUSTER` | No (default `mainnet-beta`) | One of `mainnet-beta` / `testnet` / `devnet` / `localnet`. |
| `STREAMING_SETTLEMENT_THRESHOLD_BPS_DEFAULT` | No (default `9000` = 90% of cap) | Sessions become settlement-eligible when spent ≥ this fraction of cap, OR they expire, OR they're revoked. |
| `STREAMING_CANDIDATE_LIMIT` | No (default `25`) | Max sessions the cron processes per tick. |
| `STREAMING_LOCK_TTL_MS` | No (default `55000`) | Initial settlement-lock TTL. Heartbeats extend it between chunks. |
| `STREAMING_MAX_VOUCHERS_PER_TX` | No (default `10`, library cap) | Per-tx voucher chunk cap. Lower for safety margin on hot paths. |
| `STREAMING_RECONCILE_PENDING_HORIZON_MS` | No (default `180000`) | How long after `lastSettlementAttempt.submittedAt` we still treat a pending tx as in-flight; after this we assume the tx was dropped and a fresh attempt is allowed. |
| `STREAMING_TEST_RECENT_BLOCKHASH` / `STREAMING_TEST_SETTLEMENT_TXID` | NEVER in production | Test-only fakes; the service refuses to honor them outside `NODE_ENV=test` (P5.5 guard). |

### The settlement cron

`render.yaml` declares `agentic-streaming-settlement` as a per-minute cron
running `pnpm -F @solana-agent-wallet-adapter/render-web streaming:settle`.

The cron:

1. Picks up to `STREAMING_CANDIDATE_LIMIT` sessions whose spent amount
   exceeds the configured threshold OR which have expired/revoked.
2. Locks each candidate via a per-session metadata lock (CTAS-style
   conditional UPDATE — see `claimSettlementCandidate`).
3. Reconciles any `metadata.lastSettlementAttempt` against on-chain state
   (`Connection.getSignatureStatus`) before building a new tx; if a prior
   attempt confirmed, marks the vouchers settled with that txid and skips
   the rebuild (P5.4).
4. Re-verifies every voucher signature against the session's ephemeral
   signer pubkey before passing them to `buildSettlementTx` (P5.8); forged
   vouchers are quarantined with a `streaming.voucher.quarantined` audit
   event.
5. Heartbeats the session lock between chunks so a slow settlement doesn't
   lose its lock to a second worker (P5.6).
6. Submits each chunk, marks vouchers `settled_at + settlement_txid`,
   writes a `streaming_settlement` evidence receipt (note: `signature: ''`,
   txid is in `metadata.settlementTxid`; the on-chain tx IS the proof —
   P5.9).
7. Logs a summary line: `Agentic streaming settlement settled=N failed=M skipped=K`.

### Monitoring

- Tail Render logs for the `agentic-streaming-settlement` service. Look for
  `failed > 0` or repeated `[streaming-settlement] session=… failed: …`
  messages (errors are redacted via `redactSecrets()` — P5.7).
- The fee-payer account balance decays one tx fee per settled chunk. Set up
  an external alert (Slack, Sentry, PagerDuty) when its balance drops below
  0.1 SOL.

### Key rotation procedure

`STREAMING_SESSION_ENCRYPTION_KEY` rotation requires draining active
sessions first because the v1 encryption envelope has no key-id field:

1. Block session creation (operator gate; communicate the freeze to wallet
   integrators directly until a feature flag ships).
2. Wait for all `active` sessions to either (a) settle via the cron or (b)
   be revoked on-chain by their owners. Track via the dashboard or
   `SELECT COUNT(*) FROM streaming_sessions WHERE status = 'active';`.
3. Update `STREAMING_SESSION_ENCRYPTION_KEY` in Render's env (encrypted
   secret — not committed to git). Re-deploy.
4. Re-enable session creation. New sessions encrypt with the new key.

Fee-payer rotation: **not applicable.** As of 2026-05-16 the platform-funded
fee payer was eliminated. Each session funds its own ephemeral delegate
keypair at session-open time and the leftover lamports are swept back to the
owner after settlement. There's no shared key to rotate.

### Database

Migrations 013 (`streaming_sessions`), 014 (`streaming_vouchers`), and 015
(`mpp-config` namespace doc) ship with `down` SQL (P5.10) so a bad migration
can be rolled back via:

```bash
pnpm -F @solana-agent-wallet-adapter/render-web db:rollback 015
pnpm -F @solana-agent-wallet-adapter/render-web db:rollback 014
pnpm -F @solana-agent-wallet-adapter/render-web db:rollback 013
```

Rollback only the latest-applied migration at a time; the runner refuses
out-of-order rollbacks.

### Disaster recovery

See [`render-streaming-recovery.md`](./render-streaming-recovery.md) for
operator procedures covering encryption-key loss, fee-payer depletion,
Postgres restore mid-rotation, and stuck-settlement recovery.

### Pre-mainnet smoke

Before flipping streaming sessions on for any mainnet wallet, run
[`docs/smoke/streaming-settlement.md`](../smoke/streaming-settlement.md)
against devnet and verify every pass-criterion checkbox.
