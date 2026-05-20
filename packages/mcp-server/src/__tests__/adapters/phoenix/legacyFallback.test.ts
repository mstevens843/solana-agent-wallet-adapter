import { afterEach, describe, expect, it } from 'vitest';

import {
  phoenixCloseAction,
  phoenixModifyCollateralAction,
  phoenixOpenAction,
} from '../../../adapters/phoenix/actions.js';
import { resolvePhoenixClient } from '../../../adapters/phoenix/client.js';
import { hasRiseExtensions } from '../../../adapters/phoenix/riseClient.js';
import type { DAppAdapterContext } from '../../../adapters/types.js';
import type { AgentWalletConfig } from '../../../config.js';

const VALID_WALLET = 'Cda4ZQ6oPdW97zh39NHX1njzvSjmJqkx3jJB8FZw1iCu';

afterEach(() => {
  delete process.env.PHOENIX_USE_LEGACY_HTTP;
});

function fakeCtx(): DAppAdapterContext {
  return {
    backend: {
      async getAddress() {
        return VALID_WALLET;
      },
    } as DAppAdapterContext['backend'],
    config: {
      cluster: 'mainnet-beta',
      connectors: { phoenix: { perps: { enabled: true, paperModeOnly: false } } },
    } as AgentWalletConfig,
    connection: {} as DAppAdapterContext['connection'],
    signTransaction: async () => 'sig',
    signAndBroadcast: async () => 'sig',
    signMessage: async () => 'msg',
    store: {} as DAppAdapterContext['store'],
    connectorSecrets: { phoenix: { apiKey: 'phoenix_invite_test_xyz' } },
  };
}

describe('PHOENIX_USE_LEGACY_HTTP=true safety', () => {
  it('resolvePhoenixClient returns the legacy hand-rolled client (no Rise extensions)', () => {
    process.env.PHOENIX_USE_LEGACY_HTTP = 'true';
    const ctx = fakeCtx();
    const client = resolvePhoenixClient(ctx);
    expect(client.constructor.name).toBe('PhoenixApiClient');
    expect(hasRiseExtensions(client)).toBe(false);
  });

  it('phoenixOpenAction.prepare rejects with unsupported_method when legacy fallback is active', async () => {
    process.env.PHOENIX_USE_LEGACY_HTTP = 'true';
    await expect(
      phoenixOpenAction.prepare(
        { symbol: 'SOL-PERP', side: 'long', baseSize: '0.5', leverage: 3 },
        fakeCtx(),
      ),
    ).rejects.toThrow(/unsupported_method|Rise SDK/i);
  });

  it('phoenixCloseAction.prepare rejects with unsupported_method when legacy fallback is active', async () => {
    process.env.PHOENIX_USE_LEGACY_HTTP = 'true';
    await expect(
      phoenixCloseAction.prepare({ symbol: 'SOL-PERP' }, fakeCtx()),
    ).rejects.toThrow(/unsupported_method|Rise SDK/i);
  });

  it('phoenixModifyCollateralAction.prepare rejects with unsupported_method when legacy fallback is active', async () => {
    process.env.PHOENIX_USE_LEGACY_HTTP = 'true';
    await expect(
      phoenixModifyCollateralAction.prepare({ direction: 'deposit', amountUsd: '100' }, fakeCtx()),
    ).rejects.toThrow(/unsupported_method|Rise SDK/i);
  });
});
