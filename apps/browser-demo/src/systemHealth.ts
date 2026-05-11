// System Health Runner
//
// Read-only probes against external services so the UI can surface system
// readiness before users draft or execute actions. Each probe is pure: it
// takes its inputs explicitly so tests can exercise it without touching
// real network state.

import { Connection } from '@solana/web3.js';

export type HealthStatus = 'ok' | 'warn' | 'fail' | 'unknown';
export type HealthCheckId = 'rpc' | 'jupiter' | 'wallet' | 'cluster' | 'ai';

export type RemediationIntent =
  | 'connect-wallet'
  | 'open-settings'
  | 'reload'
  | 'switch-cluster';

export interface RemediationAction {
  label: string;
  intent: RemediationIntent;
}

export interface HealthCheck {
  id: HealthCheckId;
  label: string;
  status: HealthStatus;
  message: string;
  detail?: string;
  latencyMs?: number;
  checkedAt: string;
  remediation?: RemediationAction;
}

export interface SystemHealth {
  checks: Record<HealthCheckId, HealthCheck>;
  lastCheckedAt: string;
  worstStatus: HealthStatus;
}

export type AiHealthMode = 'session' | 'bridge' | 'hosted';

export interface HealthCheckInputs {
  rpcUrl: string;
  cluster: string;
  walletAddress: string | null;
  walletConnected: boolean;
  aiMode: AiHealthMode;
  bridgeUrl: string | null;
  bridgeToken: string | null;
  bridgeActive: boolean;
  jupiterProbeUrl?: string;
  signal?: AbortSignal;
}

const DEFAULT_JUPITER_PROBE_URL =
  'https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=50';

const KNOWN_GENESIS_HASHES: Record<string, string> = {
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
};

const RPC_TIMEOUT_MS = 7000;
const JUPITER_TIMEOUT_MS = 6000;
const AI_TIMEOUT_MS = 5000;
const CLUSTER_TIMEOUT_MS = 7000;
const SLOW_LATENCY_MS = 2000;

export async function runHealthCheck(inputs: HealthCheckInputs): Promise<SystemHealth> {
  const probeUrl = inputs.jupiterProbeUrl ?? DEFAULT_JUPITER_PROBE_URL;
  const [rpc, jupiter, cluster, ai] = await Promise.all([
    checkRpc(inputs.rpcUrl, inputs.signal),
    checkJupiter(probeUrl, inputs.signal),
    checkCluster(inputs.cluster, inputs.rpcUrl, inputs.signal),
    checkAi(inputs),
  ]);
  const wallet = checkWallet(inputs.walletAddress, inputs.walletConnected);
  const checks: Record<HealthCheckId, HealthCheck> = { rpc, jupiter, wallet, cluster, ai };
  return {
    checks,
    lastCheckedAt: new Date().toISOString(),
    worstStatus: worstStatus(Object.values(checks)),
  };
}

export async function checkRpc(rpcUrl: string, signal?: AbortSignal): Promise<HealthCheck> {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  try {
    const connection = new Connection(rpcUrl, 'confirmed');
    const blockhash = await withTimeout(
      connection.getLatestBlockhash(),
      RPC_TIMEOUT_MS,
      'RPC probe',
      signal,
    );
    const latencyMs = Date.now() - startedAt;
    return {
      id: 'rpc',
      label: 'RPC',
      status: latencyMs > SLOW_LATENCY_MS ? 'warn' : 'ok',
      message: latencyMs > SLOW_LATENCY_MS ? 'RPC slow' : 'RPC reachable',
      detail: `${latencyMs}ms · slot ${blockhash.lastValidBlockHeight ?? '—'}`,
      latencyMs,
      checkedAt,
    };
  } catch (err) {
    return {
      id: 'rpc',
      label: 'RPC',
      status: 'fail',
      message: 'RPC unreachable',
      detail: errorMessage(err),
      checkedAt,
      remediation: { label: 'Open settings', intent: 'open-settings' },
    };
  }
}

export async function checkJupiter(
  probeUrl: string,
  signal?: AbortSignal,
): Promise<HealthCheck> {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), JUPITER_TIMEOUT_MS);
  const combinedSignal = combineSignals(controller.signal, signal);
  try {
    const response = await fetch(probeUrl, { method: 'GET', signal: combinedSignal });
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return {
        id: 'jupiter',
        label: 'Jupiter',
        status: 'warn',
        message: 'Jupiter quote API degraded',
        detail: `HTTP ${response.status}`,
        latencyMs,
        checkedAt,
      };
    }
    return {
      id: 'jupiter',
      label: 'Jupiter',
      status: latencyMs > SLOW_LATENCY_MS ? 'warn' : 'ok',
      message: latencyMs > SLOW_LATENCY_MS ? 'Jupiter slow' : 'Jupiter reachable',
      detail: `${latencyMs}ms`,
      latencyMs,
      checkedAt,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    return {
      id: 'jupiter',
      label: 'Jupiter',
      status: 'fail',
      message: 'Jupiter unreachable',
      detail: errorMessage(err),
      checkedAt,
    };
  }
}

export function checkWallet(
  walletAddress: string | null,
  walletConnected: boolean,
): HealthCheck {
  const checkedAt = new Date().toISOString();
  if (!walletConnected || !walletAddress) {
    return {
      id: 'wallet',
      label: 'Wallet',
      status: 'fail',
      message: 'Wallet not connected',
      detail: 'Connect a wallet to draft or execute actions.',
      checkedAt,
      remediation: { label: 'Connect wallet', intent: 'connect-wallet' },
    };
  }
  return {
    id: 'wallet',
    label: 'Wallet',
    status: 'ok',
    message: 'Wallet connected',
    detail: shortAddress(walletAddress),
    checkedAt,
  };
}

export async function checkCluster(
  cluster: string,
  rpcUrl: string,
  signal?: AbortSignal,
): Promise<HealthCheck> {
  const checkedAt = new Date().toISOString();
  if (cluster === 'localnet') {
    return {
      id: 'cluster',
      label: 'Cluster',
      status: 'ok',
      message: 'Localnet',
      detail: 'Genesis hash check skipped on localnet.',
      checkedAt,
    };
  }
  const expectedHash = KNOWN_GENESIS_HASHES[cluster];
  if (!expectedHash) {
    return {
      id: 'cluster',
      label: 'Cluster',
      status: 'warn',
      message: 'Unknown cluster',
      detail: cluster,
      checkedAt,
    };
  }
  try {
    const connection = new Connection(rpcUrl, 'confirmed');
    const hash = await withTimeout(
      connection.getGenesisHash(),
      CLUSTER_TIMEOUT_MS,
      'Cluster probe',
      signal,
    );
    if (hash !== expectedHash) {
      return {
        id: 'cluster',
        label: 'Cluster',
        status: 'fail',
        message: 'Cluster mismatch',
        detail: `RPC reports a different network than ${cluster}.`,
        checkedAt,
        remediation: { label: 'Switch cluster', intent: 'switch-cluster' },
      };
    }
    return {
      id: 'cluster',
      label: 'Cluster',
      status: 'ok',
      message: clusterDisplayName(cluster),
      checkedAt,
    };
  } catch (err) {
    return {
      id: 'cluster',
      label: 'Cluster',
      status: 'unknown',
      message: 'Cluster check skipped',
      detail: errorMessage(err),
      checkedAt,
    };
  }
}

export async function checkAi(inputs: HealthCheckInputs): Promise<HealthCheck> {
  const checkedAt = new Date().toISOString();
  if (inputs.aiMode === 'session') {
    return {
      id: 'ai',
      label: 'AI',
      status: 'ok',
      message: 'Browser-session AI',
      detail: 'Uses an in-browser key. Provider health is shown after a request.',
      checkedAt,
    };
  }
  if (inputs.aiMode === 'bridge') {
    if (!inputs.bridgeActive || !inputs.bridgeUrl) {
      return {
        id: 'ai',
        label: 'AI',
        status: 'warn',
        message: 'Local bridge offline',
        detail: 'Start the local bridge to enable AI planning.',
        checkedAt,
        remediation: { label: 'Open settings', intent: 'open-settings' },
      };
    }
    return probeUrlForAi(
      new URL('/bridge/ai/status', ensureTrailingSlash(inputs.bridgeUrl)).toString(),
      inputs.bridgeToken,
      'Local bridge AI',
      inputs.signal,
    );
  }
  return probeUrlForAi('/api/ai/status', null, 'Hosted AI', inputs.signal);
}

async function probeUrlForAi(
  url: string,
  bridgeToken: string | null,
  label: string,
  signal?: AbortSignal,
): Promise<HealthCheck> {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  const combinedSignal = combineSignals(controller.signal, signal);
  const headers: HeadersInit = bridgeToken ? { 'x-agent-wallet-token': bridgeToken } : {};
  try {
    const response = await fetch(url, { headers, signal: combinedSignal });
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return {
        id: 'ai',
        label: 'AI',
        status: 'warn',
        message: `${label} degraded`,
        detail: `HTTP ${response.status}`,
        latencyMs,
        checkedAt,
      };
    }
    return {
      id: 'ai',
      label: 'AI',
      status: latencyMs > SLOW_LATENCY_MS ? 'warn' : 'ok',
      message: `${label} ready`,
      detail: `${latencyMs}ms`,
      latencyMs,
      checkedAt,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    return {
      id: 'ai',
      label: 'AI',
      status: 'unknown',
      message: `${label} status unknown`,
      detail: errorMessage(err),
      checkedAt,
    };
  }
}

export function worstStatus(checks: HealthCheck[]): HealthStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  if (checks.length > 0 && checks.every((c) => c.status === 'ok')) return 'ok';
  return 'unknown';
}

export function statusFlipped(prev: SystemHealth | null, next: SystemHealth): boolean {
  if (!prev) return true;
  if (prev.worstStatus !== next.worstStatus) return true;
  for (const id of Object.keys(next.checks) as HealthCheckId[]) {
    if (prev.checks[id]?.status !== next.checks[id]?.status) return true;
  }
  return false;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    const abortListener = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      reject(new Error(`${label} aborted`));
    };
    if (signal) {
      if (signal.aborted) {
        abortListener();
        return;
      }
      signal.addEventListener('abort', abortListener, { once: true });
    }
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', abortListener);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', abortListener);
        reject(err);
      },
    );
  });
}

function combineSignals(a: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!b) return a;
  if (a.aborted) return a;
  if (b.aborted) return b;
  const controller = new AbortController();
  const forward = () => controller.abort();
  a.addEventListener('abort', forward, { once: true });
  b.addEventListener('abort', forward, { once: true });
  return controller.signal;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function shortAddress(value: string): string {
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function clusterDisplayName(cluster: string): string {
  if (cluster === 'mainnet-beta') return 'Mainnet';
  if (cluster === 'devnet') return 'Devnet';
  if (cluster === 'testnet') return 'Testnet';
  if (cluster === 'localnet') return 'Localnet';
  return cluster;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
