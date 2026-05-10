# Colosseum Demo Video Runbook

Goal: record a silent live-product demo for Colosseum, under 3 minutes, showing the real Agentic workspace instead of slides, code, or the simulation-first guided demo.

## Direction

- Use a straight live-product walkthrough with a few hard cuts.
- Start on `https://agentic-signer.com/` only long enough to establish the promise, then move to `https://agentic-signer.com/app`.
- Use short on-screen captions or upload `agentic-colosseum-demo-captions.srt`. The pitch video already handles spoken narrative.
- Favor the real app over `/demo`. The guided demo is useful for users, but the Colosseum video should prove the actual workspace: plan, review, inbox, recurring, and receipts.

## Preflight

- Browser: one clean Chrome profile or incognito window, bookmarks hidden, 16:9 recording area.
- Wallet: connect Backpack or Phantom to a demo-safe wallet. Hide any assets you do not want public.
- App state: clear old drafts that would clutter the view, then stage one clean wallet-connected state.
- Do not show API keys, seed phrases, bridge tokens, env files, or terminal secrets.
- Optional proof fallback: keep the verified mainnet proof link ready in submission text if wallet popup capture is unreliable.

## Timed Shot List

| Time | Page | Action | Caption |
| --- | --- | --- | --- |
| 0:00-0:12 | Home | Show hero, then click `Launch App`. | Agents prepare. Your wallet signs. |
| 0:12-0:35 | App Command Center | Show trust boundary cards and wallet/sidebar state. | One approval workspace for AI, MCP, CLI, desktop, and web requests. |
| 0:35-0:58 | Connect AI | Show Hosted BYOK, Local Bridge AI, Browser Session. Do not enter a key. | AI can draft plans. It cannot approve, sign, submit, or move funds. |
| 0:58-1:28 | Create | Use `Swap tokens`, `0.01 SOL`, `USDC`, `0.5%`, then `Draft from template`. | The agent creates a bounded request with amount, route, limits, and risk. |
| 1:28-1:58 | Review / Inbox | Send the draft to Inbox, then show the approval card. | Executable work waits for the wallet owner. The agent never receives the key. |
| 1:58-2:25 | Recurring | Show weekly `0.01 SOL` schedule or pre-created active schedule. | Recurring schedules do not auto-spend. Each run returns to Inbox for approval. |
| 2:25-2:45 | Proofs + CLI/Desktop | Show proof creation or a non-empty receipt state, then 3-5 seconds of `/cli` or `/desktop`. | Receipts preserve what was reviewed, approved, rejected, or signed. |
| 2:45-2:55 | App or Home | Hold on brand and final state. | Open-source Solana signing infrastructure. Agents prepare. Your wallet signs. |

## Capture Notes

- Hard cuts are enough. Avoid animated transitions.
- Keep each click deliberate and wait for UI state changes before cutting.
- If a wallet popup appears and records cleanly, include it. If it does not, cut around it and show the resulting signed/proof-ready state.
- Do not linger on empty `History` or empty `Receipt Archive`; empty states read as unfinished.
- If time runs long, cut CLI/Desktop first, then trim the homepage open to 7 seconds.

## Edit Checklist

- Total runtime: `2:35` to `2:55`.
- First 15 seconds show the product promise and live app.
- Middle minute shows the core product loop: draft -> review -> inbox -> wallet decision.
- Last 30 seconds proves durability: recurring, receipts, install surface.
- Captions are legible at 1080p and do not cover critical buttons.
- Upload as unlisted or public YouTube, Loom, or Vimeo.

## Final Submission Language

Use this description next to the video link:

```text
Live Agentic demo: a real approval workspace where agents draft bounded Solana actions, the wallet owner reviews them in Inbox, recurring work still requires explicit approval, and receipts preserve the decision trail. No code walkthrough, no private-key handoff.
```
