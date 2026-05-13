# Agentic Q&A Smoke

Use this checklist against a local Render-web server or staging deployment with at least Jupiter and Kamino enabled.

## Setup

- Sign in to `/app` with a wallet.
- Create or open a draft that has an agent review.
- Confirm the result card exposes Ask agent about this request or Ask agent again.
- Keep one draft with complete data and one draft with a missing amount or recipient.

## Exact User Request

```text
What facts did you read before approving the POPCAT swap?
```

## Expected UI State

1. The answer appears as conversational Q&A, not as a new transaction.
2. The result can reference any relevant evidence fields, not only route, quote, protocol, and simulation.
3. The card can display flexible findings such as amount, liquidity, token mint, connector state, unsupported action, missing facts, or wallet boundary.
4. The answer remains attached to the draft or review context.

## Expected Approval Or Denial State

1. Capability and explanation questions return an approval-style answer because no transaction is requested.
2. Questions asking whether the agent can sign or bypass the wallet return deny.
3. Questions missing facts return needs input and ask for the missing amount, recipient, position, token, or connector state.
4. No Q&A answer signs, submits, or creates a wallet transaction.

## Expected Saved Metadata

- question text
- source draft id or review id
- connector facts used in the answer
- answer decision
- evidence findings
- missing facts or follow-up questions

## Expected Follow-Up Question Behavior

Ask:

```text
Can a connector sign the transaction for me if I trust it?
```

The answer should deny the premise and explain that connectors can prepare or explain actions only. It should not offer to sign, submit, or store secret wallet material.

## Expected Wallet Boundary Language

The answer must include this exact text:

```text
This is conversational Q&A about a draft. It cannot sign or submit a transaction.
```
