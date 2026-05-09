# Agentic Render Web

`@solana-agent-wallet-adapter/render-web` is the same-origin Node service for the hosted Agentic site. It serves the
Vite build from `apps/browser-demo/dist`, hosted BYOK AI planning APIs, wallet session APIs, and Agentic Cloud workflow
APIs.

## Runtime Modes

Agentic Cloud is the default signed-in web path. The wallet signs a login message to prove ownership only; Agentic stores
unsigned plans, approval requests, recurring schedule rules, completed records, evidence receipts, and audit events.
Every money-moving action still requires explicit wallet approval.

Browser workflow is the signed-out fallback. Drafts, queued approvals, recurring fallback data, completed records, and
receipts stay in local browser storage on the current device.

Private local mode remains available for users who explicitly run the CLI or desktop local bridge. Hosted web users do
not need localhost for the normal Agentic Cloud path.

## Production Environment

Required production variables:

- `DATABASE_URL`: Postgres connection string. On Render, use the internal `connectionString` from `agentic-postgres`.
- `SESSION_SECRET`: 32+ character random secret. Render Blueprint `generateValue: true` is acceptable.
- `AGENTIC_PUBLIC_ORIGIN`: canonical HTTPS origin, currently `https://agentic-signer.com`.

Common optional settings:

- `PORT`: Render-provided listen port. Defaults to `3000`.
- `HOST`: listen host. Defaults to `0.0.0.0`.
- `AGENTIC_WEB_DIST`: alternate path to browser static assets.
- `AGENTIC_ENABLE_WEB_SCHEDULER=1`: starts the in-process recurring materializer on the web service.
- `AGW_DISABLE_SCHEDULER=1`: disables scheduler ticks when a scheduler has been enabled.
- `VITE_AGENTIC_DEV_CONTROLS=false`: production browser build setting.
- `VITE_AGENTIC_GA_MEASUREMENT_ID`: optional GA4 measurement ID for the browser build.

The hosted BYOK endpoint relays user-provided AI keys from the browser for the current request and does not store
provider keys in Render env vars.

## Persistence

Local tests and development can use the in-memory workflow store. Any non-test runtime with `DATABASE_URL` uses the
Postgres store. Migrations create:

- `users`, `wallet_sessions`, `nonces`
- `plans`, `approval_requests`, `completed_records`
- `recurring_schedules`, `recurring_occurrences`
- `evidence_receipts`, `audit_events`

Run migrations after building the package:

```sh
pnpm -F @solana-agent-wallet-adapter/render-web build
pnpm -F @solana-agent-wallet-adapter/render-web db:migrate
```

## Sessions And Cookies

The session cookie is HTTP-only and same-site. It is marked `Secure` when the request is HTTPS, Render production is
detected, or `AGENTIC_PUBLIC_ORIGIN` is HTTPS. Production startup fails unless `DATABASE_URL`, `SESSION_SECRET`, and
`AGENTIC_PUBLIC_ORIGIN` are present; `SESSION_SECRET` must be at least 32 characters.

Wallet sign-in messages are bound to `AGENTIC_PUBLIC_ORIGIN` when it is set. Test final auth on
`https://agentic-signer.com`, not the `.onrender.com` service URL.

## Recurring Materialization

Recurring schedules never auto-sign or submit transactions. Each due occurrence creates one Approval Inbox item for the
wallet to review. Materialization is idempotent by `(wallet, schedule, occurrenceKey)`, so repeated runs return duplicate
results instead of creating extra inbox records.

Supported materialization paths:

- `GET /api/recurring`: lazy materializes due work before returning schedules for the signed-in wallet.
- `POST /api/recurring/materialize-due`: signed-in API endpoint used by the browser and smoke tests.
- `pnpm -F @solana-agent-wallet-adapter/render-web recurring:materialize`: cron command for all known wallets.

Render should run the cron service from `render.yaml` every minute:

```sh
pnpm -F @solana-agent-wallet-adapter/render-web recurring:materialize
```

Keep `AGENTIC_ENABLE_WEB_SCHEDULER` unset in production so cron is the only scheduler. The cron command also runs expired
session/nonce cleanup.

## Security Boundaries

Agentic Cloud must not store seed phrases, private keys, delegated signers, unlimited approval authority, executable
transactions, or hosted BYOK provider keys. The workflow smoke rejects representative secret/authority payloads across
workflow routes and checks hosted BYOK success/error paths for provider-key redaction.

## Local Verification

```sh
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

Add `--require-local-bridge` to the workflow smoke only when a local bridge is intentionally running and private local
mode must be part of the gate. The default workflow smoke uses a mocked local bridge for CI-safe private local mode
coverage. Set `TEST_DATABASE_URL` to run optional real Postgres integration tests.
