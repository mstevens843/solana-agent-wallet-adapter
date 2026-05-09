# Recurring Production Smoke

Use this checklist against a local Render-web server or staging deployment with Postgres enabled.

## Preconditions

- Wallet can sign into Agentic Cloud.
- `DATABASE_URL` and `SESSION_SECRET` are configured.
- Run migrations before testing:

```bash
pnpm -F @solana-agent-wallet-adapter/render-web db:migrate
```

## Checklist

1. Sign in to `/app` with a wallet.
2. Open Recurring and create a weekly SOL or USDC schedule with:
   - `maxOccurrences=3`
   - `expiresAt` about ten days in the future
   - optional webhook URL from a request inspector such as webhook.site
3. Confirm the create form shows:
   - next-run preview
   - next-5 run list
   - lifetime or rate spend estimate
   - wallet-signature trust boundary
4. If a webhook URL was set, confirm the app shows a one-time webhook secret. Copy it now; later schedule reads must not show it.
5. Force materialization:

```bash
pnpm -F @solana-agent-wallet-adapter/render-web recurring:materialize
```

6. Refresh Approval Inbox and confirm one recurring approval appears.
7. Approve or deny the occurrence from the wallet flow.
8. Open Recurring history for the schedule and confirm:
   - plain-English status label
   - approval id summary
   - completed receipt or txid when available
9. Pause the schedule, run materialization again, and confirm no new occurrence is created.
10. Resume the schedule and confirm future materialization resumes.
11. If webhook URL was set, run:

```bash
pnpm -F @solana-agent-wallet-adapter/render-web notifications:deliver
```

12. Confirm webhook payload includes `type=recurring.occurrence.ready`, schedule id, occurrence id, amount, token, recipient, and headers:
   - `X-Agentic-Delivery-Id`
   - `X-Agentic-Timestamp`
   - `X-Agentic-Signature`
13. Verify the signature by computing HMAC-SHA256 over `<timestamp>.<raw JSON body>` with the one-time secret.
14. Open the schedule Notifications panel and confirm the latest delivery status, attempts, and retry/last-delivery timestamp are visible.
15. Rotate the webhook secret, copy the newly shown one-time secret, and confirm later reads do not reveal it.
16. Configure a low cap in `agent-wallet.config.json`:

```json
{
  "recurring": {
    "maxPerWeekAmount": { "SOL": "0.01" }
  }
}
```

17. Restart the server and confirm an over-cap weekly SOL schedule is rejected with `recurring_exceeds_policy`.

## Expected Result

Recurring plans feel inspectable and bounded: users can see upcoming runs, pause/resume, expiry, spend estimates, occurrence history, and webhook reminders while every occurrence still returns to the wallet for approval.
