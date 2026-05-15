import type { AgentCard, AgenticProtocol, PaymentProtocol } from './schema.js';

export interface ValidateAgentCardResult {
  valid: boolean;
  errors: string[];
  value?: AgentCard;
}

const ALLOWED_PROTOCOLS: ReadonlySet<AgenticProtocol> = new Set<AgenticProtocol>([
  'ap2',
  'acp',
  'a2a',
]);

const ALLOWED_PAYMENT_PROTOCOLS: ReadonlySet<PaymentProtocol> = new Set<PaymentProtocol>([
  'ap2-inbound',
  'acp-outbound',
  'spl-transfer',
]);

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isUrlAllowed(s: string): boolean {
  try {
    const u = new URL(s);
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isBase58Pubkey(s: unknown): s is string {
  return typeof s === 'string' && s.length >= 32 && s.length <= 44 && BASE58_RE.test(s);
}

function pushRequiredString(card: Record<string, unknown>, field: string, errors: string[]): void {
  if (!isNonEmptyString(card[field])) {
    errors.push(`$.${field}: required non-empty string`);
  }
}

function validateCapabilities(raw: unknown, errors: string[]): void {
  if (!isObject(raw)) {
    errors.push('$.capabilities: required object');
    return;
  }
  for (const k of ['streaming', 'pushNotifications', 'stateTransitionHistory'] as const) {
    if (typeof raw[k] !== 'boolean') {
      errors.push(`$.capabilities.${k}: required boolean`);
    }
  }
}

function validateSkills(raw: unknown, errors: string[]): void {
  if (!Array.isArray(raw)) {
    errors.push('$.skills: required array');
    return;
  }
  const seen = new Set<string>();
  raw.forEach((entry, i) => {
    if (!isObject(entry)) {
      errors.push(`$.skills[${i}]: must be an object`);
      return;
    }
    for (const f of ['id', 'name', 'description'] as const) {
      if (!isNonEmptyString(entry[f])) {
        errors.push(`$.skills[${i}].${f}: required non-empty string`);
      }
    }
    if (!isStringArray(entry.tags)) {
      errors.push(`$.skills[${i}].tags: required string array`);
    }
    const id = entry.id;
    if (typeof id === 'string') {
      if (seen.has(id)) {
        errors.push(`$.skills[${i}].id: duplicate skill id "${id}"`);
      }
      seen.add(id);
    }
    if (entry.examples !== undefined && !isStringArray(entry.examples)) {
      errors.push(`$.skills[${i}].examples: must be string array when present`);
    }
    if (entry.inputModes !== undefined && !isStringArray(entry.inputModes)) {
      errors.push(`$.skills[${i}].inputModes: must be string array when present`);
    }
    if (entry.outputModes !== undefined && !isStringArray(entry.outputModes)) {
      errors.push(`$.skills[${i}].outputModes: must be string array when present`);
    }
  });
}

function validatePaymentMethods(raw: unknown, errors: string[]): void {
  if (!Array.isArray(raw)) {
    errors.push('$.paymentMethods: required array');
    return;
  }
  raw.forEach((entry, i) => {
    if (!isObject(entry)) {
      errors.push(`$.paymentMethods[${i}]: must be an object`);
      return;
    }
    const protocol = entry.protocol;
    if (
      typeof protocol !== 'string' ||
      !ALLOWED_PAYMENT_PROTOCOLS.has(protocol as PaymentProtocol)
    ) {
      errors.push(
        `$.paymentMethods[${i}].protocol: must be one of ${[...ALLOWED_PAYMENT_PROTOCOLS].join(',')} (got ${JSON.stringify(protocol)})`,
      );
    }
    if (entry.endpoint !== undefined) {
      if (typeof entry.endpoint !== 'string' || !isUrlAllowed(entry.endpoint)) {
        errors.push(
          `$.paymentMethods[${i}].endpoint: must be https:// (or http://localhost) when present`,
        );
      }
    }
    if (entry.tokens !== undefined && !isStringArray(entry.tokens)) {
      errors.push(`$.paymentMethods[${i}].tokens: must be string array when present`);
    }
  });
}

/**
 * Validate that an unknown payload conforms to the A2A AgentCard shape plus
 * Agentic extensions. Strict on required fields, lenient on unknown top-level
 * keys (extension-friendly). Returns a typed `value` only when `valid` is true.
 *
 * Error strings are JSON-path prefixed (e.g. `$.skills[0].id: ...`) so route
 * handlers can surface them directly to API callers.
 */
export function validateAgentCard(card: unknown): ValidateAgentCardResult {
  if (!isObject(card)) {
    return { valid: false, errors: ['$: card must be an object'] };
  }

  const errors: string[] = [];

  pushRequiredString(card, 'protocolVersion', errors);
  pushRequiredString(card, 'name', errors);
  pushRequiredString(card, 'description', errors);
  pushRequiredString(card, 'url', errors);
  pushRequiredString(card, 'version', errors);

  if (isNonEmptyString(card.url) && !isUrlAllowed(card.url)) {
    errors.push('$.url: must be https:// (or http://localhost for dev)');
  }
  if (card.documentationUrl !== undefined) {
    if (typeof card.documentationUrl !== 'string' || !isUrlAllowed(card.documentationUrl)) {
      errors.push('$.documentationUrl: when present, must be https:// (or http://localhost)');
    }
  }
  if (card.provider !== undefined) {
    if (!isObject(card.provider)) {
      errors.push('$.provider: must be object when present');
    } else {
      if (!isNonEmptyString(card.provider.organization)) {
        errors.push('$.provider.organization: required non-empty string');
      }
      if (!isNonEmptyString(card.provider.url) || !isUrlAllowed(card.provider.url)) {
        errors.push('$.provider.url: required https:// URL');
      }
    }
  }

  validateCapabilities(card.capabilities, errors);

  for (const f of ['defaultInputModes', 'defaultOutputModes'] as const) {
    if (!isStringArray(card[f]) || (card[f] as string[]).length === 0) {
      errors.push(`$.${f}: required non-empty string array`);
    }
  }

  validateSkills(card.skills, errors);

  pushRequiredString(card, 'serviceEndpoint', errors);
  if (isNonEmptyString(card.serviceEndpoint) && !isUrlAllowed(card.serviceEndpoint)) {
    errors.push('$.serviceEndpoint: must be https:// (or http://localhost for dev)');
  }

  if (!isBase58Pubkey(card.walletAddress)) {
    errors.push('$.walletAddress: required base58 pubkey 32-44 chars');
  }

  if (!isStringArray(card.supportedProtocols)) {
    errors.push('$.supportedProtocols: required string array');
  } else if (card.supportedProtocols.length === 0) {
    errors.push('$.supportedProtocols: must declare at least one protocol');
  } else {
    card.supportedProtocols.forEach((p, i) => {
      if (!ALLOWED_PROTOCOLS.has(p as AgenticProtocol)) {
        errors.push(
          `$.supportedProtocols[${i}]: must be one of ${[...ALLOWED_PROTOCOLS].join(',')} (got "${p}")`,
        );
      }
    });
  }

  if (!isStringArray(card.supportedTokens) || (card.supportedTokens as string[]).length === 0) {
    errors.push('$.supportedTokens: required non-empty string array');
  } else {
    const seenTokens = new Set<string>();
    card.supportedTokens.forEach((t, i) => {
      const key = t.toUpperCase();
      if (seenTokens.has(key)) {
        errors.push(`$.supportedTokens[${i}]: duplicate token "${t}"`);
      }
      seenTokens.add(key);
    });
  }

  validatePaymentMethods(card.paymentMethods, errors);

  if (card.contactEmail !== undefined) {
    if (
      typeof card.contactEmail !== 'string' ||
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(card.contactEmail)
    ) {
      errors.push('$.contactEmail: must be valid email when present');
    }
  }

  if (errors.length === 0) {
    return { valid: true, errors, value: card as unknown as AgentCard };
  }
  return { valid: false, errors };
}
