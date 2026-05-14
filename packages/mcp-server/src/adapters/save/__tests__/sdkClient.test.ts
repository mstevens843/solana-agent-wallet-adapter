import { describe, expect, it } from 'vitest';

import { buildSaveSdkClient, loadSaveSdkForSmokeTest } from '../sdkClient.js';
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

  it('imports the Solend SDK symbols used by the runtime client', async () => {
    const sdk = await loadSaveSdkForSmokeTest();
    expect(typeof sdk.SolendActionCore).toBe('function');
    expect(typeof sdk.parseReserve).toBe('function');
    expect(typeof sdk.fetchPoolMetadata).toBe('function');
    expect(typeof sdk.MAIN_POOL_ADDRESS.toBase58()).toBe('string');
    expect(typeof sdk.SOLEND_PRODUCTION_PROGRAM_ID.toBase58()).toBe('string');
  });

  it('imports the Pyth price-service dependency required by Solend actions', async () => {
    const pyth = await import('@pythnetwork/price-service-client');
    expect(typeof pyth.PriceServiceConnection).toBe('function');
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
