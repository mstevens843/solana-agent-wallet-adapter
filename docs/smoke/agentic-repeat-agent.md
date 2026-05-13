# Agentic Repeat Agent Smoke

Use this checklist against a local Render-web server or staging deployment with Agentic Cloud sign-in enabled.

## Setup

- Sign in to `/app` with a wallet.
- Open Repeat Payments.
- Confirm Agentic Cloud is connected.
- Confirm repeat creation shows the AI draft control and the ask-agent-after-draft checkbox.
- Use a small test amount and a recipient public key that is safe for staging.

## Exact User Request

```text
Every Monday at 9 AM, send 0.01 SOL to 7recipient111111111111111111111111111111111 and ask the agent before each run.
```

## Expected UI State

1. Create Repeat shows a drafted weekly SOL transfer.
2. The amount, token, recipient, cadence, next-run preview, and purpose are visible before save.
3. The ask-agent-after-draft checkbox is enabled.
4. Saving creates an Active Repeats row.
5. The active repeat row exposes Ask agent again.

## Expected Approval Or Denial State

1. The first agent review returns an approval-ready state for the repeat setup.
2. No wallet transaction is signed during repeat creation.
3. When an occurrence materializes, it appears in Needs Approval.
4. The occurrence requires a normal wallet approval before any SOL transfer is sent.
5. If the recipient is removed and Ask agent again is used, the review changes to needs input and asks for the recipient.

## Expected Saved Metadata

- repeat asset: `SOL`
- repeat amount: `0.01`
- cadence: weekly Monday 09:00 local time
- recipient public key
- agent review enabled
- last agent decision and reason
- next run timestamps

## Expected Follow-Up Question Behavior

Use Ask agent again on the active repeat and ask:

```text
Why did you approve this repeat payment?
```

The answer should cite amount, recipient, cadence, manual wallet approval, and the saved agent-review setting. If the recipient or amount is missing, the agent should ask for that exact missing field rather than inventing it.

## Expected Wallet Boundary Language

The review or explanation must include this exact text:

```text
Wallet approval is required before any signature or transaction leaves the device.
```
