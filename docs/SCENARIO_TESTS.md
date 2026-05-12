# Scenario Tests

Use this file to test the product as an actual wallet agent, not just as a signing demo.

## Run with deterministic logs

```bash
pnpm dev:trace
```

The terminal emits JSONL trace events when `AGENT_WALLET_TRACE=1`.

Expected event families:

- `mcp.tool.start`
- `mcp.tool.success`
- `mcp.tool.error`
- `bridge.host.connected`
- `bridge.request.submitted`
- `bridge.request.claimed`
- `browser.approval.start`
- `browser.approval.success`
- `browser.approval.error`
- `bridge.request.resolved`
- `bridge.request.rejected`

Secrets are redacted from trace output. RPC URLs should not print API keys.

## Setup

1. Start `pnpm dev:trace`.
2. Open `http://127.0.0.1:5174`.
3. Discover wallets.
4. Connect the wallet.
5. Connect the local bridge.
6. Start Claude Code or Codex after MCP registration.

## Prompt catalog

Ask the MCP client:

```text
Use solana-agent-wallet to show me useful prompts.
```

Expected result:

- A stable list of prompts for wallet status, balances, SOL transfer, SPL transfer, swap quote, swap execution, approval inbox workflows, recurring payments/swaps, approval denials, connector/BYOK planning, treasury/payment workflows, and safety checks.
- A separate section for roadmap or partial workflows that are not automated yet.

## Scenario matrix

### Wallet status

Prompt:

```text
Use solana-agent-wallet to show my wallet status.
```

Expected:

- No wallet approval prompt.
- Returns connected status, address, cluster, RPC URL, mainnet flag, caps, and allowlisted tokens.
- Trace includes `mcp.tool.start` and `mcp.tool.success`.

Status: working.

### Balances

Prompt:

```text
Use solana-agent-wallet to show my SOL and token balances.
```

Expected:

- No wallet approval prompt.
- Returns SOL and configured token balances.
- Trace includes the balances tool start/success.

Status: working.

### Simple SOL payment

Prompt:

```text
Use solana-agent-wallet to send 0.01 SOL to 6QcqZJBYZQWfGThBPaGGU3Y67XebbjxBeo2wxuwu1i6A.
```

Expected:

- One wallet approval prompt.
- One `bridge.request.claimed` event.
- One `browser.approval.start` event.
- One `browser.approval.success` event after approval.
- One `bridge.request.resolved` event.
- MCP response includes txid and Solscan URL.

Status: working on mainnet-beta with configured caps.

### SPL token payment

Prompt:

```text
Use solana-agent-wallet to send 1 USDC to <recipient wallet> if I have enough USDC.
```

Expected:

- Fails safely if USDC balance is missing or too low.
- If funded, may create recipient ATA and request wallet approval.
- Capped by `agent-wallet.config.json`.

Status: ready to verify.

### Swap quote

Prompt:

```text
Use solana-agent-wallet to quote swapping 0.01 SOL to USDC. Do not execute it.
```

Expected:

- No wallet approval prompt.
- Returns Jupiter order preview fields.
- Requires `JUPITER_API_KEY`.

Status: ready to verify.

### Swap execution

Prompt:

```text
Use solana-agent-wallet to swap 0.01 SOL to USDC, staying within my configured slippage cap.
```

Expected:

- Gets Jupiter order.
- Requests wallet approval for the swap transaction.
- Executes through Jupiter after signing.
- Returns execution status and txid if successful.

Status: ready to verify; use tiny amounts only.

### Treasury assistant

Prompt:

```text
Use solana-agent-wallet to pay these recipients one at a time, asking for wallet approval for each transfer: <list>.
```

Expected:

- Each transfer is a separate capped approval.
- No batched hidden execution.
- Agent should stop on any rejection or cap failure.

Status: supported as a sequential prompt workflow.

### Approval inbox

Prompt:

```text
Use solana-agent-wallet to prepare a 0.01 SOL payment to <recipient wallet>, then list my prepared approval inbox actions.
```

Expected:

- No wallet approval prompt when the action is prepared.
- Browser Approval Inbox shows the same prepared action after refresh.
- Prepared action is stored under `.agent-wallet/prepared-actions.json`.
- Approving from the inbox opens one wallet approval prompt and returns a txid.
- Rejecting from the inbox marks the action rejected without opening the wallet.

Status: supported.

### Approval denial

Prompt:

```text
Use solana-agent-wallet to prepare a 0.01 SOL payment to <recipient wallet>, then reject it from the approval inbox because the recipient is wrong.
```

Expected:

- Preparing the action does not open a wallet approval prompt.
- Rejecting the inbox item records a rejected action without signing or submitting a transaction.
- Trace includes `bridge.request.rejected` or an inbox rejection event, depending on the surface used.
- The rejected item remains inspectable as evidence of the denied request.

Status: supported.

### Scheduled payment

Prompt:

```text
Every Friday, prepare a 10 USDC payment to <recipient> for manual approval.
```

Expected:

- Creates a recurring payment schedule.
- No wallet approval prompt is left open.
- Due payments materialize as inbox items when the bridge/inbox is loaded.
- Future scheduled actions are visible but cannot be approved until due.
- Missed weekly payments create one overdue inbox item, not a batch of catch-up payments.

Status: supported through manual Approval Inbox.

### Recurring swap preference

Prompt:

```text
Create a recurring SOL to USDC swap preference for 0.01 SOL weekly with 0.5% max slippage. Each occurrence should wait for manual approval.
```

Expected:

- Creates a recurring swap schedule or draft with action kind `swap`.
- Stores input token, output token, amount, cadence, and slippage limit.
- Does not grant delegated trading authority or request an unlimited token approval.
- Each due occurrence materializes as an Approval Inbox item and still requires wallet review.
- Rejecting an occurrence records the denial without signing or submitting.

Status: supported through recurring swap setup; execute with tiny amounts only.

### Production recurring payment

Prompt:

```text
Create a weekly 10 USDC payment to <recipient> for manual approval, expire it on 2026-12-31T00:00:00.000Z, and notify https://example.com/agentic-webhook when each run is ready.
```

Expected:

- Creates a recurring schedule with `expiresAt` and webhook notification settings.
- Shows the next run preview and recurring spend estimate.
- Each due run appears in Approval Inbox and still requires wallet approval.
- Pause/resume stops and restarts future materialization.
- Occurrence history shows plain-English status labels and linked approval/receipt metadata.
- Configured spend caps reject over-limit schedules with a plain-English error.

Status: supported in Agentic Cloud and MCP/local bridge field surface; webhook retries are cloud-only.

### Connector and BYOK planning

Prompt:

```text
Use Agentic's Connect AI settings to draft a SOL to USDC swap plan with my selected provider. Do not sign or submit anything.
```

Expected:

- Works with keyless templates, hosted BYOK, local bridge BYOK, or browser session BYOK depending on the selected connector.
- Provider presets include OpenAI, Claude / Anthropic, Gemini, OpenRouter, and OpenAI-compatible endpoints.
- The provider returns only a draft plan or review. It cannot approve, sign, submit, or bypass the wallet boundary.
- API keys are not written to prepared-action notes, receipts, trace logs, URLs, or checked-in config.
- Sending the plan to Approval Inbox still requires a separate wallet review before any transaction can move funds.

Status: supported for planning/review; signing remains wallet-gated.

### Portfolio rebalance

Prompt:

```text
Check my balances and quote a capped swap toward 70% SOL and 30% USDC. Do not execute without approval.
```

Expected today:

- Balance read works.
- Swap quote can work.
- Automatic portfolio policy execution is not built yet.

Status: partial.

### DeFi cleanup

Prompt:

```text
Inspect my token balances and tell me if there are dust or spam tokens I should clean up.
```

Expected today:

- Configured token balances work.
- Broad token discovery, spam classification, and cleanup transactions are not built yet.

Status: partial.

### Invoice/payment assistant

Prompt:

```text
Read this invoice, extract the recipient and amount, then ask me before using solana-agent-wallet to pay it.
```

Expected today:

- Prompt workflow only unless recipient and amount are explicit.
- Payment tool can execute after user approval.

Status: prompt workflow.
