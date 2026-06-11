// Agent Connector — run a user's locally-installed, subscription-authed first-party CLI as a
// single-shot inference endpoint, instead of calling a provider API with a key. The bridge owns
// this (it runs on the user's machine), so web/desktop/CLI all inherit it through /bridge/ai/*.
//
// We never touch the vendor's OAuth token — the CLI reads its own cached credentials. We only spawn
// it locked down (read-only sandbox, no auto-approve, throwaway cwd, hard timeout) and parse the
// final message. The CLI's final text is wrapped as `{ output_text }` so the existing planner
// normalizers (normalizeStrictAiPlan / normalizeStrictAiReview / aiAskFromPayload) consume it as-is.
//
// Economics differ and the UI must say so: Codex/Gemini draw from the user's subscription usage;
// Claude (re-enabled June 15 2026) draws from a separate, capped "Agent SDK" credit pool that runs
// out. See plans/you-are-taking-over-generic-wren.md.

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { accessSync, constants as fsConstants } from 'node:fs';

export type AgentConnector = 'codex' | 'gemini' | 'claude' | 'antigravity';
export const AGENT_CONNECTORS: AgentConnector[] = ['codex', 'gemini', 'claude', 'antigravity'];

export type ConnectorBilling = 'plan-included' | 'metered-credits';
export type ConnectorAuthStatus = 'connected' | 'needs-auth' | 'binary-not-found';
export type ConnectorRunMode = 'default' | 'research';

interface ConnectorRunContext {
  mode: ConnectorRunMode;
  schemaPath?: string;
  schemaJson?: string;
}

interface ConnectorSpec {
  id: AgentConnector;
  label: string;
  /** "subscription-included" vs the capped Agent-SDK credit pool (Claude). */
  billing: ConnectorBilling;
  /** One-line, plain-English billing note for the UI. */
  billingNote: string;
  /** Binary names to look for on PATH (first found wins). */
  binaryCandidates: string[];
  /** Command the user runs to sign in (shown in the manual fallback + spawned by one-click connect). */
  loginArgs: string[];
  /**
   * Build the locked-down, single-shot argv for one inference call. codex/gemini have no separate
   * system-prompt mechanism so they merge system+user internally; claude routes the system prompt to
   * its `--system-prompt` flag so our review/plan rules stay authoritative (matching the API path)
   * instead of being demoted under Claude Code's default agent prompt.
   */
  buildArgs(systemPrompt: string, userPrompt: string, context: ConnectorRunContext): string[];
  /** Pull the model's final text out of the CLI's stdout envelope. */
  extractText(stdout: string, context: ConnectorRunContext): string;
  /** Credential files that indicate the CLI is signed in (heuristic; real check is at call time). */
  authFiles: string[];
  /**
   * Some CLIs (e.g. Antigravity) store credentials in the OS keyring with no on-disk file. When true,
   * detection treats a present binary as connectable and defers the real auth check to call time.
   */
  authViaKeyring?: boolean;
}

const HOME = homedir();
const h = (...parts: string[]): string => join(HOME, ...parts);

const CONNECTOR_SPECS: Record<AgentConnector, ConnectorSpec> = {
  codex: {
    id: 'codex',
    label: 'Codex (ChatGPT plan)',
    billing: 'plan-included',
    billingNote: 'Uses your ChatGPT plan (within plan limits).',
    binaryCandidates: ['codex'],
    loginArgs: ['login'],
    // `codex exec` runs headless, streams progress to stderr, and prints only the final agent
    // message to stdout. `--sandbox read-only` + `--skip-git-repo-check` keep it from touching the
    // filesystem; research mode explicitly opts into live web search. `--output-schema` is OpenAI's
    // strict structured-output mechanism — applied in BOTH research and default (plan/review) mode so
    // the draft/review matches the API-key format instead of free-form prose.
    buildArgs: (systemPrompt, userPrompt, context) => {
      // codex `exec` takes a single prompt arg with no separate system flag, so merge as before.
      const prompt = `${systemPrompt}\n\n${userPrompt}`.trim();
      if (context.mode === 'research') {
        return [
          'exec',
          '--ephemeral',
          '--sandbox',
          'read-only',
          '--skip-git-repo-check',
          '-c',
          'web_search="live"',
          ...(context.schemaPath ? ['--output-schema', context.schemaPath] : []),
          prompt,
        ];
      }
      return [
        'exec',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        ...(context.schemaPath ? ['--output-schema', context.schemaPath] : []),
        prompt,
      ];
    },
    extractText: (stdout) => stdout.trim(),
    authFiles: [h('.codex', 'auth.json')],
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini (Google AI Pro/Ultra)',
    billing: 'plan-included',
    billingNote: 'Uses your Google AI Pro/Ultra plan.',
    binaryCandidates: ['gemini'],
    loginArgs: [],
    // Headless prompt with structured output. No `--yolo` so it never auto-approves tool calls.
    // No system-prompt flag on the gemini CLI, so merge system+user (the schema contract is already
    // embedded into userPrompt by runConnector for gemini). `--skip-trust` is required because we run
    // in a throwaway temp cwd (read-only, no file writes), which the CLI's trusted-folders check would
    // otherwise reject headless with exit code 55. Warnings ("Ripgrep…", "Skill conflict…") go to
    // stderr, so stdout stays clean JSON for extractText.
    buildArgs: (systemPrompt, userPrompt) => ['-p', `${systemPrompt}\n\n${userPrompt}`.trim(), '--output-format', 'json', '--skip-trust'],
    extractText: (stdout) => extractEnvelopeText(stdout, ['response']),
    authFiles: [h('.gemini', 'oauth_creds.json'), h('.gemini', 'google_accounts.json')],
  },
  claude: {
    id: 'claude',
    label: 'Claude (Agent-SDK credits)',
    billing: 'metered-credits',
    billingNote: 'Uses your Claude Agent-SDK credits ($20–$200/mo) — caps out, then stops.',
    binaryCandidates: ['claude'],
    loginArgs: ['login'],
    // Claude Code print mode with JSON envelope. Our review/plan rules go through `--system-prompt`
    // (replacing Claude Code's default verbose coding-agent prompt) so they stay authoritative like
    // the API path — only the user payload goes through `-p`. `--json-schema` (Anthropic's structured
    // output) applies in default (plan/review) mode too, not just research. Web tools stay
    // research-only. We deliberately avoid `--bare` (it forces ANTHROPIC_API_KEY auth and never reads
    // the subscription's OAuth/keychain creds) and `--exclude-dynamic-system-prompt-sections` (a no-op
    // once --system-prompt replaces the default).
    buildArgs: (systemPrompt, userPrompt, context) => [
      '--system-prompt',
      systemPrompt,
      '-p',
      userPrompt,
      '--output-format',
      'json',
      ...(context.schemaJson ? ['--json-schema', context.schemaJson] : []),
      ...(context.mode === 'research'
        ? ['--no-session-persistence', '--allowedTools', 'WebSearch', 'WebFetch']
        : []),
    ],
    // With --json-schema the validated object is in the envelope's `structured_output` field, while
    // `result` holds the model's prose — so prefer structured_output. Without a schema (ask/chat),
    // structured_output is absent and this falls through to `result` as before.
    extractText: (stdout) => extractEnvelopeText(stdout, ['structured_output', 'result']),
    authFiles: [h('.claude', '.credentials.json'), h('.claude.json')],
  },
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity (Google AI)',
    billing: 'plan-included',
    billingNote: 'Uses your Google AI Pro/Ultra plan via the Antigravity CLI (the Gemini CLI successor).',
    binaryCandidates: ['agy'],
    loginArgs: [], // `agy` signs in on first interactive run (Google Sign-In; creds cached in the OS keyring)
    // agy 1.0.7 has NO --output-format/--json-schema flag: `agy -p "<prompt>"` runs one non-interactive
    // turn and prints the model's plain-text response to stdout (Codex-style). So we merge system+user
    // into one prompt, embed the JSON schema in the prompt (done in runConnector, like gemini), and
    // extract raw stdout. NOTE: agy is an agent — if headless review/research needs it, add
    // '--dangerously-skip-permissions' / '--sandbox' here (confirm via a smoke once authenticated).
    buildArgs: (systemPrompt, userPrompt) => ['-p', `${systemPrompt}\n\n${userPrompt}`.trim()],
    extractText: (stdout) => stdout.trim(),
    authFiles: [],
    authViaKeyring: true,
  },
};

const DEFAULT_CONNECTOR_TIMEOUT_MS = 120_000;

function connectorTimeoutMs(override?: number): number {
  if (typeof override === 'number' && override > 0) return override;
  const fromEnv = Number(process.env.AGENTIC_AI_CONNECTOR_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_CONNECTOR_TIMEOUT_MS;
}

export function isAgentConnector(value: unknown): value is AgentConnector {
  return typeof value === 'string' && (AGENT_CONNECTORS as string[]).includes(value);
}

export function normalizeAgentConnector(value: string | undefined): AgentConnector | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (normalized === 'codex' || normalized === 'openai' || normalized === 'chatgpt') return 'codex';
  if (normalized === 'gemini' || normalized === 'google') return 'gemini';
  if (normalized === 'claude' || normalized === 'anthropic') return 'claude';
  if (normalized === 'antigravity' || normalized === 'agy') return 'antigravity';
  return null;
}

export function connectorLabel(connector: AgentConnector): string {
  return CONNECTOR_SPECS[connector].label;
}

export function connectorBilling(connector: AgentConnector): ConnectorBilling {
  return CONNECTOR_SPECS[connector].billing;
}

export function connectorBillingNote(connector: AgentConnector): string {
  return CONNECTOR_SPECS[connector].billingNote;
}

export function connectorLoginCommand(connector: AgentConnector, binaryPath?: string): string {
  const spec = CONNECTOR_SPECS[connector];
  const bin = binaryPath?.trim() || spec.binaryCandidates[0]!;
  return [bin, ...spec.loginArgs].join(' ').trim();
}

/** Resolve the connector binary from an explicit path or by scanning PATH. Returns null if absent. */
export function resolveConnectorBinary(connector: AgentConnector, explicitPath?: string): string | null {
  const trimmed = explicitPath?.trim();
  if (trimmed) return isExecutable(trimmed) ? trimmed : null;
  const spec = CONNECTOR_SPECS[connector];
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  // On Windows the binaries are codex.cmd / gemini.cmd / claude.cmd (or .exe) — try those suffixes.
  const suffixes = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : [''];
  for (const name of spec.binaryCandidates) {
    for (const dir of pathDirs) {
      for (const suffix of suffixes) {
        const candidate = join(dir, `${name}${suffix}`);
        if (isExecutable(candidate)) return candidate;
      }
    }
  }
  return null;
}

export interface ConnectorDetection {
  connector: AgentConnector;
  label: string;
  billing: ConnectorBilling;
  billingNote: string;
  binaryPath: string | null;
  authStatus: ConnectorAuthStatus;
  loginCommand: string;
}

/**
 * Detect whether the connector is installed and (heuristically) signed in. Auth detection checks for
 * the CLI's cached-credential files; the authoritative check is the actual invocation, which surfaces
 * an auth error if needed.
 */
export function detectConnector(connector: AgentConnector, explicitPath?: string): ConnectorDetection {
  const spec = CONNECTOR_SPECS[connector];
  const binaryPath = resolveConnectorBinary(connector, explicitPath);
  let authStatus: ConnectorAuthStatus;
  if (!binaryPath) {
    authStatus = 'binary-not-found';
  } else if (spec.authViaKeyring) {
    // Keyring-based auth (e.g. Antigravity) leaves no credential file to check — treat a present
    // binary as connectable; the authoritative auth check happens at call time (surfaces an auth error).
    authStatus = 'connected';
  } else {
    authStatus = spec.authFiles.some((file) => fileExists(file)) ? 'connected' : 'needs-auth';
  }
  return {
    connector,
    label: spec.label,
    billing: spec.billing,
    billingNote: spec.billingNote,
    binaryPath,
    authStatus,
    loginCommand: connectorLoginCommand(connector, binaryPath ?? explicitPath),
  };
}

export interface ConnectorLoginLaunch {
  launched: boolean;
  command: string;
  /** Present when we couldn't auto-launch — the UI shows it as the manual instruction. */
  manualHint?: string;
}

/**
 * One-click connect: spawn the vendor CLI's own login (detached, so it can open the user's browser
 * locally — the bridge runs on the user's machine). Falls back to a manual instruction when the
 * binary is missing or the connector has no dedicated login subcommand (Gemini signs in on first run).
 * After this, the client polls /bridge/ai/status until authStatus flips to 'connected'.
 */
export function launchConnectorLogin(connector: AgentConnector, explicitPath?: string): ConnectorLoginLaunch {
  const spec = CONNECTOR_SPECS[connector];
  const binaryPath = resolveConnectorBinary(connector, explicitPath);
  const command = connectorLoginCommand(connector, binaryPath ?? explicitPath);
  if (!binaryPath) {
    return { launched: false, command, manualHint: `Install ${spec.label} and run \`${command}\`, then click Recheck.` };
  }
  if (spec.loginArgs.length === 0) {
    return {
      launched: false,
      command: binaryPath,
      manualHint: `Run \`${binaryPath}\` once interactively to sign in, then click Recheck.`,
    };
  }
  try {
    // Detached + stdio ignored so a daemonized bridge never blocks on the child; the login still
    // opens the user's browser via the OS.
    const child = spawn(binaryPath, spec.loginArgs, { stdio: 'ignore', detached: true });
    child.unref();
    return { launched: true, command };
  } catch (err) {
    return {
      launched: false,
      command,
      manualHint: `Couldn't launch sign-in (${redact(err instanceof Error ? err.message : String(err))}). Run \`${command}\` manually, then click Recheck.`,
    };
  }
}

export class ConnectorError extends Error {
  constructor(message: string, readonly code: 'binary-not-found' | 'spawn-failed' | 'timeout' | 'exit' | 'empty') {
    super(message);
    this.name = 'ConnectorError';
  }
}

export interface RunConnectorOptions {
  systemPrompt: string;
  userPrompt: string;
  explicitPath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  mode?: ConnectorRunMode;
  outputSchema?: unknown;
}

/**
 * Run one locked-down inference through the connector CLI and return the model's final text.
 * Passes the system + user prompt to the connector spec's buildArgs (codex/gemini merge them into one
 * prompt; claude routes the system prompt to --system-prompt so our rules stay authoritative). Runs in
 * a throwaway cwd and strips the bridge's own AI secrets from the child env (the CLI uses its own creds).
 */
export async function runConnector(connector: AgentConnector, options: RunConnectorOptions): Promise<string> {
  const spec = CONNECTOR_SPECS[connector];
  const mode = options.mode ?? 'default';
  // Deterministic, secret-safe lifecycle logging: one line on success, one on failure (covering
  // binary-not-found / spawn-failed / timeout / exit / empty), so a connector review that fails for
  // ANY reason leaves a precise record in the desktop Logs panel — not the generic "bridge offline".
  const startedAt = Date.now();
  let cwd: string | undefined;
  try {
    const binaryPath = resolveConnectorBinary(connector, options.explicitPath);
    if (!binaryPath) {
      throw new ConnectorError(
        `${spec.label} CLI not found. Install it and run \`${connectorLoginCommand(connector, options.explicitPath)}\`, then reconnect.`,
        'binary-not-found',
      );
    }
    // Keep system and user separate so claude can route the system prompt to --system-prompt;
    // codex/gemini re-merge them inside their own buildArgs.
    let userPrompt = options.userPrompt;
    cwd = await mkdtemp(join(tmpdir(), 'agentic-connector-'));
    // Forward a strict-safe schema to the connector CLIs (Codex --output-schema / Claude
    // --json-schema); they relay it to the provider with strict:true, which rejects our lenient
    // research schema (maxItems / optional fields) with an HTTP 400 on text.format.schema.
    const strictSchema = options.outputSchema ? toOpenAiStrictSchema(options.outputSchema) : undefined;
    const schemaJson = strictSchema ? JSON.stringify(strictSchema) : undefined;
    const schemaPath = schemaJson ? join(cwd, 'output-schema.json') : undefined;
    if (schemaPath && schemaJson) {
      await writeFile(schemaPath, schemaJson, 'utf8');
    }
    // Gemini's CLI exposes no schema flag (unlike Codex --output-schema / Claude --json-schema), so
    // embed the strict schema in the prompt to coax structured output that matches the API-key format.
    // Gemini follows instructions less strictly than a native schema, so be emphatic. parsePlanJson
    // still strips fences downstream as a safety net, but a clean bare object is what we want.
    if ((connector === 'gemini' || connector === 'antigravity') && schemaJson) {
      userPrompt = `${userPrompt}\n\nOUTPUT CONTRACT: Respond with EXACTLY ONE JSON object and nothing else — no explanation, no preamble, and do NOT wrap it in markdown code fences. The object MUST validate against this JSON Schema:\n${schemaJson}`;
    }
    const context: ConnectorRunContext = {
      mode,
      ...(schemaPath ? { schemaPath } : {}),
      ...(schemaJson ? { schemaJson } : {}),
    };
    const args = spec.buildArgs(options.systemPrompt, userPrompt, context);
    const stdout = await spawnCollect(binaryPath, args, {
      cwd,
      env: sanitizedEnv(),
      timeoutMs: connectorTimeoutMs(options.timeoutMs),
      signal: options.signal,
      label: spec.label,
    });
    const text = spec.extractText(stdout, context).trim();
    if (!text) {
      throw new ConnectorError(`${spec.label} returned an empty response.`, 'empty');
    }
    logConnectorEvent({ phase: 'ok', connector, mode, elapsedMs: Date.now() - startedAt, bytes: stdout.length });
    return text;
  } catch (err) {
    logConnectorEvent({
      phase: 'fail',
      connector,
      mode,
      elapsedMs: Date.now() - startedAt,
      errorCode: err instanceof ConnectorError ? err.code : 'unknown',
      // Connector error messages already redact their stderr tail; redact again defensively.
      message: redact(err instanceof Error ? err.message : String(err)),
    });
    throw err;
  } finally {
    if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

// --- internals -------------------------------------------------------------------------------

function spawnCollect(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal; label: string },
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Arg array, never a shell string — no shell injection from prompt content.
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      fn();
    };
    const kill = () => {
      child.kill('SIGTERM');
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 2_000).unref?.();
    };
    const onAbort = () => { kill(); finish(() => reject(new ConnectorError(`${opts.label} request aborted.`, 'timeout'))); };
    const timer = setTimeout(() => {
      kill();
      finish(() => reject(new ConnectorError(`${opts.label} timed out after ${Math.round(opts.timeoutMs / 1000)}s.`, 'timeout')));
    }, opts.timeoutMs);
    timer.unref?.();
    if (opts.signal) {
      if (opts.signal.aborted) { onAbort(); return; }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      finish(() => reject(new ConnectorError(
        code === 'ENOENT'
          ? `${opts.label} CLI could not be launched (not found).`
          : `${opts.label} CLI failed to start: ${redact(err.message)}`,
        'spawn-failed',
      )));
    });
    child.on('close', (codeNum) => {
      if (codeNum === 0) { finish(() => resolve(stdout)); return; }
      const detail = redact((stderr || stdout).trim().split('\n').slice(-4).join(' ')).slice(0, 400);
      finish(() => reject(new ConnectorError(
        `${opts.label} exited with code ${codeNum ?? 'unknown'}${detail ? `: ${detail}` : ''}`,
        'exit',
      )));
    });
  });
}

// OpenAI's Responses API rejects (status 400, param=text.format.schema) any structured-output
// schema that isn't "strict-safe": it forbids assertion keywords like maxItems/minItems, requires
// `additionalProperties:false` on every object, and requires EVERY declared property to appear in
// `required`. The Codex CLI's `--output-schema` (and Claude's `--json-schema`) forward our schema
// with `strict:true`, so a lenient schema (e.g. RESEARCH_JSON_SCHEMA, which uses maxItems and leaves
// fields optional) blows up there even though our own API-key path sends it with `strict:false`.
// This sanitizer rewrites any schema into the strict-compatible form at the single point where the
// connector serializes it. Pure: clones, never mutates the (often `as const`) input. NOTE: $ref /
// definitions are not resolved — no connector schema uses them today; add resolution before passing
// a ref-bearing schema through here.
const OPENAI_UNSUPPORTED_SCHEMA_KEYS = new Set([
  'maxItems', 'minItems', 'maxLength', 'minLength', 'pattern', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'default', 'examples', 'propertyOrdering',
]);

export function toOpenAiStrictSchema(schema: unknown): unknown {
  return sanitizeStrictNode(schema);
}

function sanitizeStrictNode(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(sanitizeStrictNode);
  if (!input || typeof input !== 'object') return input;
  const node = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (OPENAI_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    out[key] = value;
  }
  for (const combinator of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(out[combinator])) {
      out[combinator] = (out[combinator] as unknown[]).map(sanitizeStrictNode);
    }
  }
  if (out.items !== undefined) out.items = sanitizeStrictNode(out.items);
  const props = out.properties;
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    const originalRequired = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
    const keys = Object.keys(props as Record<string, unknown>);
    const sanitizedProps: Record<string, unknown> = {};
    for (const key of keys) {
      let child = sanitizeStrictNode((props as Record<string, unknown>)[key]);
      // Strict mode requires every property in `required`; widen the previously-optional ones to a
      // nullable union so the model can still legally emit null instead of a value.
      if (!originalRequired.has(key)) child = makeNullableSchema(child);
      sanitizedProps[key] = child;
    }
    out.properties = sanitizedProps;
    out.required = keys;
    out.additionalProperties = false;
  }
  return out;
}

function makeNullableSchema(node: unknown): unknown {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  const n = node as Record<string, unknown>;
  // enum / combinator nodes can't simply add "null" to a type field — wrap them in anyOf instead.
  if (n.enum !== undefined || n.anyOf !== undefined || n.oneOf !== undefined || n.allOf !== undefined) {
    return { anyOf: [n, { type: 'null' }] };
  }
  if (typeof n.type === 'string') return { ...n, type: [n.type, 'null'] };
  if (Array.isArray(n.type)) {
    return (n.type as unknown[]).includes('null') ? n : { ...n, type: [...(n.type as unknown[]), 'null'] };
  }
  return { anyOf: [n, { type: 'null' }] };
}

/** The connector uses its own cached creds — strip the bridge's AI/wallet secrets from the child. */
function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    // Strip the bridge's own AI key + any wallet/seed/secret-ish var. Keep the vendor CLI's own
    // creds (CODEX_*/GEMINI_*/CLAUDE_*/ANTHROPIC_*) and PATH/HOME so it can authenticate and run.
    if (/^AGENTIC_AI_API_KEY$/i.test(key)
      || /SEED|MNEMONIC|PRIVATE|PHRASE|SECRET|PASSWORD|KEYPAIR|IDENTITY/i.test(key)) {
      delete env[key];
    }
  }
  return env;
}

// Pull the model's final text from a CLI JSON envelope, tolerating both string and structured shapes.
// Gemini: { response: "<text>" }. Claude: { result: "<text>" } OR { result: { content:[{text}] } } OR
// a { messages:[{content:[{text}]}], ... } wrapper. Falls back to raw stdout (text mode / plain final
// message) so a slightly-different shape degrades to the normalizer's tolerant JSON parsing.
function extractEnvelopeText(stdout: string, fields: string[]): string {
  const trimmed = stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  if (!parsed || typeof parsed !== 'object') return trimmed;
  const record = parsed as Record<string, unknown>;
  for (const field of fields) {
    const text = coerceEnvelopeText(record[field]);
    if (text) return text;
  }
  const messages = record.messages;
  if (Array.isArray(messages) && messages.length > 0) {
    const last = messages[messages.length - 1] as Record<string, unknown> | undefined;
    const text = coerceEnvelopeText(last?.content);
    if (text) return text;
  }
  return trimmed;
}

// Coerce string | { text } | { content } | [{ text }] (recursively) into its text, else ''.
function coerceEnvelopeText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map((entry) => coerceEnvelopeText(entry)).filter(Boolean).join('\n').trim();
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text.trim();
    if (record.content !== undefined) return coerceEnvelopeText(record.content);
    try {
      return JSON.stringify(record);
    } catch {
      return '';
    }
  }
  return '';
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function fileExists(path: string): boolean {
  try {
    accessSync(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function redact(message: string): string {
  return message
    .replace(/\b(sk|pk|sr|rk)-[A-Za-z0-9_-]{8,}\b/g, '$1-[redacted]')
    .replace(/((?:api[_-]?key|authorization|bearer|token)["'\s:=]+)\S+/gi, '$1[redacted]');
}

// Always-on, secret-safe connector lifecycle log. Emitted to stderr so the desktop shell's log
// reader surfaces it in the Logs panel without any flag — trace() can't, because it's gated behind
// AGENT_WALLET_TRACE, which the desktop bridge subprocess never sets. Only `message` is free text and
// callers pass it through redact(); the rest (connector, mode, code, timings) is non-secret.
function logConnectorEvent(event: {
  phase: 'ok' | 'fail';
  connector: AgentConnector;
  mode: ConnectorRunMode;
  elapsedMs: number;
  bytes?: number;
  errorCode?: string;
  message?: string;
}): void {
  try {
    console.error(`[connector] ${JSON.stringify({ ts: new Date().toISOString(), ...event })}`);
  } catch {
    // Logging must never affect the connector result.
  }
}
