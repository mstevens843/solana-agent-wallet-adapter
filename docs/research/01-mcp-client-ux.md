# 01 — MCP client UX for resource + approval rendering

What MCP clients actually render today vs what the spec promises. This determines the minimum viable approval shape we can ship now.

## Findings

### Claude Desktop

- **Tool results:** renders `content: [{type: 'text', text: '...'}]` as raw text. Does NOT auto-format JSON; whatever string the server returns is what the user sees.
- **`isError` flag:** honored as a styling hint.
- **Resources:** [discoverable but not rendered in chat UI](https://github.com/modelcontextprotocol/typescript-sdk/issues/686). Confirmed in Python SDK [issue #1016](https://github.com/modelcontextprotocol/python-sdk/issues/1016).
- **Clickable URIs:** no native handling. URIs in text become URL-styled text but don't trigger app-level actions.
- **Per-tool approval UX:** none built in. Claude Desktop authorizes the server connection (via OAuth where applicable) but does not surface per-tool-call approvals.

### Cursor

- Per-tool approval is **on by default** (user clicks approve before each tool call). Auto-run can be enabled in settings.
- Tool results shown in chat with expandable arguments and responses.
- Supports base64 image data in results.
- No approval-resource UX. Approval happens at execution time, not as a post-execution pending state.

### MCP Inspector

- Dev tool. Visualizes JSON tool responses, request history, errors. Hierarchical resource navigation.
- Doesn't render HTML or interactive widgets. Not end-user facing.

### MCP spec (2025-11-25 draft)

- No `ApprovalResource` type in the spec. (The `ApprovalResource` shape that pops up in search results is a Microsoft 365 Copilot pattern, not MCP standard.)
- Spec text says applications **SHOULD** present confirmation prompts for sensitive operations. Client responsibility, not server capability.
- Resource and elicitation primitives exist in spec; client adoption is partial (see notes 02 and 03).

### Real-world patterns

The de facto pattern for blockchain / wallet MCP servers is **two-step JSON-text + confirmation tool**:

1. Tool returns JSON: `{ status: 'pending', requestId: '...', approvalUri: '...', summary: 'Sign Solana transaction: ...' }`
2. Agent reads the message and either polls a `solana_check_approval(requestId)` tool, or the user opens the `approvalUri` externally to sign.
3. When the wallet completes, the server's pending state flips; next poll returns `{ status: 'approved', signature: '...' }`.

This works in Claude Desktop and Cursor today. References: [nikicat/mcp-wallet-signer](https://github.com/nikicat/mcp-wallet-signer), [vrllrv/junto-mcp](https://github.com/vrllrv/junto-mcp), [sendaifun/solana-mcp](https://github.com/sendaifun/solana-mcp).

## Recommendation

**Ship the JSON-text + polling-tool pattern as the v1 default.** It's the only shape that renders in every major client today.

Concrete shape per signing tool:

```jsonc
// solana_sign_message tool result (pending state)
{
  "content": [
    {
      "type": "text",
      "text": "Solana wallet approval required.\n\nRequest: sar_abc123\nAction: Sign message on devnet\nSummary: \"Authorize app session\"\n\nNext step: open the approval URL in your wallet, then call solana_check_approval with requestId=sar_abc123 to fetch the result.\n\nApproval URL: https://approve.example/sar_abc123"
    }
  ]
}
```

Plain language first (so Claude can narrate it in chat), structured fields embedded (so the agent can parse `requestId` and `approvalUri` reliably). The trailing instructional sentence explicitly tells the agent to call `solana_check_approval`.

**Already-shipped tool surface aligns:** the v0 scaffold (commit `a1aeeb6`) already returns JSON-encoded `ApprovalResource` and exposes `solana_check_approval`. Just need to humanize the text wrapper.

**Don't depend on:**
- Resource rendering in Claude Desktop (unsupported)
- Clickable URIs triggering wallet flows (Claude Desktop won't fire them)
- `content: [{type: 'resource', ...}]` (not surfaced in chat)

**Layer 2 (later):** add resource subscription per note 03 for clients that support `notifications/resources/updated`. That's pure upside — clients without subscription support fall back to polling automatically.

## Open questions

- Does Claude Desktop preview a URL when one appears in tool-result text? Test in B2d.
- Cursor's auto-run mode: does it bypass the approval flow even when the server returns a pending status? Test in B2d.
- Does Anthropic Agents API surface tool-result text differently from Claude Desktop? Test in B2e.
