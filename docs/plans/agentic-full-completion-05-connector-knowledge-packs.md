# Connector Knowledge Packs Plan

## Ownership

This workstream owns only:

- `docs/connectors/**`
- `spec/connectors/**`

Do not edit:

- `apps/browser-demo/**`
- `packages/mcp-server/**`
- `packages/workflow/**`
- `apps/render-web/**`
- `scripts/**`
- `docs/smoke/**`
- `spec/evals/**`

## Goal

Create detailed connector knowledge packs that teach agents, engineers, and evaluators what each dapp connector can read, what it can prepare, what facts are required, and how to answer user questions without hallucinating capabilities.

## Current Baseline

The browser has a connector catalog and local MCP has some Kamino/Jupiter capabilities. The knowledge is spread across code, prompts, and tool descriptions. There is no canonical connector playbook that agents can follow.

## Non-Goals

This workstream must not implement connector runtime code.

This workstream must not edit prompts directly.

This workstream must not add eval scripts.

## Required Outcomes

### 1. Connector Pack Schema

Create a schema under `spec/connectors/`.

Suggested file:

- `spec/connectors/connector-pack.schema.json`

The schema should support:

- id
- name
- aliases
- status
- supported clusters
- read capabilities
- write capabilities
- required config
- required user inputs
- required connector facts
- safety boundaries
- unsupported requests
- example user requests
- example answers
- example denials
- example needs-input questions
- action preparation notes
- wallet approval boundary

Statuses:

- `first_class`
- `blink_backed`
- `read_only`
- `planned`
- `unsupported`

Definition of done:

- The schema can describe Kamino, Jupiter, Meteora, and an unsupported connector without special casing.

### 2. Canonical Connector Packs

Create JSON or Markdown packs under `spec/connectors/`.

Minimum packs:

- `kamino.connector.json`
- `jupiter.connector.json`
- `meteora.connector.json`
- `raydium.connector.json`
- `orca.connector.json`
- `marginfi.connector.json`
- `drift.connector.json`
- `lulo.connector.json`
- `save.connector.json`

Each pack must include:

- what the connector can read today
- what the connector can prepare today
- what is planned but not implemented
- what the agent must not claim
- common synonyms
- required user inputs
- required facts before approval
- approval boundary
- risk notes
- examples

Definition of done:

- Kamino and Jupiter are detailed enough for implementation.
- Planned connectors clearly state limitations instead of pretending they work.

### 3. Natural Language Coverage

For each connector, list natural-language request forms.

Examples:

- "stake 1 SOL into Kamino"
- "supply 1 SOL to Kamino"
- "lend USDC on Kamino"
- "withdraw half my SOL from Kamino"
- "show my Kamino earnings"
- "swap 0.25 SOL to USDC"
- "DCA SOL to USDC weekly"
- "check my Meteora position"
- "claim Meteora rewards"
- "add liquidity to this pool"

For each request form, classify:

- read-only answer
- prepare approval action
- proof-only review
- needs input
- unsupported

Definition of done:

- Each connector has at least 10 request examples.
- At least 5 examples per connector include expected denial or needs-input behavior.

### 4. Connector Q&A Playbooks

Create docs under `docs/connectors/`.

Suggested files:

- `docs/connectors/README.md`
- `docs/connectors/kamino.md`
- `docs/connectors/jupiter.md`
- `docs/connectors/meteora.md`
- `docs/connectors/planned-connectors.md`

Each doc should answer:

- What can this connector do?
- What can it not do?
- What facts can the agent read?
- What actions can it prepare?
- What does the user still approve?
- What questions should the agent ask when inputs are missing?
- What should the agent deny?
- What should the agent say when the connector is disabled?

Definition of done:

- A new engineer can use these docs to implement connector runtime without reading product chat history.

### 5. Safety Language Standard

Create a standard phrase list for connector boundaries.

Required messages:

- "This prepares a wallet approval request; it does not sign."
- "The connector can read facts, but the wallet still controls approval."
- "This connector is not enabled."
- "This connector does not expose that action yet."
- "The agent is missing facts needed to decide."
- "The agent denied this because..."

Forbidden messages:

- "I signed"
- "I approved"
- "guaranteed safe"
- "I will submit"
- "the connector can move funds without you"
- "auto-pay without wallet approval"

Definition of done:

- Safety phrase list exists and can be copied into prompts/tests by other workstreams.

### 6. Review Checklist

Every connector pack must pass this checklist:

- Does it say what is actually implemented today?
- Does it distinguish read from write?
- Does it preserve wallet approval?
- Does it include missing input questions?
- Does it include denial examples?
- Does it include unsupported examples?
- Does it avoid claiming safety guarantees?
- Does it include examples in user language, not only protocol language?

## Verification

Run:

- `git diff --check`

If using JSON packs, validate with any local JSON parser available in the repo tooling. Do not add package dependencies in this workstream.

## Deliverable Summary

The final report should list:

- Connector packs created.
- Which connectors are first-class today.
- Which connectors are planned or unsupported.
- Natural-language examples count.
- Safety phrases added.
