# Smoke-testing the MCP server in Claude Desktop

End-to-end smoke for the stdio MCP server using the bundled mock backend. Confirms Claude Desktop renders the approval-pending text the way the server emits it.

## Prerequisites

- Claude Desktop installed (any recent version with MCP support)
- Node.js 20+ on PATH
- pnpm installed
- This repository cloned locally

## Steps

### 1. Build the server

```bash
cd path/to/solana-agent-wallet-adapter
pnpm install
pnpm -r --filter "./packages/*" build
```

You should see all four packages (`core`, `mcp-server`, `wallet-standard-web`, ...) build clean.

### 2. Find Claude Desktop's config file

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

If the file doesn't exist, create it.

### 3. Drop in the config snippet

Open the config file. If `mcpServers` already exists, add a `solana-agent-wallet` entry inside it; otherwise paste the whole snippet from `examples/claude-desktop-config.json`.

**Replace `/ABSOLUTE/PATH/TO/...`** with the absolute path to your clone, for example:

```json
{
  "mcpServers": {
    "solana-agent-wallet": {
      "command": "node",
      "args": [
        "/Users/you/Desktop/projects/solana-agent-wallet-adapter/packages/mcp-server/dist/bin/server.js"
      ]
    }
  }
}
```

Anthropic's reference docs on MCP server registration: <https://modelcontextprotocol.io/docs/quickstart/user>.

### 4. Restart Claude Desktop

Fully quit and relaunch (not just close the window). On macOS, `Cmd+Q` then re-open from Applications.

### 5. Smoke prompts

In a new chat, type the following one at a time. Expected agent behavior is in the second column.

| Prompt | Expected behavior |
|---|---|
| "What's my Solana wallet address? Use the solana-agent-wallet tools." | Claude calls `solana_get_address`. Result: `{"address":"11111111111111111111111111111111"}` (the mock backend's hard-coded base58 zero address). |
| "Sign the message 'hello' on devnet using the solana-agent-wallet tools." | Claude calls `solana_sign_message`. Result text starts with `Solana wallet approval pending. Request id: sar_…` and includes a `mock://approve/sar_…` URL plus the machine-readable JSON. Claude should narrate that approval is pending. |
| "Now check approval `<paste the request id from above>`." | Claude calls `solana_check_approval`. Mock backend keeps it at `pending` indefinitely (it's a mock — no real wallet to advance it). The result text confirms the still-pending state. |

### 6. What success looks like

- Claude Desktop shows the tool calls in the chat (small "Used solana_sign_message" indicator depending on Claude Desktop version).
- The `pending` status text renders verbatim, **not** collapsed into a generic error or hidden behind an opaque tool-result block.
- Claude correctly extracts the `requestId` from the rendered text and uses it on the next call.

### 7. Failure modes to watch for

| Symptom | Likely cause |
|---|---|
| Claude doesn't see the server | Path in config is not absolute / wrong / `dist/bin/server.js` not built. Run `pnpm -r build` again. |
| Server starts but tools never appear | Claude Desktop wasn't fully quit. `Cmd+Q` and relaunch. |
| Tool call returns nothing | Old `dist/` from before the v0.0.2 changes. Re-build. |
| Tool call shows raw JSON only (no narration) | Older Claude Desktop. The humanized prefix in our output is plain text and should still render; the JSON is appended for agent parsing. |

### 8. Real-wallet smoke (later)

The mock backend always stays pending so it's safe to register and click around without any real signing. Once `wallet-standard-web` is wired up to a real wallet (Phantom, Solflare in a browser), we'll do a real-wallet smoke that covers the full `pending → approved → signature` lifecycle. That's a follow-up task — for now, this mock smoke proves the protocol layer end-to-end in Claude Desktop.
