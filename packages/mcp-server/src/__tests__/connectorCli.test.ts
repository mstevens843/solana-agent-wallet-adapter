import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BridgeAiPlanner } from '../aiPlanner.js';
import { toOpenAiStrictSchema } from '../connectorCli.js';

const OPENAI_UNSUPPORTED_KEYS = [
  'maxItems', 'minItems', 'maxLength', 'minLength', 'pattern', 'format',
  'minimum', 'maximum', 'multipleOf', 'default', 'examples', 'propertyOrdering',
];

// Assert a schema satisfies OpenAI strict structured-output rules: no unsupported assertion
// keywords anywhere, every object closed (additionalProperties:false) with `required` listing ALL
// of its properties. This is the exact invariant the Codex CLI forwards as text.format.schema with
// strict:true — violating it is what caused the original 400.
function assertStrictSafe(node: unknown, path = 'root'): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => assertStrictSafe(child, `${path}[${i}]`));
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  for (const key of OPENAI_UNSUPPORTED_KEYS) {
    expect(obj, `${path} must not carry unsupported keyword ${key}`).not.toHaveProperty(key);
  }
  if (obj.properties && typeof obj.properties === 'object' && !Array.isArray(obj.properties)) {
    const keys = Object.keys(obj.properties as Record<string, unknown>);
    expect(obj.additionalProperties, `${path}.additionalProperties`).toBe(false);
    expect(new Set(obj.required as string[]), `${path}.required must list every property`).toEqual(new Set(keys));
    for (const key of keys) assertStrictSafe((obj.properties as Record<string, unknown>)[key], `${path}.${key}`);
  }
  if (obj.items !== undefined) assertStrictSafe(obj.items, `${path}[]`);
  for (const combinator of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(obj[combinator])) {
      (obj[combinator] as unknown[]).forEach((branch, i) => assertStrictSafe(branch, `${path}.${combinator}[${i}]`));
    }
  }
}

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

function makeScriptedFakeBinary(scriptBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-fake-cli-'));
  const bin = join(dir, 'fake-cli.cjs');
  writeFileSync(bin, `#!/usr/bin/env node\n${scriptBody}`);
  chmodSync(bin, 0o755);
  return bin;
}

// Pull the most recent structured `[connector] {...}` line out of a console.error spy's calls.
function lastConnectorLog(calls: unknown[][]): Record<string, unknown> {
  const line = calls
    .map((call) => String(call[0]))
    .reverse()
    .find((text) => text.startsWith('[connector]'));
  if (!line) throw new Error('no [connector] log line was emitted');
  return JSON.parse(line.slice('[connector] '.length)) as Record<string, unknown>;
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

  it('runs a native connector research pass before current-fact reviews', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentic-argv-'));
    const argvOut = join(dir, 'calls.jsonl');
    const sourceUrl = 'https://support.hellohelium.com/en/articles/7039213-all-things-helium-mobile-faq';
    const bin = makeScriptedFakeBinary(
      `const fs = require('fs');\n`
      + `const args = process.argv.slice(2);\n`
      + `fs.appendFileSync(${JSON.stringify(argvOut)}, JSON.stringify(args) + '\\n');\n`
      // Both passes now carry --output-schema (review is schema-constrained too), so distinguish the
      // research pass by its live-web-search flag instead.
      + `if (args.includes('web_search="live"')) {\n`
      + `  const schemaPath = args[args.indexOf('--output-schema') + 1];\n`
      + `  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));\n`
      + `  if (!schema.properties?.sources) process.exit(2);\n`
      + `  process.stdout.write(JSON.stringify({\n`
      + `    summary: 'Helium Mobile Air Plan costs $15/month plus taxes and fees.',\n`
      + `    findings: [{ label: 'Plan rate', value: '$15/month', tone: 'good' }],\n`
      + `    sources: [{ title: 'All Things Helium Mobile FAQ', url: ${JSON.stringify(sourceUrl)} }]\n`
      + `  }));\n`
      + `} else {\n`
      + `  const prompt = args[args.length - 1] || '';\n`
      + `  if (!prompt.includes('researchEvidence')) process.exit(3);\n`
      + `  process.stdout.write(${JSON.stringify(JSON.stringify({
            decision: 'approve',
            reason: 'The researched $15/month plan is under the $20 threshold.',
            summary: 'The current price is under the user threshold.',
            evidence: {
              research: { status: 'checked' },
              findings: [
                { label: 'Plan rate', value: '$15/month', tone: 'good' },
                { label: 'Threshold check', value: '$15/month is under $20.', tone: 'good' },
              ],
            },
          }))});\n`
      + `}\n`,
    );
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({ engine: 'connector', connector: 'codex', connectorPath: bin });

    const review = await planner.reviewPlan({
      ...reviewRequest,
      instruction: 'Check the current monthly Helium Mobile price and approve if under $20, deny if over $20.',
    });

    expect(review.decision).toBe('approve');
    expect(review.evidence.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: sourceUrl }),
    ]));
    const calls = readFileSync(argvOut, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(expect.arrayContaining([
      'exec',
      '--sandbox',
      'read-only',
      '-c',
      'web_search="live"',
      '--output-schema',
    ]));
    // The review pass is now schema-constrained too (CONNECTOR_REVIEW_SCHEMA) but never web-searches.
    expect(calls[1]).toContain('--output-schema');
    expect(calls[1]).not.toContain('web_search="live"');
  });

  it('schema-constrains the codex connector review in default mode with evidence.findings', async () => {
    // Default-mode review must carry --output-schema, and the schema must expose evidence.findings —
    // the closed-empty REVIEW_JSON_SCHEMA would have dropped it under strict sanitizing.
    const dir = mkdtempSync(join(tmpdir(), 'agentic-argv-'));
    const argvOut = join(dir, 'argv.json');
    const schemaOut = join(dir, 'schema.json'); // copied out of the connector's throwaway cwd
    const bin = makeScriptedFakeBinary(
      `const fs = require('fs');\n`
      + `const args = process.argv.slice(2);\n`
      + `fs.writeFileSync(${JSON.stringify(argvOut)}, JSON.stringify(args));\n`
      + `const i = args.indexOf('--output-schema');\n`
      + `if (i >= 0) fs.copyFileSync(args[i + 1], ${JSON.stringify(schemaOut)});\n`
      + `process.stdout.write(${JSON.stringify(reviewJson)});\n`,
    );
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({ engine: 'connector', connector: 'codex', connectorPath: bin });
    await planner.reviewPlan(reviewRequest); // instruction needs no research → single default pass

    const argv = JSON.parse(readFileSync(argvOut, 'utf8')) as string[];
    expect(argv).toContain('--output-schema');
    const schema = JSON.parse(readFileSync(schemaOut, 'utf8')) as {
      properties?: { evidence?: { properties?: Record<string, unknown> } };
    };
    expect(schema.properties?.evidence?.properties ?? {}).toHaveProperty('findings');
  });

  it('schema-constrains the codex connector plan in default mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentic-argv-'));
    const argvOut = join(dir, 'argv.json');
    const schemaOut = join(dir, 'schema.json');
    const bin = makeScriptedFakeBinary(
      `const fs = require('fs');\n`
      + `const args = process.argv.slice(2);\n`
      + `fs.writeFileSync(${JSON.stringify(argvOut)}, JSON.stringify(args));\n`
      + `const i = args.indexOf('--output-schema');\n`
      + `if (i >= 0) fs.copyFileSync(args[i + 1], ${JSON.stringify(schemaOut)});\n`
      + `process.stdout.write(${JSON.stringify(planJson)});\n`,
    );
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({ engine: 'connector', connector: 'codex', connectorPath: bin });
    const plan = await planner.generatePlan(planRequest);
    expect(plan.intent).toBe('Send 0.01 SOL');

    const argv = JSON.parse(readFileSync(argvOut, 'utf8')) as string[];
    expect(argv).toContain('--output-schema');
    const schema = JSON.parse(readFileSync(schemaOut, 'utf8')) as { properties?: Record<string, unknown> };
    expect(schema.properties ?? {}).toHaveProperty('intent');
    expect(schema.properties ?? {}).toHaveProperty('safeguards');
  });

  it('schema-constrains the claude connector review in default mode (--json-schema)', async () => {
    const argvOut = join(mkdtempSync(join(tmpdir(), 'agentic-argv-')), 'argv.json');
    const bin = makeFakeBinary(reviewJson, argvOut);
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({ engine: 'connector', connector: 'claude', connectorPath: bin });
    await planner.reviewPlan(reviewRequest);

    const argv = JSON.parse(readFileSync(argvOut, 'utf8')) as string[];
    expect(argv).toContain('--json-schema');
    // Claude takes the schema inline as JSON (not a file path).
    const schema = JSON.parse(argv[argv.indexOf('--json-schema') + 1] ?? '{}') as { properties?: Record<string, unknown> };
    expect(schema.properties ?? {}).toHaveProperty('evidence');
    // Our review rules must go through --system-prompt (authoritative), not be merged into -p.
    expect(argv).toContain('--system-prompt');
    const systemArg = argv[argv.indexOf('--system-prompt') + 1] ?? '';
    expect(systemArg).toContain('You review a Solana wallet action draft');
    const userArg = argv[argv.indexOf('-p') + 1] ?? '';
    expect(userArg).not.toContain('You review a Solana wallet action draft');
  });

  it('embeds the schema in the prompt for the gemini connector (no schema flag exists)', async () => {
    const argvOut = join(mkdtempSync(join(tmpdir(), 'agentic-argv-')), 'argv.json');
    const bin = makeFakeBinary(JSON.stringify({ response: reviewJson }), argvOut);
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({ engine: 'connector', connector: 'gemini', connectorPath: bin });
    await planner.reviewPlan(reviewRequest);

    const argv = JSON.parse(readFileSync(argvOut, 'utf8')) as string[];
    expect(argv).not.toContain('--json-schema');
    expect(argv).not.toContain('--output-schema');
    // The connector runs in a throwaway temp cwd, so --skip-trust is required or the gemini CLI exits
    // with code 55 (trusted-folders check) in headless mode.
    expect(argv).toContain('--skip-trust');
    const prompt = argv[argv.indexOf('-p') + 1] ?? '';
    expect(prompt).toContain('JSON Schema');
    expect(prompt).toContain('"decision"');
  });

  it('parses a gemini connector review even when the model wraps the JSON in markdown fences', async () => {
    // Gemini has no schema flag, so it may ignore "no fences" and wrap the object in ```json ... ```.
    // The parse chain must still recover a valid review (parsePlanJson strips fences downstream).
    const argvOut = join(mkdtempSync(join(tmpdir(), 'agentic-argv-')), 'argv.json');
    const fenced = '```json\n' + reviewJson + '\n```';
    const bin = makeFakeBinary(JSON.stringify({ response: fenced }), argvOut);
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({ engine: 'connector', connector: 'gemini', connectorPath: bin });
    const review = await planner.reviewPlan(reviewRequest);
    expect(review.decision).toBe('approve');
  });

  it('reads Claude --json-schema structured_output for plans, not the prose result', async () => {
    // Real `claude --output-format json --json-schema` envelope: the validated object is in
    // structured_output; `result` holds model prose. Reading `result` first failed isPlanJson ("not a
    // valid Agentic plan JSON"). The prose here even contains a guard-tripping claim, proving we must
    // use the structured field.
    const argvOut = join(mkdtempSync(join(tmpdir(), 'agentic-argv-')), 'argv.json');
    const envelope = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: "Here's the plan — this swap is guaranteed safe and risk-free.",
      structured_output: JSON.parse(planJson),
    });
    const bin = makeFakeBinary(envelope, argvOut);
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({ engine: 'connector', connector: 'claude', connectorPath: bin });
    const plan = await planner.generatePlan(planRequest);
    expect(plan.intent).toBe('Send 0.01 SOL');
  });

  it('reads Claude --json-schema structured_output for reviews, not the prose result', async () => {
    const argvOut = join(mkdtempSync(join(tmpdir(), 'agentic-argv-')), 'argv.json');
    const envelope = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Sure — I reviewed the draft and it looks fine overall.',
      structured_output: JSON.parse(reviewJson),
    });
    const bin = makeFakeBinary(envelope, argvOut);
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({ engine: 'connector', connector: 'claude', connectorPath: bin });
    const review = await planner.reviewPlan(reviewRequest);
    expect(review.decision).toBe('approve');
  });

  it('runs the antigravity (agy) connector as plain `-p` with a prompt-embedded schema', async () => {
    // agy 1.0.7 has no --output-format/--json-schema flag: it prints the model's plain-text response to
    // stdout (Codex-style), so the schema is embedded in the prompt and we extract raw stdout.
    const argvOut = join(mkdtempSync(join(tmpdir(), 'agentic-argv-')), 'argv.json');
    const bin = makeFakeBinary(reviewJson, argvOut);
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({ engine: 'connector', connector: 'antigravity', connectorPath: bin });
    const review = await planner.reviewPlan(reviewRequest);
    expect(review.decision).toBe('approve');

    const argv = JSON.parse(readFileSync(argvOut, 'utf8')) as string[];
    expect(argv[0]).toBe('-p');
    expect(argv).not.toContain('--output-format');
    expect(argv).not.toContain('--json-schema');
    expect(argv).not.toContain('--output-schema');
    const prompt = argv[1] ?? '';
    expect(prompt).toContain('JSON Schema');
    expect(prompt).toContain('"decision"');
  });

  it('detects an installed antigravity binary as connected (keyring auth, no credential file)', () => {
    const argvOut = join(mkdtempSync(join(tmpdir(), 'agentic-argv-')), 'argv.json');
    const bin = makeFakeBinary(reviewJson, argvOut);
    const planner = new BridgeAiPlanner();
    const status = planner.setSessionKey({ engine: 'connector', connector: 'antigravity', connectorPath: bin });
    expect(status.connector).toBe('antigravity');
    expect(status.connectorBilling).toBe('plan-included');
    // Keyring auth → a present binary is treated as connected (real auth check happens at call time).
    expect(status.connectorAuthStatus).toBe('connected');
  });

  it('keeps evidence.findings after strict-sanitizing a connector review schema', () => {
    // The closed-empty REVIEW_JSON_SCHEMA bug dropped findings; an explicit-but-optional findings
    // field must survive toOpenAiStrictSchema (as a nullable union, not removed).
    const strict = JSON.stringify(toOpenAiStrictSchema({
      type: 'object',
      additionalProperties: false,
      properties: {
        decision: { type: 'string' },
        evidence: {
          type: 'object',
          additionalProperties: false,
          properties: {
            findings: {
              type: 'array',
              items: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
            },
          },
        },
      },
      required: ['decision', 'evidence'],
    }));
    expect(strict).toContain('findings');
  });

  it('still trips the safety guard when a connector plan claims the tx is guaranteed safe', async () => {
    // Schema-constraining the OUTPUT must not weaken the guardrail: a model that DOES emit a forbidden
    // claim is still rejected.
    const argvOut = join(mkdtempSync(join(tmpdir(), 'agentic-argv-')), 'argv.json');
    const unsafePlan = JSON.stringify({
      intent: 'Send 0.01 SOL',
      route: 'This transfer is guaranteed safe and risk-free.',
      risk: 'None.',
      approval: 'Wallet approval is separate.',
      safeguards: ['Check recipient.'],
    });
    const bin = makeFakeBinary(unsafePlan, argvOut);
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({ engine: 'connector', connector: 'codex', connectorPath: bin });
    await expect(planner.generatePlan(planRequest)).rejects.toThrow(/guaranteed safe|risk-free/i);
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
    // A missing CLI is a setup/auth problem, not a transient bridge outage: map to 'unauthorized'
    // (non-recoverable) while still surfacing the real "… not found …" message verbatim.
    await expect(planner.generatePlan(planRequest)).rejects.toMatchObject({
      code: 'unauthorized',
      recoverable: false,
      message: expect.stringMatching(/Codex.*not found/i),
    });
  });

  it('maps a connector exit-code failure to a recoverable wallet_unreachable, message preserved', async () => {
    // Mirrors the real Codex 400: the CLI exits non-zero with the provider error on stderr. This
    // must surface as a transient (recoverable) error AND keep the verbatim exit detail so the user
    // sees the actual cause instead of a generic "bridge down".
    const bin = makeScriptedFakeBinary(
      `process.stderr.write('{ "param": "text.format.schema" }, "status": 400 }');\n`
      + `process.exit(1);\n`,
    );
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({ engine: 'connector', connector: 'codex', connectorPath: bin });
    await expect(planner.reviewPlan(reviewRequest)).rejects.toMatchObject({
      code: 'wallet_unreachable',
      recoverable: true,
      message: expect.stringMatching(/Codex.*exited with code 1.*text\.format\.schema/i),
    });
  });

  it('emits a deterministic [connector] log line on a successful run', async () => {
    const argvOut = join(mkdtempSync(join(tmpdir(), 'agentic-argv-')), 'argv.json');
    const bin = makeFakeBinary(reviewJson, argvOut);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Snapshot the recorded calls BEFORE mockRestore() — restore clears mock.calls.
    let calls: unknown[][] = [];
    try {
      const planner = new BridgeAiPlanner();
      planner.setSessionKey({ engine: 'connector', connector: 'codex', connectorPath: bin });
      await planner.reviewPlan(reviewRequest);
      calls = errSpy.mock.calls.map((call) => [...call]);
    } finally {
      errSpy.mockRestore();
    }
    const event = lastConnectorLog(calls);
    expect(event).toMatchObject({ phase: 'ok', connector: 'codex', mode: 'default' });
    expect(typeof event.elapsedMs).toBe('number');
  });

  it('logs a connector failure with its error code and a redacted stderr tail', async () => {
    // The CLI leaks a provider key on stderr and exits non-zero. The diagnostic log is the user-facing
    // record in the desktop Logs panel, so it must capture the failure WITHOUT the secret.
    const bin = makeScriptedFakeBinary(
      `process.stderr.write('boom: api-key sk-abcdefgh12345678 rejected by provider');\n`
      + `process.exit(1);\n`,
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let lines: string[] = [];
    try {
      const planner = new BridgeAiPlanner();
      planner.setSessionKey({ engine: 'connector', connector: 'codex', connectorPath: bin });
      await expect(planner.reviewPlan(reviewRequest)).rejects.toMatchObject({ code: 'wallet_unreachable' });
      lines = errSpy.mock.calls.map((call) => String(call[0]));
    } finally {
      errSpy.mockRestore();
    }
    const failLine = lines.find((text) => text.startsWith('[connector]') && text.includes('"phase":"fail"'));
    expect(failLine, 'expected a failing [connector] log line').toBeTruthy();
    const event = JSON.parse(failLine!.slice('[connector] '.length)) as Record<string, unknown>;
    expect(event).toMatchObject({ phase: 'fail', connector: 'codex', errorCode: 'exit' });
    // The raw secret must never reach the log; redact() rewrote it.
    expect(failLine).not.toContain('sk-abcdefgh12345678');
    expect(String(event.message)).toContain('[redacted]');
  });

  it('toOpenAiStrictSchema rewrites a lenient schema into strict-compatible form', () => {
    // Shape mirrors RESEARCH_JSON_SCHEMA: maxItems, optional fields, an enum-typed optional field.
    const lenient = {
      type: 'object',
      additionalProperties: false,
      properties: {
        summary: { type: 'string' },
        findings: {
          type: 'array',
          maxItems: 8,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: { type: 'string' },
              value: { type: 'string' },
              tone: { type: 'string', enum: ['good', 'warn', 'neutral', 'fail'] },
            },
            required: ['label', 'value'],
          },
        },
        sources: {
          type: 'array',
          maxItems: 8,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { title: { type: 'string' }, url: { type: 'string' } },
            required: ['url'],
          },
        },
        checkedAt: { type: 'string' },
      },
      required: ['summary', 'sources'],
    } as const;

    const strict = toOpenAiStrictSchema(lenient) as Record<string, unknown>;
    assertStrictSafe(strict);
    // Root now requires every property; previously-optional ones are nullable unions.
    expect(new Set(strict.required as string[])).toEqual(
      new Set(['summary', 'findings', 'sources', 'checkedAt']),
    );
    const props = strict.properties as Record<string, any>;
    expect(props.findings.type).toEqual(['array', 'null']); // was optional → nullable
    expect(props.checkedAt.type).toEqual(['string', 'null']);
    expect(props.summary.type).toBe('string'); // was required → unchanged
    // enum-typed optional field is wrapped in anyOf with a null branch.
    const tone = props.findings.items.properties.tone;
    expect(Array.isArray(tone.anyOf)).toBe(true);
    expect(tone.anyOf).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'null' })]),
    );
    // The original constant is not mutated.
    expect((lenient.properties.findings as any).maxItems).toBe(8);
  });

  it('forwards a STRICT-SAFE schema to the Codex connector for the research pass', async () => {
    // End-to-end guard for the original 400: the schema the connector actually receives via
    // --output-schema must be strict-valid (no maxItems, every object closed + fully required).
    const dir = mkdtempSync(join(tmpdir(), 'agentic-argv-'));
    const schemaOut = join(dir, 'forwarded-schema.json');
    const sourceUrl = 'https://support.hellohelium.com/en/articles/7039213-all-things-helium-mobile-faq';
    const bin = makeScriptedFakeBinary(
      `const fs = require('fs');\n`
      + `const args = process.argv.slice(2);\n`
      + `const i = args.indexOf('--output-schema');\n`
      + `if (i >= 0) {\n`
      + `  fs.writeFileSync(${JSON.stringify(schemaOut)}, fs.readFileSync(args[i + 1], 'utf8'));\n`
      + `  process.stdout.write(JSON.stringify({\n`
      + `    summary: 'Helium Mobile Air Plan costs $15/month.',\n`
      + `    findings: [{ label: 'Plan rate', value: '$15/month', tone: 'good' }],\n`
      + `    sources: [{ title: 'Helium FAQ', url: ${JSON.stringify(sourceUrl)} }]\n`
      + `  }));\n`
      + `} else {\n`
      + `  process.stdout.write(${JSON.stringify(JSON.stringify({
            decision: 'approve',
            reason: 'The researched $15/month plan is under the $20 threshold.',
            summary: 'Under the threshold.',
            evidence: { research: { status: 'checked' } },
          }))});\n`
      + `}\n`,
    );
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({ engine: 'connector', connector: 'codex', connectorPath: bin });

    await planner.reviewPlan({
      ...reviewRequest,
      instruction: 'Check the current monthly Helium Mobile price and approve if under $20, deny if over $20.',
    });

    const forwarded = JSON.parse(readFileSync(schemaOut, 'utf8'));
    assertStrictSafe(forwarded);
    expect(readFileSync(schemaOut, 'utf8')).not.toContain('maxItems');
  });
});
