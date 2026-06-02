# @solana-agent-wallet-adapter/mcp-server

MCP server for Solana wallet operations with explicit user approval. It routes signing through a pluggable `WalletBackend` from `@solana-agent-wallet-adapter/core`, so the same MCP tools can use a mock wallet, a browser Wallet Standard wallet, Android MWA mobile web, or an iOS link backend.

## Tools

Base wallet tools:

- `solana_get_address`
- `solana_connect_wallet`
- `solana_sign_message`
- `solana_sign_transaction`
- `solana_sign_and_send_transaction`
- `solana_simulate_transaction`
- `solana_check_approval`

Bridge mode also exposes higher-level tools:

- `solana_wallet_status`
- `solana_connector_capabilities`
- `solana_connector_read_facts`
- `solana_meteora_dlmm_pool_snapshot`
- `solana_meteora_wallet_positions`
- `solana_meteora_position_detail`
- `solana_orca_whirlpool_snapshot`
- `solana_orca_wallet_positions`
- `solana_orca_position_detail`
- `solana_get_balances`
- `solana_portfolio_summary`
- `solana_prepare_transfer_sol`
- `solana_prepare_transfer_spl`
- `solana_prepare_swap`
- `solana_prepare_meteora_claim_fees`
- `solana_prepare_meteora_claim_rewards`
- `solana_prepare_meteora_add_liquidity`
- `solana_prepare_meteora_remove_liquidity`
- `solana_prepare_meteora_close_position`
- `solana_prepare_orca_increase_liquidity`
- `solana_prepare_orca_decrease_liquidity`
- `solana_prepare_orca_collect_fees`
- `solana_prepare_orca_collect_rewards`
- `solana_list_prepared_actions`
- `solana_execute_prepared_action`
- `solana_reject_prepared_action`
- `solana_archive_prepared_action`
- `solana_create_recurring_payment`
- `solana_list_recurring_payments`
- `solana_pause_recurring_payment`
- `solana_resume_recurring_payment`
- `solana_delete_recurring_payment`
- `solana_export_receipts`
- `solana_health_check`
- `solana_transfer_sol`
- `solana_transfer_spl`
- `solana_get_swap_quote`
- `solana_jupiter_order_preview`
- `solana_swap`

Signing tools return an `ApprovalResource`. Compatibility clients poll with `solana_check_approval`; clients that support URL elicitation can render `approvalUri` as the out-of-band wallet approval path. `solana_simulate_transaction` returns a preview only when the selected backend supports simulation. Product-level tools are thin wrappers around `AgentWalletActionService`, which is also used by the HTTP bridge, CLI, browser demo, and desktop shell.

## Mock MCP Smoke

The bundled `bin/server.js` includes a mock backend. Use it to confirm MCP registration before attaching a real wallet.

```bash
pnpm build
claude mcp add --scope user solana-agent-wallet -- \
  node <repo>/packages/mcp-server/dist/bin/server.js \
  --mock
```

Restart the MCP client and ask:

```text
What is my Solana wallet address? Use the solana-agent-wallet tool.
```

Expected mock address: `11111111111111111111111111111111`.

## Real-Wallet Bridge Mode

Bridge mode connects MCP clients such as Codex, Claude Code, or Claude Desktop to a browser wallet running at localhost. The wallet stays in the browser, and each real signing or send action still opens the selected wallet for approval.

Fast path:

```bash
cp .env.example .env
cp agent-wallet.config.example.json agent-wallet.config.json
pnpm cli -- setup
pnpm mcp:codex:add
pnpm dev
```

Downloaded CLI users can run `solana-agent-wallet setup` instead. Desktop users can use the Transaction Setup panel. Both write the runtime `.env` consumed by the bridge and MCP server.

Open `http://127.0.0.1:5174`, discover wallets, connect the selected wallet, and click `Connect bridge`. Restart Codex after registration and ask:

```text
Use solana-agent-wallet to show my wallet status.
```

Manual bridge start:

```bash
node packages/mcp-server/dist/bin/bridge.js \
  --token local-agent-wallet \
  --env ./.env \
  --config ./agent-wallet.config.json \
  --prepared-actions ./.agent-wallet/prepared-actions.json
```

Then run the browser demo:

```bash
pnpm demo:browser
```

Prepared actions use `.agent-wallet/prepared-actions.json` by default when started through `pnpm dev` and `pnpm mcp:codex:add`. Override with `AGENT_WALLET_PREPARED_ACTIONS` or `--prepared-actions`.

Recurring payments are manual-approval schedules. Each due run becomes an Approval Inbox item; the bridge never signs or submits future runs by itself.

Example MCP prompt:

```text
Use solana-agent-wallet to create a weekly Friday 10 USDC recurring payment to <recipient> for manual approval. Stop after 2026-12-31T00:00:00.000Z and notify https://example.com/agentic-webhook.
```

Supported recurring fields include `expiresAt`, `maxOccurrences`, and `notifications.inApp` / `notifications.webhookUrl`. The local bridge stores notification preferences for parity, but signed webhook delivery is a cloud Render-web cron feature; the bridge does not run that delivery worker. Spend caps can be configured in `agent-wallet.config.json` under `recurring.maxLifetimeAmount`, `recurring.maxPerWeekAmount`, and `recurring.maxPerMonthAmount`.

## Claude Bridge Registration

For Claude Code or Claude Desktop with a running bridge:

```bash
claude mcp add --scope user solana-agent-wallet -- \
  node <repo>/packages/mcp-server/dist/bin/server.js \
  --bridge-url http://127.0.0.1:8787 \
  --bridge-token local-agent-wallet \
  --env <repo>/.env \
  --config <repo>/agent-wallet.config.json \
  --prepared-actions <repo>/.agent-wallet/prepared-actions.json
```

The default config keeps `mainnet.enabled=false`. Turn on mainnet only after setting RPC and caps. Arbitrary mainnet transaction signing remains disabled unless `allowArbitraryTransactions=true`.

## iOS Link Mode

iOS does not use Android MWA. Start the bridge with an iOS provider and call `solana_connect_wallet`.

```bash
node packages/mcp-server/dist/bin/bridge.js \
  --ios-provider phantom \
  --ios-callback-base-url http://<lan-ip>:8787 \
  --token local-agent-wallet
```

When exposing the bridge to a private LAN for mobile testing, use
`BRIDGE_ALLOW_PRIVATE_BIND=1` with a generated non-default token. The default
`local-agent-wallet` token is accepted only for loopback binds.

For Jupiter Mobile:

```bash
REOWN_PROJECT_ID=<your-reown-project-id> \
node packages/mcp-server/dist/bin/bridge.js \
  --ios-provider jupiter \
  --walletconnect-storage-dir ./.agent-wallet/walletconnect \
  --token local-agent-wallet
```

Phantom, Solflare, and Backpack use wallet-specific encrypted links. Jupiter uses WalletConnect/Reown QR approval.

## HTTP Transport

```ts
import { createHttpServer, createMockBackend } from '@solana-agent-wallet-adapter/mcp-server';

const handle = createHttpServer({
  backend: createMockBackend(),
  port: 8723,
  stateful: true,
});

await handle.start();
console.log(`MCP listening on ${handle.url}`);
```

Ready-to-run binary:

```bash
node packages/mcp-server/dist/bin/serverHttp.js \
  --mock
```

Quick initialize request:

```bash
curl -s -X POST http://127.0.0.1:8723/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

The transport speaks MCP Streamable HTTP: JSON-RPC over POST with optional SSE streaming. Stateful mode returns an `mcp-session-id` header on initialize.

## Status

The server builds and tests cleanly, mock MCP registration works, HTTP and stdio transports are wired, bridge mode has confirmed real-wallet mainnet transfer proof, and iOS link mode is available as an experimental transport. Remaining useful smokes are listed in [PROGRESS.md](../../PROGRESS.md).
