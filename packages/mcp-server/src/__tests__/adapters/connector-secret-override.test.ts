import { afterEach, describe, expect, it } from 'vitest';

import { resolveMagicedenClient } from '../../adapters/magiceden/client.js';
import { buildMagicedenClientFromOverride } from '../../adapters/magiceden/client.js';
import {
  resolveSanctumClient,
  buildSanctumClientFromOverride,
} from '../../adapters/sanctum/client.js';
import { resolvePhoenixClient, resetPhoenixClientFactory } from '../../adapters/phoenix/client.js';
import { buildPhoenixApiClient } from '../../adapters/phoenix/apiClient.js';
import { resolveTensorClient, resetTensorClientFactory } from '../../adapters/tensor/client.js';
import type { DAppAdapterContext } from '../../adapters/types.js';

afterEach(() => {
  delete process.env.MAGICEDEN_API_KEY;
  delete process.env.MAGICEDEN_CONNECTOR_ENABLED;
  delete process.env.TENSOR_API_KEY;
  delete process.env.SANCTUM_API_KEY;
  delete process.env.PHOENIX_ACCESS_CODE;
  resetTensorClientFactory();
  resetPhoenixClientFactory();
});

function fakeCtx(connectorSecrets?: DAppAdapterContext['connectorSecrets']): DAppAdapterContext {
  return {
    backend: {} as DAppAdapterContext['backend'],
    config: {} as DAppAdapterContext['config'],
    connection: {} as DAppAdapterContext['connection'],
    signTransaction: async () => 'sig',
    signAndBroadcast: async () => 'sig',
    signMessage: async () => 'msg',
    store: {} as DAppAdapterContext['store'],
    ...(connectorSecrets ? { connectorSecrets } : {}),
  };
}

describe('resolveMagicedenClient with ctx override', () => {
  it('uses ctx.connectorSecrets.magiceden when present', () => {
    const ctx = fakeCtx({ magiceden: { apiKey: 'me_user_key', baseUrl: 'https://me.test/v2' } });
    const fresh = resolveMagicedenClient(ctx);
    const built = buildMagicedenClientFromOverride({ apiKey: 'me_user_key', baseUrl: 'https://me.test/v2' });
    // Both should be configured (not the Unavailable stub).
    expect(fresh.constructor.name).toBe(built.constructor.name);
    expect(fresh.constructor.name).toMatch(/MagicedenApiClient/);
  });

  it('falls back to env-based singleton when ctx has no override', () => {
    const ctx = fakeCtx();
    const fallback = resolveMagicedenClient(ctx);
    // No env key set → returns the Unavailable stub.
    expect(fallback.constructor.name).toBe('MagicedenApiUnavailable');
  });

  it('per-request override does not mutate the global factory cache', () => {
    const overrideCtx = fakeCtx({ magiceden: { apiKey: 'one' } });
    const overridden = resolveMagicedenClient(overrideCtx);
    expect(overridden.constructor.name).toBe('MagicedenApiClient');

    const noOverrideCtx = fakeCtx();
    const fallback = resolveMagicedenClient(noOverrideCtx);
    expect(fallback.constructor.name).toBe('MagicedenApiUnavailable');
  });
});

describe('resolveTensorClient with ctx override', () => {
  it('uses ctx.connectorSecrets.tensor when present', () => {
    const ctx = fakeCtx({ tensor: { apiKey: 'tensor_user_key' } });
    const client = resolveTensorClient(ctx);
    // Builder constructs a TensorApiClient instance (not TensorSdkUnavailable).
    expect(client.constructor.name).not.toBe('TensorSdkUnavailable');
  });

  it('falls back to the un-wired stub when no ctx override and no env key', () => {
    const ctx = fakeCtx();
    const client = resolveTensorClient(ctx);
    expect(client.constructor.name).toBe('TensorSdkUnavailable');
  });
});

describe('resolveSanctumClient with ctx override', () => {
  it('uses ctx.connectorSecrets.sanctum when present', () => {
    const ctx = fakeCtx({ sanctum: { apiKey: 'sanctum_user_key' } });
    const built = buildSanctumClientFromOverride({ apiKey: 'sanctum_user_key' });
    const resolved = resolveSanctumClient(ctx);
    expect(resolved.constructor.name).toBe(built.constructor.name);
    expect(resolved.constructor.name).not.toMatch(/Unavailable/);
  });

  it('falls back to the singleton when ctx has no override', () => {
    const ctx = fakeCtx();
    const client = resolveSanctumClient(ctx);
    // No env key set → returns the Unavailable stub.
    expect(client.constructor.name).toBe('SanctumApiUnavailable');
  });
});

describe('resolvePhoenixClient with ctx override', () => {
  it('uses ctx.connectorSecrets.phoenix.apiKey as the activation code (Rise-backed by default, with Rise extensions)', async () => {
    const { hasRiseExtensions } = await import('../../adapters/phoenix/riseClient.js');
    const ctx = fakeCtx({ phoenix: { apiKey: 'phoenix_invite_xyz' } });
    const client = resolvePhoenixClient(ctx);
    // Rise-backed clients are plain objects (no class) but expose the buildOpenIxs extension.
    expect(hasRiseExtensions(client)).toBe(true);
  });

  it('falls back to the legacy PhoenixApiClient when PHOENIX_USE_LEGACY_HTTP=true', () => {
    process.env.PHOENIX_USE_LEGACY_HTTP = 'true';
    try {
      const ctx = fakeCtx({ phoenix: { apiKey: 'phoenix_invite_xyz' } });
      const client = resolvePhoenixClient(ctx);
      expect(client.constructor.name).toBe('PhoenixApiClient');
    } finally {
      delete process.env.PHOENIX_USE_LEGACY_HTTP;
    }
  });

  it('falls back to the Unavailable stub when no override and no env code', () => {
    const ctx = fakeCtx();
    const client = resolvePhoenixClient(ctx);
    expect(client.constructor.name).toBe('PhoenixClientUnavailable');
  });

  it('per-request override does not mutate the global factory cache', async () => {
    const { hasRiseExtensions } = await import('../../adapters/phoenix/riseClient.js');
    const overrideCtx = fakeCtx({ phoenix: { apiKey: 'first_code' } });
    const overridden = resolvePhoenixClient(overrideCtx);
    expect(hasRiseExtensions(overridden)).toBe(true);

    const fallback = resolvePhoenixClient(fakeCtx());
    expect(fallback.constructor.name).toBe('PhoenixClientUnavailable');
  });

  it('sends the access code as both Bearer and x-phoenix-access-code', async () => {
    const captured: Record<string, string>[] = [];
    const client = buildPhoenixApiClient({
      accessCode: 'phoenix_invite_capture',
      baseUrl: 'https://example.test',
      fetchImpl: async (_input, init) => {
        captured.push(init?.headers ?? {});
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ symbol: 'SOL-PERP', markPriceUsd: '100' });
          },
        };
      },
    });
    await client.fetchMarketSnapshot({ symbol: 'SOL-PERP' });
    expect(captured).toHaveLength(1);
    expect(captured[0]!['authorization']).toBe('Bearer phoenix_invite_capture');
    expect(captured[0]!['x-phoenix-access-code']).toBe('phoenix_invite_capture');
  });
});
