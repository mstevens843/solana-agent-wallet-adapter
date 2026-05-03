#!/usr/bin/env node
import { createHttpServer } from '../httpServer.js';
import { createMockBackend } from '../mockBackend.js';

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8723);
  const host = process.env.HOST ?? '127.0.0.1';
  const stateful = process.env.MCP_STATEFUL === '1';

  const backend = createMockBackend();
  const handle = createHttpServer({ backend, port, host, stateful });
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

main().catch((err) => {
  console.error('[solana-agent-wallet-mcp-http] fatal:', err);
  process.exit(1);
});
