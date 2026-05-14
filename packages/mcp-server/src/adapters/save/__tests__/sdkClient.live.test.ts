// Live mainnet Save transaction-building is opt-in because it depends on an RPC
// endpoint and can be slow. The default unit smoke test imports the real SDK so
// dependency-resolution failures are still caught without hitting mainnet.
import { describe, it } from 'vitest';

describe.skip('buildSaveSdkClient — live mainnet integration', () => {
  it('set up RUN_LIVE_CONNECTOR_TESTS before enabling this test', () => {});
});
