import type { AgenticCapability } from './schema.js';

/**
 * Baseline capability catalog for the Agentic wallet adapter. Curated to cover
 * wallet primitives, common DeFi entry points, and protocol surfaces (AP2,
 * ACP, A2A). Consumers may pass this directly or extend with custom skills.
 *
 * No runtime dependency on `mcp-server` by design — keeping the package pure
 * lets it ship alongside the public AgentCard route without dragging in the
 * full connector graph.
 */
export const defaultAgenticCapabilities: AgenticCapability[] = [
  {
    id: 'wallet.sign_message',
    name: 'Sign Message',
    description:
      'Sign an arbitrary UTF-8 or byte message with the connected Solana wallet. Requires user approval — never auto-signs.',
    tags: ['wallet', 'signing'],
    examples: ['Sign the string "Hello, A2A" and return the base58 signature.'],
  },
  {
    id: 'wallet.sign_transaction',
    name: 'Sign Transaction',
    description:
      'Sign a base64-encoded Solana transaction. Reviewed in the wallet UI before signing. Never auto-signs.',
    tags: ['wallet', 'signing', 'transaction'],
  },
  {
    id: 'wallet.transfer_sol',
    name: 'Transfer SOL',
    description:
      'Prepare a native SOL transfer to a base58 recipient. Surfaces as a wallet approval card; user signs.',
    tags: ['wallet', 'transfer', 'sol'],
    examples: ['Send 0.1 SOL to 4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd'],
  },
  {
    id: 'wallet.transfer_spl',
    name: 'Transfer SPL Token',
    description:
      'Prepare an SPL token transfer (USDC, USDT, or any whitelisted mint). Surfaces as a wallet approval card; user signs.',
    tags: ['wallet', 'transfer', 'spl', 'token'],
    examples: ['Send 25 USDC to merchant address X.'],
  },
  {
    id: 'wallet.read_balances',
    name: 'Read Balances',
    description: 'Return the wallet’s SOL and SPL token balances. Read-only; no user prompt.',
    tags: ['wallet', 'read', 'balances'],
  },
  {
    id: 'wallet.read_history',
    name: 'Read Transaction History',
    description: 'Return recent transaction history for the wallet via Helius. Read-only; no user prompt.',
    tags: ['wallet', 'read', 'history'],
  },
  {
    id: 'defi.swap',
    name: 'Swap (Jupiter)',
    description: 'Get a Jupiter quote and prepare a token swap. Surfaces as a wallet approval card.',
    tags: ['defi', 'swap', 'jupiter'],
    examples: ['Quote a swap from 1 SOL to USDC.'],
  },
  {
    id: 'defi.lend_deposit',
    name: 'Lend / Deposit',
    description:
      'Prepare a lending deposit into Jupiter Lend, MarginFi, Kamino, or other supported connectors. User approves in wallet.',
    tags: ['defi', 'lend', 'deposit'],
  },
  {
    id: 'defi.settle_route',
    name: 'Quote Settlement Route',
    description:
      'Quote an optimal settlement route across Jupiter / Wormhole / Sanctum for a fiat-denominated payment. Read-only; no user prompt.',
    tags: ['defi', 'bridge', 'settlement', 'routing'],
    inputModes: ['application/json'],
    outputModes: ['application/json'],
  },
  {
    id: 'protocol.ap2_inbound',
    name: 'Accept AP2 Mandate',
    description:
      'Receive an Agent Payments Protocol (AP2) IntentMandate or PaymentMandate from another agent. Mandates are verified and surfaced as wallet approval cards — never auto-signed.',
    tags: ['ap2', 'payments', 'inbound', 'protocol'],
    inputModes: ['application/json'],
    outputModes: ['application/json'],
  },
  {
    id: 'protocol.acp_outbound',
    name: 'Pay ACP Cart',
    description:
      'Parse a merchant Agent Checkout Protocol (ACP) cart and prepare an SPL transfer to the merchant. User reviews line items and approves.',
    tags: ['acp', 'checkout', 'outbound', 'protocol'],
    inputModes: ['application/json'],
    outputModes: ['application/json'],
  },
  {
    id: 'protocol.agent_card',
    name: 'AgentCard Discovery',
    description:
      'Serve this AgentCard at /.well-known/agent.json so other A2A-compatible agents can discover the wallet’s capabilities.',
    tags: ['a2a', 'discovery', 'protocol'],
    outputModes: ['application/json'],
  },
  {
    id: 'wallet.receipt_export',
    name: 'Export Receipts',
    description: 'Export signed receipts (proof-of-action) for completed approvals as portable JSON.',
    tags: ['wallet', 'receipt', 'evidence'],
  },
];
