import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { skills } from '@solana-agent-wallet-adapter/workflow/dev';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ParsedArgs } from '../parseArgs.js';
import { runPublish } from '../publish.js';

const AUTHOR = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';

interface RequestCapture {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface ServerHandle {
  url: string;
  capture: RequestCapture;
  setResponse: (status: number, body: unknown) => void;
}

async function startServer(): Promise<{ handle: ServerHandle; server: Server }> {
  const capture: RequestCapture = {};
  let status = 200;
  let body: unknown = { ok: true, id: 'friday-dca' };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    capture.method = req.method;
    capture.url = req.url;
    capture.headers = { ...req.headers };
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        capture.body = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        capture.body = raw;
      }
      const responseText = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' });
      res.end(responseText);
    });
  });

  await new Promise<void>((resolveStart) => {
    server.listen(0, '127.0.0.1', () => resolveStart());
  });
  const address = server.address() as AddressInfo;
  const handle: ServerHandle = {
    url: `http://127.0.0.1:${address.port}`,
    capture,
    setResponse(nextStatus, nextBody) {
      status = nextStatus;
      body = nextBody;
    },
  };
  return { handle, server };
}

function baseManifest(): skills.SkillManifest {
  return {
    id: 'friday-dca',
    name: 'Friday DCA',
    version: '0.1.0',
    authorWallet: AUTHOR,
    description: 'A test manifest',
    category: 'dca',
    schedule: { kind: 'interval', spec: '7d' },
    action: { connectorAction: 'jupiter_swap', paramsTemplate: { inputToken: 'USDC', amount: '50000000' } },
    caps: {
      perRunMaxAmount: '50000000',
      lifetimeMaxAmount: '500000000',
      allowlistedTokens: ['USDC'],
    },
  };
}

function makeParsed(manifestPath: string, apiUrl: string, cookie?: string): ParsedArgs {
  return {
    options: {
      help: false,
      json: false,
      color: false,
      force: false,
      dryRun: false,
      apiUrl,
      cookie,
      manifestPath,
    },
    positionals: ['publish'],
  };
}

function makeParsedWithPositional(manifestPath: string, apiUrl: string): ParsedArgs {
  return {
    options: {
      help: false,
      json: false,
      color: false,
      force: false,
      dryRun: false,
      apiUrl,
    },
    positionals: ['publish', manifestPath],
  };
}

describe('runPublish', () => {
  let workDir: string;
  let manifestPath: string;
  let serverHandle: ServerHandle;
  let server: Server;

  beforeAll(async () => {
    const started = await startServer();
    serverHandle = started.handle;
    server = started.server;
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((err) => (err ? rejectClose(err) : resolveClose()));
    });
  });

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'skills-cli-publish-'));
    manifestPath = join(workDir, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(baseManifest()), 'utf8');
    serverHandle.setResponse(200, { ok: true, id: 'friday-dca', version: '0.1.0' });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('POSTs the manifest as JSON to /api/skills/manifests', async () => {
    const result = await runPublish(makeParsed(manifestPath, serverHandle.url, 'session=abc'));

    expect(serverHandle.capture.method).toBe('POST');
    expect(serverHandle.capture.url).toBe('/api/skills/manifests');
    expect(serverHandle.capture.headers?.['content-type']).toMatch(/application\/json/);
    expect(serverHandle.capture.headers?.cookie).toBe('session=abc');
    const body = serverHandle.capture.body as skills.SkillManifest;
    expect(body.id).toBe('friday-dca');
    expect(body.caps.allowlistedTokens).toEqual(['USDC']);

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.response).toEqual({ ok: true, id: 'friday-dca', version: '0.1.0' });
  });

  it('omits the cookie header when --cookie is not set', async () => {
    await runPublish(makeParsed(manifestPath, serverHandle.url));
    expect(serverHandle.capture.headers?.cookie).toBeUndefined();
  });

  it('accepts manifest path as a positional publish argument', async () => {
    await runPublish(makeParsedWithPositional(manifestPath, serverHandle.url));
    expect(serverHandle.capture.method).toBe('POST');
    expect((serverHandle.capture.body as skills.SkillManifest).id).toBe('friday-dca');
  });

  it('surfaces 403 with a dev-cookie hint', async () => {
    serverHandle.setResponse(403, { error: 'not allowed' });
    await expect(runPublish(makeParsed(manifestPath, serverHandle.url))).rejects.toThrow(
      /Publish failed: 403[\s\S]*Hint:[\s\S]*cookie/i,
    );
  });

  it('surfaces 404 with an Agent-5 endpoint hint', async () => {
    serverHandle.setResponse(404, 'not found');
    await expect(runPublish(makeParsed(manifestPath, serverHandle.url))).rejects.toThrow(
      /Publish failed: 404[\s\S]*Agent 5/,
    );
  });

  it('validates locally before sending (bad manifest does not hit network)', async () => {
    await writeFile(
      manifestPath,
      JSON.stringify({ ...baseManifest(), caps: { perRunMaxAmount: '100', lifetimeMaxAmount: '50', allowlistedTokens: ['x'] } }),
      'utf8',
    );
    serverHandle.setResponse(500, 'should not be called');
    await expect(runPublish(makeParsed(manifestPath, serverHandle.url))).rejects.toThrow(/perRunMaxAmount/);
  });

  it('runs local forbidden-authority checks before sending', async () => {
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...baseManifest(),
        action: {
          connectorAction: 'jupiter_swap',
          paramsTemplate: { inputToken: 'USDC', privateKey: 'secret' },
        },
      }),
      'utf8',
    );
    serverHandle.setResponse(500, 'should not be called');
    await expect(runPublish(makeParsed(manifestPath, serverHandle.url))).rejects.toThrow(/privateKey/);
  });

  it('returns a friendly error when the server is unreachable', async () => {
    await expect(
      runPublish(makeParsed(manifestPath, 'http://127.0.0.1:1')),
    ).rejects.toThrow(/Failed to POST/);
  });
});
