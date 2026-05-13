# Agentic Connectors Smoke

Use this checklist against a local Render-web server or staging deployment with the local bridge running.

## Setup

- Sign in to `/app` with a wallet.
- Open Preferences.
- Enable Jupiter and Kamino connectors.
- Leave at least one connector disabled, such as Raydium, to test denial behavior.
- Confirm the connector list shows connected capability chips such as positions, rewards, blinks, markets, swap, deposit, and withdraw when available.

## Exact User Request

```text
Supply 0.25 SOL into the Kamino main SOL lend market.
```

## Expected UI State

1. New Request or the connector draft flow shows a Kamino deposit draft.
2. The card displays connector, protocol, asset, amount, market, and policy notes.
3. The review result is not limited to route and quote fields; it can show connector-specific findings such as market, position, available supply, rewards, or unsupported action.
4. Ask agent again remains available after the review.

## Expected Approval Or Denial State

1. With Kamino enabled and amount present, the agent can approve the draft for wallet review.
2. If the amount is deleted, the decision changes to needs input and asks for the amount.
3. If Kamino is disabled in Preferences, the decision changes to deny and names the disabled connector.
4. If the user requests an unsupported connector action, the decision is deny and the reason names the unsupported action.

## Expected Saved Metadata

- connector id
- connector enabled or disabled state at review time
- action type
- asset and amount
- market or position id when known
- review decision
- review evidence findings
- boundary text proving the connector did not sign

## Expected Follow-Up Question Behavior

Ask:

```text
What facts did you use to decide this Kamino deposit?
```

The answer should mention the connector state, amount, asset, market or position, and any unsupported or missing fields. It should not claim that the connector has wallet authority.

## Expected Wallet Boundary Language

The review or explanation must include this exact text:

```text
Wallet approval is required before any signature or transaction leaves the device.
```
