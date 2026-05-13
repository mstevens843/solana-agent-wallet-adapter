import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { birdeyeConfigFromEnv } from './birdeye.js';
import { redactSecrets } from './trace.js';

export type BirdeyeWsTopic = 'new_listings' | 'new_pairs' | 'large_trades';

export interface BirdeyeWsSnapshotOptions {
  start?: boolean;
  topics?: BirdeyeWsTopic[];
  limit?: number;
  minVolumeUsd?: number;
  maxVolumeUsd?: number;
  env?: NodeJS.ProcessEnv;
}

export interface BirdeyeWsSnapshot {
  source: 'birdeye_ws';
  asOf: string;
  status: 'idle' | 'connecting' | 'open' | 'closed' | 'unavailable' | 'error';
  configured: boolean;
  wsUrl?: string;
  topics: BirdeyeWsTopic[];
  stale: boolean;
  lastMessageAt?: string;
  error?: string;
  buffers: {
    newListings: Record<string, unknown>[];
    newPairs: Record<string, unknown>[];
    largeTrades: Record<string, unknown>[];
  };
}

interface WebSocketLike {
  readyState?: number;
  send(data: string): void;
  close(): void;
  addEventListener?: (event: string, listener: (event?: unknown) => void) => void;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeAllListeners?: () => void;
}

export type BirdeyeWebSocketFactory = (url: string, protocol?: string) => WebSocketLike;

const WS_OPEN = 1;
const WS_CONNECTING = 0;
const BUFFER_LIMIT = 1_000;
const STALE_AFTER_MS = 60_000;

let testWebSocketFactory: BirdeyeWebSocketFactory | undefined;

export function setBirdeyeWebSocketFactory(factory: BirdeyeWebSocketFactory): void {
  testWebSocketFactory = factory;
}

export function resetBirdeyeWebSocketFactory(): void {
  testWebSocketFactory = undefined;
}

class BirdeyeWebSocketManager {
  #socket: WebSocketLike | null = null;
  #status: BirdeyeWsSnapshot['status'] = 'idle';
  #topics = new Set<BirdeyeWsTopic>();
  #lastMessageAt: number | null = null;
  #lastError: string | undefined;
  #newListings: Record<string, unknown>[] = [];
  #newPairs: Record<string, unknown>[] = [];
  #largeTrades: Record<string, unknown>[] = [];
  #seen = {
    newListings: new Set<string>(),
    newPairs: new Set<string>(),
    largeTrades: new Set<string>(),
  };
  #minVolumeUsd = 7_500;
  #maxVolumeUsd: number | undefined;

  start(options: BirdeyeWsSnapshotOptions = {}): BirdeyeWsSnapshot {
    const config = birdeyeConfigFromEnv(options.env);
    if (!config.wsEnabled || !config.wsUrl) {
      this.#status = 'unavailable';
      this.#lastError = 'Birdeye WebSocket is not configured. Set BIRDEYE_WS_URL or BIRDEYE_WS_ENABLED=true with BIRDEYE_API_KEY.';
      return this.snapshot(options);
    }
    const topics: BirdeyeWsTopic[] = options.topics?.length
      ? options.topics
      : ['new_listings', 'new_pairs', 'large_trades'];
    for (const topic of topics) this.#topics.add(topic);
    if (options.minVolumeUsd !== undefined) this.#minVolumeUsd = options.minVolumeUsd;
    if (options.maxVolumeUsd !== undefined) this.#maxVolumeUsd = options.maxVolumeUsd;

    if (this.#socket && (this.#socket.readyState === WS_OPEN || this.#socket.readyState === WS_CONNECTING)) {
      if (this.#socket.readyState === WS_OPEN) this.#sendSubscriptions();
      return this.snapshot(options);
    }

    const factory = testWebSocketFactory ?? globalWebSocketFactory();
    if (!factory) {
      this.#status = 'unavailable';
      this.#lastError = 'No WebSocket implementation is available in this Node runtime.';
      return this.snapshot(options);
    }

    try {
      this.#socket = factory(config.wsUrl, 'echo-protocol');
      this.#status = 'connecting';
      this.#lastError = undefined;
      this.#attach(this.#socket);
    } catch (err) {
      this.#status = 'error';
      this.#lastError = err instanceof Error ? err.message : String(err);
    }
    return this.snapshot(options);
  }

  snapshot(options: Pick<BirdeyeWsSnapshotOptions, 'limit' | 'env'> = {}): BirdeyeWsSnapshot {
    const config = birdeyeConfigFromEnv(options.env);
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
    const stale = this.#lastMessageAt === null ? true : Date.now() - this.#lastMessageAt > STALE_AFTER_MS;
    return {
      source: 'birdeye_ws',
      asOf: new Date().toISOString(),
      status: this.#statusForSocket(),
      configured: Boolean(config.wsEnabled && config.wsUrl),
      ...(config.wsUrl ? { wsUrl: String(redactSecrets(config.wsUrl)) } : {}),
      topics: [...this.#topics],
      stale,
      ...(this.#lastMessageAt ? { lastMessageAt: new Date(this.#lastMessageAt).toISOString() } : {}),
      ...(this.#lastError ? { error: this.#lastError } : {}),
      buffers: {
        newListings: this.#newListings.slice(-limit).reverse(),
        newPairs: this.#newPairs.slice(-limit).reverse(),
        largeTrades: this.#largeTrades.slice(-limit).reverse(),
      },
    };
  }

  stop(): void {
    try {
      this.#socket?.removeAllListeners?.();
      this.#socket?.close();
    } finally {
      this.#socket = null;
      this.#status = 'closed';
    }
  }

  #attach(socket: WebSocketLike): void {
    const onOpen = () => {
      this.#status = 'open';
      this.#sendSubscriptions();
    };
    const onMessage = (event?: unknown) => this.#handleMessage(event);
    const onClose = () => {
      this.#status = 'closed';
    };
    const onError = (event?: unknown) => {
      this.#status = 'error';
      this.#lastError = event instanceof Error ? event.message : String(event ?? 'WebSocket error');
    };
    if (socket.addEventListener) {
      socket.addEventListener('open', onOpen);
      socket.addEventListener('message', onMessage);
      socket.addEventListener('close', onClose);
      socket.addEventListener('error', onError);
      return;
    }
    if (socket.on) {
      socket.on('open', onOpen);
      socket.on('message', onMessage);
      socket.on('close', onClose);
      socket.on('error', onError);
      return;
    }
    throw new ProtocolError('unsupported_method', 'Configured WebSocket implementation does not expose event listeners.');
  }

  #sendSubscriptions(): void {
    if (!this.#socket || this.#socket.readyState !== WS_OPEN) return;
    for (const topic of this.#topics) {
      this.#socket.send(JSON.stringify(subscriptionForTopic(topic, this.#minVolumeUsd, this.#maxVolumeUsd)));
    }
  }

  #handleMessage(event?: unknown): void {
    const raw = rawMessageData(event);
    if (raw === undefined) return;
    const msg = parseRecord(raw);
    if (!msg) return;
    this.#lastMessageAt = Date.now();
    const type = typeof msg.type === 'string' ? msg.type : '';
    if (type.endsWith('_ERROR') || msg.error) {
      this.#lastError = JSON.stringify(redactSecrets(msg));
      return;
    }
    const data = asRecord(msg.data);
    if (type === 'TOKEN_NEW_LISTING_DATA' && data) {
      this.#pushUnique('newListings', normalizeNewListing(data));
      return;
    }
    if (type === 'NEW_PAIR_DATA' && data) {
      this.#pushUnique('newPairs', normalizeNewPair(data));
      return;
    }
    if ((type === 'LARGE_TRADE_TXS_DATA' || type === 'LARGE_TRADE_TX_DATA') && data) {
      this.#pushUnique('largeTrades', { ...data, receivedAt: new Date().toISOString() });
    }
  }

  #pushUnique(buffer: 'newListings' | 'newPairs' | 'largeTrades', item: Record<string, unknown>): void {
    const key = uniqueKey(item);
    if (!key || this.#seen[buffer].has(key)) return;
    this.#seen[buffer].add(key);
    const target = buffer === 'newListings'
      ? this.#newListings
      : buffer === 'newPairs'
        ? this.#newPairs
        : this.#largeTrades;
    target.push(item);
    if (target.length > BUFFER_LIMIT) {
      const removed = target.splice(0, target.length - BUFFER_LIMIT);
      for (const row of removed) {
        const oldKey = uniqueKey(row);
        if (oldKey) this.#seen[buffer].delete(oldKey);
      }
    }
  }

  #statusForSocket(): BirdeyeWsSnapshot['status'] {
    if (!this.#socket) return this.#status;
    if (this.#socket.readyState === WS_OPEN) return 'open';
    if (this.#socket.readyState === WS_CONNECTING) return 'connecting';
    return this.#status;
  }
}

export const birdeyeWebSocketManager = new BirdeyeWebSocketManager();

export function getBirdeyeWebSocketSnapshot(options: BirdeyeWsSnapshotOptions = {}): BirdeyeWsSnapshot {
  if (options.start) {
    return birdeyeWebSocketManager.start(options);
  }
  return birdeyeWebSocketManager.snapshot(options);
}

function subscriptionForTopic(topic: BirdeyeWsTopic, minVolumeUsd: number, maxVolumeUsd: number | undefined): Record<string, unknown> {
  if (topic === 'new_listings') {
    return {
      type: 'SUBSCRIBE_TOKEN_NEW_LISTING',
      chain: 'solana',
      meme_platform_enabled: true,
    };
  }
  if (topic === 'new_pairs') {
    return {
      type: 'SUBSCRIBE_NEW_PAIR',
      chain: 'solana',
    };
  }
  return {
    type: 'SUBSCRIBE_LARGE_TRADE_TXS',
    data: {
      min_volume: Math.max(0, minVolumeUsd),
      ...(maxVolumeUsd !== undefined && maxVolumeUsd > minVolumeUsd ? { max_volume: maxVolumeUsd } : {}),
    },
  };
}

function normalizeNewListing(data: Record<string, unknown>): Record<string, unknown> {
  return {
    address: data.address,
    symbol: data.symbol,
    name: data.name,
    decimals: data.decimals,
    liquidity: numberOrUndefined(data.liquidity),
    liquidityAddedAt: unixOrUndefined(data.liquidityAddedAt),
    source: 'ws',
    receivedAt: new Date().toISOString(),
  };
}

function normalizeNewPair(data: Record<string, unknown>): Record<string, unknown> {
  const base = asRecord(data.base) ?? {};
  return {
    address: base.address,
    symbol: base.symbol,
    name: base.name,
    decimals: base.decimals,
    liquidityAddedAt: unixOrUndefined(data.blockTime ?? data.blockUnixTime),
    source: 'ws',
    raw: data,
    receivedAt: new Date().toISOString(),
  };
}

function globalWebSocketFactory(): BirdeyeWebSocketFactory | undefined {
  const ctor = (globalThis as { WebSocket?: new (url: string, protocol?: string) => WebSocketLike }).WebSocket;
  if (!ctor) return undefined;
  return (url, protocol) => new ctor(url, protocol);
}

function rawMessageData(event: unknown): string | undefined {
  const value = asRecord(event)?.data ?? event;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8');
  return undefined;
}

function parseRecord(raw: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function uniqueKey(item: Record<string, unknown>): string | undefined {
  const value = item.address ?? item.signature ?? item.txHash ?? item.receivedAt;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function unixOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 1e12 ? Math.floor(numeric / 1000) : numeric;
  }
  return undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
