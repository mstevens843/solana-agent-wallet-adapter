import { describe, expect, it } from 'vitest';

import { redactSecrets } from '../trace.js';

describe('trace redaction', () => {
  it('redacts RPC API keys from URLs', () => {
    expect(
      redactSecrets('https://mainnet.helius-rpc.com/?api-key=real-key&foo=bar'),
    ).toBe('https://mainnet.helius-rpc.com/?api-key=%5Bredacted%5D&foo=bar');
  });

  it('redacts secret object fields recursively', () => {
    expect(
      redactSecrets({
        rpcUrl: 'https://example.com/?token=secret',
        nested: {
          apiKey: 'secret',
          amount: '0.01',
        },
      }),
    ).toEqual({
      rpcUrl: 'https://example.com/?token=%5Bredacted%5D',
      nested: {
        apiKey: '[redacted]',
        amount: '0.01',
      },
    });
  });
});
