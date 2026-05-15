import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import {
  ConnectorSecretsError,
  createConnectorSecretsService,
  emptyConnectorSecretsSummary,
  isByoKeyConnectorId,
  resolveConnectorSecretsKek,
} from '../cloud/connectorSecrets.js';

const WALLET_A = '4fTqUdd9dqwMMoHd1111111111111111111111111111';
const WALLET_B = '5gAcDef0eqxNNoLm2222222222222222222222222222';

function kek(): Buffer {
  return Buffer.from(randomBytes(32));
}

describe('connector secrets storage', () => {
  it('encrypts secrets round-trip per wallet', async () => {
    const store = new MemoryWorkflowStore();
    const service = createConnectorSecretsService({ store, kek: kek() });

    await service.save(WALLET_A, 'magiceden', { apiKey: 'me_key_alpha', baseUrl: 'https://example.com' });
    await service.save(WALLET_A, 'tensor', { apiKey: 'tensor_beta' });
    await service.save(WALLET_B, 'sanctum', { apiKey: 'sanctum_gamma' });

    const loadedA = await service.loadAll(WALLET_A);
    expect(loadedA.magiceden?.apiKey).toBe('me_key_alpha');
    expect(loadedA.magiceden?.baseUrl).toBe('https://example.com');
    expect(loadedA.tensor?.apiKey).toBe('tensor_beta');
    expect(loadedA.sanctum).toBeUndefined();

    const loadedB = await service.loadAll(WALLET_B);
    expect(loadedB.sanctum?.apiKey).toBe('sanctum_gamma');
    expect(loadedB.magiceden).toBeUndefined();
  });

  it('list never exposes plaintext keys', async () => {
    const store = new MemoryWorkflowStore();
    const service = createConnectorSecretsService({ store, kek: kek() });
    await service.save(WALLET_A, 'magiceden', { apiKey: 'top-secret', baseUrl: 'https://x' });

    const summary = await service.list(WALLET_A);
    expect(summary.magiceden.hasKey).toBe(true);
    expect(summary.magiceden.baseUrl).toBe('https://x');
    expect(summary.magiceden.savedAt).toBeTypeOf('string');
    // Sanity: no `apiKey` field leaks.
    expect((summary.magiceden as unknown as { apiKey?: string }).apiKey).toBeUndefined();
    expect(summary.tensor.hasKey).toBe(false);
    expect(summary.sanctum.hasKey).toBe(false);
  });

  it('delete removes only the named connector', async () => {
    const store = new MemoryWorkflowStore();
    const service = createConnectorSecretsService({ store, kek: kek() });
    await service.save(WALLET_A, 'magiceden', { apiKey: 'one' });
    await service.save(WALLET_A, 'tensor', { apiKey: 'two' });

    const removed = await service.delete(WALLET_A, 'magiceden');
    expect(removed).toBe(true);

    const summary = await service.list(WALLET_A);
    expect(summary.magiceden.hasKey).toBe(false);
    expect(summary.tensor.hasKey).toBe(true);
  });

  it('delete on missing entry returns false', async () => {
    const store = new MemoryWorkflowStore();
    const service = createConnectorSecretsService({ store, kek: kek() });
    expect(await service.delete(WALLET_A, 'magiceden')).toBe(false);
  });

  it('wallet isolation: wallet B cannot decrypt wallet A secrets even with same KEK', async () => {
    const store = new MemoryWorkflowStore();
    const sharedKek = kek();
    const service = createConnectorSecretsService({ store, kek: sharedKek });

    await service.save(WALLET_A, 'magiceden', { apiKey: 'a-secret' });

    // Manually copy A's preference into B's slot — simulating a leak where an
    // attacker copies the encrypted blob to a different wallet.
    const aRecord = await store.getPreference(WALLET_A, 'protocol-connector-secrets');
    expect(aRecord).toBeDefined();
    await store.savePreference(WALLET_B, { ...aRecord!, version: 1 });

    // B's loadAll should fail to decrypt because HKDF info binds to wallet.
    const loaded = await service.loadAll(WALLET_B);
    expect(loaded.magiceden).toBeUndefined();
  });

  it('overwriting a key produces a fresh ciphertext (no salt/iv reuse)', async () => {
    const store = new MemoryWorkflowStore();
    const service = createConnectorSecretsService({ store, kek: kek() });
    await service.save(WALLET_A, 'magiceden', { apiKey: 'first' });
    const first = await store.getPreference(WALLET_A, 'protocol-connector-secrets');
    await service.save(WALLET_A, 'magiceden', { apiKey: 'second' });
    const second = await store.getPreference(WALLET_A, 'protocol-connector-secrets');
    expect(first?.version).not.toBe(second?.version);
    expect(JSON.stringify(first?.payload)).not.toBe(JSON.stringify(second?.payload));
  });
});

describe('isByoKeyConnectorId', () => {
  it('accepts the three BYO connectors', () => {
    expect(isByoKeyConnectorId('magiceden')).toBe(true);
    expect(isByoKeyConnectorId('tensor')).toBe(true);
    expect(isByoKeyConnectorId('sanctum')).toBe(true);
  });
  it('rejects others', () => {
    expect(isByoKeyConnectorId('jupiter')).toBe(false);
    expect(isByoKeyConnectorId('')).toBe(false);
    expect(isByoKeyConnectorId('../magiceden')).toBe(false);
  });
});

describe('emptyConnectorSecretsSummary', () => {
  it('reports no keys for each BYO connector', () => {
    const summary = emptyConnectorSecretsSummary();
    expect(summary.magiceden.hasKey).toBe(false);
    expect(summary.tensor.hasKey).toBe(false);
    expect(summary.sanctum.hasKey).toBe(false);
  });
});

describe('resolveConnectorSecretsKek', () => {
  it('throws when neither env var is set', () => {
    expect(() => resolveConnectorSecretsKek({})).toThrow(ConnectorSecretsError);
  });
  it('throws when value is shorter than 32 chars', () => {
    expect(() => resolveConnectorSecretsKek({ CONNECTOR_SECRET_KEY: 'short' })).toThrow(
      ConnectorSecretsError,
    );
  });
  it('accepts a 32+ char value', () => {
    const buf = resolveConnectorSecretsKek({
      CONNECTOR_SECRET_KEY: '12345678901234567890123456789012',
    });
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThanOrEqual(32);
  });
  it('falls back to SESSION_SECRET when CONNECTOR_SECRET_KEY is missing', () => {
    const buf = resolveConnectorSecretsKek({
      SESSION_SECRET: 'abcdefghijklmnopqrstuvwxyzABCDEFGH',
    });
    expect(buf.length).toBeGreaterThanOrEqual(32);
  });
});
