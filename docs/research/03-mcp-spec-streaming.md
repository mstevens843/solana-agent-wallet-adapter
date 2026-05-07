# 03 - MCP spec on streaming, notifications, sampling

> Superseded context, 2026-05-07: this note is preserved as dated research. Polling remains the compatibility baseline. URL Mode Elicitation is now the preferred approval UX when a client supports it, while Streamable HTTP remains useful for push updates.

What the latest spec actually offers for "tell the agent when approval status changes." Polling vs push.

## Findings

### Streamable HTTP transport - bidirectional push works

[Spec - transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports). Streamable HTTP supports server-initiated messages mid-session via Server-Sent Events (SSE):

> "The client **MAY** issue an HTTP GET to the MCP endpoint... allowing the server to communicate to the client, without the client first sending data via HTTP POST."

The server holds the GET connection open and can push notifications and server-side requests at any time without an in-flight client request. **Stdio transport cannot do this** - strictly request-response.

Client support: Claude Desktop, Cursor, MCP Inspector all support Streamable HTTP. Stdio is the universally-supported fallback.

### Notifications - limited to well-known types

The spec defines a fixed set of `notifications/*` shapes. The relevant ones:

- `notifications/resources/list_changed` - server tells client "the resource list has changed, re-fetch it"
- `notifications/resources/updated` - server tells client "this specific subscribed resource changed, re-read it"
- `notifications/tools/list_changed`
- `notifications/elicitation/complete` - paired with URL-mode elicitation

**Custom notification types are not allowed by the spec.** We cannot invent `notifications/approval_status_changed`. If we want push, we have to fit it into one of the existing shapes - `notifications/resources/updated` is the natural fit.

### Resources subscription - the cleanest fit for status push

Spec lifecycle:

1. Server declares capability: `capabilities: { resources: { subscribe: true, listChanged: true } }`
2. Client subscribes: `resources/subscribe { uri: "approval://sar_abc123" }`
3. Server emits when status changes: `notifications/resources/updated { uri: "approval://sar_abc123" }`
4. Client reads new state: `resources/read { uri: "approval://sar_abc123" }` returns the current JSON

Bidirectional, server-initiated, spec-native. No invention required.

**Caveat from note 01:** Claude Desktop today doesn't render resources in the chat UI. Subscription works at the protocol level, but the user sees nothing change unless the agent re-reads the resource itself. Fine for agent-driven flows; weak for direct user feedback.

### Sampling - wrong fit

[Spec - sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling). Server-requests-LLM. Lets the server ask the client's LLM a question. **Not a user-approval mechanism.** The LLM is the target, not the user.

### Elicitation - for asking the user, not status updates

[Spec - elicitation](https://modelcontextprotocol.io/specification/draft/client/elicitation). Form mode and URL mode covered in note 02. Useful for **initiating** an approval (URL mode), not for streaming status changes after the fact.

### TypeScript SDK

`@modelcontextprotocol/sdk` 1.x supports:
- `McpServer.registerTool` with full type inference (already using in commit `a1aeeb6`)
- Resource declarations + subscription handlers
- Sending notifications from tool handlers (`server.sendResourceUpdated(uri)`)
- Streamable HTTP transport via `StreamableHTTPServerTransport`

All production-ready as of v1.29.

## Recommendation

**Two-track design:**

### Track 1 - polling default (works everywhere, ship now)
- `solana_sign_*` tools return pending JSON + `requestId`
- `solana_check_approval(requestId)` tool returns current status
- Agent polls until approved or rejected
- Works on stdio transport, in every client (Claude Desktop, Cursor, MCP Inspector)
- This is what commit `a1aeeb6` already implements

### Track 2 - resource subscription (Streamable HTTP only, additive)
- For each pending approval, expose a resource at URI `approval://<requestId>`
- Resource content is the current JSON `ApprovalResource`
- When the wallet backend resolves, server emits `notifications/resources/updated` for that URI
- Clients that support subscription get push updates; clients that don't fall back to polling
- Requires the HTTP transport variant (B2b) which is on the immediate roadmap anyway

**Don't ship custom notification types** - spec forbids it.

**Don't rely on Sampling** for approval - wrong shape.

**Optional Track 3 (future):** URL-mode elicitation for the initial "go sign in your wallet" prompt. Adds nicely on top of Track 2 without breaking Track 1 callers.

## What this means for the implementation

- `WalletBackend.poll(requestId)` already exists in core types and stays.
- Add `WalletBackend.subscribe?(requestId, callback)` as an optional capability. Backends that can push (e.g., a wallet-standard browser backend with a Promise) populate it; backends that can't (raw HTTP polling) leave it undefined.
- MCP server registers a resource per pending request. When `subscribe` is set on the backend, the server wires the callback to `server.sendResourceUpdated(uri)`. When it's not, the server falls back to polling on demand.
- HTTP transport is a prereq for the push path. Stdio works for polling only.

## References

- [MCP spec 2025-11-25 - transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [Spec - resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)
- [Spec - sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling)
- [Spec - elicitation](https://modelcontextprotocol.io/specification/draft/client/elicitation)
- [TypeScript SDK GitHub](https://github.com/modelcontextprotocol/typescript-sdk)
