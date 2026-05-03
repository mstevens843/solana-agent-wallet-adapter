# @solana-agent-wallet-adapter/mcp-server

MCP server that exposes Solana wallet operations as tools with user-approval flows. Routes signing through any pluggable `WalletBackend` from `@solana-agent-wallet-adapter/core`.

## Tools

- `solana_get_address`
- `solana_sign_message`
- `solana_sign_transaction`
- `solana_sign_and_send_transaction`
- `solana_check_approval`

Each signing tool returns an `ApprovalResource` with `status: 'pending'` and an `approvalUri`. The host (Claude Desktop, Cursor, an Anthropic Agents harness) renders the resource so the user can approve. The agent polls `solana_check_approval` until status flips to `approved` or `rejected`.

## Wiring it up

```ts
import { createServer } from '@solana-agent-wallet-adapter/mcp-server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
// import a real backend, e.g. @solana-agent-wallet-adapter/wallet-standard-web

const backend = /* your WalletBackend */;
const server = createServer({ backend });
await server.connect(new StdioServerTransport());
```

The bundled `bin/server.js` ships with a mock backend so you can register the server with Claude Desktop and exercise the tool surface end-to-end before plugging in a real wallet.

## Status

Phase 1 skeleton. Needs: real backends, simulation preview, approval-resource rendering refinements.
