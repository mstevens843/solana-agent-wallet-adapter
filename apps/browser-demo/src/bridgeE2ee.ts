// Phone-side end-to-end encryption for the Plan Connector relay, ported byte-for-byte from the
// Android implementation (`apps/android-twa/.../agent/bridge/BridgeE2ee.kt`). The desktop CLI mints
// v2 pairing QRs that REQUIRE E2EE (`parsePairingPayload` rejects v2 without an `e2ee` block), so an
// iOS phone cannot pair or forward AI requests without reproducing this exact construction.
//
// Construction (must match Kotlin / the desktop counterpart exactly):
//   - Key agreement: P-256 ECDH. Shared secret = the 32-byte X coordinate (WebCrypto deriveBits and
//     Java's KeyAgreement.generateSecret() both return this for secp256r1).
//   - Public keys: raw uncompressed point `0x04 || X(32) || Y(32)` (65 bytes), base64url, no padding.
//   - salt   = SHA-256("agentic-bridge-e2ee-salt-v1\n{uuid}\n{desktopPub}\n{phonePub}")
//   - KDF    = HKDF-SHA256 (RFC 5869: PRK = HMAC(salt, ikm); standard expand). WebCrypto HKDF performs
//              exactly this with `salt` as the extract key, so output matches Kotlin's hand-rolled HKDF.
//   - keys   = HKDF(shared, salt, "agentic-bridge-e2ee/request/v1", 32)  -> requestKey (phone->desktop)
//              HKDF(shared, salt, "agentic-bridge-e2ee/response/v1", 32) -> responseKey (desktop->phone)
//   - proof  = base64url(HMAC-SHA256(key=base64urlDecode(pairSecret),
//                "agentic-bridge-e2ee-proof-v1\n{uuid}\n{desktopPub}\n{phonePub}"))
//   - cipher = AES-256-GCM, 12-byte random nonce, 128-bit tag appended to ciphertext (WebCrypto default;
//              Java GCMParameterSpec(128, nonce) appends the same 16-byte tag).
//   - envelope = { e2ee: { v: 2, alg: "A256GCM", nonce: b64url, ciphertext: b64url } }
//
// Parity is covered by `__tests__/bridgeE2ee.test.ts` (HKDF/HMAC/ECDH cross-checked against Node crypto,
// the same RFC primitives Kotlin uses, plus an AES-GCM round-trip).

export const BRIDGE_E2EE_PAIRING_ALG = 'P256-HKDF-SHA256-A256GCM';
export const BRIDGE_E2EE_ENVELOPE_ALG = 'A256GCM';

export interface BridgeE2eeQrPayload {
  alg: string;
  desktopPub: string;
  pairSecret: string;
}

/** Raw symmetric session keys (32 bytes each). Persisted base64url so a pairing survives app restarts. */
export interface BridgeE2eeSession {
  requestKey: Uint8Array;
  responseKey: Uint8Array;
}

export interface BridgeE2eePreparedClaim {
  /** The `e2ee` block POSTed in the relay claim body. */
  claim: { alg: string; phonePub: string; proof: string };
  session: BridgeE2eeSession;
}

export interface BridgeE2eeEnvelope {
  e2ee: { v: 2; alg: string; nonce: string; ciphertext: string };
}

function subtleCrypto(): SubtleCrypto {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (!subtle) throw new Error('e2ee_subtlecrypto_unavailable');
  return subtle;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function randomClientNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export function parseE2eeQr(value: unknown): BridgeE2eeQrPayload | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const alg = typeof obj.alg === 'string' ? obj.alg.trim() : '';
  const desktopPub = typeof obj.desktopPub === 'string' ? obj.desktopPub.trim() : '';
  const pairSecret = typeof obj.pairSecret === 'string' ? obj.pairSecret.trim() : '';
  if (!alg || !desktopPub || !pairSecret) return null;
  return { alg, desktopPub, pairSecret };
}

async function hmacSha256(key: Uint8Array, body: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await subtleCrypto().importKey(
    'raw',
    key as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await subtleCrypto().sign('HMAC', cryptoKey, body as unknown as ArrayBuffer));
}

async function sha256(body: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtleCrypto().digest('SHA-256', body as unknown as ArrayBuffer));
}

async function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: string, length: number): Promise<Uint8Array> {
  const key = await subtleCrypto().importKey('raw', ikm as unknown as ArrayBuffer, 'HKDF', false, ['deriveBits']);
  const bits = await subtleCrypto().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as unknown as ArrayBuffer, info: textEncoder.encode(info) as unknown as ArrayBuffer },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

function e2eeSaltMessage(pairUuid: string, desktopPub: string, phonePub: string): string {
  return `agentic-bridge-e2ee-salt-v1\n${pairUuid}\n${desktopPub}\n${phonePub}`;
}

function e2eeProofMessage(pairUuid: string, desktopPub: string, phonePub: string): string {
  return `agentic-bridge-e2ee-proof-v1\n${pairUuid}\n${desktopPub}\n${phonePub}`;
}

/** Derive the phone keypair + session keys and build the claim block. Throws `unsupported_e2ee_alg`
 *  for an unknown alg and `invalid_desktop_pub` for a malformed desktop public key (mirrors Kotlin). */
export async function prepareClaim(pairUuid: string, qr: BridgeE2eeQrPayload): Promise<BridgeE2eePreparedClaim> {
  if (qr.alg !== BRIDGE_E2EE_PAIRING_ALG) throw new Error('unsupported_e2ee_alg');
  const subtle = subtleCrypto();
  const keyPair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const phonePubRaw = new Uint8Array(await subtle.exportKey('raw', keyPair.publicKey));
  if (phonePubRaw.length !== 65 || phonePubRaw[0] !== 0x04) throw new Error('invalid_phone_pub');
  const phonePub = base64UrlEncode(phonePubRaw);

  const desktopRaw = base64UrlDecode(qr.desktopPub);
  if (desktopRaw.length !== 65 || desktopRaw[0] !== 0x04) throw new Error('invalid_desktop_pub');
  const desktopKey = await subtle.importKey(
    'raw',
    desktopRaw as unknown as ArrayBuffer,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const sharedSecret = new Uint8Array(
    await subtle.deriveBits({ name: 'ECDH', public: desktopKey }, keyPair.privateKey, 256),
  );

  const salt = await sha256(textEncoder.encode(e2eeSaltMessage(pairUuid, qr.desktopPub, phonePub)));
  const requestKey = await hkdfSha256(sharedSecret, salt, 'agentic-bridge-e2ee/request/v1', 32);
  const responseKey = await hkdfSha256(sharedSecret, salt, 'agentic-bridge-e2ee/response/v1', 32);
  const proofMac = await hmacSha256(base64UrlDecode(qr.pairSecret), textEncoder.encode(e2eeProofMessage(pairUuid, qr.desktopPub, phonePub)));
  const proof = base64UrlEncode(proofMac);

  return {
    claim: { alg: BRIDGE_E2EE_PAIRING_ALG, phonePub, proof },
    session: { requestKey, responseKey },
  };
}

/** Encrypt a request payload object with the request key. Returns the `{ e2ee: {...} }` envelope the
 *  relay forward body wraps as `body` (matching Kotlin BridgeE2ee.encrypt / BridgeAiClient.forward). */
export async function encryptRequest(session: BridgeE2eeSession, payload: unknown): Promise<BridgeE2eeEnvelope> {
  const nonce = new Uint8Array(12);
  globalThis.crypto.getRandomValues(nonce);
  const key = await subtleCrypto().importKey('raw', session.requestKey as unknown as ArrayBuffer, { name: 'AES-GCM' }, false, ['encrypt']);
  const plaintext = textEncoder.encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(
    await subtleCrypto().encrypt({ name: 'AES-GCM', iv: nonce as unknown as ArrayBuffer, tagLength: 128 }, key, plaintext as unknown as ArrayBuffer),
  );
  return {
    e2ee: {
      v: 2,
      alg: BRIDGE_E2EE_ENVELOPE_ALG,
      nonce: base64UrlEncode(nonce),
      ciphertext: base64UrlEncode(ciphertext),
    },
  };
}

/** Decrypt a `{ e2ee: {...} }` response envelope with the response key. Throws on a malformed or
 *  unsupported envelope (mirrors Kotlin BridgeE2ee.decrypt). */
export async function decryptResponse(session: BridgeE2eeSession, envelope: unknown): Promise<unknown> {
  const e2ee = (envelope as { e2ee?: unknown } | null)?.e2ee as Record<string, unknown> | undefined;
  if (!e2ee || typeof e2ee !== 'object') throw new Error('missing_e2ee');
  if (Number(e2ee.v) !== 2 || e2ee.alg !== BRIDGE_E2EE_ENVELOPE_ALG) throw new Error('unsupported_e2ee_envelope');
  const nonce = base64UrlDecode(typeof e2ee.nonce === 'string' ? e2ee.nonce : '');
  const ciphertext = base64UrlDecode(typeof e2ee.ciphertext === 'string' ? e2ee.ciphertext : '');
  if (nonce.length !== 12 || ciphertext.length < 17) throw new Error('invalid_e2ee_payload');
  const key = await subtleCrypto().importKey('raw', session.responseKey as unknown as ArrayBuffer, { name: 'AES-GCM' }, false, ['decrypt']);
  const plaintext = new Uint8Array(
    await subtleCrypto().decrypt({ name: 'AES-GCM', iv: nonce as unknown as ArrayBuffer, tagLength: 128 }, key, ciphertext as unknown as ArrayBuffer),
  );
  return JSON.parse(textDecoder.decode(plaintext));
}

/** Serialize a session to base64url strings for secure persistence. */
export function serializeE2eeSession(session: BridgeE2eeSession): { requestKey: string; responseKey: string } {
  return {
    requestKey: base64UrlEncode(session.requestKey),
    responseKey: base64UrlEncode(session.responseKey),
  };
}

export function deserializeE2eeSession(stored: { requestKey: string; responseKey: string }): BridgeE2eeSession {
  return {
    requestKey: base64UrlDecode(stored.requestKey),
    responseKey: base64UrlDecode(stored.responseKey),
  };
}
