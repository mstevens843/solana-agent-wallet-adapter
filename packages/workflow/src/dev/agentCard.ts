/**
 * Workflow validator for untrusted AgentCard override input arriving over HTTP.
 *
 * Sits between the route handler that accepts `/api/agents/card` overrides and
 * the pure builder in `@solana-agent-wallet-adapter/a2a-agent-card`. Keeps the
 * dependency arrow one-way: route handler imports both this package and the
 * card package; this file holds duplicate `AgentCardOverrideSkill` types by
 * design so the workflow package stays runtime-dep-free.
 */

export interface AgentCardOverrideSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
}

export interface AgentCardOverrides {
  description?: string;
  documentationUrl?: string;
  contactEmail?: string;
  supportedTokens?: string[];
  extraSkills?: AgentCardOverrideSkill[];
}

export interface AgentCardOverridesValidation {
  valid: boolean;
  errors: string[];
  value?: AgentCardOverrides;
}

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'description',
  'documentationUrl',
  'contactEmail',
  'supportedTokens',
  'extraSkills',
]);

const SKILL_ID_RE = /^[a-z0-9._-]+$/;
const TOKEN_SYMBOL_RE = /^[A-Z0-9]{1,12}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_DESCRIPTION_LEN = 500;
const MAX_NAME_LEN = 80;
const MAX_EXTRA_SKILLS = 16;
const MAX_SUPPORTED_TOKENS = 32;
const MAX_TAGS = 12;
const MAX_TAG_LEN = 40;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isHttpsUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateAgentCardOverrides(input: unknown): AgentCardOverridesValidation {
  if (!isObject(input)) {
    return { valid: false, errors: ['$: overrides must be an object'] };
  }

  const errors: string[] = [];
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) {
      errors.push(`$.${key}: unknown override key`);
    }
  }

  const value: AgentCardOverrides = {};

  if ('description' in input) {
    const d = input.description;
    if (typeof d !== 'string') {
      errors.push('$.description: must be string');
    } else if (d.length === 0) {
      errors.push('$.description: must be non-empty');
    } else if (d.length > MAX_DESCRIPTION_LEN) {
      errors.push(`$.description: max ${MAX_DESCRIPTION_LEN} chars (got ${d.length})`);
    } else {
      value.description = d;
    }
  }

  if ('documentationUrl' in input) {
    const u = input.documentationUrl;
    if (typeof u !== 'string' || !isHttpsUrl(u)) {
      errors.push('$.documentationUrl: must be https:// URL');
    } else {
      value.documentationUrl = u;
    }
  }

  if ('contactEmail' in input) {
    const e = input.contactEmail;
    if (typeof e !== 'string' || !EMAIL_RE.test(e)) {
      errors.push('$.contactEmail: invalid email');
    } else {
      value.contactEmail = e;
    }
  }

  if ('supportedTokens' in input) {
    const t = input.supportedTokens;
    if (!isStringArray(t)) {
      errors.push('$.supportedTokens: must be string array');
    } else if (t.length === 0) {
      errors.push('$.supportedTokens: must be non-empty');
    } else if (t.length > MAX_SUPPORTED_TOKENS) {
      errors.push(`$.supportedTokens: max ${MAX_SUPPORTED_TOKENS} entries (got ${t.length})`);
    } else {
      const badIdx = t.findIndex((x) => !TOKEN_SYMBOL_RE.test(x));
      if (badIdx >= 0) {
        errors.push(
          `$.supportedTokens[${badIdx}]: must be uppercase alphanumeric 1-12 chars (got ${JSON.stringify(t[badIdx])})`,
        );
      } else {
        value.supportedTokens = [...t];
      }
    }
  }

  if ('extraSkills' in input) {
    const s = input.extraSkills;
    if (!Array.isArray(s)) {
      errors.push('$.extraSkills: must be array');
    } else if (s.length > MAX_EXTRA_SKILLS) {
      errors.push(`$.extraSkills: max ${MAX_EXTRA_SKILLS} entries (got ${s.length})`);
    } else {
      const collected: AgentCardOverrideSkill[] = [];
      let allOk = true;
      const seenIds = new Set<string>();
      s.forEach((entry, i) => {
        if (!isObject(entry)) {
          errors.push(`$.extraSkills[${i}]: must be object`);
          allOk = false;
          return;
        }
        const id = entry.id;
        const name = entry.name;
        const description = entry.description;
        const tags = entry.tags;
        let entryOk = true;
        if (typeof id !== 'string' || !SKILL_ID_RE.test(id)) {
          errors.push(
            `$.extraSkills[${i}].id: must match ${SKILL_ID_RE} (got ${JSON.stringify(id)})`,
          );
          entryOk = false;
        } else if (seenIds.has(id)) {
          errors.push(`$.extraSkills[${i}].id: duplicate id "${id}"`);
          entryOk = false;
        } else {
          seenIds.add(id);
        }
        if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LEN) {
          errors.push(`$.extraSkills[${i}].name: required string 1-${MAX_NAME_LEN} chars`);
          entryOk = false;
        }
        if (
          typeof description !== 'string' ||
          description.length === 0 ||
          description.length > MAX_DESCRIPTION_LEN
        ) {
          errors.push(
            `$.extraSkills[${i}].description: required string 1-${MAX_DESCRIPTION_LEN} chars`,
          );
          entryOk = false;
        }
        let tagsValue: string[] | undefined;
        if (tags !== undefined) {
          if (!isStringArray(tags)) {
            errors.push(`$.extraSkills[${i}].tags: must be string array when present`);
            entryOk = false;
          } else if (tags.length > MAX_TAGS) {
            errors.push(`$.extraSkills[${i}].tags: max ${MAX_TAGS} entries`);
            entryOk = false;
          } else {
            const badTag = tags.findIndex((t) => t.length === 0 || t.length > MAX_TAG_LEN);
            if (badTag >= 0) {
              errors.push(
                `$.extraSkills[${i}].tags[${badTag}]: must be 1-${MAX_TAG_LEN} chars`,
              );
              entryOk = false;
            } else {
              tagsValue = [...tags];
            }
          }
        }
        if (!entryOk) {
          allOk = false;
          return;
        }
        collected.push(
          tagsValue
            ? { id: id as string, name: name as string, description: description as string, tags: tagsValue }
            : { id: id as string, name: name as string, description: description as string },
        );
      });
      if (allOk) {
        value.extraSkills = collected;
      }
    }
  }

  if (errors.length === 0) {
    return { valid: true, errors, value };
  }
  return { valid: false, errors };
}
