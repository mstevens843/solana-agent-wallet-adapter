# Connector Specs (draft v0.1)

> **Status:** draft. Subject to breaking changes until v1.0. Companion to `spec/protocol.md`.

This directory holds machine-readable knowledge packs for every Solana dapp connector the agent can read, prepare, or refuse. Packs exist so agents, evaluators, and engineers can answer "what can this connector do, what does it need, and what must I never claim about it" without rereading product chat history or scraping prompts.

## Files

- `connector-pack.schema.json` — JSON Schema (draft 2020-12) describing the shape of every pack.
- `safety-phrases.json` — canonical required/forbidden phrases with stable ids. Reference by id from prompts and evals.
- `<connector-id>.connector.json` — one pack per connector. Today: drift, jito, jupiter, kamino, lulo, magiceden, marinade, marginfi, meteora, orca, project0, pyth, raydium, realms, sanctum, save, squads, tensor, wormhole.

## Status enum

| Status | Meaning |
| --- | --- |
| `first_class` | An internal adapter owns reads and writes (Kamino today). |
| `blink_backed` | Writes route through Solana Actions/Blinks. Reads may use Dialect or a connector-specific API. |
| `read_only` | Reads work; no writes are exposed yet. |
| `planned` | Documented for completeness; no implementation. |
| `unsupported` | Agent must refuse all requests. |

A connector may mix execution modes per capability. Jupiter is `first_class` overall because its swap, token/price, and current Jupiter product reads/actions are owned by `packages/mcp-server/src/actionService.ts`.

## Source of truth

The runtime catalog lives in `apps/browser-demo/src/connectedDapps.ts` (`PROTOCOL_CONNECTORS`). Every pack mirrors a single entry there. Each pack carries a `mirrorsCanonical` block pointing at the source file and entry id; when the canonical catalog changes, update the matching pack. Drift is a bug.

Implemented adapters live under `packages/mcp-server/src/adapters/`. If a connector lists a read tool or action kind that has no adapter code, mark `implemented: false` on that capability so the pack reflects reality.

## Fact glossary

Packs reuse the shared data contract from `docs/plans/agentic-full-completion-00-parallel-map.md`:

- `fact` — grounded information read from the connector, deterministic app state, quote API, or wallet state.
- `finding` — user-facing row with `{ label, value, tone }` produced from facts.
- `actionProposal` — parse result of a write request that can be prepared but not signed.
- `approvalBoundary` — always preserves "the wallet signs separately."

## Consuming a pack

- `readCapabilities[]` — tools the agent may call to ground an answer. Check `implemented` and `requiresClientKey` before using.
- `writeCapabilities[]` — tools that prepare a wallet-approval-bound action. Always followed by `executesVia` (typically `solana_execute_prepared_action`).
- `requiredUserInputs[]` — fields the agent must collect before prepare. Empty optional fields must not be hallucinated.
- `examples.requests[]` — at least 10 user-language requests with classifications. Use for eval scaffolding.
- `approvalBoundary.summary` — phrase id; resolve against `safety-phrases.json` for the actual text.

## Validation

This workstream does not add package dependencies. To sanity-check a pack:

```bash
node -e "JSON.parse(require('fs').readFileSync('spec/connectors/kamino.connector.json','utf8'))"
```

A future workstream may wire Ajv against `connector-pack.schema.json` in CI.

## Adding a new connector

1. Add the entry to `apps/browser-demo/src/connectedDapps.ts` first (owned by the browser workstream).
2. Copy an existing pack with a matching status as a starting point.
3. Update `id`, `name`, `aliases`, `supportedClusters`, `readCapabilities`, `writeCapabilities`, `examples`, and `mirrorsCanonical`.
4. Choose `approvalBoundary.summary` from `safety-phrases.json`.
5. Write at least 10 example requests with classifications, with at least 5 denials or needs-input.
6. Update `docs/connectors/README.md`'s status matrix.

## Changelog

- v0.5, 2026-05-13: added the first-class Project 0 lending connector pack while keeping MarginFi separate.
- v0.4, 2026-05-12: added the first-class Wormhole bridge connector pack.
- v0.3, 2026-05-12: added the first-class Marinade connector pack.
- v0.2, 2026-05-12: added the first-class Jito connector pack.
- v0.1, 2026-05-12: initial schema, safety phrases, and 9 connector packs.
