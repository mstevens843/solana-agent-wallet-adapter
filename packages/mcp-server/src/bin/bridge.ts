#!/usr/bin/env node
import { randomBytes } from 'node:crypto';

import { defaultAgentsStorePath } from '../agentRegistry.js';
import { createBridgeServer } from '../bridgeServer.js';
import { loadConfig } from '../config.js';
import { loadDotEnv } from '../env.js';
import { bootstrapHostConnectorFactoriesFromConfig } from '../hostBootstrap.js';
import { JsonLabArtifactStore, defaultLabArtifactStorePath } from '../labArtifacts.js';
import { LocalBridgeBackend } from '../localBridgeBackend.js';
import { JsonPreparedActionStore, defaultPreparedActionStorePath } from '../preparedActions.js';
import { isTensorConfigured, setTensorClientFactory } from '../adapters/tensor/client.js';
import { buildTensorApiClient } from '../adapters/tensor/apiClient.js';
import { IosLinkBackend, type IosLinkWalletId } from '@solana-agent-wallet-adapter/ios-link';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadDotEnv(args.env);
  const config = await loadConfig(args.config);
  const token = args.token ?? process.env.BRIDGE_TOKEN ?? randomBytes(24).toString('base64url');
  const preparedActionsPath =
    args.preparedActions ?? process.env.AGENT_WALLET_PREPARED_ACTIONS ?? defaultPreparedActionStorePath();
  const labArtifactsPath =
    args.labArtifacts ?? process.env.AGENT_WALLET_LAB_ARTIFACTS ?? defaultLabArtifactStorePath(preparedActionsPath);
  const agentsPath =
    args.agents ?? process.env.AGENT_WALLET_AGENTS ?? defaultAgentsStorePath();
  const fallbackCallbackBaseUrl = `http://${args.host ?? '127.0.0.1'}:${args.port ?? 8787}/`;
  const backend = args.iosProvider
    ? new IosLinkBackend({
        provider: args.iosProvider,
        cluster: config.cluster,
        rpcUrl: config.rpcUrl,
        appUrl: args.iosAppUrl ?? process.env.IOS_APP_URL ?? 'https://solana-agent-wallet-adapter.local',
        callbackBaseUrl:
          args.iosCallbackBaseUrl ?? process.env.IOS_CALLBACK_BASE_URL ?? fallbackCallbackBaseUrl,
        callbackToken: token,
        reownProjectId: args.reownProjectId ?? process.env.REOWN_PROJECT_ID,
        walletConnectStorageDir: args.walletConnectStorageDir ?? process.env.WALLETCONNECT_STORAGE_DIR,
        logLevel: process.env.AGENT_WALLET_TRACE === '1' ? 'debug' : 'info',
      })
    : new LocalBridgeBackend({
        cluster: config.cluster,
        rpcUrl: config.rpcUrl,
        token,
      });
  // Wire SDK clients so connector approvals can build real unsigned transactions
  // through the local bridge instead of failing with "...sdk is not wired."
  bootstrapHostConnectorFactoriesFromConfig(config);
  // Tensor stays inline as a single-user bridge fallback: cloud users supply
  // their own TENSOR_API_KEY via Connectors UX (per-user secrets).
  if (!isTensorConfigured() && process.env.TENSOR_API_KEY?.trim()) {
    setTensorClientFactory(() => buildTensorApiClient());
  }
  const bridge = createBridgeServer({
    backend,
    actionConfig: config,
    preparedActions: new JsonPreparedActionStore(preparedActionsPath),
    labArtifacts: new JsonLabArtifactStore(labArtifactsPath),
    agentsPersistPath: agentsPath,
    ...(args.host !== undefined && { host: args.host }),
    ...(args.port !== undefined && { port: args.port }),
  });
  await bridge.start();
  console.error(`[solana-agent-wallet-bridge] listening: ${backend.getApprovalUrl()}`);

  const shutdown = async () => {
    console.error('[solana-agent-wallet-bridge] shutting down');
    await bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

interface CliArgs {
  config?: string;
  env?: string;
  host?: string;
  port?: number;
  token?: string;
  preparedActions?: string;
  labArtifacts?: string;
  agents?: string;
  iosProvider?: IosLinkWalletId;
  iosCallbackBaseUrl?: string;
  iosAppUrl?: string;
  reownProjectId?: string;
  walletConnectStorageDir?: string;
}

function parseArgs(args: string[]): CliArgs {
  const parsed: CliArgs = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--config') {
      parsed.config = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--env') {
      parsed.env = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--host') {
      parsed.host = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--port') {
      parsed.port = Number(requireValue(args, index, arg));
      if (!Number.isInteger(parsed.port) || parsed.port <= 0) {
        throw new Error('--port must be a positive integer.');
      }
      index += 1;
      continue;
    }
    if (arg === '--token') {
      parsed.token = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--prepared-actions') {
      parsed.preparedActions = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--lab-artifacts') {
      parsed.labArtifacts = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--agents') {
      parsed.agents = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--ios-provider') {
      parsed.iosProvider = requireValue(args, index, arg) as IosLinkWalletId;
      index += 1;
      continue;
    }
    if (arg === '--ios-callback-base-url') {
      parsed.iosCallbackBaseUrl = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--ios-app-url') {
      parsed.iosAppUrl = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--reown-project-id') {
      parsed.reownProjectId = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--walletconnect-storage-dir') {
      parsed.walletConnectStorageDir = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

main().catch((err) => {
  console.error('[solana-agent-wallet-bridge] fatal:', err);
  process.exit(1);
});
