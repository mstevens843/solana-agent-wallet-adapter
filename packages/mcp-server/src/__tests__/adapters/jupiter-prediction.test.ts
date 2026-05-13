import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { AgentWalletActionService } from '../../actionService.js';
import { DEFAULT_CONFIG, type AgentWalletConfig } from '../../config.js';
import { createMockBackend } from '../../mockBackend.js';

const TEST_WALLET = '11111111111111111111111111111111';

function predictionConfig(
  overrides: Partial<AgentWalletConfig['connectors']> = {},
): AgentWalletConfig {
  return {
    ...DEFAULT_CONFIG,
    connectors: {
      ...DEFAULT_CONFIG.connectors,
      jupiter: {
        ...DEFAULT_CONFIG.connectors?.jupiter,
        prediction: { enabled: true, readOnly: true },
      },
      ...overrides,
    },
  };
}

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const status = init.status ?? (init.ok === false ? 500 : 200);
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeService(config: AgentWalletConfig): AgentWalletActionService {
  return new AgentWalletActionService({ backend: createMockBackend(), config });
}

describe('Jupiter Prediction adapter (beta, read-only)', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('JUPITER_API_KEY', 'test-prediction-key');
    vi.stubEnv('JUP_API_KEY', '');
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('rejects prediction reads when the feature flag is disabled', async () => {
    const service = makeService(DEFAULT_CONFIG);
    await expect(service.jupiterPredictionEvents({})).rejects.toMatchObject({
      name: 'ProtocolError',
      code: 'unauthorized',
      message: expect.stringContaining('Jupiter Prediction beta is disabled'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects prediction reads when API key is missing', async () => {
    vi.stubEnv('JUPITER_API_KEY', '');
    const service = makeService(predictionConfig());
    await expect(service.jupiterPredictionEvents({})).rejects.toMatchObject({
      name: 'ProtocolError',
      code: 'unauthorized',
      message: expect.stringContaining('Missing Jupiter API key'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serializes event filters and includes beta warnings on success', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      events: [
        { id: 'evt-1', title: 'Will BTC > 200k?', category: 'crypto', provider: 'polymarket', volume: '12345', markets: [{ id: 'm-1' }] },
      ],
      total: 1,
    }));
    const service = makeService(predictionConfig());
    const result = await service.jupiterPredictionEvents({
      provider: 'polymarket',
      category: 'crypto',
      filter: 'live',
      sortBy: 'volume',
      sortDirection: 'desc',
      includeMarkets: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(calledUrl).toContain('/prediction/v1/events');
    expect(calledUrl).toContain('provider=polymarket');
    expect(calledUrl).toContain('category=crypto');
    expect(calledUrl).toContain('filter=live');
    expect(calledUrl).toContain('includeMarkets=true');

    const headers = ((fetchMock.mock.calls[0] as unknown[])[1] as { headers: Record<string, string> }).headers;
    expect(headers['x-api-key']).toBe('test-prediction-key');

    expect(result).toMatchObject({
      connectorId: 'jupiter',
      product: 'prediction',
      beta: true,
      apiBaseUrlHost: expect.stringContaining('jup.ag'),
    });
    expect((result as { warnings: string[] }).warnings.join(' ')).toContain('beta');
    const data = result['data'] as { events: Array<{ id?: string; marketCount?: number }> };
    expect(data.events[0]?.id).toBe('evt-1');
    expect(data.events[0]?.marketCount).toBe(1);
    expect((result as { facts: Array<Record<string, unknown>> }).facts.length).toBeGreaterThan(0);
  });

  it('runs search_events with query string', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ events: [{ id: 'evt-search', title: 'Search hit' }] }));
    const service = makeService(predictionConfig());
    await service.jupiterPredictionSearchEvents({ query: 'election', limit: 10 });
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toContain('/prediction/v1/events/search');
    expect(url).toContain('query=election');
    expect(url).toContain('limit=10');
  });

  it('normalizes market detail status and emits a warning when closed', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      market: {
        id: 'mkt-1',
        question: 'Will BTC > 200k?',
        status: 'closed',
        yesPrice: '0.65',
        noPrice: '0.35',
        volume: '100',
      },
    }));
    const service = makeService(predictionConfig());
    const result = await service.jupiterPredictionMarketDetail({ marketId: 'mkt-1' });
    const data = result['data'] as { status: string; yesPrice?: string };
    expect(data.status).toBe('closed');
    expect(data.yesPrice).toBe('0.65');
    expect((result as { warnings: string[] }).warnings.join(' ')).toMatch(/closed/i);
  });

  it('normalizes YES/NO orderbook with best bid/ask and stale warning', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      status: 'open',
      yes: { bids: [['0.65', '100'], ['0.64', '50']], asks: [['0.66', '40']] },
      no: { bids: [['0.34', '80']], asks: [['0.36', '20']] },
    }));
    const service = makeService(predictionConfig());
    const result = await service.jupiterPredictionOrderbook({ marketId: 'mkt-1' });
    const data = result['data'] as { yes: { bestBid?: string; bestAsk?: string }; no: { bestBid?: string } };
    expect(data.yes.bestBid).toBe('0.65');
    expect(data.yes.bestAsk).toBe('0.66');
    expect(data.no.bestBid).toBe('0.34');
    expect((result as { warnings: string[] }).warnings.join(' ')).toMatch(/refresh/i);
  });

  it('defaults orders/positions/history owner to the connected wallet and forwards explicit owner', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ orders: [{ id: 'ord-1' }] }))
      .mockResolvedValueOnce(jsonResponse({ positions: [{ id: 'pos-1' }] }))
      .mockResolvedValueOnce(jsonResponse({ history: [{ txid: 'sig-1' }] }))
      .mockResolvedValueOnce(jsonResponse({ vault: { address: 'vault-1', balance: '100', currency: 'USDC' } }))
      .mockResolvedValueOnce(jsonResponse({ orders: [] }));

    const service = makeService(predictionConfig());

    const orders = await service.jupiterPredictionOrders({});
    expect(orders['data']).toMatchObject({ owner: TEST_WALLET });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain(`owner=${TEST_WALLET}`);

    const positions = await service.jupiterPredictionPositions({ marketId: 'mkt-1' });
    expect(positions['data']).toMatchObject({ owner: TEST_WALLET });

    await service.jupiterPredictionHistory({ limit: 5 });
    const history = await service.jupiterPredictionVaultInfo({});
    expect(history['data']).toMatchObject({ owner: TEST_WALLET });

    await service.jupiterPredictionOrders({ owner: '22222222222222222222222222222222' });
    expect(String((fetchMock.mock.calls[4] as unknown[])[0])).toContain('owner=22222222222222222222222222222222');
  });

  it('redacts API key from upstream error messages', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      error: 'forbidden',
      apiKey: 'test-prediction-key',
    }), { status: 401, headers: { 'content-type': 'application/json' } }));
    const service = makeService(predictionConfig());
    let caught: ProtocolError | undefined;
    try {
      await service.jupiterPredictionEvents({});
    } catch (err) {
      caught = err as ProtocolError;
    }
    expect(caught).toBeInstanceOf(ProtocolError);
    expect(caught?.message).not.toContain('test-prediction-key');
    expect(caught?.message).toContain('[redacted]');
  });

  it('routes connector_read_facts capability=prediction to events by default', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ events: [] }));
    const service = makeService(predictionConfig());
    const result = await service.connectorReadFacts({
      connectorId: 'jupiter',
      capability: 'prediction',
    });
    expect(result).toMatchObject({ capability: 'prediction' });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/events');
  });

  it('rejects write-like prediction requests through connector_read_facts', async () => {
    const service = makeService(predictionConfig());
    await expect(service.connectorReadFacts({
      connectorId: 'jupiter',
      capability: 'prediction',
      predictionOperation: 'order_status',
    } as Parameters<typeof service.connectorReadFacts>[0])).rejects.toMatchObject({
      name: 'ProtocolError',
      message: expect.stringContaining('predictionOrderId is required'),
    });
  });

  it('routes connector_read_facts predictionOperation=event_markets to /events/:id/markets', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      event: { id: 'evt-9', title: 'Embedded test' },
      markets: [{ id: 'mkt-9', question: 'A?', status: 'open', yesPrice: '0.55', noPrice: '0.45' }],
    }));
    const service = makeService(predictionConfig());
    const result = await service.connectorReadFacts({
      connectorId: 'jupiter',
      capability: 'prediction',
      predictionOperation: 'event_markets',
      predictionEventId: 'evt-9',
    });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/events/evt-9/markets');
    const data = (result as { data: { markets: Array<{ yesPrice?: string; status?: string }> } }).data;
    // Embedded markets should normalize as NormalizedPredictionMarket (with YES/NO prices and status).
    expect(data.markets[0]?.yesPrice).toBe('0.55');
    expect(data.markets[0]?.status).toBe('open');
  });

  it('routes connector_read_facts to search_events when only a query is provided', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ events: [] }));
    const service = makeService(predictionConfig());
    await service.connectorReadFacts({
      connectorId: 'jupiter',
      capability: 'prediction',
      query: 'btc',
    });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/events/search');
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('query=btc');
  });

  it('redacts api key / bearer / signed-transaction fields if present in raw success bodies', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      events: [{ id: 'evt-secret', title: 'Sensitive' }],
      apiKey: 'should-not-leak-1234567890',
      meta: { authorization: 'Bearer should-not-leak', signedTransaction: 'AAAA' },
    }));
    const service = makeService(predictionConfig());
    const result = await service.jupiterPredictionEvents({});
    const data = result['data'] as { raw: Record<string, unknown> };
    expect(data.raw.apiKey).toBe('[redacted]');
    expect((data.raw.meta as Record<string, string>).authorization).toBe('[redacted]');
    expect((data.raw.meta as Record<string, string>).signedTransaction).toBe('[redacted]');
    expect(JSON.stringify(result)).not.toContain('should-not-leak');
  });

  it('embedded markets in event detail are normalized with YES/NO prices and status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      event: {
        id: 'evt-detail',
        title: 'Detail test',
        markets: [{ id: 'mkt-d', question: 'B?', status: 'resolved', yesPrice: '1', noPrice: '0', result: 'YES' }],
      },
    }));
    const service = makeService(predictionConfig());
    const result = await service.jupiterPredictionEventDetail({ eventId: 'evt-detail' });
    const data = (result as { data: { markets?: Array<{ status?: string; result?: string }> } }).data;
    expect(data.markets?.[0]?.status).toBe('resolved');
    expect(data.markets?.[0]?.result).toBe('YES');
  });
});
