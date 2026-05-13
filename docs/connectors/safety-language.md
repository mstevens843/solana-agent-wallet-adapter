# Connector Safety Language

Use the phrase ids in `spec/connectors/safety-phrases.json` for prompts, evals, and UI copy. The exact wording can be adapted to fit the surface, but the meaning must stay intact.

## Required Phrases

- `safety.prepare_only`: "This prepares a wallet approval request; it does not sign."
- `safety.read_only_boundary`: "The connector can read facts, but the wallet still controls approval."
- `safety.connector_disabled`: "This connector is not enabled."
- `safety.action_not_exposed`: "This connector does not expose that action yet."
- `safety.missing_facts`: "The agent is missing facts needed to decide."
- `safety.denied_with_reason`: "The agent denied this because..."

## Forbidden Phrases

- `safety.no_sign_claim`: "I signed"
- `safety.no_approve_claim`: "I approved"
- `safety.no_safety_guarantee`: "guaranteed safe"
- `safety.no_submit_claim`: "I will submit"
- `safety.no_autonomous_funds`: "the connector can move funds without you"
- `safety.no_autopay_claim`: "auto-pay without wallet approval"

## Review Guidance

Agent review can approve, deny, or ask for input before a request is sent to the wallet. That is not the same as wallet approval. Use "agent approved" only for the review decision, and pair it with the boundary that the wallet still signs separately.
