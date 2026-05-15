# Seeker AI dApp Research Notes

Last reviewed: 2026-05-15

## Summary

Agentic Android should stay wallet-first for v1: native MWA custody, user-opened approvals, Agentic Cloud sync, and optional AI drafting. The Seeker AI apps that run autonomous agents generally use a separate daemon/container/channel architecture, which is useful v2 research but too broad for the current Android wallet app.

## Repos And Products Checked

| Project | Source | How users connect to AI | Android relevance |
| --- | --- | --- | --- |
| SeekerClaw | https://github.com/sepivip/SeekerClaw | Bundles a Node.js agent into an Android foreground service. Users configure AI provider keys and interact through Telegram or Discord. The service bridges to device tools, Solana/Jupiter actions, skills, MCP, and MWA. | Strong v2 reference for an on-device agent daemon. Do not copy into v1 because it needs background service scope, channel auth, much wider permissions, and embedded runtime management. |
| Node Sphere AI | https://nodesphereai.com/ and https://nodesphereai.com/docs/latest/#official-links | Product/docs describe multi-channel agent creation and automation. No public GitHub repo was found in the reviewed searches. | Product/UX reference only unless a source repo is provided. |
| Clawly / OpenClaw | https://www.clawly.org/ and https://github.com/openclaw/openclaw | OpenClaw is a local-first, multi-channel agent runtime; Clawly appears to host/deploy OpenClaw-style agents across channels. | Useful for future external-agent and gateway patterns. Not a reason to embed a runtime in v1. |
| SolClaw agent | https://github.com/anagrambuild/solclaw and https://www.solclaw.ai/ | Containerized Solana agent for WhatsApp/Telegram with protocol skills and natural-language onchain actions. | Similar to SeekerClaw as a channel/agent runtime model. Treat as v2 daemon/channel research. |
| SolClaw payments | https://github.com/Sterdam/solclaw and https://www.solclaw.xyz/ | Agent-to-agent USDC payment API. Remote service returns transactions for a wallet to sign. | Relevant to Agentic Cloud preparing requests while Android signs locally through MWA. This matches our v1 model. |

## Implementation Takeaways

- Adopt now: remote services prepare requests, Android signs locally, secrets stay out of cloud persistence, and every spending action returns to wallet approval.
- Adopt now: encrypted storage for Android cloud session tokens and MWA auth records.
- Keep optional: LAN bridge for desktop/local runtime testing. Phone `localhost` cannot reach a laptop bridge; Android must use a private LAN IP or `.local` host.
- Defer: embedded Node.js, foreground services, Telegram/Discord bot ownership, broad device permissions, autonomous background jobs, and always-on agent scheduling.
- Track later: transaction-proof cloud login for wallets that do not support MWA message signing.
