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

export type AgentConnector = 'codex' | 'gemini' | 'claude';
export const AGENT_CONNECTORS: AgentConnector[] = ['codex', 'gemini', 'claude'];

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
  /** Build the locked-down, single-shot argv for one inference call. */
  buildArgs(prompt: string, context: ConnectorRunContext): string[];
  /** Pull the model's final text out of the CLI's stdout envelope. */
  extractText(stdout: string, context: ConnectorRunContext): string;
  /** Credential files that indicate the CLI is signed in (heuristic; real check is at call time). */
  authFiles: string[];
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
    // filesystem; research mode explicitly opts into live web search.
    buildArgs: (prompt, context) => {
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
      return ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', prompt];
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
    buildArgs: (prompt) => ['-p', prompt, '--output-format', 'json'],
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
    // Claude Code print mode with JSON envelope.
    buildArgs: (prompt, context) => [
      '-p',
      prompt,
      '--output-format',
      'json',
      ...(context.mode === 'research'
        ? [
            '--no-session-persistence',
            '--allowedTools',
            'WebSearch',
            'WebFetch',
            ...(context.schemaJson ? ['--json-schema', context.schemaJson] : []),
          ]
        : []),
    ],
    extractText: (stdout) => extractEnvelopeText(stdout, ['result', 'structured_output']),
    authFiles: [h('.claude', '.credentials.json'), h('.claude.json')],
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
 * Combines system+user into a single prompt (these CLIs take one prompt), runs in a throwaway cwd,
 * and strips the bridge's own AI secrets from the child env (the CLI uses its own cached creds).
 */
export async function runConnector(connector: AgentConnector, options: RunConnectorOptions): Promise<string> {
  const spec = CONNECTOR_SPECS[connector];
  const binaryPath = resolveConnectorBinary(connector, options.explicitPath);
  if (!binaryPath) {
    throw new ConnectorError(
      `${spec.label} CLI not found. Install it and run \`${connectorLoginCommand(connector, options.explicitPath)}\`, then reconnect.`,
      'binary-not-found',
    );
  }
  const prompt = `${options.systemPrompt}\n\n${options.userPrompt}`.trim();
  const cwd = await mkdtemp(join(tmpdir(), 'agentic-connector-'));
  try {
    const mode = options.mode ?? 'default';
    const schemaJson = options.outputSchema ? JSON.stringify(options.outputSchema) : undefined;
    const schemaPath = schemaJson ? join(cwd, 'output-schema.json') : undefined;
    if (schemaPath && schemaJson) {
      await writeFile(schemaPath, schemaJson, 'utf8');
    }
    const context: ConnectorRunContext = {
      mode,
      ...(schemaPath ? { schemaPath } : {}),
      ...(schemaJson ? { schemaJson } : {}),
    };
    const args = spec.buildArgs(prompt, context);
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
    return text;
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
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
