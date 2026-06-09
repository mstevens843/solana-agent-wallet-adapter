# Browser Device Agent Evals — OpenRouter

**Runtime:** `browser-native`
**Provider id:** `openrouter`
**API format:** `openai-compatible`
**Default base URL:** `https://openrouter.ai/api/v1`
**Chat endpoint:** `https://openrouter.ai/api/v1/chat/completions`
**Browser tier:** Green — OpenRouter is designed for browser CORS.
**Auth:** `Authorization: Bearer <key>`
**Special headers:** none required beyond `Content-Type: application/json` and `Accept: application/json`.
OpenRouter does honor optional `HTTP-Referer` and `X-Title` headers for analytics; the runtime does not send them.

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
- Network panel shows the request to `https://openrouter.ai/api/v1/chat/completions` with `Authorization: Bearer …`
  and `Content-Type: application/json`. Response is 200 with JSON.
- `parseModelJson` accepts the response without throwing `provider_invalid_response`.
- No `sk-or-…`, `sk-`, `Bearer `, or JWT-shaped token visible in DevTools, IndexedDB plaintext, or Local storage.

**Fail:**
- HTTP 401 / 403 → confirm the OpenRouter key has the model in scope. Some routes require an organization-level
  agreement.
- HTTP 0 / CORS error → run `node scripts/browser-device-agent-cors-check.mjs --filter=openrouter` and confirm CORS
  clears.
- HTTP 402 → key has run out of credit; surface a clear error and tell the user to top up.
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

- **Tier:** Green. OpenRouter ships with permissive CORS headers and is the smoothest browser experience of the five
  providers.
- **Auto-routing disabled:** the `openrouter/auto` model is rejected for agent reviews — the runtime cannot know the
  upstream family in advance, so decision formatting (Anthropic Messages vs OpenAI Responses) could break. Select an
  explicit model instead: `anthropic/claude-sonnet-4.5` routes through OpenRouter's Anthropic Messages skin, and
  `openai/gpt-5` through the OpenAI Responses API. OpenRouter Gemini (`google/*`, `*gemini*`) is likewise rejected —
  use the direct Gemini provider so native `generateContent` formatting is used.
- **Cost headers:** OpenRouter may include `x-prompt-tokens`, `x-completion-tokens`, and `x-ratelimit-…` headers.
  The redactor does not need to scrub these, but ensure they are not logged alongside `Authorization`.
- **`response_format`:** OpenRouter forwards `{ "type": "json_object" }` to the upstream provider when supported. The
  runtime sends it for plan and review; ask omits it. If an upstream model does not support `response_format`, the
  runtime still recovers via `parseModelJson`'s ``` fences and balanced-brace paths.
- **Temperatures and tokens:** identical to OpenAI (`PLAN/REVIEW=0.2`, `ASK=0.3`; tokens 1024/1024/800).
- **Error mapping (`provider/providerHttp.ts`):** 401/403 → `provider_auth`; 402 → `provider_auth` with a clear
  "out of credit" diagnostic; 429 → `provider_rate_limited`; 408/504 → `provider_timeout`; 5xx → `provider_upstream`;
  anything else with non-JSON body → `provider_invalid_response`.
- **Redactor coverage:** OpenRouter keys start with `sk-or-` which the `SK` regex catches. Verify by intentionally
  setting an invalid key and confirming the diagnostic message in the Device Agent status card contains `[redacted]`.
