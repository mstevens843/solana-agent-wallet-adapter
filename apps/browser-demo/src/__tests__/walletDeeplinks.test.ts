import { describe, expect, it } from 'vitest';

import bs58 from 'bs58';

import {
  buildPhantomConnectUrl,
  buildSolflareBrowseUrl,
  generatePhantomConnectKeypair,
} from '../walletDeeplinks.js';

describe('generatePhantomConnectKeypair', () => {
  it('returns base58-encoded 32-byte public + 32-byte secret keys', () => {
    const kp = generatePhantomConnectKeypair();
    expect(bs58.decode(kp.publicKey).length).toBe(32);
    expect(bs58.decode(kp.secretKey).length).toBe(32);
  });

  it('produces fresh keypairs on each call', () => {
    const a = generatePhantomConnectKeypair();
    const b = generatePhantomConnectKeypair();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.secretKey).not.toBe(b.secretKey);
  });
});

describe('buildPhantomConnectUrl', () => {
  const baseOpts = {
    dappPublicKey: '7tNZ5ZHzu4hJWdiHJYbV1aZWmYjzcfWcvDxYLqStrEbb',
    redirectLink: 'https://agentic-signer.com/app?wallet=phantom',
    cluster: 'mainnet-beta' as const,
    appUrl: 'https://agentic-signer.com',
  };

  it('targets the official phantom.app universal link', () => {
    const url = new URL(buildPhantomConnectUrl(baseOpts));
    expect(url.origin).toBe('https://phantom.app');
    expect(url.pathname).toBe('/ul/v1/connect');
  });

  it('encodes all required Phantom Connect params', () => {
    const url = new URL(buildPhantomConnectUrl(baseOpts));
    expect(url.searchParams.get('app_url')).toBe(baseOpts.appUrl);
    expect(url.searchParams.get('dapp_encryption_public_key')).toBe(baseOpts.dappPublicKey);
    expect(url.searchParams.get('cluster')).toBe('mainnet-beta');
    expect(url.searchParams.get('redirect_link')).toBe(baseOpts.redirectLink);
  });

  it('URL-encodes the redirect_link (with its own query string) safely', () => {
    const raw = buildPhantomConnectUrl(baseOpts);
    // The redirect_link contains `?` and `=`; URLSearchParams encodes them.
    expect(raw).toContain('redirect_link=https%3A%2F%2Fagentic-signer.com%2Fapp%3Fwallet%3Dphantom');
  });

  it('maps localnet to devnet for the cluster param (same genesis hash)', () => {
    const url = new URL(
      buildPhantomConnectUrl({ ...baseOpts, cluster: 'localnet' as const }),
    );
    expect(url.searchParams.get('cluster')).toBe('devnet');
  });

  it.each(['devnet', 'testnet'] as const)('passes %s through unchanged', (cluster) => {
    const url = new URL(buildPhantomConnectUrl({ ...baseOpts, cluster }));
    expect(url.searchParams.get('cluster')).toBe(cluster);
  });
});

describe('buildSolflareBrowseUrl', () => {
  const baseOpts = {
    dappUrl: 'https://agentic-signer.com/app?wallet=solflare',
    ref: 'https://agentic-signer.com',
  };

  it('targets the official solflare.com browse universal link', () => {
    const url = new URL(buildSolflareBrowseUrl(baseOpts));
    expect(url.origin).toBe('https://solflare.com');
    expect(url.pathname).toBe('/ul/browse/');
  });

  it('passes ref and url through as query params', () => {
    const url = new URL(buildSolflareBrowseUrl(baseOpts));
    expect(url.searchParams.get('ref')).toBe(baseOpts.ref);
    expect(url.searchParams.get('url')).toBe(baseOpts.dappUrl);
  });

  it('URL-encodes the inner url query (preserving its own params)', () => {
    const raw = buildSolflareBrowseUrl(baseOpts);
    expect(raw).toContain('url=https%3A%2F%2Fagentic-signer.com%2Fapp%3Fwallet%3Dsolflare');
  });
});
