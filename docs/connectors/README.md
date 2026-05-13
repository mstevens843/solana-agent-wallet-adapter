# Connector Playbooks

These playbooks explain what the agent may read, what it may prepare for wallet approval, and what it must refuse. Machine-readable packs live in `spec/connectors/*.connector.json`; use those packs for evals and prompt fixtures.

## Runtime Status

| Connector | Runtime status | Reads | Writes | Notes |
| --- | --- | --- | --- | --- |
| Kamino | First-class | Positions, rewards proof, reserve snapshots | Deposit, withdraw | Implemented by the MCP Kamino adapter. |
| Jupiter | First-class for swaps | Ultra order preview, swap quote | Prepared swap, direct wallet swap | Lend/borrow paths remain Blink-backed and need action URLs. |
| Meteora | Blink-backed planned | DLMM positions and markets planned | Add/withdraw liquidity, claim fees, close via Blink planned | No first-class MCP helper yet. |
| Raydium | Blink-backed planned | Markets planned | AMM, CLMM, farm, Stake RAY via Blink planned | Requires pool/action URL facts. |
| Orca | Blink-backed planned | Whirlpool markets planned | Liquidity and fee actions via Blink planned | Requires Whirlpool/action URL facts. |
| MarginFi | Blink-backed planned | Positions and markets planned | Deposit, withdraw, borrow, repay via Blink planned | Borrow/withdraw must include account-health facts. |
| Drift | Blink-backed planned | Strategy vault markets planned | Vault deposit/withdraw via Blink planned | Does not cover perp order placement. |
| Lulo | Blink-backed planned | Positions, rewards, markets planned | Deposit, withdraw, rewards via Blink planned | Requires exact asset and action URL. |
| Save | Blink-backed planned | Positions, rewards, markets planned | Deposit, withdraw, rewards via Blink planned | Treat like Lulo until first-class code lands. |

## Shared Rules

- Read facts may inform an answer or review, but they do not grant permission to move funds.
- Write actions prepare wallet-approval work only. The wallet still signs and broadcasts.
- If a user omits required fields, ask at most three short questions.
- If a connector or capability is unavailable, say what is missing instead of pretending it works.
- Never say "I signed", "I approved", "guaranteed safe", or "auto-pay without wallet approval".

## Files

- `kamino.md` - first-class lending connector.
- `jupiter.md` - first-class swap connector and planned Blink lend/borrow notes.
- `meteora.md` - DLMM-specific Blink-backed playbook.
- `planned-connectors.md` - Raydium, Orca, MarginFi, Drift, Lulo, and Save.
- `safety-language.md` - canonical required and forbidden phrasing.

## How Agents Should Use This

1. Match the user request to a connector by id, name, or alias.
2. Check the connector pack's `readCapabilities` and `writeCapabilities`.
3. Gather required user inputs and connector facts.
4. Classify the result as read-only answer, proof-only review, prepared approval action, needs input, or unsupported.
5. Return flexible findings that match the request. Do not force swap rows onto non-swap requests.
