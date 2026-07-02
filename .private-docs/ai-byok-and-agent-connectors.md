# AI, BYOK, And Agent Connectors

Agentic has several AI routes. They should be documented by trust boundary.

## Keyless Baseline

Agentic works without AI:

- templates
- wallet action forms
- connector forms
- deterministic research cards
- proof builders
- approval inbox
- recurring schedules

This matters because the wallet workflow is not dependent on model availability.

## Hosted BYOK

User enters a provider key in the client. Render relays a single request to the selected provider.

Rules:

- request-scoped
- no persistence
- no logs
- no receipts
- redacted errors
- no key in URLs

Supported presets include:

- OpenAI
- Anthropic/Claude
- Gemini
- OpenRouter

## Local Bridge BYOK

The user's machine holds the key. The hosted site or local app talks to the bridge.

Best for:

- desktop
- CLI
- MCP users
- privacy-conscious users

## Browser Session BYOK

Key is held in memory for the current browser session.

Best for:

- browser-compatible providers
- short sessions
- no cloud relay

Risk:

- browser-origin provider restrictions
- not equivalent to OS keychain/keystore

## Device Agent

### Android Native

Provider calls happen inside the Android runtime queue. Config is stored through Android-native secure storage paths.

### Browser Native

Gated development path. Uses browser fetch and WebCrypto/IndexedDB where enabled.

### Render

Render exposes status/control scaffolding only. It does not run a Device Agent worker and should not persist provider keys.

## Plan Connector

Plan Connector uses local subscription CLIs as single-shot inference endpoints through the local bridge.

Current connectors:

- Codex
- Gemini
- Claude

Boundary:

- CLI runs locally
- bridge strips sensitive env
- read-only sandbox
- no auto-approve
- hard timeout
- output flows through normal normalizers and guardrails

This is useful because some users prefer subscription access over per-token API keys.

## Web Research

Web research availability depends on provider and route.

Examples:

- Anthropic native `web_search`
- OpenAI Responses search where configured
- Gemini Google Search where configured
- none for locked-down local subscription connector mode

When current research is required but unavailable, the evidence gate should return needs-input or block unsupported approval.

## Policy Enrichment

`/api/policy/enrich` pre-resolves policy bundles for BYOK/device-agent paths.

Without it:

- the user's model sees raw policy text
- the model may guess facts
- Android/browser native routes drift from hosted review

With it:

- atom extraction runs server-side
- facts resolve through authoritative providers
- the device model receives compact evidence
- deterministic gates stay consistent

## Public Wording

Public docs should say:

- AI drafts and explains.
- Agentic resolves facts before asking the model to decide when possible.
- Deterministic gates can block unsupported approvals.
- The wallet still signs.

Avoid saying:

- AI controls the wallet
- AI approves transactions
- auto-trading unless describing a specific product mode with its own limits
- guaranteed safe

