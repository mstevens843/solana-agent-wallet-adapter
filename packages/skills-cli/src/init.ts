import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { skills } from '@solana-agent-wallet-adapter/workflow/dev';

import type { ParsedArgs } from './parseArgs.js';
import { stableJson } from './output.js';

type SkillManifest = skills.SkillManifest;
type SkillCategory = skills.SkillCategory;

const SKILL_ID_RE = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;

interface InitResult {
  id: string;
  outDir: string;
  files: string[];
  dryRun: boolean;
}

export async function runInit(parsed: ParsedArgs): Promise<InitResult> {
  const skillId = parsed.positionals[1];
  if (!skillId) {
    throw new Error('agentic-skill init requires a skill id. Example: agentic-skill init friday-dca');
  }
  if (!SKILL_ID_RE.test(skillId)) {
    throw new Error(
      `Invalid skill id "${skillId}". Must be kebab-case, 3-64 chars, start with a letter, end with a letter or digit. Example: friday-dca.`,
    );
  }

  const authorWallet = parsed.options.authorWallet?.trim();
  if (!authorWallet) {
    throw new Error(
      'Missing --author-wallet. Pass --author-wallet <pubkey> or set AGENTIC_AUTHOR_WALLET.',
    );
  }

  const category: SkillCategory = parsed.options.category ?? 'custom';
  const outDir = resolve(parsed.options.outDir ?? join('skills', skillId));

  if (!parsed.options.dryRun) {
    if (await dirExists(outDir)) {
      if (!parsed.options.force) {
        throw new Error(
          `Directory already exists: ${outDir}. Re-run with --force to overwrite.`,
        );
      }
    }
  }

  const manifest: SkillManifest = {
    id: skillId,
    name: titleCaseFromId(skillId),
    version: '0.1.0',
    authorWallet,
    description: 'TODO: describe what this skill does',
    category,
    schedule: { kind: 'interval', spec: '7d' },
    action: {
      connectorAction: 'TODO_REPLACE',
      paramsTemplate: { inputToken: 'USDC', amount: '{{caps.perRunMaxAmount}}' },
    },
    caps: {
      perRunMaxAmount: '1',
      lifetimeMaxAmount: '1',
      allowlistedTokens: ['USDC'],
    },
  };

  const validated = skills.validateSkillManifest(manifest);
  const manifestJson = stableJson(validated) + '\n';
  const testFile = buildTestFile(skillId);

  if (parsed.options.dryRun) {
    console.log(`# ${join(outDir, 'manifest.json')}`);
    console.log(manifestJson);
    console.log(`# ${join(outDir, 'manifest.test.ts')}`);
    console.log(testFile);
    return {
      id: skillId,
      outDir,
      files: ['manifest.json', 'manifest.test.ts'],
      dryRun: true,
    };
  }

  await mkdir(outDir, { recursive: true });
  const manifestPath = join(outDir, 'manifest.json');
  const testPath = join(outDir, 'manifest.test.ts');
  await writeFile(manifestPath, manifestJson, 'utf8');
  await writeFile(testPath, testFile, 'utf8');

  return {
    id: skillId,
    outDir,
    files: ['manifest.json', 'manifest.test.ts'],
    dryRun: false,
  };
}

function titleCaseFromId(id: string): string {
  return id
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

function buildTestFile(skillId: string): string {
  return `import { describe, expect, it } from 'vitest';
import { skills } from '@solana-agent-wallet-adapter/workflow/dev';

import manifest from './manifest.json' with { type: 'json' };

describe('${skillId} manifest', () => {
  it('round-trips through validateSkillManifest', () => {
    expect(() => skills.validateSkillManifest(manifest)).not.toThrow();
  });

  it('keeps id stable', () => {
    expect(skills.validateSkillManifest(manifest).id).toBe('${skillId}');
  });
});
`;
}
