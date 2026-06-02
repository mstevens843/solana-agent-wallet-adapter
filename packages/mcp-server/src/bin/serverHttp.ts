#!/usr/bin/env node
import { createHttpServer } from '../httpServer.js';
import { createMockBackend } from '../mockBackend.js';
import { RemoteBridgeBackend } from '../remoteBridgeBackend.js';
import { loadConfig } from '../config.js';
import { loadDotEnv } from '../env.js';
import { JsonPreparedActionStore, defaultPreparedActionStorePath } from '../preparedActions.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadDotEnv(args.env);
  const port = args.port ?? Number(process.env.PORT ?? 8723);
  const host = args.host ?? process.env.HOST ?? '127.0.0.1';
  const path = args.path ?? process.env.MCP_HTTP_PATH ?? '/mcp';
  const stateful = args.stateful ?? process.env.MCP_STATEFUL === '1';
  const usesMock = args.mock || process.env.MCP_MOCK_BACKEND === '1';
  const bridgeUrl = args.bridgeUrl ?? process.env.BRIDGE_URL ?? process.env.AGENTIC_BRIDGE_URL;
  const bridgeToken = args.bridgeToken ?? process.env.BRIDGE_TOKEN;
  const httpToken = args.httpToken ?? process.env.MCP_HTTP_TOKEN;
  const allowNonLoopbackBind = process.env.MCP_HTTP_ALLOW_NON_LOOPBACK === '1';

  if (usesMock && bridgeUrl) {
    throw new Error('Choose either HTTP mock mode or bridge mode, not both.');
  }
  if (!usesMock && !bridgeUrl) {
    throw new Error('MCP HTTP server requires --bridge-url/BRIDGE_URL for a real wallet, or --mock/MCP_MOCK_BACKEND=1 for intentional mock backend mode.');
  }
  if (bridgeUrl && !bridgeToken) {
    throw new Error('MCP HTTP bridge mode requires --bridge-token or BRIDGE_TOKEN.');
  }

  const config = bridgeUrl ? await loadConfig(args.config) : undefined;
  const backend = bridgeUrl
    ? new RemoteBridgeBackend({ bridgeUrl, token: bridgeToken! })
    : createMockBackend();
  const handle = createHttpServer({
    backend,
    port,
    host,
    path,
    stateful,
    ...(httpToken !== undefined && { requireToken: httpToken }),
    ...(allowNonLoopbackBind && { allowNonLoopbackBind: true }),
    ...(config !== undefined && { actionConfig: config }),
    ...(config !== undefined && {
      preparedActions: new JsonPreparedActionStore(
        args.preparedActions ?? process.env.AGENT_WALLET_PREPARED_ACTIONS ?? defaultPreparedActionStorePath(),
      ),
    }),
  });
  await handle.start();
  console.error(`[solana-agent-wallet-mcp-http] listening on ${handle.url}${stateful ? ' (stateful)' : ''}`);

  const shutdown = async () => {
    console.error('[solana-agent-wallet-mcp-http] shutting down');
    await handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

interface CliArgs {
  mock: boolean;
  stateful?: boolean;
  config?: string;
  env?: string;
  bridgeUrl?: string;
  bridgeToken?: string;
  httpToken?: string;
  preparedActions?: string;
  host?: string;
  port?: number;
  path?: string;
}

function parseArgs(args: string[]): CliArgs {
  const parsed: CliArgs = { mock: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--mock') {
      parsed.mock = true;
      continue;
    }
    if (arg === '--stateful') {
      parsed.stateful = true;
      continue;
    }
    if (arg === '--stateless') {
      parsed.stateful = false;
      continue;
    }
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
    if (arg === '--bridge-url') {
      parsed.bridgeUrl = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--bridge-token') {
      parsed.bridgeToken = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--http-token') {
      parsed.httpToken = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--prepared-actions') {
      parsed.preparedActions = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--host') {
      parsed.host = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--port') {
      const port = Number(requireValue(args, index, arg));
      if (!Number.isInteger(port) || port <= 0) {
        throw new Error('--port must be a positive integer.');
      }
      parsed.port = port;
      index += 1;
      continue;
    }
    if (arg === '--path') {
      parsed.path = requireValue(args, index, arg);
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
  console.error('[solana-agent-wallet-mcp-http] fatal:', err);
  process.exit(1);
});
