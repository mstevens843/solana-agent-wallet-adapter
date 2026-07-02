# Public Redaction Plan

The repo is Apache-2.0 and public, so public docs should help adoption without handing every strategic angle to a fast cloner.

## Public-Safe Now

Good to publish:

- Agentic is a Solana wallet approval workspace for AI agents.
- Agents prepare, wallets sign.
- Existing wallets stay the signing boundary.
- Chat can answer wallet/token/market questions and prepare actions.
- Approval Inbox exists.
- Cloud, browser workflow, and private local mode exist.
- MCP, CLI, desktop, Android, iOS, Vercel AI, and Solana Agent Kit integrations exist.
- Connectors read facts and prepare wallet-approval actions.
- Evidence receipts and proofs exist.
- Recurring schedules return due items to approval.
- AI drafts and reviews; it does not sign.
- Deterministic gates can block unsupported approvals.

## Public But High-Level

Mention carefully:

- policy atoms
- evidence gates
- post-AI validator
- decision receipts
- connector risk profiles
- chat tool categories
- policy enrichment
- AP2/ACP/MPP support
- streaming sessions
- skills/signals

Do not include full internal flowcharts, exhaustive endpoint lists, or strategic mappings in the first public refresh.

## Keep Private For Now

Keep out of public docs:

- the full "generic enterprise decision system" pitch
- SKU/pricing/quote mapping unless needed for a private conversation
- detailed moat language
- all planned roadmap surfaces
- exact implementation playbook for every connector and gate
- any unverified or release-gated capability as if it is generally available
- operational details that help someone clone the hosted service quickly

## Historical Docs

Mark or relocate stale docs:

- `plans/AGENTIC_RELEASE_PLAN.md`
- `plans/STATUS.md`
- old static Render claims
- missing root `README.md` and `STANDOUT_FEATURES.MD` references

Preferred public approach:

- `plans/` becomes historical coordination notes.
- Root README becomes current product truth.
- `docs/README.md` becomes current documentation map.

## Trademark And Branding

Consider adding a brand/trademark policy before a major public refresh:

- Apache-2.0 permits forks and commercial reuse.
- Brand policy can prevent forks from representing themselves as Agentic.
- Protect domain, app store listings, npm package names, release assets, and official hosted service language.

## Open-Core Option

If cloning risk becomes unacceptable:

- keep core SDKs, WalletBackend, MCP basics, and connector specs open
- move app/cloud/private strategy code into a private repo going forward
- keep public docs focused on integration and trust boundary
- keep the richer product docs private

## Suggested First Public README Tone

Use:

> Agentic lets AI agents prepare Solana wallet actions while the user's existing wallet remains the signing boundary.

Avoid:

> Agentic is a complete cross-domain AI decision platform for enterprise quote, pricing, compliance, and finance workflows.

The second sentence may be true strategically, but it is better as private positioning until distribution, brand, and product moat are stronger.

