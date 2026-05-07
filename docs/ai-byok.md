# Agentic AI Planning And BYOK

Agentic does not need an AI key for the core wallet approval flow. The browser app and Android app include keyless
templates for common Solana wallet plans, and the wallet still performs every signature.

## Modes

- **Keyless templates:** default. Users choose a template, fill visible fields, generate a plan, and optionally sign an
  approval proof in their wallet.
- **Local bridge BYOK:** recommended for desktop and CLI users. The key stays on the user's machine and the hosted site
  talks only to the local bridge.
- **Session BYOK:** fallback for Android and browser-only users. The key is held in browser memory for the current
  session and is forgotten on refresh or close.

## Local Bridge Env

Set these before starting the bridge or desktop runtime:

```sh
export AGENTIC_AI_PROVIDER=openai-compatible
export AGENTIC_AI_API_KEY=...
export AGENTIC_AI_MODEL=gpt-5
export AGENTIC_AI_BASE_URL=https://api.openai.com/v1
solana-agent-wallet app
```

OpenAI-compatible gateways such as OpenRouter, Cloudflare AI Gateway, Vercel AI Gateway, or a self-hosted proxy can be
used by changing `AGENTIC_AI_BASE_URL` and `AGENTIC_AI_MODEL`.

## Security Rules

- Do not put user AI keys in Render environment variables for public BYOK.
- Do not put AI keys in URLs, checked-in config, prepared-action notes, receipts, issue reports, or screenshots.
- Prefer provider keys with low spending limits and easy revocation.
- AI output is only a draft plan. It cannot approve, sign, submit, or bypass wallet review.
- Browser session BYOK is for users who accept that their provider must allow browser-origin requests. The safer saved
  path is the local bridge.

## Template Coverage

The keyless planner covers SOL/SPL transfers, swaps, DCA and subscriptions, portfolio checks, NFT review, staking,
governance, transaction simulation, authority audits, DeFi reviews, liquidity positions, marketplace actions, devnet
smokes, Android/Seed Vault paths, dApp interactions, bridge-link reviews, tax notes, and custom requests.
