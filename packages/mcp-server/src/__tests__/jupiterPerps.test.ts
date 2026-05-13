import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentWalletActionService } from '../actionService.js';
import { DEFAULT_CONFIG, type AgentWalletConfig } from '../config.js';
import { createMockBackend } from '../mockBackend.js';
import {
  buildPerpsStatus,
  factsFromJupiterPerpsStatus,
  getJupiterPerpsCustodySnapshot,
  getJupiterPerpsPoolSnapshot,
  getJupiterPerpsPositionSnapshot,
} from '../adapters/jupiter/index.js';

const VALID_POOL = '11111111111111111111111111111111';
const VALID_CUSTODY = 'So11111111111111111111111111111111111111112';
const VALID_WALLET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Jupiter Perps status read', () => {
  it('returns the standardized read-only response shape with API status, docs, warnings, and facts', async () => {
    const result = await service().jupiterPerpsStatus({});

    expect(result).toMatchObject({
      connectorId: 'jupiter',
      product: 'perps',
      readOnly: true,
      apiStatus: 'work_in_progress',
      officialDocsStatus: 'work_in_progress',
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('leveraged'),
        expect.stringContaining('Liquidation'),
        expect.stringContaining('work in progress'),
      ]),
    );
    const data = result.data as { docs: Record<string, string> };
    expect(Object.values(data.docs)).toEqual(
      expect.arrayContaining([
        'https://developers.jup.ag/docs/perps',
        'https://developers.jup.ag/docs/perps/position-account',
        'https://developers.jup.ag/docs/perps/positionrequest-account',
        'https://developers.jup.ag/docs/perps/pool-account',
        'https://developers.jup.ag/docs/perps/custody-account',
      ]),
    );
    expect(result.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Perps API status', tone: 'warn' }),
        expect.objectContaining({ label: 'Write support', value: expect.stringContaining('Denied') }),
        expect.objectContaining({ label: 'Official docs', value: 'developers.jup.ag/docs/perps' }),
      ]),
    );
  });

  it('does not require a Jupiter API key', async () => {
    vi.stubEnv('JUPITER_API_KEY', '');
    vi.stubEnv('JUP_API_KEY', '');

    await expect(service().jupiterPerpsStatus({})).resolves.toMatchObject({
      connectorId: 'jupiter',
      product: 'perps',
    });
  });

  it('rejects non-mainnet clusters', async () => {
    const svc = service({ ...testConfig(), cluster: 'devnet' });
    await expect(svc.jupiterPerpsStatus({})).rejects.toMatchObject({
      message: expect.stringMatching(/mainnet-beta/i),
    });
  });

  it('reflects the perps policy in perpsConfig', () => {
    const snapshot = buildPerpsStatus(testConfig());
    expect(snapshot.perpsConfig).toEqual({
      enabled: false,
      readOnly: true,
      perpsBaseUrlConfigured: false,
    });
  });

  it('marks the docs check as reserved for future use even when requested', () => {
    const snapshot = buildPerpsStatus(testConfig(), { includeDocsCheck: true });
    expect(snapshot.docsCheck).toEqual({
      requested: true,
      performed: false,
      note: expect.stringContaining('future revision'),
    });
  });
});

describe('Jupiter Perps account snapshots', () => {
  it('pool snapshot throws unsupported_method when called with a valid pool address', async () => {
    await expect(service().jupiterPerpsPoolSnapshot({ poolAddress: VALID_POOL })).rejects.toMatchObject({
      code: 'unsupported_method',
      message: expect.stringContaining('official API'),
    });
  });

  it('pool snapshot rejects an empty pool address with invalid_request', async () => {
    await expect(service().jupiterPerpsPoolSnapshot({ poolAddress: '' })).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('poolAddress is required'),
    });
  });

  it('pool snapshot rejects a malformed pool address with invalid_request', () => {
    expect(() => getJupiterPerpsPoolSnapshot({ poolAddress: 'not-a-public-key' })).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    );
  });

  it('custody snapshot throws unsupported_method when called with a valid custody address', async () => {
    await expect(service().jupiterPerpsCustodySnapshot({ custodyAddress: VALID_CUSTODY })).rejects.toMatchObject({
      code: 'unsupported_method',
    });
  });

  it('custody snapshot rejects missing input with invalid_request', () => {
    expect(() => getJupiterPerpsCustodySnapshot({ custodyAddress: '' })).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    );
  });

  it('position snapshot falls back to the connected wallet and still throws unsupported_method', async () => {
    await expect(service().jupiterPerpsPositionSnapshot({})).rejects.toMatchObject({
      code: 'unsupported_method',
    });
  });

  it('position snapshot validates wallet and position addresses when provided', () => {
    expect(() => getJupiterPerpsPositionSnapshot({ walletAddress: 'bad-key' })).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    );
    expect(() => getJupiterPerpsPositionSnapshot({ walletAddress: VALID_WALLET, positionAddress: 'bad-key' })).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    );
  });

  it('account snapshots reject non-mainnet clusters', async () => {
    const svc = service({ ...testConfig(), cluster: 'devnet' });
    await expect(svc.jupiterPerpsPoolSnapshot({ poolAddress: VALID_POOL })).rejects.toMatchObject({
      message: expect.stringMatching(/mainnet-beta/i),
    });
  });
});

describe('Jupiter Perps facts normalization', () => {
  it('factsFromJupiterPerpsStatus produces three facts with the expected labels and tones', () => {
    const snapshot = buildPerpsStatus(testConfig());
    const facts = factsFromJupiterPerpsStatus(snapshot, '2026-05-12T00:00:00.000Z');
    expect(facts).toHaveLength(3);
    expect(facts.map((entry) => entry.label)).toEqual(['Perps API status', 'Write support', 'Official docs']);
    expect(facts[0]).toMatchObject({
      connectorId: 'jupiter',
      tone: 'warn',
      source: 'connector',
      checkedAt: '2026-05-12T00:00:00.000Z',
    });
  });
});

function service(config: AgentWalletConfig = testConfig()): AgentWalletActionService {
  return new AgentWalletActionService({
    backend: createMockBackend(),
    config,
  });
}

function testConfig(): AgentWalletConfig {
  return {
    ...DEFAULT_CONFIG,
    cluster: 'mainnet-beta',
    jupiter: {
      ...DEFAULT_CONFIG.jupiter,
      apiKeyEnv: 'JUPITER_API_KEY',
    },
  };
}
