# Sendaifun coordination RFC - draft

Paste this as a new issue at <https://github.com/sendaifun/solana-agent-kit/issues/new>. Title and body separated.

---

## Title

```
RFC: alternate `BaseWallet` backend for user-approval signing flows (multi-wallet, mobile-native, no key custody)
```

## Body

```markdown
Hi sendaifun team - opening this as an RFC rather than a PR because the work plugs into your existing `BaseWallet` contract without requiring any changes on your side. Wanted to surface it early in case there's appetite for collaboration or a recommended-backend listing.

## What I'm building

`solana-agent-wallet-adapter` - a Solana wallet adapter for AI agents that routes signing through the user's actual installed wallet (Phantom, Solflare, Backpack) with no key custody. Three wallet backends:

- **Web** - Wallet Standard via `@wallet-standard/app`, working today
- **Android** - real MWA via `@solana-mobile/mobile-wallet-adapter-protocol` (planned)
- **iOS** - universal-link + AES-GCM session per wallet (planned, sibling repo `ios-solana-wallet-adapter`)

Layered on top: an MCP server with user-approval signing for Claude Desktop / Cursor / Anthropic Agents, plus framework integration packages. First framework integration is Vercel AI SDK; second is intended to be Solana Agent Kit.

Repo: <https://github.com/mstevens843/solana-agent-wallet-adapter>

## Why I'm writing

The plan is to ship `@solana-agent-wallet-adapter/solana-agent-kit` - a thin adapter that implements your `BaseWallet` interface so anyone using `SolanaAgentKit` can plug in a non-custodial, user-approval-driven backend alongside your existing Privy / Turnkey / Phantom examples. No changes to your repo required; the package would consume `BaseWallet` from `solana-agent-kit` as a peer dependency.

Two questions for you:

1. **Are you about to ship overlapping support?** I read recent commits, open issues, discussions, and didn't see anything in flight, but I'd rather ask than duplicate work. If you have a non-custodial backend roadmap I'd be happy to align with it instead of paralleling.

2. **Would you be open to listing this in your docs as a recommended community backend** alongside Privy / Turnkey / Phantom, once it's stable? I'd mirror the API style of your existing examples and ship reference apps so devs can copy-paste a setup.

## Why a non-custodial backend matters

Privy and Turnkey are excellent for embedded-wallet flows (one-tap onboarding, social login). They're not the right fit for users who already own Phantom, Solflare, or Backpack and don't want a separate wallet for their agent. The community pattern of "agent calls signTransaction → user approves in the wallet they already use → agent never holds a key" doesn't have a good story today on Solana Agent Kit.

This adapter fills that gap and pairs naturally with the embedded options you ship - you can say "use Privy if you want managed, use this if you want user-controlled."

## What's done

- Core protocol types and `WalletBackend` interface
- MCP server with user-approval signing tools (stdio + Streamable HTTP transports)
- `wallet-standard-web` backend (Phantom/Solflare/Backpack via Wallet Standard)
- Vercel AI SDK tool package
- Five research notes including a full prior-art audit
- End-to-end smoke through Claude Code (real client, not just JSON-RPC)

Happy to chat in DM, on Twitter, or here. Whatever's easiest.

- [your-handle]
```
```

---

## Notes for posting

- Replace `[your-handle]` with your actual username at the bottom.
- The repo URL `https://github.com/mstevens843/solana-agent-wallet-adapter` will resolve once you've pushed (already done).
- Add the `discussion` or `enhancement` label if their issue templates ask for one.
- If they have a Discord, drop a one-liner there pointing at the issue. Don't post the full body in Discord, keeps the canonical thread on GitHub.
- Tone is collaborative-not-defensive. Don't lead with "you should do X." Lead with "I'm doing X, want to align?"

## Timing

Post this **after** the SAK adapter package (B2f) builds clean. If a maintainer clicks through and the package looks half-baked, the RFC reads worse than if it points at a working integration. Ideal sequence: ship package → push to GitHub → post issue with a working code link they can run themselves.
