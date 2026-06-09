# Agentic AI Planning And BYOK

Agentic does not need an AI key for the core wallet approval flow. The browser app and Android app include keyless
templates for common Solana wallet plans, and the wallet still performs every signature.

## Modes

Agentic exposes five BYOK paths plus the keyless baseline. Each path has a distinct trust radius
and no two paths share storage, surface, or fallback semantics.

- **Keyless templates:** default. Users choose a template, fill visible fields, generate a plan, and optionally sign an
  approval proof in their wallet. The notes box is included in the plan review and signed approval message.
- **Local bridge BYOK:** recommended for desktop and CLI users. The key stays on the user's machine and the hosted site
  talks only to the local bridge. This remains a separate desktop/LAN/dev path and is not required by Device Agent.
- **Hosted BYOK:** default for the deployed web app and available in the bundled Android app after Agentic Cloud
  sign-in. The user enters a provider key in the client, the Agentic web server relays one AI request to the selected
  provider, and the key is not stored or logged.
- **Session BYOK:** fallback for Android and browser-only users who do not want Cloud relay or Device Agent. The key is held in browser
  memory for the current session and is forgotten on refresh or close. Raw OpenAI keys should not use this path because
  OpenAI does not allow exposing API keys in browser/mobile clients.
- **Device Agent BYOK — Browser-native:** gated browser-native development path. The key stays on the user's device,
  encrypted at rest in IndexedDB with a non-extractable WebCrypto AES-GCM key by default, or held only in tab memory
  when the user picks Session-only mode. Render never sees the key. Browser-grade storage is not Keystore-grade and is
  disclosed as such. Available providers are OpenRouter and Gemini (designed for browser CORS), OpenAI and Anthropic
  (vendor-flagged direct-from-browser), and custom OpenAI-compatible gateways.
- **Device Agent BYOK — Android-native:** default Android-native path for Seeker/on-device runtime work. The
  bundled Android shell runs provider calls inside the app and stores runtime config in Android Keystore-backed
  encrypted storage. When both Device Agent bridges are present in the same WebView, Android-native always wins.

Render can expose status/control scaffolding for signed-in wallets for either Device Agent runtime, but it does not run
a Device Agent worker and never stores Device Agent provider keys.

## Device Agent Env

Device Agent remains gated on browser and Render surfaces. Android-native Device Agent is enabled by default in Android
app builds and can be explicitly disabled with `-PagenticDeviceAgent=false`.

### Browser-native Device Agent

```sh
export VITE_AGENTIC_DEVICE_AGENT=1
export VITE_AGENTIC_BROWSER_DEVICE_AGENT=1
pnpm -F @solana-agent-wallet-adapter/browser-demo build
```

Render reports browser-native availability on `/api/device-agent/status` only when `AGENTIC_DEVICE_AGENT=1` and
`AGENTIC_BROWSER_DEVICE_AGENT=1` are both set. Render still runs no provider calls and never stores Device Agent keys.

### Android-native Device Agent

```sh
pnpm android:build
pnpm android:install
```

### Public builds

Leave browser and Render Device Agent gates unset for public production builds unless a release owner explicitly
approves those surfaces. Android app builds include the Android-native Device Agent by default; use
`-PagenticDeviceAgent=false` for opt-out regression or rollback builds. Device Agent is a draft path only: it cannot
approve, sign, submit, or move funds, and the wallet user still reviews every transaction through the normal approval
flow.

## Device Agent Runtime Matrix

| Surface | Status | Provider calls | Key/config boundary |
|---|---|---|---|
| Android default build | Native status/config/start/stop enabled | `generatePlan`, `reviewPlan`, and `ask` route through the Android runtime queue | Android Keystore-backed encrypted app storage |
| Android `agenticDeviceAgent=false` build | Hidden | None | No Device Agent config accepted |
| Browser default build | Hidden | None | No Device Agent config accepted |
| Browser `VITE_AGENTIC_BROWSER_DEVICE_AGENT=1` build | Browser-native status/config/start/stop enabled for connected wallets | `generatePlan`, `reviewPlan`, and `ask` route through the in-tab `fetch` + WebCrypto pipeline | Encrypted IndexedDB by default; Session-only tab memory when the user selects it |
| Render with both Device Agent gates | Signed-in status/control only | None | Non-secret status/config only; never store provider keys |

When both the Android-native bridge and the browser-native runtime are present in the same WebView, Android-native
wins. Treat any build that fails the matching Device Agent smoke as not release-ready for Device Agent drafting.

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
- Browser-native Device Agent uses browser-grade storage (non-extractable WebCrypto AES-GCM in IndexedDB), which is
  not equivalent to Android Keystore. Treat browser-native keys as device-scoped but tab-bound, and use Session-only
  mode on shared or temporary machines.
- The browser-native runtime calls provider chat endpoints directly from the tab. The user's provider must accept
  browser-origin requests; CORS limits, not Agentic, ultimately decide whether a key reaches the model.
- Browser session BYOK is for users who accept that their provider must allow browser-origin requests. The safer saved
  path is the local bridge.

## Template Coverage

The keyless planner covers SOL/SPL transfers, swaps, DCA and subscriptions, portfolio checks, NFT review, staking,
governance, transaction simulation, authority audits, DeFi reviews, liquidity positions, marketplace actions, devnet
smokes, Android/Seed Vault paths, dApp interactions, bridge-link reviews, tax notes, and custom requests.
