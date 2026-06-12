import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  pickWalletHostLaunchBase,
  redactWalletHostLaunchUrl,
  setWalletHostLaunchToken,
} from '../walletHostLaunch.js';

test('pickWalletHostLaunchBase: default + reachable Render → Render-hosted UI', () => {
  assert.equal(
    pickWalletHostLaunchBase({
      source: 'default',
      walletHostUrl: 'http://127.0.0.1:5174',
      remote: 'https://agentic-signer.com',
      remoteReachable: true,
    }),
    'https://agentic-signer.com',
  );
});

test('pickWalletHostLaunchBase: default + unreachable Render → bundled local fallback', () => {
  assert.equal(
    pickWalletHostLaunchBase({
      source: 'default',
      walletHostUrl: 'http://127.0.0.1:5174',
      remote: 'https://agentic-signer.com',
      remoteReachable: false,
    }),
    'http://127.0.0.1:5174',
  );
});

test('pickWalletHostLaunchBase: explicit --wallet-host-url / env is always served locally', () => {
  for (const source of ['flag', 'env'] as const) {
    assert.equal(
      pickWalletHostLaunchBase({
        source,
        walletHostUrl: 'http://127.0.0.1:9999',
        remote: 'https://agentic-signer.com',
        remoteReachable: true,
      }),
      'http://127.0.0.1:9999',
    );
  }
});

test('setWalletHostLaunchToken: token goes in the fragment, never the query', () => {
  const url = new URL('https://agentic-signer.com/connect?bridgeUrl=http%3A%2F%2F127.0.0.1%3A8787');
  setWalletHostLaunchToken(url, 'secret-tok');
  assert.equal(url.searchParams.has('token'), false);
  assert.equal(new URLSearchParams(url.hash.replace(/^#/, '')).get('token'), 'secret-tok');
  // The non-secret bridgeUrl stays in the query.
  assert.equal(url.searchParams.get('bridgeUrl'), 'http://127.0.0.1:8787');
});

test('redactWalletHostLaunchUrl: redacts the token whether in the fragment or the query', () => {
  const fromFragment = redactWalletHostLaunchUrl('https://agentic-signer.com/connect#token=secret');
  assert.match(fromFragment, /token=redacted/);
  assert.doesNotMatch(fromFragment, /secret/);
  const fromQuery = redactWalletHostLaunchUrl('http://127.0.0.1:5174/connect?token=secret');
  assert.match(fromQuery, /token=redacted/);
  assert.doesNotMatch(fromQuery, /secret/);
});
