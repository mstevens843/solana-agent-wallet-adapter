# Browser Agent Experience Plan

## Ownership

This workstream owns only:

- `apps/browser-demo/**`

Do not edit:

- `packages/mcp-server/**`
- `packages/workflow/**`
- `apps/render-web/**`
- `scripts/**`
- `docs/connectors/**`
- `spec/connectors/**`

## Goal

Make the browser app feel like a flexible Agentic DeFi control surface rather than a fixed swap-review demo. The browser should guide the LLM with connector context, show flexible findings, support repeat-payment agent decisions clearly, and answer a broad range of user questions about requests, repeats, and connector-backed actions.

## Current Baseline

Already implemented:

- Repeat create flow supports `Draft repeat payment with AI`.
- Repeat create flow supports `Ask agent before start`.
- Active repeat cards support `Ask agent again`.
- Agent result cards render flexible `checks` and `evidence.findings`.
- Browser prompt context includes connector read/write capability notes.
- Repeat swaps behave like swaps for review facts.

## Non-Goals

This workstream must not implement actual connector RPC calls, bridge tools, or cloud persistence. Those belong to other workstreams.

This workstream must not add eval runners or scenario harnesses. It may add browser-unit tests only if they already live under `apps/browser-demo/**`.

## Required Outcomes

### 1. Flexible Result Card Polish

Improve the Check result UI so arbitrary agent findings look first-class.

Requirements:

- The card must render findings with these tones:
  - `good`
  - `warn`
  - `neutral`
  - `fail`
- The card must not assume `Route`, `Quote`, `Protocol`, or `Slippage`.
- If the review has connector findings, show them as normal findings, not as a separate hardcoded Kamino/Jupiter section.
- If the review has no findings, show a compact fallback from `reason`, `summary`, and deterministic facts.
- Long values must wrap cleanly on narrow screens.
- The result card should support:
  - approval summary
  - denial reason
  - missing user inputs
  - connector unavailable state
  - stale review state after edits
  - user override state

Implementation notes:

- Keep the existing `AgentPlanReviewState` shape compatible.
- Prefer small render helpers near existing review-card rendering.
- Do not introduce a new UI framework.

Definition of done:

- A review result with only `evidence.findings` and no route/quote fields renders cleanly.
- A denial result with two findings and one missing input renders cleanly.
- A connector unavailable warning renders cleanly.

### 2. Repeat Agent UX Completion

Make repeat-agent behavior obvious and inspectable.

Requirements:

- On create repeat:
  - `Create repeat payment` with `Ask agent before start` checked runs review before activation.
  - Agent approve creates active repeat.
  - Agent deny, needs-input, or error creates paused repeat.
  - Toast copy must say exactly why the repeat was started or paused.
- On active repeat card:
  - `Ask agent again` must be visible when an agent path exists.
  - The current agent decision must be visible without opening a drawer.
  - The detailed evidence drawer must be available.
  - If the repeat is paused by agent, make that visually distinct from a user pause.
- Browser-local edge:
  - If a paused browser-local repeat is later approved by `Ask agent again`, create exactly one ready approval item if no unresolved one exists.
  - If a browser-local repeat is denied, remove unresolved non-terminal approval items for that repeat.

Definition of done:

- Browser-local active/paused behavior is deterministic.
- The UI never suggests that a repeat auto-signs.
- Active, paused-by-user, and paused-by-agent are distinguishable.

### 3. Browser Planner Natural Language Breadth

Improve browser-side plan generation prompts and parsing so users can ask in different ways.

Supported request categories:

- "Swap X to Y"
- "DCA X to Y weekly"
- "Pay recipient X every Monday"
- "Stake/supply X into Kamino"
- "Withdraw X from Kamino"
- "Show my Kamino earnings"
- "Check my Meteora position"
- "Prepare this Blink action"
- "Can this connector do X?"
- "Why did the agent deny this?"
- "What facts are missing?"

Requirements:

- The planner should use connector context when present.
- If the connector is not enabled, the plan should say which connector is missing.
- If a write action is unsupported, the plan should become read-only/proof-only instead of hallucinating execution.
- The prompt must preserve the wallet approval boundary.
- The prompt must not hardcode Kamino as the only connector.

Definition of done:

- Browser AI plan generation can produce a valid plan for a Kamino deposit request when connector context says Kamino is enabled.
- Browser AI plan generation can produce a read-only or needs-input plan for unsupported connector requests.
- Existing swap and transfer templates still work.

### 4. Ask-Agent Q&A Expansion

Improve question-answering around generated plans and repeat schedules.

Question classes to support:

- What will happen if I approve?
- What is missing before this can be approved?
- Why did the agent deny this?
- Which connector is being used?
- Can this connector sign for me?
- Does this repeat auto-pay?
- What facts did the agent read?
- Is the route/protocol fixed or selected later?
- What changed since the last review?
- What are the risks?

Requirements:

- Answers must cite plan fields or fact labels.
- Answers must be short, but can use up to four sentences.
- Missing facts must be stated directly.
- Answers must never claim safety guarantees or wallet approval.

Definition of done:

- Existing ask UI can answer repeat-specific and connector-specific questions.
- The answer does not mention irrelevant swap concepts for non-swap requests.

### 5. Connector Preference UI Clarity

Improve the Preferences connector section so users understand what connectors do.

Requirements:

- Each connector should show:
  - read capabilities
  - write/action capabilities
  - whether a client key is needed
  - whether actions are first-class, Blink-backed, or unavailable
  - wallet approval boundary
- Avoid marketing copy.
- Keep the layout compact and scannable.

Definition of done:

- A user can tell whether Kamino can prepare a deposit, whether Meteora can read positions, and whether a connector needs a client key.

### 6. Browser Test/Verification Scope

Run:

- `pnpm -F @solana-agent-wallet-adapter/browser-demo build`
- `pnpm -F @solana-agent-wallet-adapter/browser-demo test` if tests exist and pass locally.

Manual verification:

- Repeat create with agent approval.
- Repeat create with agent denial.
- Ask agent again on paused repeat.
- Ask a connector Q&A question.
- Render a findings-only review card.

## Deliverable Summary

The final report should list:

- Browser files changed.
- Which request types were improved.
- Screens or workflows manually checked.
- Any connector capabilities that remain blocked because server/cloud work is not merged yet.
