import { describe, expect, it } from 'vitest';

import { buildSaveSdkClient } from '../sdkClient.js';
import { isSaveConfigured, resetSaveClientFactory, setSaveClientFactory } from '../client.js';

describe('buildSaveSdkClient — Solend SDK wiring', () => {
  it('returns an object that implements the SaveClient interface', () => {
    const client = buildSaveSdkClient({ rpcUrl: 'http://127.0.0.1:0' });
    expect(typeof client.getMarketSnapshot).toBe('function');
    expect(typeof client.getReserveSnapshot).toBe('function');
    expect(typeof client.listReserveSnapshots).toBe('function');
    expect(typeof client.getObligation).toBe('function');
    expect(typeof client.buildDepositTransaction).toBe('function');
    expect(typeof client.buildWithdrawTransaction).toBe('function');
    expect(typeof client.buildBorrowTransaction).toBe('function');
    expect(typeof client.buildRepayTransaction).toBe('function');
  });

  it('flips isSaveConfigured() once setSaveClientFactory wires the SDK client', () => {
    try {
      resetSaveClientFactory();
      expect(isSaveConfigured()).toBe(false);
      setSaveClientFactory(() => buildSaveSdkClient({ rpcUrl: 'http://127.0.0.1:0' }));
      expect(isSaveConfigured()).toBe(true);
    } finally {
      resetSaveClientFactory();
    }
  });
});
