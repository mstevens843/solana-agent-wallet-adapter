import { describe, expect, it } from 'vitest';

import { normalizeConnectorSecretBaseUrl } from '../connectorSecretUrl.js';

describe('normalizeConnectorSecretBaseUrl', () => {
  it('accepts https URLs and strips trailing slashes', () => {
    expect(normalizeConnectorSecretBaseUrl(' https://api.example.test/v1/// ')).toBe('https://api.example.test/v1');
  });

  it('rejects remote http URLs', () => {
    expect(() => normalizeConnectorSecretBaseUrl('http://api.example.test')).toThrow('https URL');
    expect(() => normalizeConnectorSecretBaseUrl('http://api.example.test', { allowLocalHttp: true }))
      .toThrow('local http URL');
  });

  it('allows loopback http URLs when local http is enabled', () => {
    expect(normalizeConnectorSecretBaseUrl('http://localhost:8787', { allowLocalHttp: true }))
      .toBe('http://localhost:8787');
    expect(normalizeConnectorSecretBaseUrl('http://127.0.0.1:8787/', { allowLocalHttp: true }))
      .toBe('http://127.0.0.1:8787');
  });
});
