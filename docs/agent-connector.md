# Agent Connector — use a subscription instead of an API key

The **Agent Connector** lets the Local Bridge fulfil agent decisions (plan / review / ask) by shelling
out to a first-party CLI you already have installed and signed in — **OpenAI `codex`**, **Google
`gemini`**, or **Anthropic `claude`** — instead of calling a provider API with a per-token key. Your
key never leaves your machine; the bridge runs the CLI locally and reads only its final answer.

It's an alternative to the **API key** engine, available on every Local-Bridge surface: **website,
desktop, and CLI**. (Not on iOS/Android — there's no local CLI there.)

## Billing — read this

| Connector | Auth | Billing |
|---|---|---|
| **Codex** (`codex`) | your ChatGPT plan (`codex login`) | **plan-included** (within plan limits) |
| **Gemini** (`gemini`) | your Google AI Pro/Ultra (sign in on first run) | **plan-included** |
| **Claude** (`claude`) | Claude Code / Agent-SDK (`claude login`) | **metered Agent-SDK credits** ($20 Pro / $100 Max 5x / $200 Max 20x per month, billed at API rates, non-rollover) — **caps out, then stops.** Re-enabled by Anthropic on **2026-06-15**. |

Codex/Gemini draw from your normal subscription usage. **Claude is different** — it consumes a
separate, capped credit pool, not your flat plan.

## Setup

### Website / Desktop (UI)
1. AI settings → path **Local bridge** → engine **Subscription connector**.
2. Pick a connector (Codex / Gemini / Claude). The picker shows each one's billing note.
3. Click **Connect** — the bridge launches the CLI's own sign-in in your browser and connects
   automatically. (If it can't auto-launch, run the shown command and press **Recheck**.)
4. Switch back any time with **Provider API key** (this also clears the connector on the bridge).

### CLI
```
# interactive: choose "Connector · …" in the engine picker
solana-agent-wallet agent-setup

# non-interactive
solana-agent-wallet agent-setup --engine connector --connector codex
```

### Environment variables (advanced / headless)
The bridge reads these (forwarded to it by the CLI and desktop shells):

| Var | Values | Notes |
|---|---|---|
| `AGENTIC_AI_ENGINE` | `api-key` (default) \| `connector` | selects the engine |
| `AGENTIC_AI_CONNECTOR` | `codex` \| `gemini` \| `claude` | required when engine = connector |
| `AGENTIC_AI_CONNECTOR_PATH` | absolute path | optional — override binary autodetect (PATH; `.cmd`/`.exe` on Windows) |
| `AGENTIC_AI_CONNECTOR_TIMEOUT_MS` | number | optional — per-call timeout (default 120000) |

```
AGENTIC_AI_ENGINE=connector
AGENTIC_AI_CONNECTOR=codex
```
In connector mode `AGENTIC_AI_API_KEY` / `_PROVIDER` / `_MODEL` / `_BASE_URL` are ignored.

## How it works (and its limits)
- The bridge runs the CLI **locked down**: read-only sandbox, no auto-approve, throwaway working dir,
  a hard timeout, and the bridge's own secrets stripped from the child env. It's used purely as a
  single-shot inference endpoint; the CLI's final JSON flows through the same decision normalizers and
  guardrails as the API-key engines.
- **Web research is unavailable** in connector mode (the CLI is locked down) — research-needing
  reviews fall back gracefully, same as the generic OpenAI-compatible path.
- Auth/installed status is detected best-effort from each CLI's credential files; the authoritative
  check is the actual call, which returns a clear sign-in/install error if needed.
- Install/auth docs: [Codex CLI](https://developers.openai.com/codex/cli) ·
  [Gemini CLI](https://geminicli.com/docs/get-started/authentication/) ·
  [Claude Code](https://code.claude.com/docs).
