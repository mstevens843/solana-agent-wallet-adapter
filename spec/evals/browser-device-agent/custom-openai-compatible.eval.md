# Browser Device Agent Evals — Custom OpenAI-compatible

**Runtime:** `browser-native`
**Provider id:** `custom-openai-compatible`
**API format:** `openai-compatible`
**Default base URL:** user-supplied (defaults to `https://api.openai.com/v1` in `AI_PROVIDER_PRESETS`).
**Chat endpoint:** `<configured base URL>/chat/completions`
**Browser tier:** Neutral — CORS is the gateway operator's responsibility.
**Auth:** `Authorization: Bearer <key>` (most gateways; some accept additional headers — document them inside this
file when first encountered).
**Special headers:** none by default beyond `Content-Type: application/json` and `Accept: application/json`.

Run each prompt below through the browser-native runtime with this provider preset against a representative gateway
(Vercel AI Gateway, Cloudflare AI Gateway, or a self-hosted proxy). Before trusting the result, confirm the gateway's
CORS is configured for your origin via the probe:

```sh
node scripts/browser-device-agent-cors-check.mjs --filter=custom-openai-compatible --base-url=https://gateway.example.com/v1
```

## P1 — SOL transfer

**Template:** `Send SOL`
**Method:** `generatePlan`
**Cluster:** `devnet`
**User prompt:**

> Send 0.001 SOL to <recipient> on devnet with the memo "Device Agent smoke transfer".

**Expected plan JSON (load-bearing fields):**

```json
{
  "intent": "transfer_sol",
  "amount": "0.001",
  "recipient": "<recipient pubkey>",
  "cluster": "devnet",
  "memo": "Device Agent smoke transfer",
  "requiredBoundary": "AI prepares a plan only. Wallet approval and signing happen later in the user wallet."
}
```

**Pass:**
- `intent === "transfer_sol"`.
- `requiredBoundary` is byte-equal to `DEVICE_AGENT_BOUNDARIES.PLAN`.
- Network panel shows the request to `<configured base URL>/chat/completions` with `Authorization: Bearer …` and
  `Content-Type: application/json`. Response is 200 with JSON.
- `parseModelJson` accepts the response without throwing `provider_invalid_response`.
- No `sk-`, `Bearer `, or other key-shaped strings visible in DevTools, IndexedDB plaintext, or Local storage.

**Fail:**
- HTTP 0 / CORS error → the gateway is not configured for the page origin. Reconfigure CORS at the gateway and re-run
  the probe above.
- HTTP 4xx with a vendor-specific error envelope → confirm the gateway speaks OpenAI-compatible chat completions; some
  gateways require a model namespace prefix (e.g., `openai/gpt-4o`).
- Missing `requiredBoundary` → system prompt parity broken; compare against Kotlin `DeviceAgentSystemPrompts.PLAN`.

## P2 — Jupiter swap

**Template:** `Swap` (Jupiter v6)
**Method:** `generatePlan`
**Cluster:** `mainnet-beta`
**User prompt:**

> Swap 0.05 SOL for USDC on mainnet using the best Jupiter route.

**Expected plan JSON (load-bearing fields):**

```json
{
  "intent": "swap",
  "from": { "mint": "So11111111111111111111111111111111111111112", "amount": "0.05" },
  "to": { "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  "cluster": "mainnet-beta",
  "route": "jupiter",
  "requiredBoundary": "AI prepares a plan only. Wallet approval and signing happen later in the user wallet."
}
```

**Pass:**
- `intent === "swap"`.
- A route hint is present (`jupiter`, `raydium`, or `generic`).
- `requiredBoundary` is byte-equal to `DEVICE_AGENT_BOUNDARIES.PLAN`.

## P3 — Kamino deposit

**Template:** `Lend / Earn — Kamino`
**Method:** `generatePlan`
**Cluster:** `mainnet-beta`
**User prompt:**

> Deposit 5 USDC into Kamino's main USDC reserve on mainnet.

**Expected plan JSON (load-bearing fields):**

```json
{
  "intent": "kamino_deposit",
  "amount": "5",
  "asset": "USDC",
  "cluster": "mainnet-beta",
  "requiredBoundary": "AI prepares a plan only. Wallet approval and signing happen later in the user wallet."
}
```

**Pass:**
- `intent === "kamino_deposit"`.
- The planner stages the deposit only — output must not claim it has been executed.
- `requiredBoundary` is byte-equal to `DEVICE_AGENT_BOUNDARIES.PLAN`.

## P4 — NFT transfer

**Template:** `Send NFT`
**Method:** `generatePlan`
**Cluster:** `mainnet-beta`
**User prompt:**

> Transfer the NFT at mint <mint-pubkey> to <recipient-pubkey> on mainnet.

**Expected plan JSON (load-bearing fields):**

```json
{
  "intent": "transfer_nft",
  "mint": "<mint-pubkey>",
  "recipient": "<recipient-pubkey>",
  "cluster": "mainnet-beta",
  "requiredBoundary": "AI prepares a plan only. Wallet approval and signing happen later in the user wallet."
}
```

**Pass:**
- `intent === "transfer_nft"`.
- Both `mint` and `recipient` are valid base58 pubkeys.
- `requiredBoundary` is byte-equal to `DEVICE_AGENT_BOUNDARIES.PLAN`.

## P5 — Governance vote (Realms)

**Template:** `Governance vote`
**Method:** `reviewPlan`
**Cluster:** `mainnet-beta`
**User prompt:**

> Review this draft: cast a YES vote on proposal <id> in the <name> realm on mainnet. Tokens locked for the vote
> duration.

**Expected review JSON (load-bearing fields):**

```json
{
  "decision": "approve",
  "evidenceFactIds": ["<fact-id>"],
  "blockingFactIds": [],
  "missingFactIds": [],
  "requiredBoundary": "This AI review can approve, deny, or request more input. It cannot sign or submit a transaction."
}
```

**Pass:**
- `decision` is one of `approve`, `deny`, `needs_input`.
- `requiredBoundary` is byte-equal to `DEVICE_AGENT_BOUNDARIES.REVIEW`.
- For `needs_input`, `missingFactIds` is non-empty.
- For `deny`, `blockingFactIds` is non-empty.
- The reviewer must not claim it has cast, signed, or submitted the vote.

## Notes — Provider-specific quirks

- **Tier:** Neutral. The runtime makes no assumptions about CORS, model availability, rate limits, or auth header
  shape beyond OpenAI-compatible chat completions. Confirm each new gateway with the CORS probe before relying on it
  in the smoke.
- **Base URL normalization (`provider/providerHttp.ts`):** the runtime's `normalizeBaseUrl` strips trailing slashes
  and infers `/chat/completions` from the documented endpoint shape. If the gateway requires a non-default suffix
  (e.g., `/v1/chat/completions` vs `/v1/openai/chat/completions`), the user must configure the base URL precisely.
- **Auth header shape:** most OpenAI-compatible gateways accept `Authorization: Bearer`. A few accept `x-api-key` or a
  custom header. The browser-native runtime only sends `Authorization: Bearer`. Document any divergence inside this
  file and consider opening a runtime issue if the gateway is widely used.
- **`response_format`:** the runtime sends `{ "type": "json_object" }` for plan and review. Gateways that proxy to a
  model that does not support `response_format` may silently strip it; `parseModelJson` handles ``` fences and
  balanced-brace fallback.
- **Temperatures and tokens:** identical to OpenAI (`PLAN/REVIEW=0.2`, `ASK=0.3`; tokens 1024/1024/800). The
  `isDefaultTemperatureOnlyModel` heuristic only matches OpenAI-native model ids — for non-OpenAI upstream models the
  runtime sends `temperature` even when the upstream rejects it. If you hit `400 Unsupported value: 'temperature'`,
  switch to a model id the heuristic recognizes, or extend `isDefaultTemperatureOnlyModel` to cover the gateway's
  model namespace.
- **Error mapping (`provider/providerHttp.ts`):** 401/403 → `provider_auth`; 429 → `provider_rate_limited`; 408/504
  → `provider_timeout`; 5xx → `provider_upstream`; anything else with non-JSON body → `provider_invalid_response`.
- **Redactor coverage:** the existing patterns (`BEARER`, `SK`, `SK_PROJ`, `JWT`, `KEY_VALUE`) cover most gateway key
  shapes. If your gateway uses an exotic key format and it appears in error messages, extend `SecretRedactor`.
- **CORS probe before each new gateway:**
  ```sh
  node scripts/browser-device-agent-cors-check.mjs --filter=custom-openai-compatible --base-url=https://your-gateway.example.com/v1
  ```
  The probe exits 0 when the gateway accepts the preflight and a dummy POST.
