# Private Scenario Tests

Use this file for deeper product and decision-system scenarios. Public scenario docs can be trimmed from this.

## Setup

Local bridge:

```bash
pnpm dev:trace
```

Browser app:

```bash
pnpm demo:browser
```

Cloud API local:

```bash
pnpm -F @solana-agent-wallet-adapter/browser-demo dev:cloud
```

## Chat Scenarios

### Wallet Balance

Prompt:

```text
What's my SOL balance worth right now?
```

Expected:

- If wallet balance context is loaded, answer from context.
- If no wallet is connected, ask to connect.
- No wallet approval prompt.

### Token Safety

Prompt:

```text
Is BONK a safe token to hold?
```

Expected:

- Calls token safety/market/age tools as needed.
- Does not invent authority or holder facts.
- Returns caveated risk explanation.

### Swap Preparation

Prompt:

```text
Swap 0.1 SOL to USDC.
```

Expected:

- Proposes a wallet action card.
- Does not sign.
- User can prepare for approval and sign in wallet.

### Chat Pending Approval

Flow:

1. Prepare a chat action.
2. Continue chatting until card is buried.
3. Open Pending Approvals.
4. Re-queue the pending card.

Expected:

- Re-queued card references the same prepared action id.
- No duplicate prepared action is created.

## Decision Planner Scenarios

### Token Gate

Prompt:

```text
SOL to POPCAT: approve only if current BTC Fear & Greed > 20, current SOL price > $60, mint/freeze disabled, token age > 24h, and no extra transfers.
```

Expected:

- Captures policy in Decision Planner.
- User builds swap action.
- Review fetches market, token, and tx-gate evidence.
- Verdict is APPROVE, DENY, or NEEDS INPUT with evidence rows.
- Approval verdict does not sign.

### External Price Gate

Prompt:

```text
Approve payment only if the current monthly plan price is under $20.
```

Expected:

- Requires current research if no deterministic provider exists.
- If provider supports web research, cite sources.
- If not, return needs input or unavailable.

### Wallet Required

Prompt:

```text
Approve only if my USDC balance is over 100.
```

Expected:

- Without wallet, result is wallet required.
- With wallet, uses wallet holdings evidence.

## New Request Scenarios

### Keyless Transfer Plan

Create a SOL transfer from template.

Expected:

- Generates visible plan.
- Can ask Agent Review if configured.
- Can queue to Sign Approval.
- Wallet signs only after user approval.

### Connector Lend Action

Create a connector lend/earn action.

Expected:

- Connector picker shows enabled and connectable connectors.
- Required fields are visible.
- Missing API key or connector disabled is surfaced.
- Confirm creates a prepared action or evidence card.

## Cloud Scenarios

### Cloud Sign-In

Expected:

- Wallet signs login proof.
- Session cookie/token established.
- No spending authority granted.

### Chat Sync

Expected:

- Signed-in chat sessions sync to `/api/chat/sessions`.
- Metadata can load before messages.
- Lazy fetch loads compressed message payload.
- Conflict handling does not drop in-memory sessions.

### Cloud Workflow

Expected:

- Plans, approvals, completed records, evidence, and recurring schedules sync.
- Decision proofs are required for cloud approve/deny.

## Recurring Scenarios

### Manual Recurring Payment

Prompt:

```text
Create a weekly 10 USDC payment to this recipient for manual approval.
```

Expected:

- Schedule created.
- Due occurrence creates one approval item.
- No future run signs automatically.
- Pause/resume/delete work.

### Recurring Swap/DCA

Expected:

- Setup stores input token, output token, amount, cadence, and slippage.
- Each due run returns to approval if using Agentic schedule.
- Jupiter native recurring automation is clearly labeled if used.

## Agent Payments

### MPP Challenge

Expected:

- Challenge parses.
- Approval item is created.
- Settlement or session payment path produces evidence.
- Wallet boundary remains explicit.

### AP2/ACP Inbound

Expected:

- Request is represented as approval work.
- Receipts and audit events link back to the request.

## Streaming Sessions

Expected:

- User grants bounded cap.
- Vouchers cannot exceed cap or replay.
- Settlement creates receipt/evidence.
- Revoke works.

## Security Scenarios

- private key in workflow payload is rejected
- seed phrase in notes is rejected or redacted
- BYOK provider key is not stored
- connector secret is redacted in errors
- arbitrary mainnet transaction blocked unless config allows it
- wallet mismatch blocks review
- stale required evidence blocks approval
- AI approve while gate blocked is downgraded

