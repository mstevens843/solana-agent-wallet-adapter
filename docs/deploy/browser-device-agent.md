# Build Agentic Browser-Native Device Agent

Agentic's browser-native Device Agent is a gated dev path that runs provider chat calls from inside the user's browser
tab using `fetch` + WebCrypto + IndexedDB. The Vite build serves it; Render only reports availability through a status
block and never runs a worker. When both the Android-native bridge and the browser-native runtime are present in the
same WebView, Android-native always wins because the Android Keystore-backed store is stronger than browser storage.
The runtime drafts only — it cannot approve, sign, submit, or move funds, and every drafted transfer still moves
through the installed wallet's approval flow.

## Prerequisites

- An allowlisted wallet. The defaults are `4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd` and
  `7etjMSp87AUE135iW5dNeKridbW16rwSFVUN9ivfFm3w`; override with `VITE_AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST` for the
  browser build and `AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST` for the Render status block.
- A modern browser with WebCrypto and IndexedDB available. Recent Chrome, Edge, Firefox, and Safari qualify.
  Private/incognito IndexedDB blocking returns the `storage_unavailable` error code and requires the Session-only
  fallback (see Secret Store Modes).
- A provider key from one of the supported providers: OpenRouter, Gemini (OpenAI-compatible endpoint), OpenAI,
  Anthropic, or a custom OpenAI-compatible gateway. Use a short-lived, low-cap key — the browser-native runtime is a
  development path.

Never paste a wallet seed phrase, private key, recovery phrase, unrestricted credential, or production-only key into
the Device Agent key field, an AI prompt, the bridge process, a Render env var, or a support log.

## Commands

Run the dev server with both gates and an allowlist:

```sh
VITE_AGENTIC_DEVICE_AGENT=1 \
VITE_AGENTIC_BROWSER_DEVICE_AGENT=1 \
VITE_AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST=4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd,7etjMSp87AUE135iW5dNeKridbW16rwSFVUN9ivfFm3w \
pnpm -F @solana-agent-wallet-adapter/browser-demo dev
```

Or a production-style preview:

```sh
VITE_AGENTIC_DEVICE_AGENT=1 \
VITE_AGENTIC_BROWSER_DEVICE_AGENT=1 \
VITE_AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST=4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd,7etjMSp87AUE135iW5dNeKridbW16rwSFVUN9ivfFm3w \
pnpm -F @solana-agent-wallet-adapter/browser-demo build && \
pnpm -F @solana-agent-wallet-adapter/browser-demo preview
```

Both commands take the same env-var prefix. Build-time Vite flags must be set when the bundle is built, not when it is
served — toggling a Vite flag without rebuilding has no effect.

## Env Matrix

| Variable | Scope | Default | Effect |
|---|---|---|---|
| `VITE_AGENTIC_DEVICE_AGENT` | Browser build | unset | Umbrella Device Agent flag for the browser bundle. Required by both Android-native and browser-native browser UX. |
| `VITE_AGENTIC_BROWSER_DEVICE_AGENT` | Browser build | unset | Enables the browser-native runtime path. Without this flag the bundle keeps the legacy scaffold-only behavior. |
| `VITE_AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST` | Browser build | unset | Comma-separated wallet addresses allowed to use Device Agent in the browser. Empty list disables Device Agent for every wallet. |
| `AGENTIC_DEVICE_AGENT` | Render | unset | Umbrella server-side Device Agent flag. Required for the `runtimes` status block to expose anything. |
| `AGENTIC_BROWSER_DEVICE_AGENT` | Render | unset | Sets `runtimes.browserNative` to `true` on `/api/device-agent/status`. Has no effect on the browser bundle itself. |
| `AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST` | Render | unset | Wallet addresses Render will accept for Device Agent status/control calls. 403 for everything else. |

Enabling only `AGENTIC_BROWSER_DEVICE_AGENT=1` on Render does not start anything — it only changes the
`runtimes.browserNative` boolean reported by `/api/device-agent/status`. Render still serves no provider calls and
still rejects any non-status/control Device Agent call.

## Allowlist Semantics

The browser-side `VITE_AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST` and the Render-side
`AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST` accept the same comma-separated wallet address format. The browser bundle
hides the Device Agent card and the `Device Agent - drafts via browser` AI-path option for any wallet not on the list.
Render returns 403 for any wallet not on the list. An unset or empty allowlist means no wallets qualify — there is no
implicit allow-all. Keep the browser and Render copies in sync to avoid status flicker (the browser-side block plus a
Render-side allow looks fine in DevTools but is unusable in practice, and the reverse hides a working backend behind
an empty card).

## Secret Store Modes

The browser-native runtime stores the provider key locally and never sends it to Render. Two modes are selectable;
both are configurable from the Device Agent card's `Secret store mode` toggle.

### Encrypted IndexedDB (default)

WebCrypto AES-GCM 256 with a non-extractable wrapping key kept in IndexedDB database `agentic-device-agent-secrets`.
The database holds three stores: `wrappingKey` (single `{ id: 'v1', key: CryptoKey }` record), `ciphertext` (per-key
encrypted blobs with a fresh 12-byte IV per write), and `stateMeta` (runtime persistence). On reload the runtime
hydrates as `stopped` with `configured=true`, and the user can start it again without re-pasting the key. The key
material is wiped on `Clear key`, `Full reset`, or any browser-level storage clear that touches the database.

### Session-only

User-selected through the Device Agent card's `Secret store mode` toggle, persisted in `localStorage` under
`agentic-device-agent-secret-store-mode`. The provider key lives only in tab memory and is forgotten on tab close,
reload, or runtime stop. Use this mode on shared or temporary machines, and as the required fallback when
`storage_unavailable` surfaces in private-mode browsing.

Neither mode persists to Render, neither mode logs the key, and the redactor scrubs key shapes from any captured
error payload before it reaches diagnostics, receipts, or the console.

## CORS Expectations per Provider

The browser-native runtime calls each provider's chat endpoint directly from the tab. The provider's CORS
configuration, not Agentic, decides whether the request completes.

| Provider | Tier | CORS behavior | Notes |
|---|---|---|---|
| OpenRouter | green ✅ | Designed for browser-origin requests | `Authorization: Bearer` from the tab |
| Gemini (OpenAI-compatible endpoint) | green ✅ | Google publishes CORS on `generativelanguage.googleapis.com/v1beta/openai/chat/completions` | `Authorization: Bearer` from the tab |
| OpenAI | amber ⚠️ | Works from the tab; vendor-flagged direct-from-browser access. Use a short-lived, low-cap key. | Some model families (`gpt-5`, `o1`, `o3`, `o4`) omit `temperature` |
| Anthropic | amber ⚠️ | Works from the tab when `anthropic-dangerous-direct-browser-access: true` is sent | Header is set by the runtime, not the user. `anthropic-version: 2023-06-01`. |
| Custom OpenAI-compatible | neutral | CORS is the gateway operator's responsibility | Run `node scripts/browser-device-agent-cors-check.mjs --base-url=...` before trusting |

Run the CORS probe before switching providers or pointing the runtime at a custom gateway. The probe never reads a
real key and never prints one.

## Android Precedence

When the browser-native bundle loads inside the Android TWA and the Android Device Agent bridge is present,
`defaultDeviceAgentRuntime()` returns `'android-native'`. The browser-side `Secret store mode` toggle is inert in
that case; the Android Keystore-backed store is the authority and the Kotlin runtime executes provider calls. Setting
`VITE_AGENTIC_BROWSER_DEVICE_AGENT=1` in an Android-targeted build does not weaken this precedence.

## Storage Failures

Private/incognito IndexedDB blocking and similar storage-unavailable conditions return the `storage_unavailable`
error code from the runtime. Remediation is to switch the `Secret store mode` selector to `Session only` and re-enter
the key for the active session. Do not work around this by storing keys in `localStorage` or URL fragments — the
runtime rejects those paths by design.

## Render Reporting

Render exposes a `runtimes: { android, browserNative }` block on `GET /api/device-agent/status`. Both booleans
reflect the server-side flags only; they do not imply that Render is running any worker. Render still rejects any
non-status/control call and never persists Device Agent provider keys.

## Smoke and CORS Probe

The manual verification path lives in [docs/smoke/browser-device-agent.md](../smoke/browser-device-agent.md). This
deploy doc explains how to assemble a build; the smoke doc explains how to verify one against every supported
provider. Do not duplicate per-provider step lists between the two documents.
