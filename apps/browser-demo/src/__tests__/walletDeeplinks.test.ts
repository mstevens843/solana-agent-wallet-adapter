import { describe, expect, it } from 'vitest';

import bs58 from 'bs58';

import {
  buildPhantomConnectUrl,
  buildSolflareConnectUrl,
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

  it('appends pairing UUID to redirect_link when supplied', () => {
    const raw = buildPhantomConnectUrl({
      ...baseOpts,
      pairing: '01234567-89ab-cdef-0123-456789abcdef',
    });
    // redirect_link is itself a query value; its inner query string carries
    // pairing=<uuid> alongside the original wallet=phantom.
    expect(raw).toContain('pairing%3D01234567-89ab-cdef-0123-456789abcdef');
    expect(raw).toContain('wallet%3Dphantom');
  });
});

describe('buildSolflareBrowseUrl', () => {
  const baseOpts = {
    dappUrl: 'https://agentic-signer.com/app?wallet=solflare',
    ref: 'https://agentic-signer.com',
  };

  it('targets the v1 browse universal link path (matches Solflare\'s registered handler)', () => {
    const url = new URL(buildSolflareBrowseUrl(baseOpts));
    expect(url.origin).toBe('https://solflare.com');
    // dappUrl is a path segment, NOT a query param. The `/ul/v1/browse/`
    // prefix is mandatory — iOS/Android only routes this exact pattern to
    // Solflare's universal-link handler.
    expect(url.pathname.startsWith('/ul/v1/browse/')).toBe(true);
  });

  it('encodes the destination URL as a path segment (not a query param)', () => {
    const raw = buildSolflareBrowseUrl(baseOpts);
    // The dappUrl should appear URL-encoded directly inside the path —
    // double-encoded because URL also re-encodes the path segment, hence
    // `https` → `https`, `:` → `%3A`, `/` → `%2F`, `?` → `%3F`, etc.
    expect(raw).toContain('/ul/v1/browse/https%3A%2F%2Fagentic-signer.com%2Fapp%3Fwallet%3Dsolflare');
    // And it must NOT use the legacy `?url=…` query-param form.
    expect(raw).not.toContain('?url=');
    expect(raw).not.toContain('&url=');
  });

  it('keeps ref as the only query parameter', () => {
    const url = new URL(buildSolflareBrowseUrl(baseOpts));
    expect(url.searchParams.get('ref')).toBe(baseOpts.ref);
    expect([...url.searchParams.keys()]).toEqual(['ref']);
  });

  it('appends pairing UUID to the dappUrl path segment when supplied', () => {
    const raw = buildSolflareBrowseUrl({
      ...baseOpts,
      pairing: '01234567-89ab-cdef-0123-456789abcdef',
    });
    // The path-segment-encoded dappUrl now includes the pairing param.
    expect(raw).toContain('pairing%3D01234567-89ab-cdef-0123-456789abcdef');
    // Ref query stays unchanged.
    const url = new URL(raw);
    expect(url.searchParams.get('ref')).toBe(baseOpts.ref);
  });
});

describe('buildSolflareConnectUrl', () => {
  const baseOpts = {
    dappPublicKey: '7tNZ5ZHzu4hJWdiHJYbV1aZWmYjzcfWcvDxYLqStrEbb',
    redirectLink: 'https://agentic-signer.com/qr-connect?wallet=solflare&phase=connect',
    cluster: 'mainnet-beta' as const,
    appUrl: 'https://agentic-signer.com',
  };

  it('targets the official Solflare encrypted connect universal link', () => {
    const url = new URL(buildSolflareConnectUrl(baseOpts));
    expect(url.origin).toBe('https://solflare.com');
    expect(url.pathname).toBe('/ul/v1/connect');
  });

  it('encodes all required Solflare Connect params', () => {
    const url = new URL(buildSolflareConnectUrl(baseOpts));
    expect(url.searchParams.get('app_url')).toBe(baseOpts.appUrl);
    expect(url.searchParams.get('dapp_encryption_public_key')).toBe(baseOpts.dappPublicKey);
    expect(url.searchParams.get('cluster')).toBe('mainnet-beta');
    expect(url.searchParams.get('redirect_link')).toBe(baseOpts.redirectLink);
  });

  it('appends pairing UUID to redirect_link when supplied', () => {
    const raw = buildSolflareConnectUrl({
      ...baseOpts,
      pairing: '01234567-89ab-cdef-0123-456789abcdef',
    });
    expect(raw).toContain('pairing%3D01234567-89ab-cdef-0123-456789abcdef');
    expect(raw).toContain('wallet%3Dsolflare');
  });

  it('maps localnet to devnet for the cluster param', () => {
    const url = new URL(buildSolflareConnectUrl({ ...baseOpts, cluster: 'localnet' }));
    expect(url.searchParams.get('cluster')).toBe('devnet');
  });
});
