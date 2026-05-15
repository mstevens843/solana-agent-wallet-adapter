# Agentic AI Planning And BYOK

Agentic does not need an AI key for the core wallet approval flow. The browser app and Android app include keyless
templates for common Solana wallet plans, and the wallet still performs every signature.

## Modes

- **Keyless templates:** default. Users choose a template, fill visible fields, generate a plan, and optionally sign an
  approval proof in their wallet. The notes box is included in the plan review and signed approval message.
- **Local bridge BYOK:** recommended for desktop and CLI users. The key stays on the user's machine and the hosted site
  talks only to the local bridge. This remains a separate desktop/LAN/dev path and is not required by Device Agent.
- **Hosted BYOK:** default for the deployed web app and available in the bundled Android app after Agentic Cloud
  sign-in. The user enters a provider key in the client, the Agentic web server relays one AI request to the selected
  provider, and the key is not stored or logged.
- **Session BYOK:** fallback for Android and browser-only users who do not want Cloud relay. The key is held in browser
  memory for the current session and is forgotten on refresh or close. Raw OpenAI keys should not use this path because
  OpenAI does not allow exposing API keys in browser/mobile clients.
- **Device Agent BYOK:** gated Android-native development path for Seeker/on-device runtime work. It reuses the same
  AI path, provider, model, and key UX, stores Android runtime config in encrypted app storage, and does not change
  approval or signing authority. Render can expose status/control scaffolding for allowlisted wallets, but it does not
  run a Device Agent worker.

## Device Agent Env

Device Agent is hidden unless an explicit dev gate is enabled:

```sh
export AGENTIC_DEVICE_AGENT=1
export AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST=4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd,7etjMSp87AUE135iW5dNeKridbW16rwSFVUN9ivfFm3w
export VITE_AGENTIC_DEVICE_AGENT=1
export VITE_AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST="$AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST"
pnpm -F @solana-agent-wallet-adapter/browser-demo build
```

For Android APK builds, use:

```sh
pnpm android:build -- -PagenticDeviceAgent=true
pnpm android:install -- -PagenticDeviceAgent=true
```

Leave these gates unset for public production builds unless a release owner explicitly approves shipping Device Agent.
Device Agent is a draft path only: it cannot approve, sign, submit, or move funds, and the wallet user still reviews
every transaction through the normal approval flow.

## Device Agent Runtime Matrix

| Surface | Status | Provider calls | Key/config boundary |
|---|---|---|---|
| Android default build | Hidden | None | No Device Agent config accepted |
| Android `agenticDeviceAgent=true` build | Native status/config/start/stop enabled | `generatePlan`, `reviewPlan`, and `ask` route through the Android runtime queue | Android encrypted app storage |
| Render with both Device Agent gates | Allowlisted status/control only | None | Non-secret status/config only; never store provider keys |
| Browser dev | Scaffold/status only | None | Local dev state only |

Treat any Android build that fails the Device Agent smoke source checks as not release-ready for Device Agent drafting.

## Local Bridge Env

Set these before starting the bridge or desktop runtime:

```sh
export AGENTIC_AI_PROVIDER=openai
export AGENTIC_AI_API_FORMAT=openai-compatible
export AGENTIC_AI_API_KEY=...
export AGENTIC_AI_MODEL=gpt-5
export AGENTIC_AI_BASE_URL=https://api.openai.com/v1
solana-agent-wallet app
```

Claude can be used through the Anthropic Messages API:

```sh
export AGENTIC_AI_PROVIDER=anthropic
export AGENTIC_AI_API_FORMAT=anthropic
export AGENTIC_AI_API_KEY=...
export AGENTIC_AI_MODEL=claude-sonnet-4-5
export AGENTIC_AI_BASE_URL=https://api.anthropic.com/v1
solana-agent-wallet app
```

OpenAI-compatible gateways such as OpenRouter, Gemini's OpenAI-compatible endpoint, Cloudflare AI Gateway, Vercel AI
Gateway, or a self-hosted proxy can be used by changing `AGENTIC_AI_PROVIDER`, `AGENTIC_AI_BASE_URL`, and
`AGENTIC_AI_MODEL`. In the browser app, selecting a provider preset fills the matching base URL and starter model.
Hosted BYOK accepts preset providers only: OpenAI, Claude / Anthropic, Gemini, and OpenRouter.

## Security Rules

- Do not put user AI keys in Render environment variables for public BYOK.
- Hosted BYOK must treat the user key as request-scoped secret material: no persistence, no logs, no receipts, and no
  echoing provider errors that include the key.
- Do not put AI keys in URLs, checked-in config, prepared-action notes, receipts, issue reports, or screenshots.
- Prefer provider keys with low spending limits and easy revocation.
- AI output is only a draft plan. It cannot approve, sign, submit, or bypass wallet review.
- Device Agent keys and config must stay inside the selected runtime boundary. Do not sync them, log them, write them to
  receipts, or store them on Render.
- Browser session BYOK is for users who accept that their provider must allow browser-origin requests. The safer saved
  path is the local bridge.

## Template Coverage

The keyless planner covers SOL/SPL transfers, swaps, DCA and subscriptions, portfolio checks, NFT review, staking,
governance, transaction simulation, authority audits, DeFi reviews, liquidity positions, marketplace actions, devnet
smokes, Android/Seed Vault paths, dApp interactions, bridge-link reviews, tax notes, and custom requests.
