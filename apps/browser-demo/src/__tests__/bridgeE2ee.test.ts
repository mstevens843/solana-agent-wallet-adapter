// Interop tests for the phone-side E2EE (bridgeE2ee.ts) — the byte-for-byte port of Android's
// BridgeE2ee.kt and the desktop counterpart. We validate against Node's standard crypto (the SAME RFC
// 5869 HKDF / ECDH P-256 / AES-256-GCM primitives Kotlin and the desktop use), simulating the desktop
// as the counterparty: derive the shared keys independently and confirm they match, then round-trip a
// GCM payload in both directions. If this passes, a real desktop connector can decrypt our forwards and
// we can decrypt its responses.

import { createECDH, createHash, createHmac, hkdfSync, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  base64UrlDecode,
  base64UrlEncode,
  decryptResponse,
  encryptRequest,
  prepareClaim,
  type BridgeE2eeSession,
} from '../bridgeE2ee.js';

const PAIRING_ALG = 'P256-HKDF-SHA256-A256GCM';

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function saltFor(uuid: string, desktopPub: string, phonePub: string): Buffer {
  return createHash('sha256').update(`agentic-bridge-e2ee-salt-v1\n${uuid}\n${desktopPub}\n${phonePub}`, 'utf8').digest();
}

function hkdf(shared: Buffer, salt: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from(info, 'utf8'), 32));
}

describe('bridgeE2ee interop with the desktop/Kotlin crypto', () => {
  it('derives request/response keys and proof a desktop counterparty can reproduce', async () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    // Simulate the desktop: P-256 keypair + a random pair secret, exactly as bridgePairingClient mints.
    const desktop = createECDH('prime256v1');
    desktop.generateKeys();
    const desktopPub = b64url(desktop.getPublicKey()); // 0x04||X||Y, base64url
    const pairSecretRaw = randomBytes(32);
    const pairSecret = b64url(pairSecretRaw);

    const prepared = await prepareClaim(uuid, { alg: PAIRING_ALG, desktopPub, pairSecret });
    expect(prepared.claim.alg).toBe(PAIRING_ALG);

    // Desktop reproduces the shared secret + keys from the phone's public key in the claim.
    const phonePubRaw = Buffer.from(base64UrlDecode(prepared.claim.phonePub));
    expect(phonePubRaw.length).toBe(65);
    expect(phonePubRaw[0]).toBe(0x04);
    const shared = desktop.computeSecret(phonePubRaw); // 32-byte X coordinate
    const salt = saltFor(uuid, desktopPub, prepared.claim.phonePub);
    const expectedRequestKey = hkdf(shared, salt, 'agentic-bridge-e2ee/request/v1');
    const expectedResponseKey = hkdf(shared, salt, 'agentic-bridge-e2ee/response/v1');

    expect(Buffer.from(prepared.session.requestKey).equals(expectedRequestKey)).toBe(true);
    expect(Buffer.from(prepared.session.responseKey).equals(expectedResponseKey)).toBe(true);

    // Proof = HMAC-SHA256(pairSecret bytes, proof message), base64url.
    const expectedProof = b64url(
      createHmac('sha256', pairSecretRaw)
        .update(`agentic-bridge-e2ee-proof-v1\n${uuid}\n${desktopPub}\n${prepared.claim.phonePub}`, 'utf8')
        .digest(),
    );
    expect(prepared.claim.proof).toBe(expectedProof);
  });

  it('encrypts a request the desktop can decrypt (AES-256-GCM, 128-bit tag)', async () => {
    const requestKey = randomBytes(32);
    const session: BridgeE2eeSession = { requestKey: new Uint8Array(requestKey), responseKey: new Uint8Array(randomBytes(32)) };
    const payload = { v: 2, path: '/bridge/ai/generate-plan', clientNonce: 'abc', body: { hello: 'world' } };

    const envelope = await encryptRequest(session, payload);
    expect(envelope.e2ee.v).toBe(2);
    expect(envelope.e2ee.alg).toBe('A256GCM');

    const nonce = Buffer.from(base64UrlDecode(envelope.e2ee.nonce));
    const ctWithTag = Buffer.from(base64UrlDecode(envelope.e2ee.ciphertext));
    expect(nonce.length).toBe(12);
    const tag = ctWithTag.subarray(ctWithTag.length - 16);
    const ciphertext = ctWithTag.subarray(0, ctWithTag.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', requestKey, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    expect(JSON.parse(plaintext)).toEqual(payload);
  });

  it('decrypts a desktop-encrypted response envelope', async () => {
    const responseKey = randomBytes(32);
    const session: BridgeE2eeSession = { requestKey: new Uint8Array(randomBytes(32)), responseKey: new Uint8Array(responseKey) };
    const responsePayload = { v: 2, path: '/bridge/ai/generate-plan', requestId: 'req-1', clientNonce: 'abc', result: { ok: true } };

    // Desktop encrypts with the response key (AES-256-GCM), appending the tag like Java GCMParameterSpec(128).
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', responseKey, nonce);
    const ct = Buffer.concat([cipher.update(JSON.stringify(responsePayload), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const envelope = {
      e2ee: { v: 2, alg: 'A256GCM', nonce: b64url(nonce), ciphertext: b64url(Buffer.concat([ct, tag])) },
    };

    const decrypted = await decryptResponse(session, envelope);
    expect(decrypted).toEqual(responsePayload);
  });

  it('base64url round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array(randomBytes(40));
    expect(Array.from(base64UrlDecode(base64UrlEncode(bytes)))).toEqual(Array.from(bytes));
  });
});
