# AP2 Inbound Smoke

End-to-end verification for the AP2 inbound surface (Agentic Layer 1).
Drives an external-agent → recipient-wallet payment mandate through the
full approval lifecycle and confirms the AP2 receipt is produced.

## Preconditions

- `pnpm -r build` has been run so `packages/workflow/dist`,
  `packages/ap2-adapter/dist`, and `apps/render-web/dist/server.js` are
  current. The smoke imports `packages/workflow/dist/index.js` and
  `packages/ap2-adapter/dist/verifier.js` for canonical mandate
  signing, and spawns the built Render server.
- Phase 0 dev-gate hooks are merged (`devGate.ts`, `devApiRegistry.ts`,
  router fallthrough). All Phase 1 surfaces (Agents 1, 3, 5, 7, 8, 9)
  are merged on `master`.
- Smoke runs locally do not require any cloud credentials. The harness
  spins up its own ed25519 test wallet for the recipient and signs the
  mandate with an ephemeral agent ed25519 key.

## Local checklist — `pnpm smoke:render-web:ap2`

The smoke boots a local Render server with `AGENTIC_DEV_AP2_ACP=1` and
`AGENTIC_DEV_WALLET_ALLOWLIST=<test-wallet>` set so the dev gate
allows the test wallet through the AP2 routes. Twelve checks:

1. Generate an ed25519 test wallet (`createTestWallet`).
2. Sign in to the cloud via `/api/auth/nonce` → `/api/auth/verify-wallet`
   and capture the session cookie.
3. Generate an ephemeral ed25519 agent keypair (the "external agent").
4. Build a proper AP2 `IntentMandate` — `mandateId`, `mandateType`,
   `protocolVersion: 'ap2/0.1'`, `issuedAt`, `expiresAt` (now+1h),
   `agent: {agentId, agentLabel, publicKey: <base58>}`, `signedFields`
   (mirroring all common fields + the `intent` subtree), and `intent`
   with `description` + `cap: {amount, tokenSymbol, tokenMint,
   recipient, cluster: 'mainnet-beta'}`. Sign
   `canonicalize(signedFields)` (Agent 1's deterministic JSON
   formatter) with the agent's ed25519 key; base58-encode the
   signature.
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
12. `POST /api/ap2/inbound/:inboundId/receipt` and confirm the wrapped
    response `{receipt, evidenceId, approvalId}` includes a receipt
    with `schema: 'ap2/inbound/0.1'`, a 64-char hex `artifactHash`, a
    `mandateId` that round-trips the request, and `approval.id` equal
    to the materialized approval.

Each step logs a `[smoke-render-web] PASS …` line. The final summary
line is `[smoke-render-web] PASS AP2 inbound lifecycle: <inboundId> →
<approvalId> → finalized → receipted.`

If the local server returns 404 on step 5, run
`pnpm -F @solana-agent-wallet-adapter/render-web build` to refresh
`apps/render-web/dist/server.js` and re-run.

## Live checklist — `pnpm smoke:render-web:ap2-live`

A thin probe against the deployed origin (default
`https://agentic-signer.com`, override with the positional `[origin]`
argument). Two assertions, no session, no state mutation.

1. `GET <origin>/.well-known/agent.json` — expect HTTP 200 with
   `application/json` body containing at least the string fields
   `name`, `description`, `walletAddress`. If the route returns 404,
   the smoke logs a `SKIP` line stating the route is not deployed at
   this origin yet and continues without failing.
2. `GET <origin>/api/ap2/inbound` unauthenticated — expect HTTP 401 or
   403. If the route returns 404, the smoke soft-skips with a
   matching log line. Any other status fails.

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
   and inspect the returned AP2 receipt — confirm `schema`,
   `artifactHash`, and `approval.id` match expectations.

## Caveats

- The smoke uses an ephemeral agent key for every run; the mandate
  signature is therefore non-reproducible. This is intentional — there
  is no stable "smoke agent identity" in the system.
- The `AGENTIC_MOCK_FINALIZATION=1` env var (set by `withLocalServer`)
  keeps the local server's finalization path on the mock path used by
  the existing workflow smoke. This is required for the
  `/finalization/prepare` → `submit` → `confirm` chain to complete
  without an on-chain transaction.
- Live mode against `agentic-signer.com` will only go fully green
  after Agents 3, 5, and 7 are deployed to the live origin. Until
  then the soft-skip lines are the expected output.
