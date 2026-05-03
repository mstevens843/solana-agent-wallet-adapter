# 02 - MCP approval-gated prior art

Existing MCP servers that gate actions behind explicit user confirmation. We want to copy a working pattern, not invent one.

## Patterns surveyed

### A. URL-mode elicitation (MCP spec, draft)

[Spec link](https://modelcontextprotocol.io/specification/draft/client/elicitation). Server emits `elicitation/create` with `mode: "url"`; client displays a URL and consent prompt; user completes the action externally; server emits `notifications/elicitation/complete` when done; client retries the original tool call.

Fits our async wallet-popup model exactly in spirit, but **client adoption is partial.** We'd be building against a spec feature that not every client implements yet.

### B. JSON-text + confirmation-tool (de facto blockchain pattern)

The shape used by every existing wallet-flavored MCP server today:

| Repo | Pattern | Custodial? |
|---|---|---|
| [nikicat/mcp-wallet-signer](https://github.com/nikicat/mcp-wallet-signer) | Tool returns pending + URL; user clicks; second tool finalizes | Non-custodial via external sign |
| [vrllrv/junto-mcp](https://github.com/vrllrv/junto-mcp) | Same shape | Non-custodial |
| [sendaifun/solana-mcp](https://github.com/sendaifun/solana-mcp) | Auto-signs with embedded keypair | **Custodial** (server holds key in `.env`) |
| [paulfruitful/WalletMCP](https://github.com/paulfruitful/WalletMCP) | Auto-signs | Custodial |
| [hifriendbot/agentwallet-mcp](https://github.com/hifriendbot/agentwallet-mcp) | Custodial + automated guards (daily limits, gas-price ceilings, rate limits) | Custodial |

Two existing servers (mcp-wallet-signer, junto-mcp) match our async-non-custodial model. Both use the JSON-text + confirmation-tool pattern. Three Solana-flavored servers exist (sendaifun, openSVM, paulfruitful) but **all three are custodial** - they don't implement user-approval flows because they don't need to.

### C. Form-mode elicitation (MCP spec)

Server pauses execution and asks the user a structured question synchronously. Good for password prompts and yes/no clarifications. **Wrong fit** for async wallet signing because the user has to bounce out to the wallet, possibly on another device.

### D. Stripe Link CLI pattern

[stripe/link-cli](https://github.com/stripe/link-cli). Triggers a push notification or email to the user, then polls until approved or denied. Reusable idea: **polling loop with status check** after triggering the external interaction. Matches our model where the wallet popup is the "external interaction."

### E. Custodial + automated guards

`hifriendbot/agentwallet-mcp` skips user approval entirely and instead constrains what the agent can do (daily spend, max gas, allowed addresses). **Wrong fit** for us - we explicitly want non-custodial, user-in-the-loop signing. But the guards layer is a good optional addition for later (e.g., "auto-approve transactions under $1 if pre-authorized").

### F. Anthropic's official examples

[modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) - filesystem, git, github, brave-search, etc. None implement a documented approval-required pattern. Filesystem has `require_approval` config but no two-step flow visible in source.

## What our v1 should look like

**Use Pattern B (JSON-text + confirmation-tool)** as the v1 default. Reasons:

1. Two existing wallet MCP servers already prove it works in Claude Desktop and Cursor today.
2. No client adoption gating (works everywhere).
3. Maps cleanly to our existing scaffold - already implemented in commit `a1aeeb6`.
4. Easy to layer Pattern A (URL elicitation) on top later for clients that support it.

**Avoid Pattern C** - synchronous re-prompt-with-confirm doesn't fit async wallet UX.

**Avoid Pattern E** - opposite of our value proposition. Custodial + guards is a different product.

## Concrete tool definitions to mirror

From `nikicat/mcp-wallet-signer` (the cleanest non-custodial example):

```typescript
// 1. Initiate signing - returns pending
{
  name: 'sign_transaction',
  inputSchema: { /* tx + cluster + summary */ },
  // Returns: { content: [{ type: 'text', text: '<JSON pending state with requestId + approvalUri>' }] }
}

// 2. Poll until resolved
{
  name: 'check_signing_status',
  inputSchema: { requestId: string },
  // Returns: { content: [{ type: 'text', text: '<JSON: pending|approved|rejected with signature on approved>' }] }
}
```

Our scaffold already mirrors this exactly (`solana_sign_*` + `solana_check_approval`). Implementation note for v1: ensure the pending JSON includes `approvalUri` even if it's a placeholder for now - agents will eventually want it for click-through.

## References

- [MCP spec - elicitation](https://modelcontextprotocol.io/specification/draft/client/elicitation)
- [nikicat/mcp-wallet-signer](https://github.com/nikicat/mcp-wallet-signer)
- [vrllrv/junto-mcp](https://github.com/vrllrv/junto-mcp)
- [sendaifun/solana-mcp](https://github.com/sendaifun/solana-mcp)
- [hifriendbot/agentwallet-mcp](https://github.com/hifriendbot/agentwallet-mcp)
- [stripe/link-cli](https://github.com/stripe/link-cli)
- [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers)
