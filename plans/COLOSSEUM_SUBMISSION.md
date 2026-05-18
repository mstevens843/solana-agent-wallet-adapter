# Colosseum Submission: Agentic

Copy-paste source for submitting Agentic, the Solana Agent Wallet Adapter, to Colosseum. This submission frames the project as open-source signing infrastructure with a working approval app built on top.

## Positioning

Primary line:

```text
Agentic is open Solana-native approval infrastructure for AI agents.
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
https://agentic-signer.com/
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
Agentic is an open-source multi-wallet Agent Signer for Solana: a wallet approval layer that lets AI agents prepare actions while the user's existing wallet signs. It routes MCP, CLI, Vercel AI, Solana Agent Kit, and app requests through Phantom, Solflare, Backpack, Jupiter, Wallet Standard, MWA, and iOS wallet paths. Includes a live approval workspace with templates, BYOK connectors, approve/deny reviews, recurring swap and payment setup, caps, inbox, receipts, and mainnet transfer proof.
```

### What Are You Building, And Who Is It For?

```text
Agentic is open-source signing infrastructure plus a working app. At the core is a shared WalletBackend protocol: agents create signing requests, wallet transports open an approval surface, users approve or reject in their existing wallet, and agents receive only the approved result.

The repo includes MCP tools, CLI, Wallet Standard web backend, Android MWA path, iOS wallet-link path, Vercel AI tools, Solana Agent Kit adapter, browser app, desktop shell, approval inbox, caps, BYOK connectors, signed artifacts, rejection/review proofs, recurring swap/payment setup, and receipts.

It is for Solana users who want AI help without giving agents keys, and for builders who need agent signing without custody.
```

### Why Did You Decide To Build This, And Why Build It Now?

```text
Onchain agents have signing models for autonomy: env-var signers, hot wallets, funded agent wallets, and delegated vaults. Those are useful, but user-owned actions need a different layer.

Solana users already trust Phantom, Solflare, Backpack, Jupiter, and mobile wallets. Agentic lets agents prepare transfers, swaps, DCA requests, recurring preferences, reviews, denials, and app approvals while the existing wallet remains the signer.

The timing is now because MCP and AI app stacks are becoming the interface for onchain workflows, but Solana still lacked a multi-wallet approval layer for agents.
```

### Technologies

```text
TypeScript, Node, Vite, Solana web3.js, Wallet Standard, Solana Mobile Wallet Adapter, iOS wallet links, WalletConnect/Reown for Jupiter mobile, MCP stdio/HTTP, Vercel AI SDK, Solana Agent Kit BaseWallet, Tauri desktop shell, Android TWA, Capacitor iOS, BYOK AI connectors, Render Node service, Vitest, GitHub Actions.
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
It communicates the full moat in one image: Agentic x Solana, multi-wallet agent signing, and the wallet set across Phantom, Solflare, Backpack, Jupiter, and MWA.
```

### GitHub Link

```text
https://github.com/mstevens843/solana-agent-wallet-adapter
```

### Important Context About The Repo

```text
Monorepo for Agentic: core WalletBackend protocol, MCP server, Wallet Standard web backend, Android MWA path, iOS wallet links, Vercel AI tools, Solana Agent Kit adapter, CLI, browser app, desktop shell, Android/iOS shells, BYOK connectors, approval inbox, caps, approve/deny reviews, recurring swap/payment setup, signed artifacts, rejection/review proofs, and receipts. Main proof: real mainnet SOL transfer requested by an agent, approved in an existing wallet, confirmed on-chain, with no private key exposure.
```

### Demo Video Link

Upload a public or unlisted YouTube, Loom, or Vimeo link. Keep it under 3 minutes. It should show the live product, not slides or a code walkthrough.

Recommended demo flow:

```text
0:00 - Open agentic-signer.com, show the hero promise, then click Launch App.
0:12 - Show the real /app Command Center and wallet/sidebar trust boundary.
0:35 - Open Connect AI and show Hosted BYOK, Local Bridge AI, and Browser Session. Make clear AI drafts only.
0:58 - Create a bounded Swap tokens draft: 0.01 SOL to USDC, 0.5% max slippage.
1:28 - Review the saved plan, send it to Approval Inbox, and show the wallet-gated approval card.
1:58 - Show Recurring: a weekly SOL-to-USDC swap or payment schedule where each due run returns to Inbox.
2:25 - Show Proofs or a non-empty receipt/rejection state, then a 3-5 second CLI/Desktop install surface.
2:45 - End on the line: Open-source Solana signing infrastructure. Agents prepare. Your wallet signs.
```

Recording direction: silent live-product walkthrough with short captions, hard cuts only, no slides, no code walkthrough, and the real app as the main proof. Use `/demo` only as a fallback or user-facing preview; the submitted demo should primarily show `/app`.

### Live Product Link

```text
https://agentic-signer.com/
```

### Access Instructions

```text
Open https://agentic-signer.com/. Use templates without an AI key, or use BYOK with OpenAI, Claude / Anthropic, Gemini, OpenRouter, or a custom OpenAI-compatible provider. AI only drafts plans and reviews. It cannot sign, submit, approve, or bypass wallet review.

For local approvals, use the CLI or Desktop App from the site. Connect a Solana wallet, create a plan, queue an approval, approve or deny from the inbox, and sign from the wallet only when ready. Wallet approvals run locally; the user's wallet remains the signer.

If repo access fails, contact @mattinfra.
```

### Pitch Video

Upload a separate public YouTube, Loom, or Vimeo link. Keep it under 2 minutes. Rework the existing Remotion video from:

```text
/Users/devlegacy/Desktop/marketing/remotion/out/agent-wallet-pitch-v7.mp4
```

Recommended pitch script:

```text
I'm Mathew Stevens.

I build Solana wallet infrastructure.

So I built Agentic: open-source signing infrastructure for AI agents on Solana.

Right now, agents are being handed private keys.

That works for agent-owned autonomy.

But for user-owned actions, the wallet should stay the signer.

Agentic flips the boundary.

Agents prepare. Your wallet signs.
```

Animation voiceover source:

```text
docs/handoff/colosseum-pitch-voiceover.md
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
No. Solo project. No contributors outside @mattinfra did meaningful work on Agentic. I built the architecture, protocol, MCP server, wallet backends, CLI, browser app, desktop shell, AI planning/review flow, approval inbox, recurring workflows, receipts, documentation, and real-wallet testing. Prior Cocos, Unreal, Capacitor, Unity, and Godot wallet-adapter work is my background only, not outside contribution to this repo.
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
This project builds on my prior Solana wallet infrastructure work: Cocos Creator MWA SDK, Unreal Solana MWA plugin, Capacitor MWA plugin, plus Unity/Godot MWA grant work. That background matters because Agentic generalizes the same wallet-approval problem from mobile apps to AI agents. Open source, Apache-2.0, with a live website, local CLI/Desktop runtimes, BYOK connectors, recurring approval workflows, and verified mainnet transfer proof.
```

### Accelerator Program

Recommended answer:

```text
No, unless you want to reposition Agentic as a venture-backed company. The strongest current lane is open-source infrastructure / public good.
```

## Final Pre-Submit Checklist

- Replace the old Cocos logo with the Agentic x Solana project graphic.
- Replace the GitHub link with `https://github.com/mstevens843/solana-agent-wallet-adapter`.
- Replace the live product link with `https://agentic-signer.com/`.
- Replace Cocos repo context with the Agentic repo context above.
- Upload a new demo video focused on the live Agentic app.
- Upload a new 2-minute pitch video with current Agentic positioning.
- Confirm the repository is public or shared with `hackathon@colosseum.org`.
- Confirm the demo and pitch videos play in an incognito browser.
- Keep prior Cocos/Unreal/MWA work only in team credibility fields.
