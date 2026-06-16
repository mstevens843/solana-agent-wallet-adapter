import { PostgresWorkflowStore } from './postgresStore.js';
import type { WorkflowStore } from './store.js';
import { loadTreasuryConfig, TreasuryConfigError } from './treasuryConfig.js';

export interface RuntimeWorkflowStore extends WorkflowStore {
  migrate(): Promise<void>;
  close?(): Promise<void>;
}

export interface RuntimeWorkflowStoreOptions {
  env?: NodeJS.ProcessEnv;
  createPostgresStore?: () => RuntimeWorkflowStore;
}

const REQUIRED_PRODUCTION_ENV = ['DATABASE_URL', 'SESSION_SECRET', 'AGENTIC_PUBLIC_ORIGIN'] as const;
const REQUIRED_BRIDGE_PAIRING_FRONTEND_ENV = [
  'VITE_AGENTIC_ANDROID_DEVICE_AGENT',
  'VITE_AGENTIC_IOS_DEVICE_AGENT',
] as const;
const MIN_SESSION_SECRET_LENGTH = 32;

export async function createRuntimeWorkflowStore(
  options: RuntimeWorkflowStoreOptions = {},
): Promise<RuntimeWorkflowStore | undefined> {
  const env = options.env ?? process.env;
  if (!shouldUsePostgresWorkflowStore(env)) {
    return undefined;
  }

  const store = options.createPostgresStore?.() ?? new PostgresWorkflowStore({
    connectionString: env.DATABASE_URL,
  });
  await store.migrate();
  return store;
}

export function shouldUsePostgresWorkflowStore(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.DATABASE_URL?.trim()) && env.NODE_ENV !== 'test';
}

export function assertProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (!isProductionRuntime(env)) return;
  const missing = REQUIRED_PRODUCTION_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required production environment variable(s): ${missing.join(', ')}.`);
  }

  if (env.AGENTIC_MOCK_FINALIZATION === '1') {
    throw new Error('AGENTIC_MOCK_FINALIZATION must not be enabled in production.');
  }

  if (env.BRIDGE_PAIRING_ENABLED === '1') {
    const disabledFrontendFlags = REQUIRED_BRIDGE_PAIRING_FRONTEND_ENV.filter(
      (name) => !isEnabledProductionFlag(env[name]),
    );
    if (disabledFrontendFlags.length > 0) {
      throw new Error(
        `BRIDGE_PAIRING_ENABLED=1 requires enabled frontend build flag(s): ${disabledFrontendFlags.join(', ')}.`,
      );
    }
  }

  const sessionSecret = env.SESSION_SECRET?.trim() ?? '';
  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(`SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters in production.`);
  }

  try {
    const origin = new URL(env.AGENTIC_PUBLIC_ORIGIN ?? '');
    if (origin.protocol !== 'https:') {
      throw new Error('AGENTIC_PUBLIC_ORIGIN must use https.');
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'invalid URL';
    throw new Error(`AGENTIC_PUBLIC_ORIGIN is invalid: ${detail}`);
  }

  // Surface BYOK / streaming key misconfiguration at boot rather than at first use.
  // Absence degrades gracefully (feature disabled) so we warn; a present-but-short
  // connector key is a clear misconfig, so we fail fast.
  const connectorKey = env.CONNECTOR_SECRET_KEY?.trim();
  if (!connectorKey) {
    // eslint-disable-next-line no-console
    console.warn('[config] CONNECTOR_SECRET_KEY is not set — hosted BYOK connector keys will be unavailable.');
  } else if (connectorKey.length < 32) {
    throw new Error('CONNECTOR_SECRET_KEY must be at least 32 characters.');
  }
  if (!env.STREAMING_SESSION_ENCRYPTION_KEY?.trim()) {
    // eslint-disable-next-line no-console
    console.warn('[config] STREAMING_SESSION_ENCRYPTION_KEY is not set — streaming settlement sessions will be unavailable.');
  }

  try {
    const treasury = loadTreasuryConfig(env);
    if (!treasury.wallet) {
      // eslint-disable-next-line no-console
      console.log('[treasury] TREASURY_WALLET not configured — skill platform fee disabled.');
    } else {
      // eslint-disable-next-line no-console
      console.log(
        `[treasury] platform fee active: wallet=${treasury.wallet.slice(0, 4)}...${treasury.wallet.slice(-4)} feeBps=${treasury.feeBps}`,
      );
    }
  } catch (err) {
    if (err instanceof TreasuryConfigError) throw err;
    throw err;
  }
}

export function isProductionRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' || env.RENDER === 'true';
}

function isEnabledProductionFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}
