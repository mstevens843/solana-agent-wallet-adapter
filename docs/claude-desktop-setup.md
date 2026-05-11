# Claude Desktop MCP Smoke

Smoke the stdio MCP server in Claude Desktop. Start with the bundled mock backend, then use bridge mode when you want real wallet approvals.

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
pnpm build
```

All workspace packages and apps should build clean.

### 2. Find Claude Desktop's config file

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

If the file doesn't exist, create it.

### 3. Drop in the config snippet

Open the config file. If `mcpServers` already exists, add a `solana-agent-wallet` entry inside it; otherwise paste the whole snippet from `examples/claude-desktop-config.json`.

Replace the path with the absolute path to your clone, for example:

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
| "Sign the message 'hello' on devnet using the solana-agent-wallet tools." | Claude calls `solana_sign_message`. Result text starts with `Solana wallet approval pending. Request id: sar_...` and includes a `mock://approve/sar_...` URL plus the machine-readable JSON. Claude should narrate that approval is pending. |
| "Now check approval `<paste the request id from above>`." | Claude calls `solana_check_approval`. Mock backend keeps it at `pending` indefinitely (it's a mock - no real wallet to advance it). The result text confirms the still-pending state. |

### 6. What success looks like

- Claude Desktop shows the tool calls in the chat (small "Used solana_sign_message" indicator depending on Claude Desktop version).
- The `pending` status text renders verbatim, **not** collapsed into a generic error or hidden behind an opaque tool-result block.
- Claude correctly extracts the `requestId` from the rendered text and uses it on the next call.

### 7. Failure modes to watch for

| Symptom | Likely cause |
|---|---|
| Claude doesn't see the server | Path in config is not absolute / wrong / `dist/bin/server.js` not built. Run `pnpm -r build` again. |
| Server starts but tools never appear | Claude Desktop wasn't fully quit. `Cmd+Q` and relaunch. |
| Tool call returns nothing | Stale `dist/` output. Rebuild with `pnpm build`. |
| Tool call shows raw JSON only (no narration) | Older Claude Desktop. The humanized prefix in our output is plain text and should still render; the JSON is appended for agent parsing. |

### 8. Real-wallet bridge smoke

The mock backend always stays pending, so it is safe for registration and rendering checks. For real wallet approval, start the local bridge and browser demo:

```bash
cp .env.example .env
cp agent-wallet.config.example.json agent-wallet.config.json
pnpm cli -- setup
pnpm dev
```

Open `http://127.0.0.1:5174`, discover wallets, connect the selected wallet, and click `Connect bridge`. Then register Claude against the bridge:

```bash
claude mcp add --scope user solana-agent-wallet -- \
  node /absolute/path/to/solana-agent-wallet-adapter/packages/mcp-server/dist/bin/server.js \
  --bridge-url http://127.0.0.1:8787 \
  --bridge-token local-agent-wallet \
  --env /absolute/path/to/solana-agent-wallet-adapter/.env \
  --config /absolute/path/to/solana-agent-wallet-adapter/agent-wallet.config.json \
  --prepared-actions /absolute/path/to/solana-agent-wallet-adapter/.agent-wallet/prepared-actions.json
```

Restart Claude Desktop and ask:

```text
Use solana-agent-wallet to show my wallet status.
```

For mainnet actions, edit `.env` and `agent-wallet.config.json` first. Keep caps small and leave arbitrary transaction signing disabled unless you are intentionally testing that path.
