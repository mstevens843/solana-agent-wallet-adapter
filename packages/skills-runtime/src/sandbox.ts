import type { JsonObject, JsonValue, SandboxBindInput, SandboxResult } from './types.js';

const FORBIDDEN_KEYS = new Set<string>(['delegatedSigner', 'privateKey', 'seedPhrase']);
const PLACEHOLDER_RE = /\{\{[^}]+\}\}/;

export class SandboxError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'SandboxError';
    this.code = code;
  }
}

export function bindManifestParams(input: SandboxBindInput): SandboxResult {
  const { install, manifest, executionCount, nowIso } = input;
  const template = manifest.action.paramsTemplate;
  if (template === null || typeof template !== 'object' || Array.isArray(template)) {
    throw new SandboxError('invalid-params-template');
  }
  const substitutions: Record<string, string> = {
    '{{walletAddress}}': install.walletAddress,
    '{{nowIso}}': nowIso,
    '{{caps.perRunMaxAmount}}': install.caps.perRunMaxAmount,
    '{{caps.lifetimeMaxAmount}}': install.caps.lifetimeMaxAmount,
    '{{execution.count}}': String(executionCount),
    ...installParamSubstitutions(install.metadata),
  };
  const cloned = JSON.parse(JSON.stringify(template)) as JsonValue;
  const bound = substituteValue(cloned, substitutions);
  assertForbidden(bound, '$');
  assertNoUnresolvedPlaceholders(bound, '$');
  if (bound === null || typeof bound !== 'object' || Array.isArray(bound)) {
    throw new SandboxError('invalid-params-template-after-bind');
  }
  return { params: bound };
}

function installParamSubstitutions(metadata: JsonObject | undefined): Record<string, string> {
  const installParams = metadata?.installParams;
  if (installParams === null || typeof installParams !== 'object' || Array.isArray(installParams)) {
    return {};
  }
  const substitutions: Record<string, string> = {};
  for (const [key, value] of Object.entries(installParams)) {
    if (typeof value === 'string') {
      substitutions[`{{install.${key}}}`] = value;
    }
  }
  return substitutions;
}

function substituteValue(value: JsonValue, subs: Record<string, string>): JsonValue {
  if (typeof value === 'string') return substituteString(value, subs);
  if (Array.isArray(value)) return value.map((v) => substituteValue(v, subs));
  if (value !== null && typeof value === 'object') {
    const out: JsonObject = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = substituteValue(inner, subs);
    }
    return out;
  }
  return value;
}

function substituteString(value: string, subs: Record<string, string>): string {
  let result = value;
  for (const [placeholder, replacement] of Object.entries(subs)) {
    if (result.includes(placeholder)) {
      result = result.split(placeholder).join(replacement);
    }
  }
  return result;
}

function assertForbidden(value: JsonValue, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, idx) => assertForbidden(entry, `${path}[${idx}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new SandboxError('forbidden-key', `forbidden key '${key}' at ${path}.${key}`);
      }
      if (key.startsWith('approvalAuthority') && typeof inner === 'string'
        && inner.trim().toLowerCase() === 'unlimited') {
        throw new SandboxError(
          'forbidden-unlimited-authority',
          `forbidden value 'unlimited' for ${path}.${key}`,
        );
      }
      assertForbidden(inner, `${path}.${key}`);
    }
  }
}

function assertNoUnresolvedPlaceholders(value: JsonValue, path: string): void {
  if (typeof value === 'string') {
    if (PLACEHOLDER_RE.test(value)) {
      throw new SandboxError('unresolved-placeholder', `unresolved placeholder at ${path}: ${value}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, idx) => assertNoUnresolvedPlaceholders(entry, `${path}[${idx}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      assertNoUnresolvedPlaceholders(inner, `${path}.${key}`);
    }
  }
}
