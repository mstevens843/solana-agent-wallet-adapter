# Direct Outbound

Direct outbound is the primary channel. The goal is not mass spam. The goal is to find teams where your proof is unusually relevant.

## Prospect Buckets

Prioritize in this order:

1. Solana dApp Store / Seeker / Saga apps with weak wallet/mobile UX.
2. Solana games or game-engine teams.
3. Solana apps announcing mobile support, AI agents, or wallet integrations.
4. Founders posting about MCP, agents, or AI workflows.
5. GitHub repos with open wallet/mobile issues.
6. Agencies building crypto/mobile apps who need overflow specialist help.

## Daily Target

- 15-25 direct messages per day.
- 8-12 Upwork proposals per day.
- 5 follow-ups per day.
- 1-2 paid diagnostics booked per week minimum.

## Message 1: Solana Mobile / Wallet Bug

```text
Hey [name] - saw [app/project] is working on Solana mobile/wallet flows.

This is a narrow area I have been deep in recently: Agentic, SolPulse, and public MWA SDK/example work across Unity, Godot, Unreal, Cocos, Capacitor, Android, and iOS wallet paths.

If you have any Phantom/Solflare/Backpack/Jupiter/MWA/mobile signing bugs, I can do a focused diagnostic and give you the exact fix path. No private keys or custody involved.

Relevant proof: https://mathewstevens.dev/portfolio/
```

## Message 2: MCP / AI Agent

```text
Hey [name] - noticed [company/project] is touching AI agents / MCP / workflow automation.

I have been building Agentic, a Solana agent-wallet layer with MCP transports, local bridge auth, CLI/desktop/web/mobile surfaces, and approval boundaries where the user wallet stays the signer.

If you are trying to expose product APIs to Claude/Cursor/Codex-style agents, I can help design and build the first MCP/tool surface with schemas, auth, logs, and a practical deployment path.

Proof: https://github.com/mstevens843/solana-agent-wallet-adapter
```

## Message 3: Agency Overflow

```text
Hey [name] - quick note in case useful.

I do specialist overflow work around Solana wallet integrations, mobile app packaging, MCP/AI-agent tools, and dApp rescue. I am strongest where the task crosses product code, wallet behavior, mobile release constraints, and production debugging.

Recent proof:
- Agentic: Solana agent-wallet signer across MCP/web/mobile/CLI/desktop
- SolPulse: live Solana trading app
- Public MWA SDK/example work across Unity, Godot, Unreal, Cocos, Capacitor, iOS

If you ever have a client stuck on wallet/mobile/agent integration, I can take a scoped diagnostic or implementation sprint.
Portfolio: https://mathewstevens.dev/portfolio/
```

## Message 4: GitHub Issue Reply

Use only when relevant and not spammy.

```text
I have worked through similar Solana wallet/mobile behavior in production and SDK/example repos.

Likely areas to check:
- adapter session/auth state after reconnect/disconnect
- wallet-specific sign/send behavior
- transaction serialization / fee payer / blockhash lifecycle
- mobile browser or webview constraints if this fails only on device

If helpful, I can take a focused look and produce a root-cause/fix plan. Relevant work: https://mathewstevens.dev/portfolio/
```

## Follow-Up 1: Two Days Later

```text
Quick follow-up. If wallet/mobile/agent integration is not a priority right now, no worries.

If it is, the fastest useful first step is a scoped diagnostic: I reproduce/inspect one issue, identify the root cause, and give you the exact fix path before any larger implementation.
```

## Follow-Up 2: One Week Later

```text
Closing the loop here. I am booking a few short Solana wallet/MCP/mobile sprints this month.

Best fit is a concrete issue like "wallet fails on mobile", "MCP tool surface needs production hardening", or "web app needs Android/iOS release path." If that comes up later, send the repo and target platform.
```

## Inbound Reply Triage

When someone replies, classify quickly:

- **Hot:** Has a concrete bug, repo, deadline, budget, or app-store blocker. Offer paid diagnostic immediately.
- **Warm:** Has interest but no specific issue. Ask for current stack, wallet/platform target, and next release milestone.
- **Cold:** Wants free advice, vague collab, or no budget. Give one helpful sentence, then move on.
- **Reject:** Private keys, bots, fake volume, exploitative unpaid work, or unclear payment.

## Paid Diagnostic Close

```text
The cleanest next step is a paid diagnostic.

Scope:
- I inspect/reproduce one issue.
- I identify root cause and risk.
- I deliver the exact fix path and implementation estimate.
- If you want me to implement after that, the diagnostic cost is credited against the sprint.

Price: $350.
Turnaround: 48 hours after access/repro is available.

No private keys, seed phrases, or custody material.
```

## Implementation Sprint Close

```text
This is scoped enough for a fixed sprint.

Deliverable:
- [specific wallet/MCP/mobile/app fix]
- Code changes in branch/PR
- Basic verification notes
- Handoff notes

Price: $[amount].
Timeline: [timeline].
Start requirement: repo access, target environment, and a test wallet/reproduction.
```

## 20-Minute Call Agenda

```text
1. What needs to ship or what is broken?
2. Which platform/wallet/client matters first?
3. What is the smallest useful result this week?
4. What access, logs, devices, or reproduction exist?
5. Confirm no private keys or custody material.
6. Choose diagnostic or fixed sprint.
```

## Lead Sources To Search Daily

- X/Twitter: `Solana Mobile`, `Seeker`, `Saga`, `Mobile Wallet Adapter`, `MCP`, `Claude MCP`, `Solana wallet`, `Jupiter API`.
- GitHub: issues containing `Mobile Wallet Adapter`, `Wallet Standard`, `Phantom`, `Solflare`, `Backpack`, `Jupiter`, `signTransaction`, `signAndSendTransaction`.
- Superteam: development/project listings only.
- Upwork: saved searches listed in [upwork.md](./upwork.md).
