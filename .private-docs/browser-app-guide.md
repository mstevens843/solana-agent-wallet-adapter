# Browser App Guide

`apps/browser-demo` is the main Agentic product shell. The name is historical. It now contains the hosted public website, `/app` workspace, local browser wallet host, chat interface, connector controls, and mobile web shell.

## Run Locally

```bash
pnpm demo:browser
```

Open `http://127.0.0.1:5174`.

For local cloud APIs:

```bash
pnpm -F @solana-agent-wallet-adapter/browser-demo dev:cloud
pnpm demo:browser
```

The Vite server proxies `/api` to render-web on port `3001` by default.

## App Routes

Important SPA routes include:

- `/`
- `/docs`
- `/builders`
- `/app`
- `/connect`
- `/approve`
- `/sign`
- `/sign-in`
- `/qr-connect`
- `/cli`
- `/desktop`
- `/aiconnectors`
- `/android`
- `/demo`
- `/mwa-test`
- `/privacy`
- `/terms`

## Workspace Tabs And Workflows

Desktop public tabs:

- Home
- Chat
- New Request
- Sign Approval
- Done
- More

More menu:

- Positions
- Address Book
- Repeat Payments
- Save Proof
- Agent Payments
- Skills
- Sessions

Mobile moves some surfaces into bottom dock and More.

## Chat Surface

Chat code lives mainly in `src/main.ts` plus:

- `chatRequest.ts`
- `chatCloudSync.ts`
- `chatDecisionCheck.ts`
- `chatMarkdown.ts`
- `chatProof.ts`
- `chatReadiness.ts`
- `chatResearchQuota.ts`
- `chatStaticReplies.ts`
- `chatAgent/clientTools.ts`
- `chatAgent/toolLabels.ts`

Chat features:

- streaming assistant replies
- wallet context injection
- wallet balance context
- connector context injection
- action proposal cards
- prepared action promotion
- inline tx receipts
- receive QR card
- recurring card references
- research cards
- Decision Planner cards
- citations and usage footer
- copy, edit, regenerate
- history menu
- per-wallet cloud chat sync
- pending approval dropdown

## Chat Wallet Actions

Everyday actions:

- Swap Tokens
- Send Tokens
- Recurring / DCA
- Sign Proof

Advanced connector actions:

- Lend
- Limit / TP-SL
- Borrow
- Liquidity
- Stake
- Perps
- Prediction, feature gated
- NFT
- Governance
- Bridge
- Oracle

Chat connector actions intentionally reuse New Request forms instead of duplicating connector logic.

## Chat Research

Research actions:

- Safety Checker
- Rug Scanner
- Dev Forensics
- Token Lifecycle
- Whale Scanner
- Wallet X-Ray
- Market Regime
- Trending Tokens
- Smart Money Tokens
- New Listings
- Top Traders

These are deterministic read-only cards. They do not create approval actions by themselves.

## Decision Planner

The Decision Planner lets the user type conditions, then attach or build a wallet action. It runs the same review/evidence engine as New Request and Repeat workflows.

Outcomes:

- APPROVE
- DENY
- NEEDS INPUT
- WALLET NEEDED
- REVIEW FAILED

Approval does not sign. It only means the action can continue to human wallet review.

## Workflow Persistence

Browser app state includes:

- generated plans
- browser workflow approvals
- chat history
- completed records
- recipient rules
- agent policies
- custom tokens
- agents
- planner preferences
- connector preferences
- failure policies
- program rules
- positions
- spend caps
- slippage caps
- lab artifacts

Chat history is capped and compressed to avoid localStorage blowups.

## Native/Mobile Notes

The same web app runs inside:

- Android native/TWA shell
- iOS Capacitor/native shell
- desktop Tauri shell

Native-specific paths include cloud token bridges, Android MWA, iOS wallet links, device-agent runtime, and live update handling.

## Build

```bash
pnpm render:build
```

This builds browser assets, writes route fallback files, builds render-web, and runs render smoke.

