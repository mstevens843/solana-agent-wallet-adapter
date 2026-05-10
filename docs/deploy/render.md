# Deploy Agentic on Render

Agentic's public homepage is a Vite build from `apps/browser-demo` served by a small same-origin Node service in
`apps/render-web`. Render serves the website and the hosted BYOK AI planning proxy; the CLI, desktop app, bridge, and
wallet host still run locally on the user's machine after installation. The Android app is a Trusted Web Activity
wrapper around this hosted origin.

## Blueprint Deploy

Use the root `render.yaml` as a Render Blueprint. It defines one Node web service, one Render Postgres database, and
one cron job:

- Service name: `agentic`
- Build command: `pnpm install --frozen-lockfile --ignore-scripts && pnpm render:build && pnpm -F @solana-agent-wallet-adapter/render-web build`
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
`/desktop`, `/demo`, `/terms`, `/privacy`, and Android/TWA utility routes). The Node server also falls back to
`index.html` for direct visits and hard refreshes on client-side routes.

## Manual Web Service Settings

If configuring Render manually, use:

- Root directory: repository root
- Runtime: Node
- Build command: `pnpm install --frozen-lockfile --ignore-scripts && pnpm render:build && pnpm -F @solana-agent-wallet-adapter/render-web build`
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

Session cookies are HTTP-only and same-site. They are marked `Secure` in Render production and whenever the canonical
origin is HTTPS. Wallet auth messages are bound to `AGENTIC_PUBLIC_ORIGIN`, so use `https://agentic-signer.com` for final
sign-in testing instead of the `.onrender.com` service URL.

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
```

## Google Analytics

The hosted website loads Google Analytics 4 only when `VITE_AGENTIC_GA_MEASUREMENT_ID` is set at build time. The
production Blueprint sets it to `G-MJ3VZ7VEX7`. The client sends sanitized SPA page views and product interaction
events only; it does not send query strings, hashes, wallet addresses, signatures, transaction IDs, AI prompts, AI
keys, or bridge tokens.

In the GA4 Web Stream settings, disable Enhanced Measurement's browser-history page-change tracking if manual SPA
page views show duplicates. The app already sets `send_page_view: false` and emits one route-level page view itself.

## Hosted BYOK AI

The deployed app defaults to `Hosted BYOK` for AI planning. Users paste their OpenAI, Claude / Anthropic, Gemini, or
OpenRouter key in the browser. The same-origin Node server relays that request to the selected provider and does not
persist or log the key. Do not add user keys to Render environment variables.

## Private Local Mode

Private local mode remains optional. Users who start the desktop app or local bridge can keep workflow state local to
their machine. Normal signed-in web users use Agentic Cloud on `https://agentic-signer.com` and do not need localhost.

## Release Links Used by the Website

The website links GitHub Release assets directly from:

```text
https://github.com/mstevens843/solana-agent-wallet-adapter/releases/latest/download/<asset-name>
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

After publishing a public release, run the live verifier against the tag:

```sh
pnpm verify:release-links:live -- --tag v0.2.1
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
pnpm -F @solana-agent-wallet-adapter/render-web build
pnpm -F @solana-agent-wallet-adapter/render-web typecheck
pnpm -F @solana-agent-wallet-adapter/render-web test
pnpm -F @solana-agent-wallet-adapter/browser-demo typecheck
pnpm -F @solana-agent-wallet-adapter/browser-demo test
pnpm smoke:render-web
pnpm smoke:render-web:workflow
pnpm verify:release-links
```

Then manually smoke `/docs`, `/cli`, `/desktop`, and `/android` at desktop and mobile widths.
