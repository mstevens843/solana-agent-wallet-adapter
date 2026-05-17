/**
 * Verifies the simulator wire end-to-end on the planner side: when a review request
 * carries `context.transactionBase64` AND the planner has a simulator set, the planner
 * pre-simulates and runs tx-gate analyzers from the resulting digest.
 *
 * Uses a stubbed simulator so the test doesn't touch the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SimulationDigest } from '@solana-agent-wallet-adapter/workflow';

import { BridgeAiPlanner } from '../aiPlanner.js';
import { resetAlternativeMeClient } from '../adapters/alternative_me/index.js';

const SYSTEM = '11111111111111111111111111111111';
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

function buildCleanSwapDigest(): SimulationDigest {
  return {
    ok: true,
    invokedPrograms: [COMPUTE, ATA, JUPITER],
    logs: [
      `Program ${COMPUTE} invoke [1]`,
      `Program ${COMPUTE} success`,
      `Program ${JUPITER} invoke [1]`,
      `Program ${SPL_TOKEN} invoke [2]`,
      'Program log: Instruction: TransferChecked',
      `Program ${SPL_TOKEN} success`,
      `Program ${SPL_TOKEN} invoke [2]`,
      'Program log: Instruction: TransferChecked',
      `Program ${SPL_TOKEN} success`,
      `Program ${JUPITER} success`,
    ],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('simulationDigest wire end-to-end', () => {
  let originalFetch: typeof fetch;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = { ...process.env };
    process.env.AGENTIC_AI_API_KEY = 'test_anthropic_key';
    process.env.AGENTIC_AI_API_FORMAT = 'anthropic';
    process.env.AGENTIC_AI_BASE_URL = 'https://api.anthropic.com';
    process.env.AGENTIC_AI_MODEL = 'claude-test';
    process.env.AGENTIC_AI_PROVIDER = 'anthropic';
    process.env.AGENTIC_AI_ALLOW_CUSTOM_BASE_URL = '1';
    resetAlternativeMeClient();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    resetAlternativeMeClient();
    vi.unstubAllGlobals();
  });

  it('runs tx_gate analyzers when context.transactionBase64 is present and simulator is wired', async () => {
    // Minimal AI response — orchestrator's tx_gate outcomes ride in evidence.policyTxGates regardless.
    const fetchStub = vi.fn(async (_input: string | URL | Request) => jsonResponse({
      id: 'msg', type: 'message', role: 'assistant',
      content: [{
        type: 'text',
        text: JSON.stringify({
          decision: 'approve',
          reason: 'Pipeline ran end-to-end.',
          summary: 'OK.',
          evidence: { findings: [] },
        }),
      }],
    }));
    vi.stubGlobal('fetch', fetchStub);

    const planner = new BridgeAiPlanner();
    // Inject a deterministic stub simulator that returns a clean-swap digest regardless of input.
    planner.simulator = async (_txBase64: string) => buildCleanSwapDigest();

    const result = await planner.reviewPlan({
      instruction: 'only executes the requested swap. no extra transfers. no unrelated instructions.',
      walletAddress: '4fTqUdd9xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      cluster: 'mainnet-beta',
      plan: {
        source: 'ai',
        category: 'trading',
        actionType: 'swap',
        templateTitle: 'Swap SOL to USDC',
        intent: 'Swap SOL to USDC',
        route: 'AI draft only.',
        risk: 'Medium.',
        approval: 'Wallet approval is required before signing or submitting.',
        parameters: { inputToken: 'SOL', outputToken: 'USDC', amount: '0.01', slippageBps: '50' },
        fields: [],
        safeguards: ['Wallet approval is required.'],
      },
      context: {
        // Caller-provided base64 tx that the simulator should consume.
        transactionBase64: 'AAA=', // dummy — stub ignores it
      },
    });

    // policyTxGates surfaces the analyzer outcomes — atom ids keyed.
    const txGates = (result.evidence as { policyTxGates?: Record<string, { pass: boolean }> }).policyTxGates;
    expect(txGates).toBeDefined();
    const passes = Object.values(txGates ?? {}).map((o) => o.pass);
    expect(passes.length).toBeGreaterThanOrEqual(3);
    expect(passes.every((p) => p === true)).toBe(true);
  });

  it('leaves tx_gate atoms unresolved when no simulator is wired', async () => {
    const fetchStub = vi.fn(async (_input: string | URL | Request) => jsonResponse({
      id: 'msg', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: JSON.stringify({ decision: 'approve', reason: 'r', summary: 's', evidence: { findings: [] } }) }],
    }));
    vi.stubGlobal('fetch', fetchStub);

    const planner = new BridgeAiPlanner();
    // No simulator set — even with transactionBase64 present, no digest is built.
    const result = await planner.reviewPlan({
      instruction: 'only executes the requested swap. no extra transfers.',
      walletAddress: '4fTqUdd9xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      cluster: 'mainnet-beta',
      plan: {
        source: 'ai', category: 'trading', actionType: 'swap',
        templateTitle: 'Swap', intent: 'Swap',
        route: 'AI draft only.', risk: 'Medium.', approval: 'Wallet approval is required.',
        parameters: { inputToken: 'SOL', outputToken: 'USDC', amount: '0.01', slippageBps: '50' },
        fields: [],
        safeguards: ['Wallet approval is required.'],
      },
      context: { transactionBase64: 'AAA=' },
    });

    const txGates = (result.evidence as { policyTxGates?: Record<string, unknown> }).policyTxGates;
    expect(txGates).toBeUndefined();
    // The atoms themselves were extracted but unresolved.
    const policyAtoms = (result.evidence as { policyAtoms?: unknown[] }).policyAtoms;
    expect(Array.isArray(policyAtoms)).toBe(true);
  });
});
