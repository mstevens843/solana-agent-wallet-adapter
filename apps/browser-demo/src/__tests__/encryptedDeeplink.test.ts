import { describe, expect, it } from 'vitest';

import bs58 from 'bs58';
import nacl from 'tweetnacl';

import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import {
  buildAndroidWalletIntentUrl,
  buildEncryptedSigningUrl,
  decryptConnectResponse,
  decryptSigningResponse,
  generateEncryptedDeeplinkKeypair,
  parseQrConnectUrl,
  resolveSigningPayload,
  signingPayloadForRequest,
} from '../encryptedDeeplink.js';

describe('encrypted deeplink crypto helpers', () => {
  it('generates base58-encoded x25519 keypairs', () => {
    const keypair = generateEncryptedDeeplinkKeypair();
    expect(bs58.decode(keypair.publicKey)).toHaveLength(32);
    expect(bs58.decode(keypair.secretKey)).toHaveLength(32);
  });

  it('decrypts a Phantom connect response and normalizes session fields', () => {
    const dapp = nacl.box.keyPair();
    const wallet = nacl.box.keyPair();
    const nonce = new Uint8Array(nacl.box.nonceLength).fill(1);
    const plaintext = new TextEncoder().encode(JSON.stringify({
      public_key: 'User1111111111111111111111111111111111111',
      session: 'SessionToken',
    }));
    const encrypted = nacl.box(plaintext, nonce, dapp.publicKey, wallet.secretKey);
    const url = new URL('https://agentic-signer.com/qr-connect');
    url.searchParams.set('phantom_encryption_public_key', bs58.encode(wallet.publicKey));
    url.searchParams.set('nonce', bs58.encode(nonce));
    url.searchParams.set('data', bs58.encode(encrypted));

    const result = decryptConnectResponse('phantom', url, bs58.encode(dapp.secretKey));

    expect(result.publicKey).toBe('User1111111111111111111111111111111111111');
    expect(result.session).toBe('SessionToken');
    expect(result.walletEncryptionPublicKey).toBe(bs58.encode(wallet.publicKey));
    expect(result.sharedSecret).toBe(bs58.encode(nacl.box.before(wallet.publicKey, dapp.secretKey)));
  });

  it('builds encrypted Solflare signing links with deterministic nonce support', () => {
    const sharedSecret = new Uint8Array(nacl.box.sharedKeyLength).fill(9);
    const nonce = new Uint8Array(nacl.box.nonceLength).fill(2);
    const url = new URL(buildEncryptedSigningUrl({
      wallet: 'solflare',
      dappPublicKey: 'DappPublicKey',
      sharedSecret: bs58.encode(sharedSecret),
      redirectLink: 'https://agentic-signer.com/qr-connect?phase=sign',
      method: 'signMessage',
      payload: { session: 's', message: 'm', display: 'utf8' },
      nonce,
    }));

    expect(url.origin).toBe('https://solflare.com');
    expect(url.pathname).toBe('/ul/v1/signMessage');
    expect(url.searchParams.get('dapp_encryption_public_key')).toBe('DappPublicKey');
    expect(url.searchParams.get('nonce')).toBe(bs58.encode(nonce));
    const decrypted = nacl.box.open.after(
      bs58.decode(url.searchParams.get('payload') ?? ''),
      nonce,
      sharedSecret,
    );
    expect(JSON.parse(new TextDecoder().decode(decrypted!))).toEqual({
      session: 's',
      message: 'm',
      display: 'utf8',
    });
  });

  it('decrypts encrypted signing responses with the stored shared secret', () => {
    const sharedSecret = new Uint8Array(nacl.box.sharedKeyLength).fill(7);
    const nonce = new Uint8Array(nacl.box.nonceLength).fill(3);
    const encrypted = nacl.box.after(
      new TextEncoder().encode(JSON.stringify({ signature: 'sig' })),
      nonce,
      sharedSecret,
    );
    const url = new URL('https://agentic-signer.com/qr-connect');
    url.searchParams.set('nonce', bs58.encode(nonce));
    url.searchParams.set('data', bs58.encode(encrypted));

    expect(decryptSigningResponse(url, bs58.encode(sharedSecret))).toEqual({ signature: 'sig' });
  });
});

describe('encrypted deeplink request parsing and result conversion', () => {
  it('parses connect approval callback state without treating encrypted params as errors', () => {
    const parsed = parseQrConnectUrl(
      'https://agentic-signer.com/qr-connect?wallet=solflare&pairing=01234567-89ab-4def-8123-456789abcdef&phase=connect&solflare_encryption_public_key=WalletKey&nonce=Nonce&data=Data',
    );
    expect(parsed.wallet).toBe('solflare');
    expect(parsed.phase).toBe('connect');
    expect(parsed.pairing).toBe('01234567-89ab-4def-8123-456789abcdef');
    expect(parsed.error).toBeNull();
    expect(parsed.queryKeys).toContain('solflare_encryption_public_key');
  });

  it('treats missing or malformed pairing ids as absent state', () => {
    const parsed = parseQrConnectUrl(
      'https://agentic-signer.com/qr-connect?wallet=phantom&phase=connect&pairing=not-a-uuid',
    );
    expect(parsed.wallet).toBe('phantom');
    expect(parsed.phase).toBe('connect');
    expect(parsed.pairing).toBe('');
  });

  it('parses /qr-connect state and wallet rejection params', () => {
    const parsed = parseQrConnectUrl(
      'https://agentic-signer.com/qr-connect?wallet=phantom&pairing=01234567-89ab-4def-8123-456789abcdef&phase=sign&requestId=req-1&errorCode=USER_REJECTED&errorMessage=No',
    );
    expect(parsed.wallet).toBe('phantom');
    expect(parsed.phase).toBe('sign');
    expect(parsed.pairing).toBe('01234567-89ab-4def-8123-456789abcdef');
    expect(parsed.requestId).toBe('req-1');
    expect(parsed.error?.code).toBe('user_rejected');
  });

  it('parses connect rejection params independently of signing request ids', () => {
    const parsed = parseQrConnectUrl(
      'https://agentic-signer.com/qr-connect?wallet=solflare&pairing=01234567-89ab-4def-8123-456789abcdef&phase=connect&errorCode=INVALID_SESSION&errorMessage=Expired',
    );
    expect(parsed.wallet).toBe('solflare');
    expect(parsed.phase).toBe('connect');
    expect(parsed.requestId).toBe('');
    expect(parsed.error).toMatchObject({
      code: 'unauthorized',
      message: 'Expired',
    });
  });

  it('throws ProtocolError for malformed encrypted signing callbacks', () => {
    const url = new URL('https://agentic-signer.com/qr-connect');
    url.searchParams.set('nonce', bs58.encode(new Uint8Array(nacl.box.nonceLength).fill(4)));
    url.searchParams.set('data', 'not-base58');

    expect(() => decryptSigningResponse(url, bs58.encode(new Uint8Array(nacl.box.sharedKeyLength).fill(5))))
      .toThrow(ProtocolError);
  });

  it('builds base58 signing payloads from core SigningRequest shapes', () => {
    const message = signingPayloadForRequest({
      id: 'req-message',
      kind: 'sign_message',
      payload: { data: 'hello', encoding: 'utf8' },
      cluster: 'devnet',
    }, 'session-1');
    expect(message).toEqual({
      session: 'session-1',
      message: bs58.encode(new TextEncoder().encode('hello')),
      display: 'utf8',
    });

    const tx = signingPayloadForRequest({
      id: 'req-tx',
      kind: 'sign_transaction',
      payload: { data: 'AQID', encoding: 'base64' },
      cluster: 'devnet',
    }, 'session-1');
    expect(tx).toEqual({
      session: 'session-1',
      transaction: bs58.encode(new Uint8Array([1, 2, 3])),
    });
  });

  it('returns base58 signatures for sign_message approvals', async () => {
    const approval = await resolveSigningPayload({
      wallet: 'phantom',
      request: {
        id: 'req-1',
        kind: 'sign_message',
        payload: { data: 'hello', encoding: 'utf8' },
        cluster: 'devnet',
      },
      payload: { signature: 'sig-1' },
    });
    expect(approval).toMatchObject({
      requestId: 'req-1',
      status: 'approved',
      result: { signature: 'sig-1' },
    });
  });

  it('converts signed transaction base58 responses back to base64', async () => {
    const approval = await resolveSigningPayload({
      wallet: 'phantom',
      request: {
        id: 'req-2',
        kind: 'sign_transaction',
        payload: { data: 'AQID', encoding: 'base64' },
        cluster: 'devnet',
      },
      payload: { transaction: bs58.encode(new Uint8Array([4, 5, 6])) },
    });
    expect(approval.result?.signature).toBe('BAUG');
  });

  it('returns Solflare signAndSendTransaction signatures as txids', async () => {
    const approval = await resolveSigningPayload({
      wallet: 'solflare',
      request: {
        id: 'req-3',
        kind: 'sign_and_send_transaction',
        payload: { data: 'AQID', encoding: 'base64' },
        cluster: 'devnet',
      },
      payload: { signature: 'txid-1' },
    });
    expect(approval.result).toEqual({ signature: 'txid-1', txid: 'txid-1' });
  });

  it('broadcasts Phantom signAndSendTransaction via the provided RPC sender', async () => {
    const approval = await resolveSigningPayload({
      wallet: 'phantom',
      request: {
        id: 'req-4',
        kind: 'sign_and_send_transaction',
        payload: { data: 'AQID', encoding: 'base64' },
        cluster: 'devnet',
      },
      payload: { transaction: bs58.encode(new Uint8Array([8, 9, 10])) },
      sendRawTransaction: async (bytes) => {
        expect([...bytes]).toEqual([8, 9, 10]);
        return 'txid-phantom';
      },
    });
    expect(approval.result).toEqual({ signature: 'txid-phantom', txid: 'txid-phantom' });
  });
});

describe('buildAndroidWalletIntentUrl', () => {
  // Wallet HTTPS URL with the typical query payload Solflare's encrypted
  // deeplink protocol emits. The intent URI must preserve every query param
  // verbatim (only the leading https: scheme moves into the Intent fragment),
  // and the fallback URL must round-trip via `decodeURIComponent`.
  const solflareHttps =
    'https://solflare.com/ul/v1/signTransaction?dapp_encryption_public_key=PUB&nonce=NONCE&redirect_link=https%3A%2F%2Fagentic-signer.com%2Fqr-connect%3Fwallet%3Dsolflare%26pairing%3DABC%26phase%3Dsign%26requestId%3DREQ&payload=ENC';

  function extractFallback(intent: string): string {
    const match = intent.match(/S\.browser_fallback_url=([^;]+);end$/);
    if (!match || !match[1]) throw new Error(`intent URL missing fallback: ${intent}`);
    return decodeURIComponent(match[1]);
  }

  it('wraps the Solflare HTTPS link with Solflare package and fallback', () => {
    const intent = buildAndroidWalletIntentUrl('solflare', solflareHttps);
    expect(intent.startsWith('intent://solflare.com/ul/v1/signTransaction?')).toBe(true);
    expect(intent).toContain('dapp_encryption_public_key=PUB');
    expect(intent).toContain('payload=ENC');
    expect(intent).toContain('#Intent;scheme=https;package=com.solflare.mobile;');
    expect(intent.endsWith(';end')).toBe(true);
    expect(extractFallback(intent)).toBe(solflareHttps);
  });

  it('uses the Phantom package id when wrapping a Phantom HTTPS link', () => {
    const phantomHttps =
      'https://phantom.app/ul/v1/signTransaction?dapp_encryption_public_key=PUB&nonce=NONCE&redirect_link=https%3A%2F%2Fagentic-signer.com%2Fqr-connect%3Fwallet%3Dphantom%26pairing%3DXYZ%26phase%3Dsign%26requestId%3DREQ&payload=ENC';
    const intent = buildAndroidWalletIntentUrl('phantom', phantomHttps);
    expect(intent.startsWith('intent://phantom.app/ul/v1/signTransaction?')).toBe(true);
    expect(intent).toContain(';package=app.phantom;');
    expect(extractFallback(intent)).toBe(phantomHttps);
  });
});
