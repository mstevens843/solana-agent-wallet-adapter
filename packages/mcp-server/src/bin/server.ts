#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer } from '../server.js';
import { createMockBackend } from '../mockBackend.js';

async function main(): Promise<void> {
  const backend = createMockBackend();
  const server = createServer({ backend });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[solana-agent-wallet-mcp] fatal:', err);
  process.exit(1);
});
