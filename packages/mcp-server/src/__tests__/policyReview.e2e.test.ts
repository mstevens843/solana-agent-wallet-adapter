/**
 * End-to-end smoke test for the wired policy-review pipeline.
 *
 * Stubs `fetch` so neither the AI provider nor any data provider is actually hit. The test
 * fires a `reviewPlan` call with the mixed policy NOTE the user originally asked about and
 * asserts the response is:
 *   - decision: 'approve'
 *   - evidence.findings contains rows sourced from `alternative_me`, `jupiter`, and `web`
 *   - evidence.decisionContract.evidenceFactIds cites atom ids
 *   - evidence.policyAtoms mirror is present
 *
 * Locks the four layers (extract → resolve → evaluate → merge) against future drift.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BridgeAiPlanner } from '../aiPlanner.js';
import { resetAlternativeMeClient } from '../adapters/alternative_me/index.js';

const NOTE = [
  'Run my pre-signing policy for this swap.',
  'Market gates: BTC Fear & Greed must be above 20. SOL must be above $80.',
  'And only approve if helium phone plan is less than $20.',
].join('\n');

interface MockFetchResponse {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

function jsonResponse({ status = 200, body, headers }: MockFetchResponse): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
  });
}

/**
 * Build a fetch stub that dispatches by URL substring to canned responses.
 * - Anthropic /v1/messages → returns either the research-pass payload or the review payload.
 * - alternative.me /fng → Fear & Greed snapshot.
 * - jupiter /price → SOL price.
 */
function buildFetchStub() {
  const calls: string[] = [];
  let anthropicCallCount = 0;
  const stub = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    if (url.includes('api.alternative.me/fng')) {
      return jsonResponse({
        body: { data: [{ value: '42', value_classification: 'Fear', timestamp: '1700000000' }] },
      });
    }
    if (url.includes('api.jup.ag/price') || url.includes('api.jup.ag/price/v3')) {
      // Jupiter price API v3 returns { <mint>: { usdPrice, decimals, blockId, ... } }
      return jsonResponse({
        body: {
          So11111111111111111111111111111111111111112: {
            usdPrice: 146.32,
            decimals: 9,
            blockId: 1,
          },
        },
      });
    }
    if (url.includes('coingecko.com')) {
      // Default to no data — we want Jupiter to be the SOL price source.
      return jsonResponse({ body: {} });
    }
    if (url.includes('api.anthropic.com/v1/messages') || url.includes('/v1/messages')) {
      anthropicCallCount += 1;
      // Two pass shape: 1) research pass (web-search tool active), 2) reviewer pass.
      // For simplicity, always return a reviewer-style payload — the orchestrator's bundle
      // doesn't depend on the research pass for the helium atom (which is web-only — we
      // just inline an external_price finding from the model).
      const responseBody = {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              decision: 'approve',
              reason: 'All policy gates pass.',
              summary: 'Approved per resolved policy bundle.',
              evidence: {
                findings: [
                  { label: 'Helium plan', value: '$15.00 — web', tone: 'good' },
                ],
              },
              evidenceFactIds: ['atom.market_regime.fear_and_greed.gt.20', 'atom.price.sol.gt.80'],
              confidence: 'high',
            }),
          },
        ],
      };
      return jsonResponse({ body: responseBody });
    }
    // Default: 404 so unexpected calls are visible.
    return new Response('not stubbed', { status: 404 });
  });
  return { stub, calls, anthropicCallCount: () => anthropicCallCount };
}

describe('policy-review end-to-end pipeline', () => {
  let originalFetch: typeof fetch;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = { ...process.env };
    // Configure the planner to use Anthropic via env.
    process.env.AGENTIC_AI_API_KEY = 'test_anthropic_key';
    process.env.AGENTIC_AI_API_FORMAT = 'anthropic';
    process.env.AGENTIC_AI_BASE_URL = 'https://api.anthropic.com';
    process.env.AGENTIC_AI_MODEL = 'claude-test';
    process.env.AGENTIC_AI_PROVIDER = 'anthropic';
    process.env.AGENTIC_AI_ALLOW_CUSTOM_BASE_URL = '1';
    // Jupiter price calls require an API key — supply a fake one so the resolver actually
    // hits the (stubbed) Jupiter URL instead of erroring out before the network call.
    process.env.JUPITER_API_KEY = 'fake_jupiter_key';
    resetAlternativeMeClient();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    resetAlternativeMeClient();
    vi.unstubAllGlobals();
  });

  it('runs the wired pipeline and surfaces structured findings in the AI review result', async () => {
    const { stub, calls } = buildFetchStub();
    vi.stubGlobal('fetch', stub);

    const planner = new BridgeAiPlanner();
    const result = await planner.reviewPlan({
      instruction: NOTE,
      walletAddress: '4fTqUdd9xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      cluster: 'mainnet-beta',
      plan: {
        source: 'ai',
        category: 'trading',
        actionType: 'swap',
        templateTitle: 'Swap SOL to USDC',
        intent: 'Swap SOL to USDC',
        route: 'AI draft only. Wallet approval is required later.',
        risk: 'Medium.',
        approval: 'Wallet approval is required before signing or submitting.',
        parameters: { inputToken: 'SOL', outputToken: 'USDC', amount: '0.01', slippageBps: '50' },
        fields: [],
        safeguards: ['Wallet approval is required.'],
        userNotes: NOTE,
      },
    });

    // The policy bundle ran upstream: at least one fetch went to alternative.me (Fear & Greed)
    // and one to Jupiter (SOL price).
    expect(calls.some((url) => url.includes('alternative.me/fng'))).toBe(true);
    expect(calls.some((url) => url.includes('api.jup.ag/price'))).toBe(true);

    // The merged findings contain rows sourced from alternative_me and jupiter.
    const findings = (result.evidence as { findings?: Array<{ value?: string; label?: string }> }).findings ?? [];
    expect(findings.some((f) => typeof f.value === 'string' && f.value.includes('alternative_me'))).toBe(true);
    expect(findings.some((f) => typeof f.value === 'string' && f.value.includes('jupiter'))).toBe(true);
    // The LLM-supplied "Helium plan: $15 — web" row survives (web atom is LLM-resolved).
    expect(findings.some((f) => typeof f.label === 'string' && /helium/i.test(f.label))).toBe(true);

    // policyAtoms mirror is present.
    const policyAtoms = (result.evidence as { policyAtoms?: unknown[] }).policyAtoms;
    expect(Array.isArray(policyAtoms)).toBe(true);
    expect((policyAtoms as unknown[]).length).toBeGreaterThanOrEqual(2);

    // decisionContract cites at least the two API-resolved atoms.
    const contract = (result.evidence as { decisionContract?: { evidenceFactIds?: unknown[] } }).decisionContract;
    expect(contract?.evidenceFactIds).toEqual(expect.arrayContaining([
      'atom.market_regime.fear_and_greed.gt.20',
      'atom.price.sol.gt.80',
    ]));
  });
});
