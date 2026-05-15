# `@solana-agent-wallet-adapter/a2a-agent-card`

Dev-only Google A2A (Agent-to-Agent) AgentCard schema, builder, and validator for the Agentic Solana wallet adapter. The output JSON is served at `/.well-known/agent.json` by `apps/render-web` so external A2A-compatible agents can discover this wallet's identity, capabilities, and the AP2/ACP entry points it accepts.

The builder is a pure library — no runtime dependency on `mcp-server` or any other workspace package. Consumers pass their own `capabilities` array (or extend `defaultAgenticCapabilities`).

## Usage

```ts
import {
  buildAgenticAgentCard,
  defaultAgenticCapabilities,
  validateAgentCard,
} from '@solana-agent-wallet-adapter/a2a-agent-card';

const card = buildAgenticAgentCard({
  walletAddress: '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd',
  baseUrl: 'https://agentic-signer.com',
  supportedTokens: ['USDC', 'USDT', 'SOL'],
  capabilities: defaultAgenticCapabilities,
});

const result = validateAgentCard(card);
if (!result.valid) throw new Error(result.errors.join('\n'));
```

The returned object is A2A v0.2.x-shaped (`protocolVersion`, `skills`, `capabilities` object, `defaultInputModes`/`defaultOutputModes`) plus the Agentic extension fields (`serviceEndpoint`, `supportedProtocols`, `supportedTokens`, `paymentMethods`, `walletAddress`).

## Deployment note

The public route is wired in `apps/render-web/src/cloud/agentCardRoutes.ts`. The card is cached `public, max-age=60`. A dev-gated preview at `/api/agents/card` serves the same content for browser inspection.

## See also

- Master plan: `/Users/devlegacy/.claude/plans/ok-please-plan-out-purrfect-squirrel.md` — Agent 3 contract and the surrounding Layer 1 (AP2 + ACP + Bridge) work.
- A2A spec: https://google.github.io/A2A/
