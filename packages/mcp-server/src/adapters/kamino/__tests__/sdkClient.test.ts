import { describe, expect, it } from 'vitest';

import { buildKaminoSdkClient } from '../sdkClient.js';
import { isKaminoConfigured, resetKaminoClientFactory, setKaminoClientFactory } from '../client.js';

describe('buildKaminoSdkClient — Kamino SDK wiring', () => {
  it('returns an object that implements the KaminoClient interface', () => {
    // Constructing the client must not require any network access; the SDK is
    // loaded lazily on first method call.
    const client = buildKaminoSdkClient({ rpcUrl: 'http://127.0.0.1:0' });
    expect(typeof client.getReserveSnapshot).toBe('function');
    expect(typeof client.listReserveSnapshots).toBe('function');
    expect(typeof client.getPositions).toBe('function');
    expect(typeof client.buildDepositTransaction).toBe('function');
    expect(typeof client.buildWithdrawTransaction).toBe('function');
  });

  it('flips isKaminoConfigured() once setKaminoClientFactory wires the SDK client', () => {
    try {
      resetKaminoClientFactory();
      expect(isKaminoConfigured()).toBe(false);
      setKaminoClientFactory(() => buildKaminoSdkClient({ rpcUrl: 'http://127.0.0.1:0' }));
      expect(isKaminoConfigured()).toBe(true);
    } finally {
      resetKaminoClientFactory();
    }
  });
});
