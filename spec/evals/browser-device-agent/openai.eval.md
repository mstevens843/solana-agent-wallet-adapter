# Browser Device Agent Evals — OpenAI

> **⚠️ Known CORS limitation:** Direct OpenAI calls from the browser-native runtime currently **fail** because
> `api.openai.com/v1/chat/completions` does not include `Access-Control-Allow-Origin` on POST responses. The
> browser blocks the response body even when the request succeeds upstream. The CORS probe
> (`node scripts/browser-device-agent-cors-check.mjs --filter=openai`) exits non-zero to surface this.
> **To run these evals end-to-end, use the OpenRouter provider with an `openai/*` model route** (OpenRouter
> exposes OpenAI models with browser-correct CORS) **or proxy through your own backend.** The amber-tier UI
> chip warns users at runtime.

**Runtime:** `browser-native`
**Provider id:** `openai`
**API format:** `openai-compatible`
**Default base URL:** `https://api.openai.com/v1`
**Chat endpoint:** `https://api.openai.com/v1/chat/completions`
**Browser tier:** Amber — vendor-flagged direct-from-browser access (currently CORS-blocked).
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
- Network panel shows the request to `https://api.openai.com/v1/chat/completions` with `Authorization: Bearer …` and
  `Content-Type: application/json`. Response is 200 with JSON.
- `parseModelJson` (per `provider/responseParser.ts`) accepts the response without throwing `provider_invalid_response`.
- No `sk-`, `sk-proj-`, `Bearer `, `x-api-key:`, or JWT-shaped token visible in DevTools, IndexedDB plaintext, or Local
  storage.

**Fail:**
- HTTP 401 / 403 → check the `Authorization: Bearer` header was set; verify the key has chat-completions scope.
- HTTP 0 / network error → run `node scripts/browser-device-agent-cors-check.mjs --filter=openai` and confirm CORS clears.
- HTTP 400 with `Unsupported value: 'temperature'` → confirm `isDefaultTemperatureOnlyModel` strips temperature for the
  selected model.
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
- When re-run as `reviewPlan`, the review JSON includes `evidenceFactIds` for the quote and route source.

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
- Both `mint` and `recipient` are valid base58 pubkeys (length 32–44).
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

- **Tier:** Amber. OpenAI flags direct-from-browser calls as dangerous; the runtime sends the
  `Authorization: Bearer` header and relies on the per-key allowlist. Production builds must NOT default
  `VITE_AGENTIC_BROWSER_DEVICE_AGENT=1` on without explicit approval.
- **Temperatures and tokens:** `PLAN_TEMPERATURE=0.2`, `REVIEW_TEMPERATURE=0.2`, `ASK_TEMPERATURE=0.3`;
  `PLAN_MAX_TOKENS=1024`, `REVIEW_MAX_TOKENS=1024`, `ASK_MAX_TOKENS=800`.
- **`temperature` is dropped** from the request body for models matching `isDefaultTemperatureOnlyModel` in
  `provider/providerHttp.ts`: the `gpt-5`, `o1`, `o3`, and `o4` families. Confirm by inspecting the request body in the
  Network panel for the selected model.
- **`response_format`:** `{ "type": "json_object" }` is sent for `plan` and `review` only. The `ask` request omits it
  because the runtime accepts a natural-language answer there.
- **Error mapping (`provider/providerHttp.ts`):** 401/403 → `provider_auth`; 429 → `provider_rate_limited`; 408/504 →
  `provider_timeout`; 5xx → `provider_upstream`; anything else with non-JSON body → `provider_invalid_response`.
- **Redactor coverage:** `SecretRedactor`'s `BEARER`, `SK`, and `SK_PROJ` patterns must scrub any error message that
  leaks the dummy or real key. Verify by intentionally setting an invalid key and confirming the diagnostic message in
  the Device Agent status card contains `[redacted]` instead of the key.
