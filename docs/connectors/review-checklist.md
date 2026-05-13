# Connector Pack Review Checklist

Every connector pack under `spec/connectors/` must pass this checklist before merge. If a check fails, fix the pack rather than the checklist.

## 1. Does it say what is actually implemented today?

- Cross-check `readCapabilities[].implemented` and `writeCapabilities[].implemented` against `packages/mcp-server/src/adapters/`. If no adapter file exists, `implemented: false`.
- The pack must not list facts the adapter does not return.

**Pass:** Kamino lists `solana_kamino_get_positions` with `implemented: true` and the adapter exists at `packages/mcp-server/src/adapters/kamino/positions.ts`.

**Fail:** A connector lists `implemented: true` for `solana_example_positions` while no matching adapter or tool exists.

## 2. Does it distinguish read from write?

- Reads live in `readCapabilities`; writes live in `writeCapabilities`. No mixing.
- A read tool that returns "preview-only" data and never prepares an action (e.g., earnings proof) stays in reads; classification of its example request is `proof_only_review`.

**Pass:** `solana_kamino_prepare_earnings_proof` is in `readCapabilities`, and its example request is classified `proof_only_review`.

**Fail:** Listing `solana_get_swap_quote` as a write because it touches Jupiter.

## 3. Does it preserve wallet approval?

- `approvalBoundary.writeGated` is `true` for any connector with at least one `writeCapability`.
- `approvalBoundary.summary` references a valid phrase id in `safety-phrases.json`.
- The pack does not say "the agent signs", "the agent submits", "auto-pay", or "guaranteed safe" anywhere.

**Pass:** Every Kamino example uses `safety.prepare_only` after a prepare and never claims to sign.

**Fail:** A pack example whose `agentResponse` reads "I signed your Jupiter swap." Disqualifying — `safety.no_sign_claim` is forbidden.

## 4. Does it include missing-input questions?

- Each `requiredUserInputs` entry has a concrete `prompt`.
- At least 3 example requests with `classification: "needs_input"` and a `needsInputQuestions` array of 1–3 items.

**Pass:** Kamino pack has needs-input examples for missing amount, missing token, and 'half my position'.

**Fail:** A pack with zero `needs_input` examples or empty `needsInputQuestions`.

## 5. Does it include denial examples?

- At least 2 examples with `classification: "unsupported"` and a `denialReason` pointing at a phrase id.

**Pass:** Meteora pack denies "create a new Meteora DLMM position" with `safety.action_not_exposed` because new position creation is not exposed.

**Fail:** A pack that lists only happy-path examples.

## 6. Does it include unsupported examples?

- `unsupportedRequests` array lists at least 2 plain-English unsupported asks for the connector.
- Disabled-connector and wrong-cluster cases are represented in `examples.requests`.

**Pass:** Drift pack lists "Open a 5x long on SOL on Drift" with `safety.action_not_exposed` because only strategy vaults are exposed.

**Fail:** A pack that does not name a single concrete unsupported request.

## 7. Does it avoid claiming safety guarantees?

- No use of "guaranteed safe", "risk-free", "always profitable", "auto-pay", "auto-submit", "no risk".
- Risk notes use concrete language (slippage, withdrawal delays, liquidation, out-of-range bins).

**Pass:** Lulo pack denies "is Lulo's boosted tier safe?" with `safety.no_safety_guarantee` and surfaces APY vs underlying risk in `riskNotes`.

**Fail:** A pack whose `riskNotes` reads "Protected deposits are safe."

## 8. Does it include examples in user language?

- Examples use natural English ("supply 25 USDC to Kamino", "swap a lot of SOL", "show my balances") not API names ("call solana_prepare_swap").
- Aliases from `connectedDapps.ts` appear in at least one example phrasing (e.g., "klend", "jup", "whirlpool", "DLMM").

**Pass:** Jupiter pack includes "DCA SOL to USDC weekly" and "swap a lot of SOL".

**Fail:** A pack whose examples all read like API call descriptions.

## Running the checklist

For each new or changed pack:

1. Read the JSON top-to-bottom and check each section against this list.
2. Run `node -e "JSON.parse(require('fs').readFileSync('spec/connectors/<file>.json','utf8'))"`.
3. Cross-check `id`, `aliases`, `supportedClusters`, `readTools`, and `actionKinds` against the matching `PROTOCOL_CONNECTORS` entry in `apps/browser-demo/src/connectedDapps.ts`.
4. Confirm every `approvalBoundary.summary` and `denialReason` value resolves to an id in `spec/connectors/safety-phrases.json`.

A pack that passes this list is fit to ship to evals and prompt designers.
