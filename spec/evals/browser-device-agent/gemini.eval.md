# Browser Device Agent Evals — Gemini

**Runtime:** `browser-native`
**Provider id:** `gemini`
**API format:** `openai-compatible`
**Default base URL:** `https://generativelanguage.googleapis.com/v1beta/openai`
**Chat endpoint:** `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`
**Browser tier:** Green — Google supports browser CORS on the OpenAI-compatible endpoint.
**Auth:** `Authorization: Bearer <key>`
**Special headers:** none beyond `Content-Type: application/json` and `Accept: application/json`.

Run each prompt below through the browser-native runtime with this provider preset. Confirm the response JSON matches
the expected shape, the boundary phrase is verbatim, no API key string appears anywhere in DevTools (Console, Network
payload preview, IndexedDB plaintext, Local/Session storage), and the runtime stays inside the drafts-only contract.

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
- Network panel shows the request to
  `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` with `Authorization: Bearer …` and
  `Content-Type: application/json`. Response is 200 with JSON.
- `parseModelJson` accepts the response without throwing `provider_invalid_response`.
- No `sk-`, `Bearer `, JWT-shaped token, or Google API-key prefix (`AIza…`) visible in DevTools, IndexedDB plaintext, or
  Local storage.

**Fail:**
- HTTP 401 / 403 → confirm the key has access to the Gemini OpenAI-compat surface; some keys are scoped to the native
  Gemini API only.
- HTTP 0 / CORS error → run `node scripts/browser-device-agent-cors-check.mjs --filter=gemini` and confirm CORS clears.
- HTTP 400 with `Unsupported model` → confirm the selected model id exists in the OpenAI-compat surface (e.g.,
  `gemini-2.5-flash-lite`, `gemini-2.5-pro`).
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

- **Tier:** Green. Google's OpenAI-compatible surface is browser-friendly by design — preflight passes from `localhost`
  and most production origins.
- **Endpoint shape:** the `/v1beta/openai/` prefix matters. The runtime's `normalizeBaseUrl` keeps this prefix intact;
  do not collapse it to `/v1/`.
- **Models drop `temperature` rarely:** none of the listed Gemini presets in `AI_PROVIDER_PRESETS` match
  `isDefaultTemperatureOnlyModel`, so `temperature` is included by default. Confirm in the Network panel.
- **`response_format`:** Gemini's OpenAI-compat surface accepts `{ "type": "json_object" }` for plan and review; the
  runtime sends it. The `ask` request omits it.
- **Output token caps:** some Gemini models cap output well below `PLAN_MAX_TOKENS=1024`. The runtime sends 1024 and
  trusts the server-side cap; verify the response is still valid JSON after truncation, or fall back to
  `parseModelJson`'s balanced-brace extraction path.
- **Error mapping (`provider/providerHttp.ts`):** 401/403 → `provider_auth`; 429 → `provider_rate_limited`; 408/504 →
  `provider_timeout`; 5xx → `provider_upstream`; anything else with non-JSON body → `provider_invalid_response`.
- **Redactor coverage:** Google API keys begin with `AIza` — none of the redactor regexes match that prefix directly
  today. The runtime never logs the key value, so this is acceptable, but if Google API-key strings start appearing in
  error messages, extend `SecretRedactor` rather than relying on prompt review.
