import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { skills } from '@solana-agent-wallet-adapter/workflow/dev';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runInit } from '../init.js';
import type { ParsedArgs } from '../parseArgs.js';
import { resolveManifestPath, runTest } from '../test.js';

const AUTHOR = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';

function parsedFor(manifestPath: string): ParsedArgs {
  return {
    options: {
      help: false,
      json: false,
      color: false,
      force: false,
      dryRun: false,
      apiUrl: 'http://localhost:3000',
      manifestPath,
    },
    positionals: ['test'],
  };
}

async function writeManifest(dir: string, manifest: skills.SkillManifest): Promise<string> {
  const path = join(dir, 'manifest.json');
  await writeFile(path, JSON.stringify(manifest), 'utf8');
  return path;
}

function baseManifest(overrides: Partial<skills.SkillManifest> = {}): skills.SkillManifest {
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
    ...overrides,
  };
}

describe('runTest', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'skills-cli-test-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('accepts a freshly init-scaffolded manifest (after author fills caps)', async () => {
    const outDir = join(workDir, 'friday-dca');
    await runInit({
      options: {
        help: false,
        json: false,
        color: false,
        force: false,
        dryRun: false,
        authorWallet: AUTHOR,
        apiUrl: 'http://localhost:3000',
        outDir,
      },
      positionals: ['init', 'friday-dca'],
    });

    const path = await writeManifest(
      outDir,
      baseManifest({ id: 'friday-dca', name: 'Friday Dca' }),
    );

    const result = await runTest(parsedFor(path));
    expect(result.ok).toBe(true);
    expect(result.manifestId).toBe('friday-dca');
    expect(result.nextRuns).toHaveLength(3);
    expect(result.dryRun.approval.kind).toBe('jupiter_swap');
    expect(result.dryRun.approval.params).toEqual({ inputToken: 'USDC', amount: '50000000' });
  });

  it('accepts manifest path as the second positional argument', async () => {
    const path = await writeManifest(workDir, baseManifest());
    const parsed: ParsedArgs = {
      options: {
        help: false,
        json: false,
        color: false,
        force: false,
        dryRun: false,
        apiUrl: 'http://localhost:3000',
      },
      positionals: ['test', path],
    };
    expect(resolveManifestPath(parsed)).toBe(path);
    await expect(runTest(parsed)).resolves.toMatchObject({ ok: true, manifestId: 'friday-dca' });
  });

  it('rejects perRunMaxAmount > lifetimeMaxAmount', async () => {
    const path = await writeManifest(
      workDir,
      baseManifest({
        caps: {
          perRunMaxAmount: '1000000000',
          lifetimeMaxAmount: '50000000',
          allowlistedTokens: ['USDC'],
        },
      }),
    );
    await expect(runTest(parsedFor(path))).rejects.toThrow(/perRunMaxAmount.*<=.*lifetimeMaxAmount/);
  });

  it('rejects empty allowlistedTokens', async () => {
    const path = await writeManifest(
      workDir,
      baseManifest({
        caps: {
          perRunMaxAmount: '0',
          lifetimeMaxAmount: '0',
          allowlistedTokens: [],
        },
      }),
    );
    await expect(runTest(parsedFor(path))).rejects.toThrow(/allowlistedTokens/);
  });

  it('rejects sub-minute cron schedule', async () => {
    const path = await writeManifest(
      workDir,
      baseManifest({ schedule: { kind: 'cron', spec: '* * * * *' } }),
    );
    await expect(runTest(parsedFor(path))).rejects.toThrow(/once per minute/);
  });

  it('rejects sub-minute runtime interval', async () => {
    const path = await writeManifest(
      workDir,
      baseManifest({ schedule: { kind: 'interval', spec: '30s' } }),
    );
    await expect(runTest(parsedFor(path))).rejects.toThrow(/once per minute/);
  });

  it('rejects unsupported interval aliases before publish', async () => {
    const path = await writeManifest(
      workDir,
      baseManifest({ schedule: { kind: 'interval', spec: '@weekly' } }),
    );
    await expect(runTest(parsedFor(path))).rejects.toThrow(/Unsupported interval spec/);
  });

  it('returns 3 next runs for 7d interval', async () => {
    const path = await writeManifest(workDir, baseManifest());
    const result = await runTest(parsedFor(path));
    expect(result.nextRuns).toHaveLength(3);
    const deltaMs = new Date(result.nextRuns[1]!).getTime() - new Date(result.nextRuns[0]!).getTime();
    expect(deltaMs).toBe(7 * 24 * 60 * 60_000);
  });

  it('accepts decimal cap strings that runtime cap evaluation supports', async () => {
    const path = await writeManifest(
      workDir,
      baseManifest({
        action: { connectorAction: 'jupiter_swap', paramsTemplate: { inputToken: 'USDC', amount: '0.5' } },
        caps: {
          perRunMaxAmount: '0.5',
          lifetimeMaxAmount: '1.25',
          allowlistedTokens: ['USDC'],
        },
      }),
    );
    await expect(runTest(parsedFor(path))).resolves.toMatchObject({ ok: true, manifestId: 'friday-dca' });
  });

  it('surfaces friendly error for missing manifest', async () => {
    await expect(runTest(parsedFor(join(workDir, 'missing.json')))).rejects.toThrow(/Manifest not found/);
  });

  it('surfaces friendly error for invalid JSON', async () => {
    const path = join(workDir, 'manifest.json');
    await writeFile(path, '{not json', 'utf8');
    await expect(runTest(parsedFor(path))).rejects.toThrow(/not valid JSON/);
  });

  it('rejects expired caps.expiresAt', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const path = await writeManifest(
      workDir,
      baseManifest({
        caps: {
          perRunMaxAmount: '0',
          lifetimeMaxAmount: '0',
          allowlistedTokens: ['USDC'],
          expiresAt: past,
        },
      }),
    );
    await expect(runTest(parsedFor(path))).rejects.toThrow(/in the past/);
  });

  it('rejects monetization without payoutWallet', async () => {
    const path = await writeManifest(
      workDir,
      baseManifest({
        monetization: { kind: 'monthly', amount: '5000000', payoutWallet: '' },
      }),
    );
    await expect(runTest(parsedFor(path))).rejects.toThrow(/payoutWallet/);
  });

  it('rejects scaffold TODO placeholders before publish', async () => {
    const path = await writeManifest(
      workDir,
      baseManifest({
        description: 'TODO: describe this',
        action: { connectorAction: 'TODO_REPLACE', paramsTemplate: { inputToken: 'USDC' } },
      }),
    );
    await expect(runTest(parsedFor(path))).rejects.toThrow(/TODO placeholder/);
  });

  it('rejects forbidden authority fields before dry-run', async () => {
    const path = join(workDir, 'manifest.json');
    await writeFile(
      path,
      JSON.stringify({
        ...baseManifest(),
        action: {
          connectorAction: 'jupiter_swap',
          paramsTemplate: { inputToken: 'USDC', delegatedSigner: AUTHOR },
        },
      }),
      'utf8',
    );
    await expect(runTest(parsedFor(path))).rejects.toThrow(/forbidden field.*delegatedSigner/);
  });

  it('rejects approvalAuthority unlimited before dry-run', async () => {
    const path = join(workDir, 'manifest.json');
    await writeFile(
      path,
      JSON.stringify({
        ...baseManifest(),
        action: {
          connectorAction: 'jupiter_swap',
          paramsTemplate: { inputToken: 'USDC', approvalAuthority: 'unlimited' },
        },
      }),
      'utf8',
    );
    await expect(runTest(parsedFor(path))).rejects.toThrow(/approvalAuthority cannot be unlimited/);
  });

  it('rejects unresolved template placeholders during dry-run', async () => {
    const path = await writeManifest(
      workDir,
      baseManifest({
        action: {
          connectorAction: 'jupiter_swap',
          paramsTemplate: { inputToken: 'USDC', amount: '{{unknown.amount}}' },
        },
      }),
    );
    await expect(runTest(parsedFor(path))).rejects.toThrow(/unresolved placeholder/);
  });

  it('rejects templates whose token is outside the cap allowlist during dry-run', async () => {
    const path = await writeManifest(
      workDir,
      baseManifest({
        action: {
          connectorAction: 'jupiter_swap',
          paramsTemplate: { inputToken: 'BONK', amount: '50000000' },
        },
      }),
    );
    await expect(runTest(parsedFor(path))).rejects.toThrow(/token-not-allowlisted/);
  });
});
