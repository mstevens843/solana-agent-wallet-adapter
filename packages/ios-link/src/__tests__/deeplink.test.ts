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

  it('opens Backpack with only the documented universal-link candidate', () => {
    const candidates = buildIosConnectUrlCandidates('backpack', connectParams());

    expect(candidates).toHaveLength(1);
    const universal = new URL(candidates[0]!);
    expect(universal.origin).toBe('https://backpack.app');
    expect(universal.pathname).toBe('/ul/v1/connect');
    expect(universal.searchParams.get('redirect_link')).toBe('agenticwallet://callback/connect?requestId=req_1&phase=connect');
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

  it('keeps Backpack signing on the documented universal-link candidate', () => {
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

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.origin).toBe('https://backpack.app');
    expect(candidates[0]!.pathname).toBe('/ul/v1/signMessage');
    expect(candidates[0]!.searchParams.get('nonce')).toBe(bs58.encode(nonce));

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
