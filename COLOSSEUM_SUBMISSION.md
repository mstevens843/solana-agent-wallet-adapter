# Colosseum Submission: Agentic

Copy-paste source for submitting Agentic, the Solana Agent Wallet Adapter, to Colosseum. This submission frames the project as open-source signing infrastructure with a working approval app built on top.

## Positioning

Primary line:

```text
Agentic is the first multi-wallet Agent Signer on Solana.
```

Slogan:

```text
Agents prepare. Your wallet signs.
```

Submission posture:

```text
Open-source Solana signing infrastructure plus a working approval app. The durable product is the wallet approval layer: agents can prepare Solana actions, but the user's existing wallet remains the signer.
```

Canonical live URL:

```text
https://agent-signer.com/
```

Repository:

```text
https://github.com/mstevens843/solana-agent-wallet-adapter
```

## Page 1: Project Info

### Project Name

```text
Agentic
```

### Brief Description

```text
Agentic is the first multi-wallet Agent Signer on Solana: an open-source wallet approval layer that lets AI agents prepare actions while the user's existing wallet signs. It routes MCP, CLI, Vercel AI, Solana Agent Kit, and app requests through Phantom, Solflare, Backpack, Jupiter, Wallet Standard, MWA, and iOS wallet paths. Includes a live approval workspace with templates, BYOK planning, caps, inbox, receipts, and mainnet transfer proof.
```

### What Are You Building, And Who Is It For?

```text
Agentic is open-source signing infrastructure plus a working app. At the core is a shared WalletBackend protocol: agents create signing requests, wallet transports open an approval surface, users approve or reject in their existing wallet, and agents receive only the approved result.

The repo includes MCP tools, CLI, Wallet Standard web backend, Android MWA path, iOS wallet-link path, Vercel AI tools, Solana Agent Kit adapter, browser app, desktop shell, approval inbox, caps, BYOK planning, signed artifacts, and receipts.

It is for Solana users who want AI help without giving agents keys, and for builders who need agent signing without custody.
```

### Why Did You Decide To Build This, And Why Build It Now?

```text
Onchain agents have signing models for autonomy: env-var signers, hot wallets, funded agent wallets, and delegated vaults. Those are useful, but user-owned actions need a different layer.

Solana users already trust Phantom, Solflare, Backpack, Jupiter, and mobile wallets. Agentic lets agents prepare transfers, swaps, DCA requests, reviews, and app approvals while the existing wallet remains the signer.

The timing is now because MCP and AI app stacks are becoming the interface for onchain workflows, but Solana still lacked a multi-wallet approval layer for agents.
```

### Technologies

```text
TypeScript, Node, Vite, Solana web3.js, Wallet Standard, Solana Mobile Wallet Adapter, iOS wallet links, WalletConnect/Reown for Jupiter mobile, MCP stdio/HTTP, Vercel AI SDK, Solana Agent Kit BaseWallet, Tauri desktop shell, Android TWA, Capacitor iOS, BYOK AI planning, Render Node service, Vitest, GitHub Actions.
```

### Category

```text
Infrastructure
```

If Colosseum offers a secondary public-good or open-source category, use that as secondary framing. Do not make the submission sound like a token startup.

## Page 2: Media And Code

### Project Logo Or Graphic

Use the Agentic x Solana graphic with Phantom, Solflare, Backpack, Jupiter, and MWA badges.

Preferred file from the launch assets:

```text
project-logo.png
```

Visual rationale:

```text
It communicates the full moat in one image: Agentic x Solana, first multi-wallet Agent Signer, and the wallet set across Phantom, Solflare, Backpack, Jupiter, and MWA.
```

### GitHub Link

```text
https://github.com/mstevens843/solana-agent-wallet-adapter
```

### Important Context About The Repo

```text
Monorepo for Agentic: core WalletBackend protocol, MCP server, Wallet Standard web backend, Android MWA path, iOS wallet links, Vercel AI tools, Solana Agent Kit adapter, CLI, browser app, desktop shell, Android/iOS shells, BYOK planning, approval inbox, caps, signed artifacts, and receipts. Main proof: real mainnet SOL transfer requested by an agent, approved in an existing wallet, confirmed on-chain, with no private key exposure.
```

### Demo Video Link

Upload a public or unlisted YouTube, Loom, or Vimeo link. Keep it under 3 minutes. It should show the live product, not slides or a code walkthrough.

Recommended demo flow:

```text
0:00 - Open agent-signer.com and show the app/workspace.
0:15 - Connect a Solana wallet or show wallet connection state.
0:30 - Create a plan from a template, for example SOL to USDC swap or capped SOL transfer.
0:55 - Show optional BYOK provider choices: OpenAI, Claude / Anthropic, Gemini, OpenRouter, custom OpenAI-compatible.
1:10 - Show that AI output is only a draft plan and cannot sign, submit, or approve.
1:25 - Queue the plan into Approval Inbox.
1:45 - Open the wallet approval flow or show the wallet-gated signing step.
2:05 - Show a signed artifact, receipt, or transaction confirmation.
2:25 - Show CLI/Desktop install surface briefly.
2:45 - End on the line: Agents prepare. Your wallet signs.
```

### Live Product Link

```text
https://agent-signer.com/
```

### Access Instructions

```text
Open https://agent-signer.com/. Use templates without an AI key, or use BYOK with OpenAI, Claude / Anthropic, Gemini, OpenRouter, or a custom OpenAI-compatible provider. AI only drafts plans. It cannot sign, submit, or approve.

For local approvals, use the CLI or Desktop App from the site. Connect a Solana wallet, create a plan, queue an approval, and sign from the wallet. Wallet approvals run locally; the user's wallet remains the signer.

If repo access fails, contact @mattinfra.
```

### Pitch Video

Upload a separate public YouTube, Loom, or Vimeo link. Keep it under 2 minutes. Rework the existing Remotion video from:

```text
/Users/devlegacy/Desktop/marketing/remotion/out/agent-wallet-pitch-v7.mp4
```

Recommended pitch script:

```text
Hi, I'm Matt. I built Agentic, the first multi-wallet Agent Signer on Solana.

The gap is simple: onchain agents have signing models for autonomy, like env-var signers, hot wallets, funded agent wallets, and delegated vaults. Those are useful, but user-owned actions need a different layer.

Agentic adds that layer. Agents prepare Solana actions. The user's existing wallet signs.

The repo includes a shared WalletBackend protocol, MCP tools, CLI, Wallet Standard web backend, Android MWA path, iOS wallet-link path, Vercel AI tools, Solana Agent Kit adapter, browser app, desktop shell, approval inbox, caps, BYOK planning, signed artifacts, and receipts.

The proof is live: an AI agent requested a real mainnet SOL transfer, the user approved in an existing browser wallet, the wallet signed and broadcasted, and the agent received the confirmed transaction id. The private key never left the wallet.

Agentic is for users who want AI help without giving up keys, and for builders who need agent signing without becoming custodians.

Agents prepare. Your wallet signs.
```

## Page 3: Team

### Primary Location

```text
United States
```

### Team Members

```text
@mattinfra
```

### Where Have You Worked Or Built Before?

```text
Full-stack Solana dev shipping wallet and mobile infrastructure.

SolPulse: Solana trading app built solo, with a 35-pillar intelligence engine, high-throughput transaction execution, MWA hardware signing, and web/iOS/Android/dApp Store releases.

Godot MWA SDK (Solana Mobile grant): brought to React Native parity. Merged upstream PRs #449, #453, #454 for signAndSend, getCapabilities, clearState, SIWS, identity, and auth-token cache. Fixed 10 bugs. Verified on Seeker.

Unity MWA SDK (Solana Mobile grant): merged PR #275 and opened PRs #274, #277, #278, #279, #280 for SignMessage, capabilities, SIWS, sign_and_send, and AuthToken. Fixed 11 bugs during hardware testing.

Capacitor Solana MWA: first Capacitor plugin for MWA, open source.

Cocos Creator MWA SDK: solo SDK for Asia's dominant mobile game engine.

Unreal Solana MWA: UE5 plugin exposing MWA through Blueprint nodes.

Agentic: this submission, the agent signing layer built from that wallet-infra base.
```

### Did Anyone Not Listed On The Team Do Meaningful Work?

```text
No. Solo project. No contributors outside @mattinfra did meaningful work on Agentic. I built the architecture, protocol, MCP server, wallet backends, CLI, browser app, desktop shell, AI planning flow, approval inbox, receipts, documentation, and real-wallet testing. Prior Cocos, Unreal, Capacitor, Unity, and Godot wallet-adapter work is my background only, not outside contribution to this repo.
```

### Team Telegram Contact

```text
mattinfra
```

### X Profile

```text
mattinfra
```

### Anything Else Judges Should Know?

```text
This project builds on my prior Solana wallet infrastructure work: Cocos Creator MWA SDK, Unreal Solana MWA plugin, Capacitor MWA plugin, plus Unity/Godot MWA grant work. That background matters because Agentic generalizes the same wallet-approval problem from mobile apps to AI agents. Open source, Apache-2.0, with a live website, local CLI/Desktop runtimes, and verified mainnet transfer proof.
```

### Accelerator Program

Recommended answer:

```text
No, unless you want to reposition Agentic as a venture-backed company. The strongest current lane is open-source infrastructure / public good.
```

## Final Pre-Submit Checklist

- Replace the old Cocos logo with the Agentic x Solana project graphic.
- Replace the GitHub link with `https://github.com/mstevens843/solana-agent-wallet-adapter`.
- Replace the live product link with `https://agent-signer.com/`.
- Replace Cocos repo context with the Agentic repo context above.
- Upload a new demo video focused on the live Agentic app.
- Upload a new 2-minute pitch video with current Agentic positioning.
- Confirm the repository is public or shared with `hackathon@colosseum.org`.
- Confirm the demo and pitch videos play in an incognito browser.
- Keep prior Cocos/Unreal/MWA work only in team credibility fields.
