# Documentation Map Draft

This is the proposed private replacement for `docs/README.md`.

## Start Here

- Root README: product overview, architecture, quick start, and public package map.
- `docs/app-feature-analysis.md`: current product workflow map.
- `docs/agentic-decision-system.md`: decision-system architecture behind Chat, Agent Review, Evidence Gate, and Policy Orchestrator.
- `apps/browser-demo/README.md`: browser app and local development guide.
- `apps/render-web/README.md`: Agentic Cloud, Render backend, sessions, workflow APIs, recurring, persistence, and deployment.
- `packages/workflow/README.md`: shared decision, evidence, workflow, and policy primitives.
- `packages/mcp-server/README.md`: MCP, bridge, action service, connector facts, prepared actions, and local runtime.

## Public Guides

- `docs/ai-byok.md`: AI route modes, BYOK, Device Agent, hosted relay, local bridge, and Plan Connector.
- `docs/agent-connector.md`: subscription CLI connector mode for Codex, Gemini, and Claude through the local bridge.
- `docs/connectors/README.md`: protocol connector capability catalog.
- `docs/SECURITY.md`: wallet custody, supply-chain hygiene, signing boundary, server-signing exception for streaming sessions, and operational safety.
- `spec/protocol.md`: transport-agnostic signing request and WalletBackend protocol.
- `spec/connectors/README.md`: machine-readable connector pack notes.

## Product Workflows

- Chat: wallet-aware assistant, research cards, action preparation, Decision Planner, pending approvals, and cloud chat sync.
- New Request: template, connector, proof, and read-only evidence creation.
- Sign Approval: approval inbox for one-time, recurring, connector, proof, chat-originated, and external agent actions.
- Done: completed approvals, denials, receipts, finalization records, and history.
- Repeat Payments: manual-approval recurring payments and recurring swap/DCA setup.
- Save Proof: wallet-signed proof and evidence records.
- Agent Payments: AP2, ACP, MPP, inbound payment requests, and A2A profile surfaces.
- Spending Sessions: capped streaming-payment sessions and settlement records.
- Skills: installable skill lifecycle and execution approval.

## Smoke Guides

- `docs/SCENARIO_TESTS.md`: broad prompt and workflow scenario catalog.
- `docs/smoke/browser-wallet-standard.md`
- `docs/smoke/android-mwa-web.md`
- `docs/smoke/android-native-mwa.md`
- `docs/smoke/ios-wallet-web.md`
- `docs/smoke/agentic-connectors.md`
- `docs/smoke/agentic-repeat-agent.md`
- `docs/smoke/recurring-production.md`
- `docs/smoke/streaming-settlement.md`
- `docs/smoke/ap2-inbound.md`
- `docs/smoke/skills-layer2.md`

## Deploy Guides

- `docs/deploy/render.md`: hosted Node service and Agentic Cloud deployment.
- `docs/deploy/release.md`: CLI, GitHub release assets, desktop installers, Android artifacts, and release readiness.
- `docs/deploy/android.md`: Android build, asset links, signing, and release notes.
- `docs/deploy/browser-device-agent.md`: browser-native Device Agent deployment gating.

## Research And Historical Notes

Research notes are dated artifacts. They preserve past state and may be superseded by current docs.

- `docs/research/*`
- `plans/*`
- `connector_plan/*`

Do not treat old `plans/*` files as current product truth unless the file explicitly says it has been refreshed.

