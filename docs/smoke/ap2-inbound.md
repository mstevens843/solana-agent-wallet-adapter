# AP2 Inbound Smoke

End-to-end verification for the AP2 inbound surface (Agentic Layer 1).
Drives an external-agent → recipient-wallet payment mandate through the
deployed approval lifecycle and confirms the AP2 receipt is produced.

## Preconditions

- `pnpm -r build` has been run so `packages/workflow/dist` and
  `apps/render-web/dist/server.js` are current. The smoke imports
  `packages/workflow/dist/index.js` and spawns the built server.
- Phase 0 dev-gate hooks are merged (`devGate.ts`, `devApiRegistry.ts`,
  router fallthrough). This is true on `master`.
- For full local PASS — Phase 1 Agent 5 (`apps/render-web/src/cloud/ap2Routes.ts`)
  must be in the tree. Until it lands, the smoke fails at the first POST
  with a clear message about the missing route.
- For full live PASS — Phase 1 Agent 7 (`apps/render-web/src/cloud/agentCardRoutes.ts`)
  must be deployed. Until it ships, the smoke soft-skips the
  `/.well-known/agent.json` assertion with a warning.
- Smoke runs locally do not require any cloud credentials. The harness
  spins up its own ed25519 test wallet and signs the mandate with an
  ephemeral agent key.

## Local checklist — `pnpm smoke:render-web:ap2`

The smoke boots a local Render server with `AGENTIC_DEV_AP2_ACP=1` and
`AGENTIC_DEV_WALLET_ALLOWLIST=<test-wallet>` set so the dev gate
allows the test wallet through the AP2 routes. Twelve checks:

1. Generate an ed25519 test wallet (`createTestWallet`).
2. Sign in to the cloud via `/api/auth/nonce` → `/api/auth/verify-wallet`
   and capture the session cookie.
3. Generate an ephemeral ed25519 agent keypair (the "external agent").
4. Build a canonical AP2 `IntentMandate` payload — `kind`, `version`,
   `sourceAgentId`, `sourceAgentLabel`, `recipient`, `amount`,
   `tokenMint`, `memo`, `issuedAt`, `nonce` — and sign it with the
   agent key (base64 ed25519 signature over the sorted-key JSON).
5. `POST /api/ap2/inbound` with the signed mandate and session cookie.
   Expect a 2xx response with `{inboundId, approvalId}`.
6. `GET /api/ap2/inbound` and confirm the listing contains the new
   `inboundId`.
7. `GET /api/ap2/inbound/:id` and confirm the single record matches.
8. `GET /api/approvals` and confirm the materialized approval exists
   in the inbox under the returned `approvalId`.
9. `POST /api/approvals/:approvalId/approve` with the standard decision
   proof signature (the wallet signs the decision message).
10. `POST /api/approvals/:approvalId/finalization/prepare` and capture
    the finalization preview.
11. `POST /api/approvals/:approvalId/finalization/:finalizationId/submit`
    with a confirmed finalization proof + mock txid.
12. `POST /api/ap2/inbound/:inboundId/receipt` and confirm a receipt
    object is returned.

Each step logs a `[smoke-render-web] PASS …` line. The final summary
line is `[smoke-render-web] PASS AP2 inbound lifecycle: <inboundId> →
<approvalId> → finalized → receipted.`

Failure modes (expected during parallel build):

- `POST /api/ap2/inbound returned HTTP 404 — Agent 5 routes have not
  landed yet.` → Agent 5 (`ap2Routes.ts`) has not been merged. Re-run
  after merge.

## Live checklist — `pnpm smoke:render-web:ap2-live`

A thin probe against the deployed origin (default
`https://agentic-signer.com`, override with the positional `[origin]`
argument). Two assertions, no session, no state mutation.

1. `GET <origin>/.well-known/agent.json` — expect HTTP 200 with
   `application/json` body containing at least the string fields
   `name`, `description`, `walletAddress`. If the route returns 404,
   the smoke logs `[smoke-render-web] SKIP /.well-known/agent.json
   not yet deployed (Agent 7 pending).` and continues without failing.
2. `GET <origin>/api/ap2/inbound` unauthenticated — expect HTTP 401 or
   403. If the route returns 404, the smoke logs `[smoke-render-web]
   SKIP /api/ap2/inbound not yet deployed (Agent 5 pending).` and
   continues. Any other status fails.

## Manual deployed verification

The live mode above runs without any wallet credentials, so it cannot
exercise the full inbound → approval → receipt loop against the
deployed site. To verify end-to-end on `agentic-signer.com`:

1. Set the dev gate env vars on Render so the dev wallet pubkey
   `4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd` is allowlisted
   (`AGENTIC_DEV_AP2_ACP=1`, `AGENTIC_DEV_WALLET_ALLOWLIST=…`).
2. Connect that wallet on `https://agentic-signer.com/app`. The Agent
   Card tab should appear between Save Proof and Preferences.
3. Issue a signed AP2 mandate using the same fixture shape the smoke
   generates (any agent ed25519 key) and `curl` it to
   `https://agentic-signer.com/api/ap2/inbound` with the dev wallet's
   session cookie. The approval should appear in the inbox.
4. Approve in-wallet, finalize, then call `/api/ap2/inbound/:id/receipt`
   and inspect the returned AP2 receipt.

## Caveats

- Receipt-shape assertions are intentionally minimal
  (`typeof receipt === 'object'`). The canonical AP2 receipt schema is
  Agent 1's deliverable (`packages/ap2-adapter/src/receipt.ts`); pinning
  the shape here would pre-judge it. Add stricter assertions in a
  follow-up after Agent 1 ships.
- The smoke uses an ephemeral agent key for every run; the mandate
  signature is therefore non-reproducible. This is intentional — there
  is no stable "smoke agent identity" in the system.
- The `AGENTIC_MOCK_FINALIZATION=1` env var (set by `withLocalServer`)
  keeps the local server's finalization path on the mock path used by
  the existing workflow smoke. This is required for the
  `/finalization/prepare` → `submit` → `confirm` chain to complete
  without on-chain confirmation.
- Live mode against `agentic-signer.com` will only become fully green
  after Agents 3, 5, and 7 are deployed. Until then `SKIP` lines are
  the expected output.
