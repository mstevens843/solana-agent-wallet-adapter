# Service Offers

Use these as the public service menu across Upwork, Fiverr, Contra, portfolio CTAs, and direct outbound.

## Offer 1: Solana Mobile Wallet Integration Sprint

### One-Line Pitch

I integrate or fix Solana wallet flows across Phantom, Solflare, Backpack, Wallet Standard, Mobile Wallet Adapter, Seed Vault, Android, iOS, and hybrid mobile apps.

### Best Buyers

- Solana dApps trying to support Seeker/Saga users.
- Teams with broken wallet connect/sign/send flows on mobile.
- Games or mobile apps using Unity, Unreal, Godot, Cocos, React Native, Capacitor, or webview shells.
- Founders who need app-store-ready wallet behavior and do not have deep Solana Mobile experience.

### Packages

**Diagnostic - $350**

- Reproduce wallet issue.
- Inspect app code, wallet integration, mobile environment, and transaction path.
- Deliver written findings, exact fix plan, and risk notes.
- 48-hour turnaround after repo/access is provided.

**Implementation Sprint - $1,500-$3,000**

- Fix or integrate one wallet flow end to end.
- Includes connect, sign message, sign transaction, send transaction, disconnect/reconnect, and basic docs where applicable.
- Includes one supported platform target: web, Android, iOS, Unity, Unreal, Godot, Cocos, or Capacitor.

**Production Hardening - $4,000+**

- Multi-wallet/mobile compatibility pass.
- Error handling, receipt/logging, auth/session behavior, and release notes.
- Hardware or device-specific test plan when client can provide access/device expectations.

### Public Description

```text
I help Solana teams ship wallet integrations that actually work outside the happy path.

I have built and tested Solana wallet infrastructure across web, Android, iOS, CLI, desktop, Unity, Godot, Unreal, Cocos, and Capacitor. My recent work includes Agentic, a Solana agent-wallet approval layer, SolPulse, a live Solana trading app, and public Mobile Wallet Adapter SDK/example work.

I can help with:
- Phantom, Solflare, Backpack, Jupiter, Wallet Standard, Mobile Wallet Adapter, and Seed Vault flows
- Android / Solana Mobile / Seeker / Saga wallet behavior
- iOS wallet deeplinks and WalletConnect-style approval paths
- signMessage, signTransaction, signAndSendTransaction, reconnect, disconnect, and auth cache bugs
- Web-to-mobile packaging issues in Capacitor, TWA, React Native, Unity, Unreal, Godot, or Cocos

I do not ask for private keys or seed phrases. I work with devnet/test wallets, reproducible cases, logs, and code review.
```

### Buyer Requirements

```text
Please provide:
1. Repo access or a minimal reproduction.
2. Target platform and wallets.
3. Expected behavior vs actual behavior.
4. Error logs, screenshots, or screen recording if available.
5. Whether this must work on devnet, testnet, mainnet-beta, or all of them.

Do not send private keys, seed phrases, production wallet secrets, or custodial credentials.
```

## Offer 2: MCP / AI Agent Tooling For Real Apps

### One-Line Pitch

I build secure MCP servers and AI-agent tool layers that connect LLMs to real product APIs without turning your app into a demo-only bot.

### Best Buyers

- SaaS teams adding Claude/Cursor/Codex/ChatGPT tool access.
- Founders with real APIs/data who need an MCP server or agent workflow.
- Web3 teams that want agents to prepare actions while users still approve wallet operations.
- Teams stuck between prototype and production because auth, logging, retries, and tool design are unclear.

### Packages

**Architecture Audit - $500**

- Review API/product workflow.
- Identify safe tools, auth boundary, transport, data shape, and deployment path.
- Deliver an implementation plan and recommended first MCP surface.

**Starter MCP - $1,500-$3,500**

- Build one MCP server or agent tool layer with 3-6 useful tools.
- Includes schema validation, auth approach, local run docs, and smoke test prompts.
- Can target Claude Desktop, Cursor, Codex-compatible MCP, or a custom agent runtime.

**Production Integration - $4,000-$6,000**

- Hardened deployment path, logging, retries, error handling, access controls, and test coverage.
- Optional dashboard/admin notes for operators.

### Public Description

```text
I build MCP servers and AI-agent integrations for real products, not toy demos.

My recent work includes a Solana agent-wallet adapter with MCP transports, local bridge auth, CLI/desktop/web/mobile surfaces, and wallet approval safety boundaries. I can help turn your existing app/API into a usable tool surface for Claude, Cursor, Codex-style agents, or your own LLM workflow.

I can help with:
- MCP server design and implementation
- Tool schemas that agents can actually use
- Auth, rate limits, token scoping, and operator safety
- API integration with Node.js, TypeScript, Hono/Express, PostgreSQL, Redis, and cloud deployment
- Agent workflows that prepare actions, gather facts, and produce auditable receipts
- Solana-specific agent/wallet flows where the user wallet stays the signer

You get practical implementation, not generic AI consulting.
```

### Buyer Requirements

```text
Please provide:
1. The app/API/workflow you want the agent to use.
2. Which client you care about first: Claude Desktop, Cursor, Codex, ChatGPT, custom app, or internal service.
3. Authentication requirements.
4. The first 3-6 tasks the agent should perform.
5. Deployment target if known.
```

## Offer 3: Solana dApp Rescue / Wallet Bug Fix

### One-Line Pitch

I debug Solana dApp, wallet, Jupiter, transaction, mobile, and signing bugs quickly and leave you with the exact fix.

### Best Buyers

- Teams with a visible production bug.
- Founders who need a fast second brain on transaction/wallet failures.
- Apps with failing sign/send flows, mobile connect bugs, or broken wallet adapters.

### Packages

**Triage - $250**

- Reproduce or inspect one issue.
- Deliver exact cause, fix path, and risk notes.

**Fix Sprint - $750-$1,500**

- Implement and test one scoped bug fix.
- Includes short handoff notes and reproduction verification.

**Stabilization Pass - $2,000-$3,000**

- Resolve a cluster of related wallet/transaction bugs.
- Add regression tests or smoke checks where appropriate.

### Public Description

```text
I fix Solana dApp bugs around wallet connection, signing, transactions, Jupiter routes, mobile behavior, and app packaging.

I have shipped production Solana apps and wallet infrastructure across web, mobile, desktop, CLI, and game-engine SDKs. If your wallet connect works on desktop but fails on mobile, your transaction simulates but will not sign, or your adapter state is broken after reconnect/disconnect, I can help isolate the cause and ship the fix.

Common issues I handle:
- Wallet Standard / adapter bugs
- Phantom, Solflare, Backpack, Jupiter, MWA, and Seed Vault behavior
- Transaction serialization, blockhash, fee payer, simulation, and send failures
- Jupiter quote/swap integration issues
- Mobile browser, webview, Capacitor, TWA, and app-store packaging bugs
- TypeScript, React, Next/Vite, Node, web3.js, Anchor-adjacent integration bugs
```

## Offer 4: Web-To-Mobile App Shipping Sprint

### One-Line Pitch

I package web apps into Android/iOS-ready mobile apps with release checks, listings, privacy notes, and wallet-aware behavior.

### Best Buyers

- SaaS or web3 founders who have a working web app but need Android/iOS distribution.
- Solana teams submitting to Google Play, Apple App Store, or Solana dApp Store.
- Teams using Capacitor/TWA/webview shells and hitting review or mobile behavior problems.

### Packages

**Release Readiness Audit - $400**

- Review app, store requirements, privacy/data-safety gaps, build path, and mobile blockers.

**Android Shipping Sprint - $1,500-$3,000**

- Package or fix Android release path.
- Includes build notes, asset/link checks, listing notes, and core smoke plan.

**Cross-Platform Shipping Sprint - $3,500-$6,000**

- Android + iOS packaging/release path, or Android + Solana dApp Store with wallet/mobile hardening.

### Public Description

```text
I help teams turn working web apps into mobile app releases.

I have shipped and prepared Solana/web apps for Android, iOS, TWA, Capacitor, and Solana dApp Store style distribution. I can help with app shells, release builds, store listing copy, privacy/data-safety notes, deep links, asset links, universal links, wallet behavior, and release smoke tests.

Best fit:
- React, Vite, Next.js, Node, TypeScript apps
- Solana/web3 apps that need wallet behavior to survive mobile/webview constraints
- Founders who need a practical ship plan instead of a rewrite
```

## Red Lines

Decline these:

- Private key, seed phrase, or custodial wallet work.
- Memecoin volume bots, fake activity, market manipulation, or spam.
- Unpaid implementation in exchange for "exposure."
- Bounties/grants where eligibility is not confirmed in writing before work.
- Ambiguous "build my whole app for $200" requests.
