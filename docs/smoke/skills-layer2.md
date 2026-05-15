# Skills Layer 2 Smoke

End-to-end local verification for the Skills Hub path: catalog, install,
executor, approval, evidence receipt, aggregator snapshot, and public profile
SSR.

## Preconditions

- Build output is current:

```bash
pnpm -r build
```

- No cloud credentials are required. The smoke creates an ephemeral wallet,
  starts the built Render server in-process, and uses a shared memory store so
  API routes, executor, evidence, aggregator, and SSR all see the same records.

## Command

```bash
pnpm smoke:render-web:skills
```

## Expected Flow

1. Enable the dev gate for the ephemeral smoke wallet.
2. Sign in through `/api/auth/nonce` and `/api/auth/verify-wallet`.
3. Load `/api/skills` and find `friday-dca`.
4. Install `friday-dca` with a tight one-run USDC cap.
5. Force `runSkillsExecuteTick` at the Friday DCA cron time.
6. Confirm a `skill_executions` row and approval inbox item were created.
7. Approve the generated request with the normal wallet decision proof.
8. Confirm the skill execution is marked successful and linked to a verified
   `tool_trace_receipt`.
9. Force `runAggregatorRoll` and verify
   `/api/aggregator/skills/friday-dca`.
10. Verify `/u/<smoke-wallet>` returns HTML that lists `friday-dca`.

The final line should be:

```text
[smoke-render-web] PASS Skills Layer 2 smoke completed.
```

## Deployed Verification

The automated smoke is intentionally local. For a deployed Render URL, use the
same feature surfaces manually: connect the allowlisted dev wallet, install
Friday DCA, run the configured `skills-execute` and `aggregator-roll` crons,
approve the generated inbox item, then inspect `/api/aggregator/skills/friday-dca`
and `/u/<dev-wallet>`.
