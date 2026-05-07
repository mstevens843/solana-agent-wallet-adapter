# Documentation Map

This directory keeps product guides, smoke procedures, dated research, and outreach drafts separate. Start with the root [README](../README.md) for the product overview.

## Public Guides

- [Claude Desktop setup](./claude-desktop-setup.md): register and smoke the MCP server in Claude Desktop.
- [Scenario tests](./SCENARIO_TESTS.md): prompt catalog and expected behavior for wallet status, balances, payments, swaps, inbox actions, schedules, and assistant workflows.
- [Protocol spec](../spec/protocol.md): draft `SigningRequest`, `ApprovalResource`, `WalletBackend`, and MCP tool contract.
- [Standout features](../STANDOUT_FEATURES.MD): current competitive positioning and differentiation.

## Smoke Guides

- [Browser Wallet Standard smoke](./smoke/browser-wallet-standard.md): desktop browser wallet harness and demo results.
- [Android MWA mobile web smoke](./smoke/android-mwa-web.md): Android Chrome and Mobile Wallet Adapter path.
- [iOS wallet web smoke](./smoke/ios-wallet-web.md): iOS Wallet Standard host fallback plus iOS link bridge path.

## Research Notes

Research notes are dated artifacts. They preserve what was known when written and may be superseded by newer docs.

- [01 - MCP client UX](./research/01-mcp-client-ux.md)
- [02 - MCP approval prior art](./research/02-mcp-approval-prior-art.md)
- [03 - MCP streaming and notifications](./research/03-mcp-spec-streaming.md)
- [04 - Sendaifun coordination](./research/04-sendaifun-coordination.md)
- [05 - Framework signer shapes](./research/05-framework-signer-shapes.md)
- [06 - Prior-art audit](./research/06-prior-art-audit.md)

Use [Standout features](../STANDOUT_FEATURES.MD) for the current competitive stance. The 2026-05-03 prior-art audit predates the y0 and broader competitor refresh.

## Outreach

- [Sendaifun RFC draft](./outreach/sendaifun-rfc.md): public issue draft for positioning this adapter as a Solana Agent Kit community wallet backend.
