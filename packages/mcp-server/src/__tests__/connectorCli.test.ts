import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BridgeAiPlanner } from '../aiPlanner.js';

// A fake first-party CLI: records the argv it was invoked with, then prints `outputJson` to stdout
// (what codex `exec` / `gemini -p` / `claude -p` would emit as their final message).
function makeFakeBinary(outputJson: string, argvOut: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-fake-cli-'));
  const bin = join(dir, 'fake-cli.cjs');
  writeFileSync(
    bin,
    `#!/usr/bin/env node\n`
    + `const fs = require('fs');\n`
    + `fs.writeFileSync(${JSON.stringify(argvOut)}, JSON.stringify(process.argv.slice(2)));\n`
    + `process.stdout.write(${JSON.stringify(outputJson)});\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

const reviewJson = JSON.stringify({
  decision: 'approve',
  reason: 'Plan matches the request and stays under the cap.',
  summary: 'Approved by the connector.',
  evidence: { findings: [{ label: 'Amount', value: '0.01 SOL', tone: 'good' }] },
});

const planJson = JSON.stringify({
  intent: 'Send 0.01 SOL',
  route: 'System Program transfer.',
  risk: 'Medium risk.',
  approval: 'Wallet approval is separate.',
  safeguards: ['Check recipient.'],
});

const reviewRequest = {
  plan: {
    intent: 'Send 0.01 SOL if the user rule passes',
    route: '0.01 SOL to 6QcqZJBYxuwu1i6A.',
    risk: 'Medium',
    approval: 'Wallet approval required after agent review.',
    source: 'ai' as const,
    category: 'payments',
    actionType: 'transfer_sol',
    templateTitle: 'Send SOL',
    parameters: { recipient: '6QcqZJBYxuwu1i6A', amount: '0.01' },
    fields: [{ label: 'Amount', value: '0.01 SOL' }],
    safeguards: ['Confirm recipient.'],
  },
  instruction: 'No outside facts needed; just verify the draft.',
};

const planRequest = {
  prompt: 'send 0.01 SOL',
  userNotes: 'test only',
  template: {
    id: 'custom-request',
    category: 'custom',
    title: 'Custom request',
    description: 'Turn request into a plan.',
    actionType: 'custom',
    risk: 'medium',
  },
  parameters: { amount: '0.01' },
};

describe('BridgeAiPlanner connector (cli-agent) transport', () => {
  beforeEach(() => {
    vi.stubEnv('AGENTIC_AI_ATOM_LLM_FALLBACK', '0');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('runs a review through a connector CLI with a locked-down, single-shot invocation', async () => {
    const argvOut = join(mkdtempSync(join(tmpdir(), 'agentic-argv-')), 'argv.json');
    const bin = makeFakeBinary(reviewJson, argvOut);
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({ engine: 'connector', connector: 'codex', connectorPath: bin });

    const review = await planner.reviewPlan(reviewRequest);
    expect(review.decision).toBe('approve');
    expect(review.source).toBe('ai');

    // codex must be invoked headless + read-only sandbox, never with an auto-approve flag.
    const argv = JSON.parse(readFileSync(argvOut, 'utf8')) as string[];
    expect(argv).toContain('exec');
    expect(argv).toContain('--sandbox');
    expect(argv).toContain('read-only');
    expect(argv).not.toContain('--yolo');
  });

  it('runs a plan through a connector that emits a JSON envelope (gemini/claude shape)', async () => {
    const argvOut = join(mkdtempSync(join(tmpdir(), 'agentic-argv-')), 'argv.json');
    // gemini/claude print `--output-format json`; the fake prints the bare plan JSON, which the
    // extractor falls back to when there's no envelope field.
    const bin = makeFakeBinary(planJson, argvOut);
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({ engine: 'connector', connector: 'gemini', connectorPath: bin });

    const plan = await planner.generatePlan(planRequest);
    expect(plan.intent).toBe('Send 0.01 SOL');

    const argv = JSON.parse(readFileSync(argvOut, 'utf8')) as string[];
    expect(argv).toContain('-p');
    expect(argv).toContain('--output-format');
    expect(argv).toContain('json');
  });

  it('extracts Claude object-shaped { result: { content: [{ text }] } } envelopes', async () => {
    const argvOut = join(mkdtempSync(join(tmpdir(), 'agentic-argv-')), 'argv.json');
    // Claude -p --output-format json can return .result as an OBJECT with a content array
    // (not just a string) — the extractor must unwrap the nested text.
    const envelope = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: { content: [{ type: 'text', text: reviewJson }] },
    });
    const bin = makeFakeBinary(envelope, argvOut);
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({ engine: 'connector', connector: 'claude', connectorPath: bin });

    const review = await planner.reviewPlan(reviewRequest);
    expect(review.decision).toBe('approve');
  });

  it('extracts Claude { messages: [...] } wrapper envelopes', async () => {
    const argvOut = join(mkdtempSync(join(tmpdir(), 'agentic-argv-')), 'argv.json');
    const envelope = JSON.stringify({
      messages: [{ role: 'assistant', content: [{ type: 'text', text: planJson }] }],
    });
    const bin = makeFakeBinary(envelope, argvOut);
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({ engine: 'connector', connector: 'claude', connectorPath: bin });

    const plan = await planner.generatePlan(planRequest);
    expect(plan.intent).toBe('Send 0.01 SOL');
  });

  it('reports connector status without an API key', () => {
    const argvOut = join(mkdtempSync(join(tmpdir(), 'agentic-argv-')), 'argv.json');
    const bin = makeFakeBinary(reviewJson, argvOut);
    const planner = new BridgeAiPlanner();
    const status = planner.setSessionKey({ engine: 'connector', connector: 'claude', connectorPath: bin });

    expect(status.configured).toBe(true);
    expect(status.engine).toBe('connector');
    expect(status.connector).toBe('claude');
    expect(status.connectorBilling).toBe('metered-credits');
    // Auth status is detected from the host's real credential files (env-dependent); just assert it
    // resolves to a valid state. The fake binary exists, so it's never 'binary-not-found'.
    expect(['connected', 'needs-auth']).toContain(status.connectorAuthStatus);
  });

  it('rejects an unknown connector', () => {
    const planner = new BridgeAiPlanner();
    expect(() => planner.setSessionKey({ engine: 'connector', connector: 'not-a-thing' }))
      .toThrow('Unknown agent connector');
  });

  it('surfaces a clear error when the connector binary is missing', async () => {
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({ engine: 'connector', connector: 'codex', connectorPath: '/no/such/codex-binary' });
    await expect(planner.generatePlan(planRequest)).rejects.toThrow(/Codex.*not found/i);
  });
});
