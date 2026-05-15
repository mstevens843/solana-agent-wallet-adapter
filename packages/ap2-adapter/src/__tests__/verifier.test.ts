import { generateKeyPairSync, sign as signDetached, type KeyObject } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { Ap2VerifyError, type Ap2PaymentMandate } from '../types.js';
import { canonicalize, decodeBase58, encodeBase58, verifyAp2Mandate } from '../verifier.js';

const RECIPIENT = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const NOW = new Date('2026-05-14T10:30:00.000Z');

let agentPublicKey: string;
let agentPrivateKey: KeyObject;

beforeAll(() => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const rawPubkey = spki.subarray(spki.length - 32);
  agentPublicKey = encodeBase58(rawPubkey);
  agentPrivateKey = privateKey;
});

function buildSignedFields(): Record<string, unknown> {
  return {
    mandateId: '01J0AP2INBOUND01',
    mandateType: 'payment_mandate',
    protocolVersion: 'ap2/0.1',
    issuedAt: '2026-05-14T10:00:00.000Z',
    expiresAt: '2026-05-14T11:00:00.000Z',
    intentMandateId: '01J0AP2INTENT01',
    payment: {
      amount: '12.50',
      tokenSymbol: 'USDC',
      tokenMint: USDC_MINT,
      recipient: RECIPIENT,
      cluster: 'mainnet-beta',
    },
  };
}

function signAndBuild(signedFields: Record<string, unknown>): Ap2PaymentMandate {
  const message = Buffer.from(canonicalize(signedFields as never), 'utf8');
  const sigBytes = signDetached(null, message, agentPrivateKey);
  const signature = encodeBase58(sigBytes);
  return {
    mandateId: signedFields.mandateId as string,
    mandateType: 'payment_mandate',
    protocolVersion: signedFields.protocolVersion as string,
    issuedAt: signedFields.issuedAt as string,
    expiresAt: signedFields.expiresAt as string,
    intentMandateId: signedFields.intentMandateId as string,
    agent: { agentId: 'did:web:merchant.example', agentLabel: 'Acme', publicKey: agentPublicKey },
    payment: signedFields.payment as Ap2PaymentMandate['payment'],
    signature,
    signedFields: signedFields as never,
  };
}

describe('verifyAp2Mandate', () => {
  it('verifies a freshly signed mandate', () => {
    const mandate = signAndBuild(buildSignedFields());
    const result = verifyAp2Mandate(mandate, { clockNow: NOW });
    expect(result.verified).toBe(true);
    expect(result.agent.agentLabel).toBe('Acme');
    expect(result.agent.publicKey).toBe(agentPublicKey);
  });

  it('throws bad_signature when signedFields are tampered', () => {
    const mandate = signAndBuild(buildSignedFields());
    const tampered = JSON.parse(JSON.stringify(mandate)) as Ap2PaymentMandate;
    (tampered.signedFields.payment as { amount: string }).amount = '999.00';
    try {
      verifyAp2Mandate(tampered, { clockNow: NOW });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Ap2VerifyError);
      expect((err as Ap2VerifyError).code).toBe('bad_signature');
    }
  });

  it('throws expired when expiresAt is in the past beyond skew', () => {
    const signedFields = buildSignedFields();
    signedFields.expiresAt = '2026-05-14T09:00:00.000Z';
    (signedFields.payment as Record<string, unknown>).cluster = 'mainnet-beta';
    const mandate = signAndBuild(signedFields);
    try {
      verifyAp2Mandate(mandate, { clockNow: NOW });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Ap2VerifyError).code).toBe('expired');
    }
  });

  it('tolerates short clock skew on expiresAt', () => {
    const signedFields = buildSignedFields();
    signedFields.expiresAt = '2026-05-14T10:29:30.000Z';
    const mandate = signAndBuild(signedFields);
    expect(() => verifyAp2Mandate(mandate, { clockNow: NOW, clockSkewMs: 60_000 })).not.toThrow();
  });

  it('throws recipient_mismatch when expectedRecipient is wrong', () => {
    const mandate = signAndBuild(buildSignedFields());
    try {
      verifyAp2Mandate(mandate, { clockNow: NOW, expectedRecipient: 'OtherRecipient1111111111111111111111111111' });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Ap2VerifyError).code).toBe('recipient_mismatch');
    }
  });

  it('throws cluster_mismatch when expectedCluster is wrong', () => {
    const mandate = signAndBuild(buildSignedFields());
    try {
      verifyAp2Mandate(mandate, { clockNow: NOW, expectedCluster: 'devnet' });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Ap2VerifyError).code).toBe('cluster_mismatch');
    }
  });

  it('throws invalid_public_key for a 31-byte pubkey', () => {
    const mandate = signAndBuild(buildSignedFields());
    const shortBytes = new Uint8Array(31);
    mandate.agent.publicKey = encodeBase58(shortBytes);
    try {
      verifyAp2Mandate(mandate, { clockNow: NOW });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Ap2VerifyError).code).toBe('invalid_public_key');
    }
  });

  it('throws invalid_signature for a 63-byte signature', () => {
    const mandate = signAndBuild(buildSignedFields());
    const shortSig = new Uint8Array(63);
    mandate.signature = encodeBase58(shortSig);
    try {
      verifyAp2Mandate(mandate, { clockNow: NOW });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Ap2VerifyError).code).toBe('invalid_signature');
    }
  });
});

describe('canonicalize', () => {
  it('sorts object keys deterministically', () => {
    const a = { z: 1, a: 2, m: 3 };
    const b = { m: 3, a: 2, z: 1 };
    expect(canonicalize(a as never)).toBe(canonicalize(b as never));
    expect(canonicalize(a as never)).toBe('{"a":2,"m":3,"z":1}');
  });

  it('rejects NaN/Infinity', () => {
    expect(() => canonicalize(NaN as never)).toThrowError(Ap2VerifyError);
    expect(() => canonicalize(Infinity as never)).toThrowError(Ap2VerifyError);
  });

  it('escapes strings via JSON.stringify', () => {
    expect(canonicalize('hello\n"world"' as never)).toBe('"hello\\n\\"world\\""');
  });
});

describe('base58 round-trip', () => {
  it('round-trips arbitrary byte arrays', () => {
    for (const bytes of [
      new Uint8Array([0]),
      new Uint8Array([0, 0, 1, 255]),
      new Uint8Array([255, 254, 253]),
      new Uint8Array(32).fill(7),
    ]) {
      expect(Array.from(decodeBase58(encodeBase58(bytes)))).toEqual(Array.from(bytes));
    }
  });
});
