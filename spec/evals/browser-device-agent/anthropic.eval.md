# Browser Device Agent Evals — Claude / Anthropic

**Runtime:** `browser-native`
**Provider id:** `anthropic`
**API format:** `anthropic`
**Default base URL:** `https://api.anthropic.com/v1`
**Chat endpoint:** `https://api.anthropic.com/v1/messages`
**Browser tier:** Amber — vendor-flagged direct-from-browser access. Requires the
`anthropic-dangerous-direct-browser-access` opt-in header.
**Auth:** `x-api-key: <key>`
**Special headers:** `anthropic-version: 2023-06-01`, `anthropic-dangerous-direct-browser-access: true`,
`Content-Type: application/json`, `Accept: application/json`.

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
- Network panel shows the request to `https://api.anthropic.com/v1/messages` with all three Anthropic-specific headers
  set: `x-api-key`, `anthropic-version: 2023-06-01`, `anthropic-dangerous-direct-browser-access: true`. Response is 200
  with JSON.
- `extractAnthropicText` returns the assistant text without throwing.
- `parseModelJson` accepts the extracted text without throwing `provider_invalid_response`.
- No `sk-`, `sk-ant-`, `Bearer `, or `x-api-key:` value visible in DevTools, IndexedDB plaintext, or Local storage.

**Fail:**
- HTTP 401 / 403 → check `x-api-key` is set and `anthropic-dangerous-direct-browser-access: true` is sent verbatim.
- HTTP 0 / CORS error → run `node scripts/browser-device-agent-cors-check.mjs --filter=anthropic` and inspect the
  preflight response.
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

- **Tier:** Amber. Anthropic flags direct-from-browser calls as dangerous; the runtime sends
  `anthropic-dangerous-direct-browser-access: true` — this is the **only** divergence from the Kotlin runtime, which
  does not set this header. Production builds must NOT default `VITE_AGENTIC_BROWSER_DEVICE_AGENT=1` on without explicit
  approval.
- **Endpoint:** `/v1/messages`, not `/chat/completions`. The runtime selects `AnthropicProvider`, not
  `OpenAiCompatibleProvider`, when `apiFormat === 'anthropic'`.
- **Auth header:** `x-api-key`, not `Authorization: Bearer`. The redactor still covers it via the `KEY_VALUE` and
  `SK` patterns; verify by intentionally setting an invalid key and confirming the diagnostic message in the Device
  Agent status card contains `[redacted]` instead of the key value.
- **`anthropic-version`:** pinned to `2023-06-01`. Bumping is a breaking change — coordinate with the Kotlin runtime
  before changing it in either place.
- **No `response_format`:** Anthropic's `/messages` API does not accept the OpenAI `response_format` parameter. The
  planner therefore must produce JSON via the prompt alone; `parseModelJson` handles ``` fences and balanced-brace
  extraction when the model wraps the JSON.
- **Temperatures and tokens:** identical to OpenAI (`PLAN/REVIEW=0.2`, `ASK=0.3`; tokens 1024/1024/800).
- **Error mapping (`provider/providerHttp.ts`):** 401/403 → `provider_auth`; 429 → `provider_rate_limited`; 408/504 →
  `provider_timeout`; 5xx → `provider_upstream`; anything else with non-JSON body → `provider_invalid_response`.
