/**
 * Per-wallet "Agent Payment Profile" payload.
 *
 * This payload is what a connected wallet publishes to advertise discovery
 * metadata (display name, accepted tokens, supported protocols) under its
 * own URL. The wallet signs a canonical SHA-256 hash of this payload during
 * the publish flow; server and client must produce byte-identical hashes for
 * the signature to verify, so both sides import `canonicalizeProfilePayload`
 * from this module — there is no alternate path.
 */

export const ALLOWED_PROFILE_TOKENS = ['USDC', 'USDT', 'SOL'] as const;
export const ALLOWED_PROFILE_PROTOCOLS = ['ap2', 'acp', 'a2a'] as const;

export type AllowedProfileToken = (typeof ALLOWED_PROFILE_TOKENS)[number];
export type AllowedProfileProtocol = (typeof ALLOWED_PROFILE_PROTOCOLS)[number];

export const PROFILE_PAYLOAD_VERSION = 1 as const;

export const PROFILE_DISPLAY_NAME_MAX = 64;
export const PROFILE_CONTACT_EMAIL_MAX = 254;
export const PROFILE_SERIALIZED_MAX_BYTES = 4_096;

export interface AgentPaymentProfilePayload {
  version: typeof PROFILE_PAYLOAD_VERSION;
  discoverable: boolean;
  displayName: string;
  acceptedTokens: AllowedProfileToken[];
  protocols: AllowedProfileProtocol[];
  contactEmail?: string;
}

export interface ProfilePayloadValidationError {
  field: keyof AgentPaymentProfilePayload | 'general';
  message: string;
}

export type ValidateProfilePayloadResult =
  | { ok: true; payload: AgentPaymentProfilePayload }
  | { ok: false; errors: ProfilePayloadValidationError[] };

/**
 * Canonical JSON encoding used as the hashed-and-signed representation of a
 * profile payload. Rules:
 *   - top-level keys are alphabetical
 *   - array fields are deduplicated and sorted ascending
 *   - empty/undefined optional fields are omitted (not nulled)
 *   - no whitespace, no trailing newline
 *
 * Determinism is the contract. If you change this function, increment
 * `PROFILE_PAYLOAD_VERSION` so the message-build code can refuse mixed-version
 * signatures.
 */
export function canonicalizeProfilePayload(payload: AgentPaymentProfilePayload): string {
  const acceptedTokens = sortedUnique(
    payload.acceptedTokens
      .map((token) => String(token).trim())
      .filter((token): token is AllowedProfileToken =>
        (ALLOWED_PROFILE_TOKENS as readonly string[]).includes(token),
      ),
  );
  const protocols = sortedUnique(
    payload.protocols
      .map((protocol) => String(protocol).trim())
      .filter((protocol): protocol is AllowedProfileProtocol =>
        (ALLOWED_PROFILE_PROTOCOLS as readonly string[]).includes(protocol),
      ),
  );

  const fields: Record<string, unknown> = {
    acceptedTokens,
    discoverable: Boolean(payload.discoverable),
    displayName: String(payload.displayName ?? '').trim(),
    protocols,
    version: payload.version,
  };

  const email = typeof payload.contactEmail === 'string' ? payload.contactEmail.trim() : '';
  if (email.length > 0) fields.contactEmail = email;

  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(fields).sort()) {
    ordered[key] = fields[key];
  }
  return JSON.stringify(ordered);
}

/**
 * SHA-256 hex digest of the canonical payload. Uses WebCrypto SubtleCrypto,
 * which is available in browsers and Node 18+. Both call sites in this repo
 * (`apps/browser-demo` and `apps/render-web`) hit the same path; the hash is
 * what gets embedded into the wallet-signed publish message.
 */
export async function hashProfilePayload(payload: AgentPaymentProfilePayload): Promise<string> {
  const subtle = resolveSubtleCrypto();
  const canonical = canonicalizeProfilePayload(payload);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Validate a payload coming from an untrusted source (form input, API body).
 * Used by the browser to gate Save and by the server as defense-in-depth
 * before signature verification.
 */
export function validateProfilePayload(input: unknown): ValidateProfilePayloadResult {
  const errors: ProfilePayloadValidationError[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [{ field: 'general', message: 'Profile payload must be an object.' }] };
  }
  const record = input as Record<string, unknown>;

  if (record.version !== PROFILE_PAYLOAD_VERSION) {
    errors.push({ field: 'version', message: `Profile schema version must be ${PROFILE_PAYLOAD_VERSION}.` });
  }
  if (typeof record.discoverable !== 'boolean') {
    errors.push({ field: 'discoverable', message: 'Discoverable must be true or false.' });
  }

  const displayName = typeof record.displayName === 'string' ? record.displayName.trim() : '';
  if (displayName.length === 0) {
    errors.push({ field: 'displayName', message: 'Display name is required.' });
  } else if (displayName.length > PROFILE_DISPLAY_NAME_MAX) {
    errors.push({ field: 'displayName', message: `Display name must be ${PROFILE_DISPLAY_NAME_MAX} characters or fewer.` });
  }

  const acceptedTokens = Array.isArray(record.acceptedTokens) ? record.acceptedTokens : [];
  const cleanedTokens = sortedUnique(
    acceptedTokens
      .map((token) => (typeof token === 'string' ? token.trim() : ''))
      .filter((token): token is AllowedProfileToken =>
        (ALLOWED_PROFILE_TOKENS as readonly string[]).includes(token),
      ),
  );

  const protocols = Array.isArray(record.protocols) ? record.protocols : [];
  const cleanedProtocols = sortedUnique(
    protocols
      .map((protocol) => (typeof protocol === 'string' ? protocol.trim() : ''))
      .filter((protocol): protocol is AllowedProfileProtocol =>
        (ALLOWED_PROFILE_PROTOCOLS as readonly string[]).includes(protocol),
      ),
  );

  const discoverable = typeof record.discoverable === 'boolean' ? record.discoverable : false;
  if (discoverable) {
    if (cleanedTokens.length === 0) {
      errors.push({ field: 'acceptedTokens', message: 'Pick at least one accepted token to publish.' });
    }
    if (cleanedProtocols.length === 0) {
      errors.push({ field: 'protocols', message: 'Pick at least one protocol to publish.' });
    }
  }

  let contactEmail: string | undefined;
  if (record.contactEmail !== undefined && record.contactEmail !== '') {
    if (typeof record.contactEmail !== 'string') {
      errors.push({ field: 'contactEmail', message: 'Contact email must be a string.' });
    } else {
      const trimmed = record.contactEmail.trim();
      if (trimmed.length > PROFILE_CONTACT_EMAIL_MAX) {
        errors.push({ field: 'contactEmail', message: `Contact email must be ${PROFILE_CONTACT_EMAIL_MAX} characters or fewer.` });
      } else if (trimmed.length > 0 && !isPlausibleEmail(trimmed)) {
        errors.push({ field: 'contactEmail', message: 'Contact email looks malformed.' });
      } else if (trimmed.length > 0) {
        contactEmail = trimmed;
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const payload: AgentPaymentProfilePayload = {
    version: PROFILE_PAYLOAD_VERSION,
    discoverable,
    displayName,
    acceptedTokens: cleanedTokens,
    protocols: cleanedProtocols,
  };
  if (contactEmail) payload.contactEmail = contactEmail;

  if (canonicalizeProfilePayload(payload).length > PROFILE_SERIALIZED_MAX_BYTES) {
    return { ok: false, errors: [{ field: 'general', message: 'Profile payload exceeds size limit.' }] };
  }

  return { ok: true, payload };
}

function sortedUnique<T extends string>(values: T[]): T[] {
  return Array.from(new Set(values)).sort();
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

function isPlausibleEmail(value: string): boolean {
  if (value.length < 3) return false;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return false;
  if (at >= value.length - 1) return false;
  if (value.includes(' ')) return false;
  return value.slice(at + 1).includes('.');
}

interface SubtleCryptoLike {
  digest(algorithm: 'SHA-256', data: ArrayBufferView | ArrayBuffer): Promise<ArrayBuffer>;
}

function resolveSubtleCrypto(): SubtleCryptoLike {
  const candidate = (globalThis as { crypto?: { subtle?: SubtleCryptoLike } }).crypto?.subtle;
  if (!candidate) {
    throw new Error('SubtleCrypto is not available in this environment.');
  }
  return candidate;
}
