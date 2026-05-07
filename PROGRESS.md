# Project Progress

Last updated: 2026-05-07

## Current working state

The real-wallet MCP bridge is now working end to end on `mainnet-beta` with a browser wallet approval flow.

Confirmed capabilities:

- The MCP client can read wallet status through `solana_wallet_status`.
- The MCP client can read balances through `solana_get_balances`.
- The MCP client can request a capped SOL transfer through `solana_transfer_sol`.
- The browser bridge opens the connected Wallet Standard wallet for approval.
- The wallet signs and broadcasts the transaction without exposing the private key to the agent.
- The agent receives the mainnet transaction id and Solscan URL after approval.

## Verified mainnet transfers

Source wallet:

```text
Z8MBJ7wbVu68dFa2LKFkTLkqZNfpCgYYDp2Bz4b9iaC
```

Recipient wallet:

```text
6QcqZJBYZQWfGThBPaGGU3Y67XebbjxBeo2wxuwu1i6A
```

Confirmed transfers:

| Date | Amount | Cluster | Transaction |
| --- | ---: | --- | --- |
| 2026-05-04 | 0.03 SOL | mainnet-beta | [`gHv9TGWxKHVR7EDY6rdcRctrJViiRYqUchTgeos6zfz64eBb7TmoQ6mKad4noF2og1YCgVqMSUKNEnLjTdZiMHp`](https://solscan.io/tx/gHv9TGWxKHVR7EDY6rdcRctrJViiRYqUchTgeos6zfz64eBb7TmoQ6mKad4noF2og1YCgVqMSUKNEnLjTdZiMHp) |
| 2026-05-05 | 0.01 SOL | mainnet-beta | [`3GbBfjZkxBinhaNQrqmQ5LRzyF5WEA4xfFKcMUfZBXkG8Rve6BtV3vwRhAjiQSRyEgZKHBrtmZDea1ojiovQBDAo`](https://solscan.io/tx/3GbBfjZkxBinhaNQrqmQ5LRzyF5WEA4xfFKcMUfZBXkG8Rve6BtV3vwRhAjiQSRyEgZKHBrtmZDea1ojiovQBDAo) |

## Working local flow

Start the local bridge and browser demo:

```bash
pnpm dev
```

Then:

1. Open `http://127.0.0.1:5174`.
2. Discover wallets.
3. Select and connect the browser wallet.
4. Connect the local bridge.
5. Use Claude Code or Codex to call `solana-agent-wallet`.

Known working prompt:

```text
Use solana-agent-wallet to show my wallet status.
```

Known working transfer prompt:

```text
Use solana-agent-wallet to send 0.01 SOL to 6QcqZJBYZQWfGThBPaGGU3Y67XebbjxBeo2wxuwu1i6A.
```

## Safety controls currently active

The mainnet action tools are guarded by `agent-wallet.config.json`.

Current intended caps:

- Max SOL transfer: `0.05 SOL`
- Max swap input: `0.05 SOL`
- Max slippage: `100 bps`
- Arbitrary transactions: disabled
- USDC allowlist max transfer: `25 USDC`

The model cannot access the wallet private key. Every real signing or send action still requires the user to approve in the browser wallet.

## Fixes completed during mainnet testing

- Added `.env` support for `SOLANA_RPC_URL`, `JUPITER_API_KEY`, and `BRIDGE_TOKEN`.
- Added `.gitignore` coverage so local `.env` secrets are not committed.
- Added `pnpm dev` to start both the local bridge and browser demo.
- Added Codex MCP registration scripts:
  - `npm run mcp:codex:add`
  - `npm run mcp:codex:remove`
- Added a durable Approval Inbox for prepared and recurring actions.
- Wired `pnpm dev` and Codex registration to the same repo-local `.agent-wallet/prepared-actions.json` store.
- Hardened prepared-action execution so scheduled, approved, rejected, blocked, and pending actions cannot be executed from the bridge endpoint.
- Fixed the browser RPC split so the browser send path uses the same bridge RPC config as the MCP server.
- Added `/bridge/config` so the browser can load the bridge cluster and RPC URL.
- Fixed duplicate wallet prompts by claiming each pending bridge request once before handing it to the browser.
- Added a shared bridge action service for status, balances, portfolio, prepared actions, capped direct transfers, SPL transfers, and Jupiter swap actions.
- Added `@solana-agent-wallet-adapter/cli` with a standalone terminal app for bridge health, wallet-host launch, prepared inbox, recurring schedules, agent plans, signed research artifacts, receipts, direct transfers, and swaps.
- Hardened the terminal app UX with `/connect`, full-detail inbox rendering, `/inspect`, guarded approve/reject status checks, and all 15 research labs.
- Added a Tauri `apps/desktop-shell` bridge orchestrator for bridge lifecycle, diagnostics, logs, health, wallet-host launch, Approval Inbox, and receipts.
- The Browser Demo Agent Plan tab can now queue a capped SOL-to-USDC prepared action into the Approval Inbox when the bridge is connected.
- Added prepared-action normalization for older SOL recurring inbox records that used `amount` instead of `amountSol`.
- Added direct SOL/SPL balance preflight before opening wallet approval.
- Added current competitive positioning in `STANDOUT_FEATURES.MD`.
- Began a builder-first documentation cleanup so public docs reflect the current proof, bridge flow, and competitor landscape.

## Still to verify

Detailed scenario prompts and expected trace events are tracked in [`docs/SCENARIO_TESTS.md`](./docs/SCENARIO_TESTS.md).

- SPL token transfer through `solana_transfer_spl`.
- Jupiter quote through `solana_get_swap_quote`.
- Jupiter swap through `solana_swap`.
- CLI transaction end-to-end against a running bridge, including `prepare transfer-sol`, `inbox approve`, and `receipts`.
- Tauri native packaging after installing the Tauri CLI.
- Codex mainnet transfer flow after restart, using the same bridge.
- Longer-running bridge stability with multiple sequential requests.

## Current product milestone

The project has crossed the main proof point:

> An AI agent can request a real mainnet SOL transfer, the user approves in their existing browser wallet, the private key never leaves the wallet, and the agent receives the confirmed transaction id.
