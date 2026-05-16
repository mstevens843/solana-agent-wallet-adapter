import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createIndexedDbPersistence,
  createMemoryPersistence,
} from '../storage/persistence.js';
import {
  SECRETS_DB_NAME,
  STATE_META_STORE,
} from '../storage/secretStore.js';

import { createFakeIndexedDb, type FakeIndexedDbHarness } from './fakeIndexedDb.js';

describe('createMemoryPersistence', () => {
  it('load() returns sensible defaults', async () => {
    const persistence = createMemoryPersistence();
    expect(await persistence.load()).toEqual({
      state: 'stopped',
      error: null,
      lastTransitionAtMs: 0,
    });
  });

  it('round-trips state with error fields', async () => {
    const persistence = createMemoryPersistence();
    await persistence.save('error', { code: 'invalid_config', subcode: 'missing_model', message: 'no model' });
    const snap = await persistence.load();
    expect(snap.state).toBe('error');
    expect(snap.error).toEqual({ code: 'invalid_config', subcode: 'missing_model', message: 'no model' });
    expect(snap.lastTransitionAtMs).toBeGreaterThan(0);
  });

  it('clears error fields when state transitions to stopped', async () => {
    const persistence = createMemoryPersistence();
    await persistence.save('error', { code: 'invalid_config', message: 'boom' });
    await persistence.save('stopped', null);
    const snap = await persistence.load();
    expect(snap.state).toBe('stopped');
    expect(snap.error).toBeNull();
  });

  it('drops a blank subcode on round-trip', async () => {
    const persistence = createMemoryPersistence();
    await persistence.save('error', { code: 'x', subcode: '   ', message: 'm' });
    const snap = await persistence.load();
    expect(snap.error).toEqual({ code: 'x', message: 'm' });
    expect(snap.error).not.toHaveProperty('subcode');
  });
});

describe('createIndexedDbPersistence', () => {
  let fake: FakeIndexedDbHarness;

  beforeEach(() => {
    fake = createFakeIndexedDb();
    fake.install();
  });

  afterEach(() => {
    fake.uninstall();
  });

  it('load() returns defaults when no record exists', async () => {
    const persistence = createIndexedDbPersistence();
    const snap = await persistence.load();
    expect(snap).toEqual({ state: 'stopped', error: null, lastTransitionAtMs: 0 });
  });

  it('round-trips state and error', async () => {
    const persistence = createIndexedDbPersistence();
    const before = Date.now();
    await persistence.save('error', { code: 'invalid_config', subcode: 'missing_model', message: 'no model' });
    const snap = await persistence.load();
    expect(snap.state).toBe('error');
    expect(snap.error).toEqual({ code: 'invalid_config', subcode: 'missing_model', message: 'no model' });
    expect(snap.lastTransitionAtMs).toBeGreaterThanOrEqual(before);
  });

  it('omits error fields entirely when save(stopped, null) follows an error', async () => {
    const persistence = createIndexedDbPersistence();
    await persistence.save('error', { code: 'invalid_config', subcode: 'missing_model', message: 'no model' });
    await persistence.save('stopped', null);

    const record = fake.peek(SECRETS_DB_NAME, STATE_META_STORE, 'state') as Record<string, unknown>;
    expect(record).toBeDefined();
    expect(record.state).toBe('stopped');
    expect('errorCode' in record).toBe(false);
    expect('errorSubcode' in record).toBe(false);
    expect('errorMessage' in record).toBe(false);

    const snap = await persistence.load();
    expect(snap.state).toBe('stopped');
    expect(snap.error).toBeNull();
  });

  it('omits errorSubcode when subcode is missing or blank', async () => {
    const persistence = createIndexedDbPersistence();
    await persistence.save('error', { code: 'invalid_config', message: 'no subcode' });
    let record = fake.peek(SECRETS_DB_NAME, STATE_META_STORE, 'state') as Record<string, unknown>;
    expect(record.errorCode).toBe('invalid_config');
    expect('errorSubcode' in record).toBe(false);

    await persistence.save('error', { code: 'invalid_config', subcode: '   ', message: 'blank subcode' });
    record = fake.peek(SECRETS_DB_NAME, STATE_META_STORE, 'state') as Record<string, unknown>;
    expect('errorSubcode' in record).toBe(false);

    const snap = await persistence.load();
    expect(snap.error).toEqual({ code: 'invalid_config', message: 'blank subcode' });
    expect(snap.error).not.toHaveProperty('subcode');
  });

  it('updates lastTransitionAtMs on every save', async () => {
    const persistence = createIndexedDbPersistence();
    const t0 = Date.now();
    await persistence.save('starting', null);
    const first = (await persistence.load()).lastTransitionAtMs;
    expect(first).toBeGreaterThanOrEqual(t0);

    await new Promise((resolve) => setTimeout(resolve, 2));
    await persistence.save('running', null);
    const second = (await persistence.load()).lastTransitionAtMs;
    expect(second).toBeGreaterThan(first);
  });

  it('load() falls back to defaults when IDB open fails', async () => {
    const persistence = createIndexedDbPersistence();
    fake.failNextOpen('UnknownError', 'simulated open failure');
    const snap = await persistence.load();
    expect(snap).toEqual({ state: 'stopped', error: null, lastTransitionAtMs: 0 });
  });

  it('save() rejects with storage_unavailable when IDB open fails', async () => {
    const persistence = createIndexedDbPersistence();
    fake.failNextOpen('UnknownError', 'simulated open failure');
    await expect(persistence.save('starting', null)).rejects.toThrow(/^storage_unavailable:/);
  });

  it('reconstructs the error only when a non-blank errorCode is present in the record', async () => {
    const persistence = createIndexedDbPersistence();
    // Write a record directly with a blank errorCode — the loader must treat it as null.
    await persistence.save('error', { code: '   ', message: 'should be dropped' });
    const snap = await persistence.load();
    expect(snap.state).toBe('error');
    expect(snap.error).toBeNull();
  });
});
