import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { skills } from '@solana-agent-wallet-adapter/workflow/dev';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runInit } from '../init.js';
import type { ParsedArgs } from '../parseArgs.js';

const AUTHOR = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';

function defaultParsed(overrides: Partial<ParsedArgs['options']> = {}, positionals: string[] = []): ParsedArgs {
  return {
    options: {
      help: false,
      json: false,
      color: false,
      force: false,
      dryRun: false,
      authorWallet: AUTHOR,
      apiUrl: 'http://localhost:3000',
      ...overrides,
    },
    positionals: ['init', ...positionals],
  };
}

describe('runInit', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'skills-cli-init-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('scaffolds manifest.json and manifest.test.ts in the --out dir', async () => {
    const outDir = join(workDir, 'friday-dca');
    const result = await runInit(defaultParsed({ outDir }, ['friday-dca']));

    expect(result.id).toBe('friday-dca');
    expect(result.files).toEqual(['manifest.json', 'manifest.test.ts']);
    expect(result.dryRun).toBe(false);

    const manifestRaw = await readFile(join(outDir, 'manifest.json'), 'utf8');
    const parsedManifest = JSON.parse(manifestRaw);
    expect(parsedManifest.id).toBe('friday-dca');
    expect(parsedManifest.authorWallet).toBe(AUTHOR);
    expect(parsedManifest.schedule).toEqual({ kind: 'interval', spec: '7d' });
    expect(parsedManifest.action.paramsTemplate.inputToken).toBe('USDC');
    expect(parsedManifest.caps.allowlistedTokens).toEqual(['USDC']);

    const testRaw = await readFile(join(outDir, 'manifest.test.ts'), 'utf8');
    expect(testRaw).toContain("describe('friday-dca manifest'");
    expect(testRaw).toContain("@solana-agent-wallet-adapter/workflow/dev");
  });

  it('produced manifest round-trips through validateSkillManifest', async () => {
    const outDir = join(workDir, 'round-trip');
    await runInit(defaultParsed({ outDir }, ['round-trip']));
    const raw = await readFile(join(outDir, 'manifest.json'), 'utf8');
    const parsedManifest = JSON.parse(raw);
    expect(() => skills.validateSkillManifest(parsedManifest)).not.toThrow();
    const validated = skills.validateSkillManifest(parsedManifest);
    expect(validated.id).toBe('round-trip');
  });

  it('refuses to overwrite an existing directory without --force', async () => {
    const outDir = join(workDir, 'collide');
    await runInit(defaultParsed({ outDir }, ['collide']));
    await expect(runInit(defaultParsed({ outDir }, ['collide']))).rejects.toThrow(/--force/);
  });

  it('overwrites with --force', async () => {
    const outDir = join(workDir, 'forced');
    await runInit(defaultParsed({ outDir }, ['forced']));
    await expect(runInit(defaultParsed({ outDir, force: true }, ['forced']))).resolves.toBeDefined();
  });

  it('--dry-run writes nothing to disk', async () => {
    const outDir = join(workDir, 'dry');
    const result = await runInit(defaultParsed({ outDir, dryRun: true }, ['dry']));
    expect(result.dryRun).toBe(true);
    await expect(stat(outDir)).rejects.toThrow();
  });

  it('rejects invalid skill ids', async () => {
    for (const bad of ['Bad-ID', 'a', '-leading', 'trailing-', 'has space', 'UPPER']) {
      await expect(runInit(defaultParsed({}, [bad]))).rejects.toThrow(/Invalid skill id/);
    }
  });

  it('rejects missing author wallet', async () => {
    await expect(
      runInit(defaultParsed({ authorWallet: undefined }, ['friday-dca'])),
    ).rejects.toThrow(/--author-wallet/);
  });

  it('requires a positional skill id', async () => {
    await expect(runInit(defaultParsed({}, []))).rejects.toThrow(/requires a skill id/);
  });

  it('respects --category override', async () => {
    const outDir = join(workDir, 'cat');
    await runInit(defaultParsed({ outDir, category: 'dca' }, ['cat']));
    const raw = await readFile(join(outDir, 'manifest.json'), 'utf8');
    expect(JSON.parse(raw).category).toBe('dca');
  });
});
