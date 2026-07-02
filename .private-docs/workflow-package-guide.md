# Workflow Package Guide

`packages/workflow` is the shared decision and workflow logic package. It is the common layer used by browser-demo, render-web, mcp-server, mobile runtimes, and tests.

## Package Role

The package models:

- unsigned plan state
- approval request state
- recurring schedules
- completed records
- evidence receipts
- audit events
- chat agent contracts
- decision atoms
- fact routing
- evidence gates
- policy evaluation
- tx gates
- confidence and counterfactuals
- device-agent and dev-layer contract helpers

It must not model:

- seed phrases
- private keys
- unlimited delegated signers
- silently executable transactions

## Chat Agent

Directory: `packages/workflow/src/chatAgent`

Key files:

- `systemPrompt.ts`
- `routing.ts`
- `tools.ts`
- `loop.ts`
- `providerTurn.ts`
- `transport.ts`
- `sse.ts`
- `facts.ts`
- `types.ts`

The chat agent is provider-neutral. It defines:

- shared system prompt
- tool schemas
- proposal schema
- streaming event shape
- provider transport normalization
- routing helpers
- fallback strings
- max token/history/iteration caps

Important guarantee: each runtime should apply the same wallet/action rules, whether hosted, local bridge, browser session, device agent, or Plan Connector.

## Fact Routing

`agentFactRouter.ts` plans review evidence routes based on:

- plan fields
- user question
- instruction/prompt text
- wallet availability
- token mint availability
- connector availability

It distinguishes required and optional evidence and records skipped needs when prerequisites are missing.

## Atoms

`agentAtoms.ts` parses user policy text into structured atoms.

Examples:

- price
- market regime
- token audit
- token age
- token metric
- coin metric
- tx gate
- external price
- external state
- tradfi price
- time fact
- network metric
- balance and fee checks

Atoms make the policy layer deterministic instead of asking the model to rediscover and interpret every rule from prose.

## Capability Registry

`agentCapabilityRegistry.ts` maps atom types to resolver chains. Each deployment supplies the actual resolver implementation. `mcp-server` provides the main resolver for Solana, connector, market, and wallet facts.

## Policy Orchestrator

`policyOrchestrator.ts` runs:

1. extract atoms
2. canonicalize/cross-language normalize if needed
3. resolve facts
4. coerce facts into canonical values
5. evaluate atoms
6. analyze tx gates
7. return a `PolicyEvaluationBundle`

This is the main function to describe in architecture docs.

## Policy Evaluator

`policyEvaluator.ts` is pure deterministic evaluation:

- numeric operators
- boolean checks
- USD and duration formatting
- pass/fail/warn/unresolved findings

It is intentionally shared so browser, server, and MCP findings match.

## Evidence Requirements And Gate

`agentEvidenceRequirements.ts` builds evidence requirements from route plans and connector risk profiles.

`agentEvidenceGate.ts` has two jobs:

- pre-AI gate: decide whether the AI may approve
- post-AI validator: enforce deterministic blocks after the AI returns

This is where Agentic becomes more than "LLM said yes."

## Tx Gates

`txGates.ts` analyzes simulation digests against expected wallet action context.

Examples:

- only requested swap
- no extra transfers
- no unknown recipients
- no unrelated instructions

## Confidence And Counterfactuals

`confidence.ts` computes confidence bands from evidence quality.

`counterfactuals.ts` explains which facts would change the decision.

These are useful for making review output legible to humans.

## Device And Dev Contracts

The `dev/*` modules model Layer 1 routes for:

- ACP
- AP2
- MPP
- agent card
- aggregator
- bridge
- signals
- skills

These are used by render-web and app surfaces to keep agent-payment and skills contracts typed and testable.

## Test Areas

The package has focused unit tests for:

- atom extraction
- fact routing
- evidence gate
- policy evaluator
- policy orchestrator
- chat loop
- chat routing
- chat hardening
- connector atoms
- tx gates
- device agent
- dev-layer APIs
- workflow validators

