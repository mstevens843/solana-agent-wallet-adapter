#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer } from '../server.js';
import { createMockBackend } from '../mockBackend.js';
import { loadConfig } from '../config.js';
import { loadDotEnv } from '../env.js';
import { JsonPreparedActionStore, defaultPreparedActionStorePath } from '../preparedActions.js';
import { RemoteBridgeBackend } from '../remoteBridgeBackend.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadDotEnv(args.env);
  const config = await loadConfig(args.config);
  const backend =
    args.bridge || args.bridgeUrl
      ? new RemoteBridgeBackend({
          bridgeUrl: args.bridgeUrl ?? 'http://127.0.0.1:8787',
          token: args.bridgeToken ?? process.env.BRIDGE_TOKEN ?? 'local-agent-wallet',
        })
      : createMockBackend();
  const server = createServer({
    backend,
    ...((args.bridge || args.bridgeUrl) && { actionConfig: config }),
    ...((args.bridge || args.bridgeUrl) && {
      preparedActions: new JsonPreparedActionStore(
        args.preparedActions ?? process.env.AGENT_WALLET_PREPARED_ACTIONS ?? defaultPreparedActionStorePath(),
      ),
    }),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

interface CliArgs {
  bridge: boolean;
  config?: string;
  env?: string;
  bridgeUrl?: string;
  bridgeToken?: string;
  preparedActions?: string;
}

function parseArgs(args: string[]): CliArgs {
  const parsed: CliArgs = { bridge: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--bridge') {
      parsed.bridge = true;
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
    if (arg === '--prepared-actions') {
      parsed.preparedActions = requireValue(args, index, arg);
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
  console.error('[solana-agent-wallet-mcp] fatal:', err);
  process.exit(1);
});
