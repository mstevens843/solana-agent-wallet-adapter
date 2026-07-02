# Render Cloud Guide

`apps/render-web` is the same-origin Node service behind Agentic Cloud.

It is not just a static site.

## Responsibilities

Render-web serves:

- Vite app assets
- hosted BYOK AI endpoints
- operator-managed hosted AI endpoints when configured
- chat streaming endpoint
- chat session storage API
- wallet auth/session API
- cloud workflow API
- evidence API
- recurring API
- connector read and prepare APIs
- Solana RPC helper APIs
- swap APIs
- BirdEye/CoinGecko/Helius data APIs
- policy enrichment API
- review localization API
- connector secrets API
- AP2/ACP/MPP routes
- skills routes
- signals routes
- streaming session routes
- agent card/profile routes
- mobile config
- bridge pairing and bridge AI relay
- release download resolution

## Important Registered Routes

Core:

- `GET /api/app-build`
- `GET /api/ai/status`
- `POST /api/ai/generate-plan`
- `POST /api/ai/review-plan`
- `POST /api/ai/ask-about-plan`
- `POST /api/ai/chat`
- `POST /api/ai/chat/stream`
- `POST /api/policy/enrich`
- `POST /api/review/localize`

Session/auth:

- `POST /api/auth/nonce`
- `POST /api/auth/siws-nonce`
- `POST /api/auth/verify-wallet`
- `POST /api/auth/logout`
- `GET /api/session`
- `GET /api/audit`

Chat:

- `GET /api/chat/sessions`
- `DELETE /api/chat/sessions`
- `GET /api/chat/sessions/:id`
- `PUT /api/chat/sessions/:id`
- `DELETE /api/chat/sessions/:id`

Workflow:

- `/api/plans`
- `/api/approvals`
- `/api/completed`
- `/api/evidence`
- `/api/recurring`

Solana and market reads:

- `/api/solana/*`
- `/api/swap/*`
- `/api/connector/*`
- `/api/birdeye/*`
- `/api/coingecko/*`
- `/api/helius/*`

Layer 1:

- `/api/ap2/*`
- `/api/acp/*`
- `/api/mpp/*`
- `/api/skills/*`
- `/api/signals/*`
- `/api/streaming/*`

## Agentic Cloud Model

Agentic Cloud stores unsigned workflow state:

- plans
- approvals
- completed records
- recurring schedules
- recurring occurrences
- evidence receipts
- chat sessions
- preferences
- audit events
- streaming session and voucher metadata

Cloud sign-in proves wallet ownership only. It does not authorize spending.

## Policy Enrichment

`POST /api/policy/enrich` runs atom extraction and policy fact resolution without invoking the review LLM.

It exists because BYOK and device-agent paths run the user's model outside Render. Without enrichment, the model would see raw policy prose and might guess. With enrichment, the model receives a compact, pre-resolved `PolicyEvaluationBundle`.

## Recurring

Recurring materialization:

- creates due approval items
- is idempotent by wallet, schedule, and occurrence key
- does not auto-sign
- can use cron or in-process scheduler depending on environment
- supports notifications/webhooks when configured

## Evidence

Evidence receipts are stored only after validation. Signed receipts must verify against the signed-in wallet when marked verified.

Evidence supports approval, review, rejection, payment, streaming, and settlement artifacts.

## Same-Origin And CORS

Most APIs enforce same-origin and JSON-write constraints. Pairing relay and bridge AI relay own separate auth/CORS behavior because pairing tokens are the secret.

## Persistence

Production uses Postgres when `DATABASE_URL` exists. Local dev can use memory.

Migrations include:

- users and wallet sessions
- plans and approvals
- completed records
- recurring schedules and occurrences
- evidence receipts and audit events
- skills
- signals
- streaming sessions and vouchers
- chat sessions
- preferences namespaces

## Production Env

Required:

- `DATABASE_URL`
- `SESSION_SECRET`
- `AGENTIC_PUBLIC_ORIGIN`

Common optional:

- `AGENTIC_ENABLE_WEB_SCHEDULER`
- `AGENTIC_HOSTED_AI_API_KEY`
- `AGENTIC_HOSTED_AI_PROVIDER`
- `AGENTIC_HOSTED_AI_MODEL`
- `AGENTIC_DEVICE_AGENT`
- `AGENTIC_BROWSER_DEVICE_AGENT`
- connector API keys
- Android/iOS trust config
- recurring policy env

## Security Notes

Render must not store:

- seed phrases
- private keys
- unlimited delegated signers
- hosted BYOK user keys
- arbitrary executable transaction authority

Streaming sessions are the explicit bounded exception. They use limited delegate authority under a user-approved cap.

