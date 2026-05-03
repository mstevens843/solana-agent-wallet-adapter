# @solana-agent-wallet-adapter/mcp-server

MCP server that exposes Solana wallet operations as tools with user-approval flows. Routes signing through any pluggable `WalletBackend` from `@solana-agent-wallet-adapter/core`.

## Tools

- `solana_get_address`
- `solana_sign_message`
- `solana_sign_transaction`
- `solana_sign_and_send_transaction`
- `solana_check_approval`

Each signing tool returns an `ApprovalResource` with `status: 'pending'` and an `approvalUri`. The host (Claude Desktop, Cursor, an Anthropic Agents harness) renders the resource so the user can approve. The agent polls `solana_check_approval` until status flips to `approved` or `rejected`.

## Wiring it up — stdio transport (Claude Desktop, Cursor)

```ts
import { createServer } from '@solana-agent-wallet-adapter/mcp-server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
// import a real backend, e.g. @solana-agent-wallet-adapter/wallet-standard-web

const backend = /* your WalletBackend */;
const server = createServer({ backend });
await server.connect(new StdioServerTransport());
```

The bundled `bin/server.js` ships with a mock backend so you can register the server with Claude Desktop and exercise the tool surface end-to-end before plugging in a real wallet.

## Wiring it up — HTTP transport (web + remote agents)

```ts
import { createHttpServer, createMockBackend } from '@solana-agent-wallet-adapter/mcp-server';

const handle = createHttpServer({
  backend: createMockBackend(),
  port: 8723,
  stateful: true, // session-id header per client; default is stateless single-shot
});
await handle.start();
console.log(`MCP listening on ${handle.url}`);
```

A second bin ships ready-to-run: `solana-agent-wallet-mcp-http` (env vars `PORT`, `HOST`, `MCP_STATEFUL=1`). Quick smoke:

```bash
node packages/mcp-server/dist/bin/serverHttp.js &
# in another shell:
curl -s -X POST http://127.0.0.1:8723/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

The transport speaks Streamable HTTP per the MCP spec — JSON-RPC over POST with optional SSE streaming. Stateful mode returns an `mcp-session-id` header on init that subsequent requests must echo back.

## Status

Phase 1: stdio + HTTP transports working, mock backend ships, end-to-end smoke clean. Approval-resource rendering tuned for Claude Desktop (humanized text + machine-readable JSON appendix).
