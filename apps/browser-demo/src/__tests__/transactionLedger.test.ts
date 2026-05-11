import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TRANSACTION_LEDGER_MAX_RECORDS,
  TRANSACTION_LEDGER_STORAGE_KEY,
  explorerUrlForTxid,
  findPendingTransactionByAction,
  findPendingTransactionByTxid,
  loadTransactionLedger,
  markTransactionPhase,
  pendingTransactionsNeedingReconciliation,
  removePendingTransaction,
  saveTransactionLedger,
  signedTransactionHashFromBase64,
  upsertPendingTransaction,
  type PendingTransactionPatch,
  type PendingTransactionRecord,
} from '../transactionLedger.js';

class MemoryStorage implements Storage {
  private readonly store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  // Test helpers.
  raw(key: string): string | null {
    return this.getItem(key);
  }
}

function writeLedger(storage: MemoryStorage, payload: unknown): void {
  storage.setItem(TRANSACTION_LEDGER_STORAGE_KEY, JSON.stringify(payload));
}

function makePatch(overrides: Partial<PendingTransactionPatch> = {}): PendingTransactionPatch {
  return {
    actionId: 'act-1',
    cluster: 'mainnet-beta',
    workflowSource: 'browser',
    kind: 'send_sol',
    ...overrides,
  };
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('transactionLedger storage key', () => {
  it('uses the v1 namespaced key', () => {
    expect(TRANSACTION_LEDGER_STORAGE_KEY).toBe('solana-agent-wallet-pending-transactions-v1');
  });
});

describe('loadTransactionLedger', () => {
  it('returns an empty array when storage is missing', () => {
    expect(loadTransactionLedger(storage)).toEqual([]);
  });

  it('returns an empty array when storage throws on access', () => {
    const throwingStorage: Storage = {
      length: 0,
      clear: () => {},
      key: () => null,
      removeItem: () => {},
      setItem: () => {},
      getItem: () => {
        throw new Error('storage exploded');
      },
    };
    expect(loadTransactionLedger(throwingStorage)).toEqual([]);
  });

  it('returns an empty array when payload is malformed JSON', () => {
    storage.setItem(TRANSACTION_LEDGER_STORAGE_KEY, '{not json');
    expect(loadTransactionLedger(storage)).toEqual([]);
  });

  it('returns an empty array when payload has wrong version', () => {
    writeLedger(storage, { version: 9, records: [] });
    expect(loadTransactionLedger(storage)).toEqual([]);
  });

  it('returns an empty array when payload records is not an array', () => {
    writeLedger(storage, { version: 1, records: 'oops' });
    expect(loadTransactionLedger(storage)).toEqual([]);
  });

  it('drops records missing required fields', () => {
    writeLedger(storage, {
      version: 1,
      records: [
        // valid
        {
          id: 'good-1',
          actionId: 'act-good',
          cluster: 'mainnet-beta',
          workflowSource: 'browser',
          kind: 'send_sol',
          phase: 'prepared',
          attemptCount: 0,
          createdAt: '2026-05-09T10:00:00.000Z',
          updatedAt: '2026-05-09T10:00:00.000Z',
        },
        // missing actionId
        {
          id: 'bad-1',
          cluster: 'mainnet-beta',
          workflowSource: 'browser',
          kind: 'send_sol',
          phase: 'prepared',
          attemptCount: 0,
          createdAt: '2026-05-09T10:00:00.000Z',
          updatedAt: '2026-05-09T10:00:00.000Z',
        },
        // invalid workflowSource
        {
          id: 'bad-2',
          actionId: 'act-bad',
          cluster: 'mainnet-beta',
          workflowSource: 'martians',
          kind: 'send_sol',
          phase: 'prepared',
          attemptCount: 0,
          createdAt: '2026-05-09T10:00:00.000Z',
          updatedAt: '2026-05-09T10:00:00.000Z',
        },
        // not an object at all
        'definitely not a record',
      ],
    });

    const records = loadTransactionLedger(storage);
    expect(records.map((r) => r.id)).toEqual(['good-1']);
  });

  it('normalizes records and sorts newest first', () => {
    writeLedger(storage, {
      version: 1,
      records: [
        {
          id: 'older',
          actionId: 'act-older',
          cluster: 'mainnet-beta',
          workflowSource: 'browser',
          kind: 'send_sol',
          phase: 'prepared',
          attemptCount: 0,
          createdAt: '2026-05-09T10:00:00.000Z',
          updatedAt: '2026-05-09T10:00:00.000Z',
        },
        {
          id: 'newer',
          actionId: 'act-newer',
          cluster: 'mainnet-beta',
          workflowSource: 'browser',
          kind: 'send_sol',
          phase: 'unknown_phase',
          attemptCount: -5,
          createdAt: '2026-05-09T11:00:00.000Z',
          updatedAt: '2026-05-09T11:30:00.000Z',
        },
      ],
    });

    const records = loadTransactionLedger(storage);
    expect(records.map((r) => r.id)).toEqual(['newer', 'older']);
    // normalization: unknown phase -> prepared, negative attemptCount -> 0
    expect(records[0]?.phase).toBe('prepared');
    expect(records[0]?.attemptCount).toBe(0);
  });

  it('auto-fills explorerUrl when a txid is present without one stored', () => {
    writeLedger(storage, {
      version: 1,
      records: [
        {
          id: 'rec-1',
          actionId: 'act-with-tx',
          cluster: 'devnet',
          workflowSource: 'browser',
          kind: 'send_sol',
          phase: 'submitted',
          attemptCount: 1,
          txid: 'tx-abc',
          createdAt: '2026-05-09T10:00:00.000Z',
          updatedAt: '2026-05-09T10:00:00.000Z',
        },
      ],
    });

    const records = loadTransactionLedger(storage);
    expect(records[0]?.explorerUrl).toBe('https://solscan.io/tx/tx-abc?cluster=devnet');
  });
});

describe('saveTransactionLedger', () => {
  it('serializes a v1 document and sorts newest first', () => {
    const records: PendingTransactionRecord[] = [
      {
        id: 'a',
        actionId: 'act-a',
        cluster: 'mainnet-beta',
        workflowSource: 'browser',
        kind: 'send_sol',
        phase: 'prepared',
        attemptCount: 0,
        createdAt: '2026-05-09T08:00:00.000Z',
        updatedAt: '2026-05-09T08:00:00.000Z',
      },
      {
        id: 'b',
        actionId: 'act-b',
        cluster: 'mainnet-beta',
        workflowSource: 'browser',
        kind: 'send_sol',
        phase: 'submitted',
        attemptCount: 1,
        createdAt: '2026-05-09T09:00:00.000Z',
        updatedAt: '2026-05-09T09:30:00.000Z',
      },
    ];

    saveTransactionLedger(records, storage);
    const raw = storage.raw(TRANSACTION_LEDGER_STORAGE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string) as { version: number; records: PendingTransactionRecord[] };
    expect(parsed.version).toBe(1);
    expect(parsed.records.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('removes the storage key when given zero records', () => {
    storage.setItem(TRANSACTION_LEDGER_STORAGE_KEY, JSON.stringify({ version: 1, records: [] }));
    saveTransactionLedger([], storage);
    expect(storage.raw(TRANSACTION_LEDGER_STORAGE_KEY)).toBeNull();
  });

  it('trims to the max record cap, keeping the newest', () => {
    const records: PendingTransactionRecord[] = [];
    const overflow = TRANSACTION_LEDGER_MAX_RECORDS + 25;
    for (let i = 0; i < overflow; i += 1) {
      const ts = new Date(2026, 0, 1, 0, 0, i).toISOString();
      records.push({
        id: `rec-${i}`,
        actionId: `act-${i}`,
        cluster: 'mainnet-beta',
        workflowSource: 'browser',
        kind: 'send_sol',
        phase: 'prepared',
        attemptCount: 0,
        createdAt: ts,
        updatedAt: ts,
      });
    }

    saveTransactionLedger(records, storage);
    const loaded = loadTransactionLedger(storage);
    expect(loaded.length).toBe(TRANSACTION_LEDGER_MAX_RECORDS);
    // newest should be the last-pushed record
    expect(loaded[0]?.id).toBe(`rec-${overflow - 1}`);
    // oldest kept should be at index 0 of the trimmed window
    const oldestKept = loaded[loaded.length - 1];
    const trimmedIndex = overflow - TRANSACTION_LEDGER_MAX_RECORDS;
    expect(oldestKept?.id).toBe(`rec-${trimmedIndex}`);
  });
});

describe('upsertPendingTransaction', () => {
  it('creates a new record when no match exists', () => {
    const result = upsertPendingTransaction(
      makePatch({ id: 'rec-x', phase: 'wallet_signed', attemptCount: 1 }),
      storage,
    );
    expect(result.id).toBe('rec-x');
    expect(result.phase).toBe('wallet_signed');
    expect(result.attemptCount).toBe(1);
    expect(result.createdAt).toBe(result.updatedAt);
    expect(loadTransactionLedger(storage)).toHaveLength(1);
  });

  it('generates a stable-shaped id when missing', () => {
    const result = upsertPendingTransaction(makePatch({ actionId: 'act-stable' }), storage);
    expect(result.id).toMatch(/^tx-ledger-act-stable-\d+-[a-z0-9]+$/);
  });

  it('updates an existing record by id without duplicating', () => {
    upsertPendingTransaction(makePatch({ id: 'shared', phase: 'wallet_signed' }), storage);
    const updated = upsertPendingTransaction(
      makePatch({ id: 'shared', phase: 'submitted', actionId: 'act-1' }),
      storage,
    );
    expect(updated.phase).toBe('submitted');
    expect(loadTransactionLedger(storage)).toHaveLength(1);
  });

  it('updates an existing record by actionId when ids differ', () => {
    upsertPendingTransaction(makePatch({ id: 'one', actionId: 'act-same' }), storage);
    upsertPendingTransaction(
      makePatch({ actionId: 'act-same', phase: 'submitted', kind: 'send_sol' }),
      storage,
    );
    const records = loadTransactionLedger(storage);
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe('one');
    expect(records[0]?.phase).toBe('submitted');
  });

  it('updates an existing record by txid+cluster without duplicating', () => {
    upsertPendingTransaction(
      makePatch({ id: 'rec-1', actionId: 'act-a', txid: 'tx-xyz', cluster: 'mainnet-beta' }),
      storage,
    );
    upsertPendingTransaction(
      makePatch({
        actionId: 'act-b',
        txid: 'tx-xyz',
        cluster: 'mainnet-beta',
        phase: 'confirmed',
        confirmedAt: '2026-05-09T11:00:00.000Z',
      }),
      storage,
    );
    const records = loadTransactionLedger(storage);
    expect(records).toHaveLength(1);
    expect(records[0]?.phase).toBe('confirmed');
    expect(records[0]?.confirmedAt).toBe('2026-05-09T11:00:00.000Z');
  });

  it('does not match by txid when clusters differ', () => {
    upsertPendingTransaction(
      makePatch({ id: 'mainnet-rec', txid: 'tx-1', cluster: 'mainnet-beta', actionId: 'act-mainnet' }),
      storage,
    );
    upsertPendingTransaction(
      makePatch({ txid: 'tx-1', cluster: 'devnet', actionId: 'act-devnet' }),
      storage,
    );
    expect(loadTransactionLedger(storage)).toHaveLength(2);
  });

  it('preserves txid/signed hash/signed bytes when later patches omit them', () => {
    upsertPendingTransaction(
      makePatch({
        id: 'sticky',
        txid: 'tx-old',
        signedTransactionBase64: 'base64-bytes',
        signedTransactionHash: 'sha256hex',
        phase: 'wallet_signed',
      }),
      storage,
    );
    const merged = upsertPendingTransaction(
      makePatch({ id: 'sticky', phase: 'broadcasting', attemptCount: 2 }),
      storage,
    );
    expect(merged.txid).toBe('tx-old');
    expect(merged.signedTransactionBase64).toBe('base64-bytes');
    expect(merged.signedTransactionHash).toBe('sha256hex');
    expect(merged.attemptCount).toBe(2);
  });

  it('lets callers explicitly clear a signed artifact by passing an empty string', () => {
    upsertPendingTransaction(
      makePatch({ id: 'clearable', txid: 'tx-1', signedTransactionBase64: 'bytes' }),
      storage,
    );
    const cleared = upsertPendingTransaction(
      makePatch({ id: 'clearable', txid: '', signedTransactionBase64: '' }),
      storage,
    );
    expect(cleared.txid).toBeUndefined();
    expect(cleared.signedTransactionBase64).toBeUndefined();
  });

  it('auto-fills explorerUrl when a txid is added without explorerUrl', () => {
    const record = upsertPendingTransaction(
      makePatch({ id: 'with-tx', txid: 'tx-explorer', cluster: 'devnet' }),
      storage,
    );
    expect(record.explorerUrl).toBe('https://solscan.io/tx/tx-explorer?cluster=devnet');
  });

  it('preserves createdAt across updates', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T10:00:00.000Z'));
    const first = upsertPendingTransaction(makePatch({ id: 'time-1' }), storage);
    vi.setSystemTime(new Date('2026-05-09T10:05:00.000Z'));
    const second = upsertPendingTransaction(
      makePatch({ id: 'time-1', phase: 'submitted' }),
      storage,
    );
    expect(second.createdAt).toBe(first.createdAt);
    expect(Date.parse(second.updatedAt)).toBeGreaterThan(Date.parse(first.updatedAt));
  });

  it('throws when required fields are missing', () => {
    expect(() =>
      upsertPendingTransaction(
        // @ts-expect-error -- exercising runtime guard
        { cluster: 'mainnet-beta', workflowSource: 'browser', kind: 'send_sol' },
        storage,
      ),
    ).toThrowError(/actionId/);
  });
});

describe('lookup helpers', () => {
  it('findPendingTransactionByAction returns the matching record', () => {
    upsertPendingTransaction(makePatch({ id: 'one', actionId: 'act-find' }), storage);
    const found = findPendingTransactionByAction('act-find', storage);
    expect(found?.id).toBe('one');
  });

  it('findPendingTransactionByAction returns undefined when missing', () => {
    expect(findPendingTransactionByAction('nope', storage)).toBeUndefined();
    expect(findPendingTransactionByAction('', storage)).toBeUndefined();
  });

  it('findPendingTransactionByTxid honors cluster filter', () => {
    upsertPendingTransaction(
      makePatch({ id: 'main', txid: 'tx-1', cluster: 'mainnet-beta', actionId: 'act-main' }),
      storage,
    );
    upsertPendingTransaction(
      makePatch({ id: 'dev', txid: 'tx-1', cluster: 'devnet', actionId: 'act-dev' }),
      storage,
    );

    expect(findPendingTransactionByTxid('tx-1', 'devnet', storage)?.id).toBe('dev');
    expect(findPendingTransactionByTxid('tx-1', undefined, storage)).toBeDefined();
    expect(findPendingTransactionByTxid('', 'mainnet-beta', storage)).toBeUndefined();
  });
});

describe('markTransactionPhase', () => {
  it('updates phase and merges optional overlay fields', () => {
    const initial = upsertPendingTransaction(
      makePatch({ id: 'mark', phase: 'wallet_signed' }),
      storage,
    );
    const updated = markTransactionPhase(
      initial.id,
      'confirmed',
      { confirmedAt: '2026-05-09T11:00:00.000Z', txid: 'tx-mark' },
      storage,
    );
    expect(updated?.phase).toBe('confirmed');
    expect(updated?.confirmedAt).toBe('2026-05-09T11:00:00.000Z');
    expect(updated?.txid).toBe('tx-mark');
    expect(updated?.explorerUrl).toBe('https://solscan.io/tx/tx-mark');
  });

  it('returns undefined when the record is missing', () => {
    expect(markTransactionPhase('ghost', 'submitted', undefined, storage)).toBeUndefined();
  });

  it('refuses invalid phases', () => {
    upsertPendingTransaction(makePatch({ id: 'phase-guard' }), storage);
    // @ts-expect-error -- exercising runtime guard
    expect(markTransactionPhase('phase-guard', 'bogus', undefined, storage)).toBeUndefined();
  });
});

describe('removePendingTransaction', () => {
  it('removes only the targeted record', () => {
    upsertPendingTransaction(makePatch({ id: 'keep', actionId: 'act-keep' }), storage);
    upsertPendingTransaction(makePatch({ id: 'drop', actionId: 'act-drop' }), storage);
    removePendingTransaction('drop', storage);
    const remaining = loadTransactionLedger(storage);
    expect(remaining.map((r) => r.id)).toEqual(['keep']);
  });

  it('is a no-op when id is unknown', () => {
    upsertPendingTransaction(makePatch({ id: 'untouched' }), storage);
    removePendingTransaction('nope', storage);
    expect(loadTransactionLedger(storage)).toHaveLength(1);
  });
});

describe('pendingTransactionsNeedingReconciliation', () => {
  const fixed = new Date('2026-05-09T12:00:00.000Z');

  const baseRecord = (overrides: Partial<PendingTransactionRecord>): PendingTransactionRecord => ({
    id: 'rec',
    actionId: 'act',
    cluster: 'mainnet-beta',
    workflowSource: 'browser',
    kind: 'send_sol',
    phase: 'submitted',
    attemptCount: 0,
    createdAt: '2026-05-09T10:00:00.000Z',
    updatedAt: '2026-05-09T10:00:00.000Z',
    ...overrides,
  });

  it('includes wallet_signed/broadcasting/submitted/confirming/ambiguous and excludes confirmed/failed/prepared/wallet_opening', () => {
    const records: PendingTransactionRecord[] = [
      baseRecord({ id: 'r-prepared', phase: 'prepared' }),
      baseRecord({ id: 'r-wallet-opening', phase: 'wallet_opening' }),
      baseRecord({ id: 'r-wallet-signed', phase: 'wallet_signed' }),
      baseRecord({ id: 'r-broadcasting', phase: 'broadcasting' }),
      baseRecord({ id: 'r-submitted', phase: 'submitted' }),
      baseRecord({ id: 'r-confirming', phase: 'confirming' }),
      baseRecord({ id: 'r-ambiguous', phase: 'ambiguous' }),
      baseRecord({ id: 'r-confirmed', phase: 'confirmed' }),
      baseRecord({ id: 'r-failed', phase: 'failed' }),
    ];

    const result = pendingTransactionsNeedingReconciliation(records, fixed);
    const ids = new Set(result.map((r) => r.id));
    expect(ids).toEqual(
      new Set(['r-wallet-signed', 'r-broadcasting', 'r-submitted', 'r-confirming', 'r-ambiguous']),
    );
    expect(ids.has('r-prepared')).toBe(false);
    expect(ids.has('r-wallet-opening')).toBe(false);
    expect(ids.has('r-confirmed')).toBe(false);
    expect(ids.has('r-failed')).toBe(false);
  });

  it('skips records whose nextRetryAt is in the future', () => {
    const records: PendingTransactionRecord[] = [
      baseRecord({
        id: 'r-due-now',
        phase: 'broadcasting',
        nextRetryAt: '2026-05-09T11:00:00.000Z',
      }),
      baseRecord({
        id: 'r-due-future',
        phase: 'broadcasting',
        nextRetryAt: '2026-05-09T13:00:00.000Z',
      }),
      baseRecord({ id: 'r-no-retry', phase: 'broadcasting' }),
    ];
    const result = pendingTransactionsNeedingReconciliation(records, fixed);
    expect(result.map((r) => r.id).sort()).toEqual(['r-due-now', 'r-no-retry']);
  });

  it('returns newest first', () => {
    const records: PendingTransactionRecord[] = [
      baseRecord({ id: 'older', phase: 'submitted', updatedAt: '2026-05-09T09:00:00.000Z' }),
      baseRecord({ id: 'newest', phase: 'submitted', updatedAt: '2026-05-09T11:30:00.000Z' }),
      baseRecord({ id: 'middle', phase: 'submitted', updatedAt: '2026-05-09T10:30:00.000Z' }),
    ];
    const result = pendingTransactionsNeedingReconciliation(records, fixed);
    expect(result.map((r) => r.id)).toEqual(['newest', 'middle', 'older']);
  });

  it('falls back to loading from storage when records arg is omitted', () => {
    upsertPendingTransaction(
      makePatch({ id: 'live', phase: 'submitted' }),
      storage,
    );
    upsertPendingTransaction(
      makePatch({ id: 'done', phase: 'confirmed', actionId: 'act-done' }),
      storage,
    );
    const result = pendingTransactionsNeedingReconciliation(undefined, fixed, storage);
    expect(result.map((r) => r.id)).toEqual(['live']);
  });
});

describe('signedTransactionHashFromBase64', () => {
  it('produces a stable hex string per input', async () => {
    const a = await signedTransactionHashFromBase64('AAAA');
    const b = await signedTransactionHashFromBase64('AAAA');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hashes for different inputs', async () => {
    const a = await signedTransactionHashFromBase64('AAAA');
    const b = await signedTransactionHashFromBase64('BBBB');
    expect(a).not.toBe(b);
  });

  it('matches the canonical SHA-256 of the input text', async () => {
    const hex = await signedTransactionHashFromBase64('hello');
    // SHA-256("hello")
    expect(hex).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('falls back to node:crypto when Web Crypto is unavailable', async () => {
    vi.stubGlobal('crypto', undefined);
    const hex = await signedTransactionHashFromBase64('hello');
    expect(hex).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});

describe('explorerUrlForTxid', () => {
  it('uses no cluster query for mainnet', () => {
    expect(explorerUrlForTxid('tx-1', 'mainnet-beta')).toBe('https://solscan.io/tx/tx-1');
    expect(explorerUrlForTxid('tx-2', 'mainnet')).toBe('https://solscan.io/tx/tx-2');
  });

  it('adds a cluster query for non-mainnet clusters', () => {
    expect(explorerUrlForTxid('tx-3', 'devnet')).toBe('https://solscan.io/tx/tx-3?cluster=devnet');
    expect(explorerUrlForTxid('tx-4', 'testnet')).toBe('https://solscan.io/tx/tx-4?cluster=testnet');
  });

  it('encodes unsafe characters', () => {
    expect(explorerUrlForTxid('tx with space', 'devnet')).toBe(
      'https://solscan.io/tx/tx%20with%20space?cluster=devnet',
    );
  });

  it('falls back to a mainnet-shaped URL when cluster is empty', () => {
    expect(explorerUrlForTxid('tx-5', '')).toBe('https://solscan.io/tx/tx-5');
  });
});
