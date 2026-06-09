#!/usr/bin/env node
/**
 * Browser-native Device Agent CORS probe.
 *
 * Sends an OPTIONS preflight and a dummy-key POST to each provider's chat endpoint
 * to confirm the browser-native runtime can reach the provider from a tab origin.
 *
 * Phase 8 deliverable for docs/plans/browser-device-agent-runtime-plan.md.
 * Independent of code: this script does not import from apps/browser-demo. Provider
 * facts are duplicated here from apps/browser-demo/src/planner.ts AI_PROVIDER_PRESETS
 * and the Anthropic header set so the probe can be run before the runtime ships.
 *
 * Exit codes:
 *   0 — every green/amber provider returned a CORS-acceptable response
 *   1 — at least one green/amber provider failed
 *   2 — bad CLI input
 *   3 — unexpected internal error
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const DEFAULT_REPORT = path.join(ROOT, 'build/browser-device-agent-cors-check/report.json');
const DEFAULT_ORIGIN = 'http://localhost:5173';
const DEFAULT_TIMEOUT_MS = 8000;

const DUMMY_KEY_OPENAI_COMPAT = 'sk-cors-probe-not-a-real-key';
const DUMMY_KEY_ANTHROPIC = 'sk-ant-cors-probe-not-real';

const REDACT_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/g,
  /sk-proj-[A-Za-z0-9_-]{8,}/g,
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{8,}/g,
];

const PROVIDERS = [
  {
    id: 'openai',
    label: 'OpenAI',
    tier: 'amber',
    apiFormat: 'openai-compatible',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    runtimeHeaders: ['authorization', 'content-type'],
    buildHeaders: () => ({
      'content-type': 'application/json',
      authorization: `Bearer ${DUMMY_KEY_OPENAI_COMPAT}`,
    }),
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'cors probe' }],
    }),
  },
  {
    id: 'anthropic',
    label: 'Claude / Anthropic',
    tier: 'amber',
    apiFormat: 'anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    runtimeHeaders: [
      'content-type',
      'x-api-key',
      'anthropic-version',
      'anthropic-dangerous-direct-browser-access',
    ],
    buildHeaders: () => ({
      'content-type': 'application/json',
      'x-api-key': DUMMY_KEY_ANTHROPIC,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    }),
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'cors probe' }],
    }),
  },
  {
    id: 'gemini',
    label: 'Gemini',
    tier: 'green',
    apiFormat: 'openai-compatible',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    runtimeHeaders: ['authorization', 'content-type'],
    buildHeaders: () => ({
      'content-type': 'application/json',
      authorization: `Bearer ${DUMMY_KEY_OPENAI_COMPAT}`,
    }),
    body: JSON.stringify({
      model: 'gemini-2.5-flash-lite',
      messages: [{ role: 'user', content: 'cors probe' }],
    }),
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    tier: 'green',
    apiFormat: 'openai-compatible',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    runtimeHeaders: ['authorization', 'content-type'],
    buildHeaders: () => ({
      'content-type': 'application/json',
      authorization: `Bearer ${DUMMY_KEY_OPENAI_COMPAT}`,
    }),
    body: JSON.stringify({
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'cors probe' }],
    }),
  },
  {
    id: 'custom-openai-compatible',
    label: 'Custom OpenAI-compatible',
    tier: 'neutral',
    apiFormat: 'openai-compatible',
    endpoint: null,
    runtimeHeaders: ['authorization', 'content-type'],
    buildHeaders: () => ({
      'content-type': 'application/json',
      authorization: `Bearer ${DUMMY_KEY_OPENAI_COMPAT}`,
    }),
    body: JSON.stringify({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'cors probe' }],
    }),
  },
];

const PROVIDER_IDS = new Set(PROVIDERS.map((entry) => entry.id));

function redact(value) {
  if (value === null || value === undefined) return value;
  let out = String(value);
  for (const pattern of REDACT_PATTERNS) {
    out = out.replace(pattern, '[redacted]');
  }
  return out;
}

function redactHeadersForReport(headers) {
  const out = {};
  for (const [name, raw] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (key === 'authorization' || key === 'x-api-key') {
      out[key] = '[redacted]';
    } else {
      out[key] = redact(raw);
    }
  }
  return out;
}

function exitError(message, code) {
  process.stderr.write(`browser-device-agent-cors-check: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const flags = new Set();
  const options = {};
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      flags.add('help');
      continue;
    }
    if (arg === '--json') {
      flags.add('json');
      continue;
    }
    if (arg === '--no-post') {
      flags.add('no-post');
      continue;
    }
    const match = arg.match(/^--([a-z][a-z0-9-]*)=(.*)$/i);
    if (!match) {
      exitError(`unknown argument: ${arg}`, 2);
    }
    options[match[1]] = match[2];
  }
  return { flags, options };
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: node scripts/browser-device-agent-cors-check.mjs [options]',
      '',
      'Options:',
      '  --filter=<provider>   Run only one provider id (openai|anthropic|gemini|openrouter|custom-openai-compatible)',
      '  --base-url=<url>      Override base URL for custom-openai-compatible (e.g. https://gateway.example.com/v1)',
      '  --origin=<url>        Origin header for preflight (default: http://localhost:5173)',
      '  --json                Emit JSON report only; suppress human output',
      '  --report=<path>       Write JSON report to file (default: build/browser-device-agent-cors-check/report.json)',
      '  --no-post             Only run OPTIONS preflight (skip dummy POST)',
      '  --timeout-ms=<ms>     Per-request timeout (default: 8000)',
      '  --help                Print this usage',
      '',
      'Exit codes:',
      '  0  all green/amber providers ok',
      '  1  at least one green/amber provider failed',
      '  2  bad CLI input',
      '  3  unexpected internal error',
      '',
    ].join('\n'),
  );
}

function isAllowedAclOrigin(value, origin) {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed === '*') return true;
  return trimmed === origin;
}

function aclHeadersCoverage(value, required) {
  if (!value) return { ok: false, covered: [], missing: required.slice() };
  const allowed = new Set(
    value
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length > 0),
  );
  const covered = [];
  const missing = [];
  for (const header of required) {
    if (allowed.has(header.toLowerCase()) || allowed.has('*')) {
      covered.push(header);
    } else {
      missing.push(header);
    }
  }
  return { ok: missing.length === 0, covered, missing };
}

async function timedFetch(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return {
      ok: true,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.name === 'AbortError' ? 'timeout' : (err?.message ?? String(err)),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function probeProvider(provider, options) {
  const messages = [];
  const headers = provider.buildHeaders();
  const requestedHeaders = provider.runtimeHeaders.join(', ');

  const preflightResult = await timedFetch(
    provider.endpoint,
    {
      method: 'OPTIONS',
      headers: {
        origin: options.origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': requestedHeaders,
      },
    },
    options.timeoutMs,
  );

  let preflightOk = false;
  let preflightAllowOrigin = null;
  let preflightAllowHeadersCoverage = null;
  if (preflightResult.ok) {
    preflightAllowOrigin = preflightResult.headers['access-control-allow-origin'] ?? null;
    preflightAllowHeadersCoverage = aclHeadersCoverage(
      preflightResult.headers['access-control-allow-headers'] ?? '',
      provider.runtimeHeaders,
    );
    const status = preflightResult.status;
    const statusFine = status === 200 || status === 204;
    const originFine = isAllowedAclOrigin(preflightAllowOrigin, options.origin);
    preflightOk = statusFine && originFine && preflightAllowHeadersCoverage.ok;
    if (!statusFine) {
      messages.push(`preflight returned status ${status}`);
    }
    if (!originFine) {
      messages.push(
        `preflight access-control-allow-origin missing or not matching (${preflightAllowOrigin ?? 'none'})`,
      );
    }
    if (preflightAllowHeadersCoverage && !preflightAllowHeadersCoverage.ok) {
      messages.push(
        `preflight access-control-allow-headers missing: ${preflightAllowHeadersCoverage.missing.join(', ')}`,
      );
    }
  } else {
    messages.push(`preflight network error: ${preflightResult.error}`);
  }

  let postResult = null;
  let postOk = false;
  let postAllowOrigin = null;
  if (!options.skipPost) {
    postResult = await timedFetch(
      provider.endpoint,
      {
        method: 'POST',
        headers: {
          ...headers,
          origin: options.origin,
        },
        body: provider.body,
      },
      options.timeoutMs,
    );
    if (postResult.ok) {
      postAllowOrigin = postResult.headers['access-control-allow-origin'] ?? null;
      const originFine = isAllowedAclOrigin(postAllowOrigin, options.origin);
      const status = postResult.status;
      const statusReachable = status === 400 || status === 401 || status === 403 || status === 404;
      const softPass = status === 429;
      if (originFine && (statusReachable || softPass)) {
        postOk = true;
        if (softPass) {
          messages.push('POST rate-limited (429) — CORS clearly OK');
        }
      } else {
        if (!originFine) {
          messages.push(`POST access-control-allow-origin missing or not matching (${postAllowOrigin ?? 'none'})`);
        }
        if (!statusReachable && !softPass) {
          messages.push(`POST returned unexpected status ${status} (expected 400/401/403/404 with dummy key)`);
        }
      }
    } else {
      messages.push(`POST network error: ${postResult.error}`);
    }
  }

  let result;
  if (provider.tier === 'neutral' && !provider.endpoint) {
    result = 'warn';
    messages.unshift('custom-openai-compatible skipped: pass --base-url to probe');
  } else if (provider.tier === 'neutral') {
    result = preflightOk || postOk ? 'ok' : 'warn';
  } else if (options.skipPost) {
    result = preflightOk ? 'ok' : 'fail';
  } else {
    result = preflightOk && postOk ? 'ok' : 'fail';
  }

  return {
    id: provider.id,
    label: provider.label,
    tier: provider.tier,
    endpoint: provider.endpoint,
    requestedHeaders: provider.runtimeHeaders,
    headersSent: redactHeadersForReport(headers),
    preflight: preflightResult.ok
      ? {
          status: preflightResult.status,
          durationMs: preflightResult.durationMs,
          allowOrigin: preflightAllowOrigin,
          allowHeaders: preflightAllowHeadersCoverage,
          ok: preflightOk,
        }
      : { ok: false, error: preflightResult.error, durationMs: preflightResult.durationMs },
    post: postResult
      ? postResult.ok
        ? {
            status: postResult.status,
            durationMs: postResult.durationMs,
            allowOrigin: postAllowOrigin,
            ok: postOk,
          }
        : { ok: false, error: postResult.error, durationMs: postResult.durationMs }
      : null,
    messages,
    result,
  };
}

function formatHumanLine(entry) {
  const icon = entry.result === 'ok' ? '✓' : entry.result === 'warn' ? '!' : '✗';
  const preflightSummary = entry.preflight.ok
    ? `preflight ${entry.preflight.status}`
    : `preflight ${entry.preflight.error}`;
  const postSummary = entry.post
    ? entry.post.ok
      ? `POST ${entry.post.status}`
      : `POST ${entry.post.error}`
    : 'POST skipped';
  const tail = entry.messages.length > 0 ? ` — ${entry.messages.join('; ')}` : '';
  return `${icon} ${entry.id} (${entry.tier}): ${preflightSummary}, ${postSummary}${tail}`;
}

async function main() {
  const { flags, options: rawOptions } = parseArgs(process.argv.slice(2));
  if (flags.has('help')) {
    printHelp();
    return 0;
  }

  const filter = rawOptions.filter ?? null;
  if (filter && !PROVIDER_IDS.has(filter)) {
    exitError(`unknown --filter value: ${filter}`, 2);
  }

  const origin = rawOptions.origin ?? DEFAULT_ORIGIN;
  const timeoutRaw = rawOptions['timeout-ms'] ?? null;
  const timeoutMs = timeoutRaw === null ? DEFAULT_TIMEOUT_MS : Number(timeoutRaw);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    exitError(`invalid --timeout-ms value: ${timeoutRaw}`, 2);
  }

  const customBaseUrl =
    rawOptions['base-url'] ?? process.env.AGENTIC_BROWSER_CORS_CHECK_CUSTOM_BASE_URL ?? null;
  const skipPost = flags.has('no-post');
  const json = flags.has('json');
  const reportPath = rawOptions.report ?? DEFAULT_REPORT;

  const targets = (filter ? PROVIDERS.filter((entry) => entry.id === filter) : PROVIDERS).map(
    (provider) => {
      if (provider.id !== 'custom-openai-compatible') return provider;
      if (!customBaseUrl) {
        return { ...provider, endpoint: null };
      }
      const trimmed = customBaseUrl.replace(/\/+$/, '');
      return { ...provider, endpoint: `${trimmed}/chat/completions` };
    },
  );

  const probeOptions = { origin, timeoutMs, skipPost };
  const results = [];
  for (const provider of targets) {
    if (!provider.endpoint) {
      results.push({
        id: provider.id,
        label: provider.label,
        tier: provider.tier,
        endpoint: null,
        requestedHeaders: provider.runtimeHeaders,
        headersSent: redactHeadersForReport(provider.buildHeaders()),
        preflight: { ok: false, error: 'no endpoint configured' },
        post: null,
        messages: ['custom-openai-compatible skipped: pass --base-url to probe'],
        result: 'warn',
      });
      continue;
    }
    const probe = await probeProvider(provider, probeOptions);
    results.push(probe);
  }

  const hardFail = results.some((entry) => entry.tier !== 'neutral' && entry.result === 'fail');
  const exitCode = hardFail ? 1 : 0;

  const report = {
    schemaVersion: 1,
    ranAt: new Date().toISOString(),
    origin,
    timeoutMs,
    skipPost,
    filter,
    customBaseUrl: customBaseUrl ? customBaseUrl.replace(/\/+$/, '') : null,
    providers: results,
    exitCode,
  };

  try {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch (err) {
    exitError(`failed to write report ${reportPath}: ${err?.message ?? err}`, 3);
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`Origin: ${origin}\n`);
    process.stdout.write(`Timeout: ${timeoutMs}ms\n`);
    process.stdout.write(`Report: ${reportPath}\n`);
    process.stdout.write('\n');
    for (const entry of results) {
      process.stdout.write(`${formatHumanLine(entry)}\n`);
    }
    const okCount = results.filter((entry) => entry.result === 'ok').length;
    const warnCount = results.filter((entry) => entry.result === 'warn').length;
    const failCount = results.filter((entry) => entry.result === 'fail').length;
    process.stdout.write('\n');
    process.stdout.write(`Summary: ${okCount} ok, ${warnCount} warn, ${failCount} fail\n`);
    process.stdout.write(`Exit code: ${exitCode}\n`);
  }

  return exitCode;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    process.stderr.write(`browser-device-agent-cors-check: ${err?.stack ?? err}\n`);
    process.exit(3);
  });
