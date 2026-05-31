import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

import {
  buildIosConnectUrl,
  buildIosConnectUrlCandidates,
  buildIosSignMessageUrlCandidates,
} from '../deeplink.js';

describe('iOS deeplink URL candidates', () => {
  it('keeps the single Backpack connect URL as the documented universal link', () => {
    const url = new URL(buildIosConnectUrl('backpack', connectParams()));

    expect(url.origin).toBe('https://backpack.app');
    expect(url.pathname).toBe('/ul/v1/connect');
  });

  it('opens Backpack with a custom-scheme candidate before the universal-link fallback', () => {
    const candidates = buildIosConnectUrlCandidates('backpack', connectParams());

    expect(candidates).toHaveLength(2);
    const custom = new URL(candidates[0]!);
    const universal = new URL(candidates[1]!);
    expect(custom.protocol).toBe('backpack:');
    expect(custom.host).toBe('ul');
    expect(custom.pathname).toBe('/v1/connect');
    expect(universal.origin).toBe('https://backpack.app');
    expect(universal.pathname).toBe('/ul/v1/connect');
    expect(custom.searchParams.toString()).toBe(universal.searchParams.toString());
    expect(custom.searchParams.get('redirect_link')).toBe('agenticwallet://callback/connect?requestId=req_1&phase=connect');
  });

  it('keeps Phantom and Solflare on their current single universal-link candidate', () => {
    const phantom = buildIosConnectUrlCandidates('phantom', connectParams()).map((url) => new URL(url));
    const solflare = buildIosConnectUrlCandidates('solflare', connectParams()).map((url) => new URL(url));

    expect(phantom).toHaveLength(1);
    expect(phantom[0]!.origin).toBe('https://phantom.app');
    expect(phantom[0]!.pathname).toBe('/ul/v1/connect');
    expect(solflare).toHaveLength(1);
    expect(solflare[0]!.origin).toBe('https://solflare.com');
    expect(solflare[0]!.pathname).toBe('/ul/v1/connect');
  });

  it('reuses the same encrypted Backpack signing payload for both launch candidates', () => {
    const dapp = nacl.box.keyPair();
    const wallet = nacl.box.keyPair();
    const sharedSecret = nacl.box.before(wallet.publicKey, dapp.secretKey);
    const nonce = new Uint8Array(nacl.box.nonceLength).fill(9);
    const candidates = buildIosSignMessageUrlCandidates({
      walletId: 'backpack',
      dappEncryptionPublicKey: dapp.publicKey,
      redirectLink: 'agenticwallet://callback/sign?requestId=req_2&phase=sign',
      payload: { session: 'session-123', message: bs58.encode(new TextEncoder().encode('hello')) },
      sharedSecret,
      nonce,
    }).map((url) => new URL(url));

    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.protocol).toBe('backpack:');
    expect(candidates[0]!.pathname).toBe('/v1/signMessage');
    expect(candidates[1]!.origin).toBe('https://backpack.app');
    expect(candidates[1]!.pathname).toBe('/ul/v1/signMessage');
    expect(candidates[0]!.searchParams.get('nonce')).toBe(bs58.encode(nonce));
    expect(candidates[0]!.searchParams.get('payload')).toBe(candidates[1]!.searchParams.get('payload'));

    const encrypted = bs58.decode(candidates[0]!.searchParams.get('payload') ?? '');
    const plaintext = nacl.box.open.after(encrypted, nonce, sharedSecret);
    expect(plaintext).toBeTruthy();
    expect(JSON.parse(new TextDecoder().decode(plaintext!))).toMatchObject({
      session: 'session-123',
    });
  });
});

function connectParams() {
  return {
    appUrl: 'https://agentic-signer.com',
    cluster: 'mainnet-beta' as const,
    dappEncryptionPublicKey: 'DappKey111111111111111111111111111111111',
    redirectLink: 'agenticwallet://callback/connect?requestId=req_1&phase=connect',
  };
}
