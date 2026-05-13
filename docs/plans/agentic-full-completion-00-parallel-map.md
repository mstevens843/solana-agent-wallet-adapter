# Agentic Full Completion Parallel Map

## Purpose

This plan set breaks the remaining "fully complete Agentic DeFi agent" work into parallel implementation tracks. Each track has a strict file ownership boundary so multiple agents can work at the same time without editing the same files.

The current baseline already includes:

- Repeat payments can ask the agent before start.
- AI-drafted repeats can activate or pause based on review.
- Active repeat cards can ask the agent again.
- Agent review findings are flexible, not locked to route/quote/slippage rows.
- Connector context is exposed to browser and bridge LLM prompts.
- Cloud, browser-local, and local bridge repeat schedules preserve agent review metadata and paused/active status.

The remaining work is about depth, reliability, breadth, and product polish.

## Parallel Workstreams

1. `agentic-full-completion-01-browser-agent-experience.md`
   - Owner: browser app experience, browser prompt surface, review cards, repeat UX.
   - Files: `apps/browser-demo/**` only.

2. `agentic-full-completion-02-mcp-connector-runtime.md`
   - Owner: local bridge/MCP connector reads, connector writes, adapter runtime, MCP tests.
   - Files: `packages/mcp-server/**` only.

3. `agentic-full-completion-03-cloud-workflow-recurring.md`
   - Owner: hosted cloud recurring/backend workflow contracts, persistence, API behavior.
   - Files: `packages/workflow/**` and `apps/render-web/**` only.

4. `agentic-full-completion-04-eval-harness.md`
   - Owner: scenario corpus, deterministic eval runner, smoke scripts, reporting.
   - Files: `docs/scenarios/**`, `docs/smoke/agentic-*.md`, new `scripts/*.mjs`, `spec/evals/**`. See the File Ownership Boundary Map below for the narrowing on `docs/smoke/` and `scripts/`.

5. `agentic-full-completion-05-connector-knowledge-packs.md`
   - Owner: connector knowledge specs, natural language coverage, connector playbooks.
   - Files: `docs/connectors/**`, `spec/connectors/**` only.

## File Ownership Boundary Map

A precise glob → workstream table. A fresh agent can `git diff --name-only` and verify every changed path falls inside its owned column.

| Workstream | Owned globs | Explicit "do not touch" |
|---|---|---|
| 01 browser | `apps/browser-demo/**` | everything else |
| 02 mcp | `packages/mcp-server/**` | everything else |
| 03 cloud | `packages/workflow/**`, `apps/render-web/**` | everything else |
| 04 evals | `docs/scenarios/**`, `docs/smoke/agentic-*.md`, `scripts/*.mjs` (new files only), `spec/evals/**` | existing files in `docs/smoke/` other than `agentic-*.md`; all of `apps/**` and `packages/**` |
| 05 packs | `docs/connectors/**`, `spec/connectors/**` | everything else |

The `docs/smoke/agentic-*.md` narrowing on 04 is load-bearing: the eval harness must not edit the five existing non-agentic smoke files (`android-*.md`, `ios-*.md`, `browser-wallet-standard.md`, `recurring-production.md`).

## Non-Overlap Rules

- Each agent must stay inside its owned path list.
- If an agent needs a change outside its owned paths, it should write a note in its plan file or final report instead of editing that file.
- Do not move shared files between workstreams.
- Do not rename public functions or types outside the owned path list.
- Do not introduce global formatting or lint churn.
- Tests should live inside the owned paths unless the plan explicitly owns a cross-package script path.

## Cross-Workstream Coordination Rules

- If a workstream needs a change in another workstream's owned path, write a `BLOCKED:` note in its own plan file's Deliverable Summary and stop. Do not edit cross-stream.
- The **Shared Data Contract** field names below are sticky. A workstream cannot rename or repurpose them without first proposing an amendment in this file. Dependent workstreams pause until the amendment is merged.
- Locking is file-level, not directory-level. Two workstreams can both touch `package.json` only if they edit disjoint top-level keys. By default, do not edit `package.json` at all — document direct-node invocation instead.
- When the same conceptual change must land in multiple workstreams (e.g., a new connector id), the parallel-map owner publishes the contract addition here first, then dependent workstreams pick it up under their own paths.

## Shared Product Contract

All workstreams must preserve these user-facing rules:

- The agent can read facts where connectors expose read APIs.
- The agent can prepare wallet-approval work where connectors expose actions.
- The agent must never claim it can sign, submit, or approve without the user's wallet.
- Agent approval means "safe enough to send to Needs Approval" or "start the repeat schedule"; it is not a wallet signature.
- Agent denial or missing information must pause repeat execution and explain what blocked it.
- Every due repeat occurrence still requires wallet approval.
- Connector write actions must be represented as prepare-only, wallet-gated operations.
- Q&A answers must say when a fact is missing instead of inventing it.

## Shared Data Contract

The plans should converge on these concepts. Names can differ locally, but the semantics should match:

- `connectorId`: stable connector id such as `kamino`, `jupiter`, `meteora`.
- `capability`: one of `positions`, `rewards`, `markets`, `blinks`, `swap`, `earn`, `borrow`, `withdraw`, `repay`, `add_liquidity`, `close`.
- `readiness`: whether the connector can currently read facts, and why not if blocked.
- `fact`: grounded information read from connector, deterministic app state, quote API, or wallet state.
- `finding`: user-facing row with `{ label, value, tone }`.
- `actionProposal`: parse result for a write request that can be prepared but not signed.
- `approvalBoundary`: always states that the wallet signs separately.

## Suggested Merge Order

The workstreams are parallel in implementation, but merge order should minimize integration friction:

1. Connector knowledge packs.
2. MCP connector runtime.
3. Cloud/workflow recurring backend.
4. Browser agent experience.
5. Eval harness.

This order is not a dependency chain for development. It is only a practical merge order if all agents finish around the same time.

Why this order: it follows contract direction. Knowledge packs define the connector contract; MCP runtime implements it; cloud persists the metadata; browser surfaces it; evals verify it. Merging in reverse would assert behaviors against shifting implementations and create churn — evals would fail-then-pass as each upstream workstream lands, and reviewers would lose signal.

## Drift Detection

These invariants must be preserved by every workstream. If any of them drift, the plan-set is broken regardless of which workstream caused the change.

- Agent decision strings are exactly `'approve' | 'deny' | 'needs_input'`. Source of truth: `packages/mcp-server/src/aiPlanner.ts:58` (`AiReviewDecision`).
- Reviewer role IDs are exactly `'risk' | 'quote' | 'policy' | 'protocol'`. Source of truth: `packages/mcp-server/src/aiPlanner.ts:228` (schema enum) and `aiPlanner.ts:988` (runtime guard). Aggregation rule: any `deny` outranks any `needs_input` outranks all-`approve`.
- The wallet-approval boundary phrase corpus in `packages/mcp-server/src/aiPlanner.ts:132-134, 745, 803, 829` must remain assertable verbatim by the eval runner. The eval-harness plan (file 04) lists the full corpus (six phrases); a representative excerpt:
  - "Wallet approval is required before any signature or transaction leaves the device."
  - "AI drafts a plan only. Wallet approval and signing happen later in the user wallet."
  - "This AI review can approve, deny, or request more input. It cannot sign or submit a transaction."
- Connector **registry entry** shape (one record per connector in the MCP registry, browser catalog, and connector knowledge packs) is canonical: `id`, `readCapabilities`, `writeCapabilities`, `approvalBoundary`. This is distinct from the per-instance type names in the Shared Data Contract (`connectorId` is an *id reference* to a registry entry; `capability` is a *value* drawn from `readCapabilities` or `writeCapabilities`).
- The `agentReview*` metadata key set (`agentReview`, `agentReviewStatus`, `agentReviewDecision`, `agentReviewCheckedAt`, `agentReviewProvider`, `agentReviewModel`) is shared across workflow, browser, and cloud. Workstreams cannot redefine these locally.

If a workstream needs to evolve an invariant, treat it as a contract amendment per Cross-Workstream Coordination Rules.

## Final Acceptance Criteria

The full plan is complete when every bullet below has a concrete proof artifact under workstream 04's owned paths. The matrix in `docs/scenarios/agentic-completion-matrix.md` is the single index linking each bullet to its scenario id or smoke doc.

- A user can ask for common connector-specific work in natural language and get a correct plan or honest missing-fact denial. → proven by: scenarios under `spec/evals/connector-actions.scenarios.json` and `spec/evals/connector-qa.scenarios.json`.
- Kamino/Jupiter/Meteora connector paths have clear read/write capability boundaries. → proven by: connector packs under `spec/connectors/` (workstream 05) plus capability scenarios in `spec/evals/connector-actions.scenarios.json`.
- Repeat transfers and repeat swaps can be drafted, reviewed, activated, paused, re-reviewed, and inspected across browser-local, local bridge, and cloud modes. → proven by: scenarios in `spec/evals/repeat-agent.scenarios.json` plus the smoke doc `docs/smoke/agentic-repeat-agent.md`.
- Agent Q&A can answer "why", "what changed", "what is missing", "what will happen", "what connector can do this", and "why was this denied" without being bound to one swap example. → proven by: scenarios in `spec/evals/connector-qa.scenarios.json` plus `docs/smoke/agentic-qa.md`.
- Denials, needs-input, and approvals are covered by deterministic evals. → proven by: scenarios in `spec/evals/denials-needs-input.scenarios.json`; at least 10 denial/needs-input cases as required by 04.
- Connector write actions are never presented as autonomous wallet authority. → proven by: forbidden-phrase assertion in `scripts/run-agentic-evals.mjs` against every scenario expected output.
- All package builds and relevant tests pass. → proven by: green `pnpm -r build` and `pnpm -r test`, plus `node scripts/run-agentic-evals.mjs` exits 0.

## Amendment Log

When the **Shared Data Contract** or a **Drift Detection** invariant must evolve, append a dated entry below before any dependent workstream picks up the change. Entries are append-only; do not edit historical entries.

Format:

```
- YYYY-MM-DD — <workstream id> — <one-line summary>. Affected invariant(s): <list>. Migration notes: <how dependent workstreams should adapt>.
```

(No amendments yet. The initial contract is the body of this document.)
