import { describe, expect, it } from 'vitest';

import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import {
  assertProductionConfig,
  createRuntimeWorkflowStore,
  shouldUsePostgresWorkflowStore,
  type RuntimeWorkflowStore,
} from '../cloud/runtimeStore.js';

describe('runtime workflow store configuration', () => {
  it('uses Postgres only when DATABASE_URL is configured outside tests', () => {
    expect(shouldUsePostgresWorkflowStore({ DATABASE_URL: 'postgres://db', NODE_ENV: 'production' })).toBe(true);
    expect(shouldUsePostgresWorkflowStore({ DATABASE_URL: 'postgres://db', NODE_ENV: 'test' })).toBe(false);
    expect(shouldUsePostgresWorkflowStore({ NODE_ENV: 'production' })).toBe(false);
  });

  it('migrates the selected production Postgres store', async () => {
    let migrated = false;
    const fakeStore = Object.assign(new MemoryWorkflowStore(), {
      async migrate() {
        migrated = true;
      },
    }) as RuntimeWorkflowStore;

    const store = await createRuntimeWorkflowStore({
      env: { DATABASE_URL: 'postgres://db', NODE_ENV: 'production' },
      createPostgresStore: () => fakeStore,
    });

    expect(store).toBe(fakeStore);
    expect(migrated).toBe(true);
  });

  it('falls back to memory when DATABASE_URL is absent or NODE_ENV is test', async () => {
    await expect(createRuntimeWorkflowStore({ env: { NODE_ENV: 'production' } })).resolves.toBeUndefined();
    await expect(createRuntimeWorkflowStore({
      env: { DATABASE_URL: 'postgres://db', NODE_ENV: 'test' },
    })).resolves.toBeUndefined();
  });

  it('requires strong production environment values', () => {
    expect(() => assertProductionConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://db',
      SESSION_SECRET: 'short',
      AGENTIC_PUBLIC_ORIGIN: 'https://agentic-signer.com',
    })).toThrow(/SESSION_SECRET/);

    expect(() => assertProductionConfig({
      RENDER: 'true',
      DATABASE_URL: 'postgres://db',
      SESSION_SECRET: 'x'.repeat(32),
      AGENTIC_PUBLIC_ORIGIN: 'http://agentic-signer.com',
    })).toThrow(/https/);

    expect(() => assertProductionConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://db',
      SESSION_SECRET: 'x'.repeat(32),
      AGENTIC_PUBLIC_ORIGIN: 'https://agentic-signer.com',
    })).not.toThrow();
  });
});
