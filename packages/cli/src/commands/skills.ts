/**
 * Skills surface.
 *
 *   solana-agent-wallet skills init     → spawns `agentic-skill init` (authoring)
 *   solana-agent-wallet skills test     → spawns `agentic-skill test`
 *   solana-agent-wallet skills publish  → spawns `agentic-skill publish`
 *
 * Endpoints (verified against apps/render-web/src/cloud/skillsRoutes.ts):
 *   GET  /api/skills                                  — catalog (list)
 *   GET  /api/skills/<skill-id>                       — skill manifest detail
 *   POST /api/skills/manifests                        — publish a manifest
 *   GET  /api/skills/installs                         — list MY installs
 *   POST /api/skills/installs                         — install a skill
 *   POST /api/skills/installs/<id>/(pause|resume|uninstall)
 *   GET  /api/skills/platform-earnings                — treasury earnings
 *   GET  /api/skills/authors/<wallet>/earnings        — per-author earnings
 *
 * The authoring commands proxy to `agentic-skill` (resolved from local
 * node_modules/.bin first, then PATH, then a bundled path), so the CLI binary
 * doesn't bloat with the full skills-runtime + workflow dependency tree.
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import type { ParsedArgs } from '../shared/types.js';
import { optionValue, readJsonFile, removeUndefined } from '../shared/util.js';
import { renderWebRequest } from '../http/index.js';

const PROXY_SUBS = new Set(['init', 'test', 'publish', 'lint', 'pack']);

export async function dispatchSkills(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1] ?? 'list';
  if (PROXY_SUBS.has(sub)) {
    return spawnSkillsCli(sub, parsed.positionals.slice(2));
  }

  if (sub === 'list' || sub === 'catalog') {
    return renderWebRequest(parsed.options, '/api/skills', undefined, {
      label: 'Render-web skills',
    });
  }
  if (sub === 'detail' || sub === 'manifests') {
    const id = parsed.positionals[2];
    if (!id) throw new Error('Usage: solana-agent-wallet skills detail <skill-id>');
    return renderWebRequest(parsed.options, `/api/skills/${encodeURIComponent(id)}`, undefined, {
      label: 'Render-web skills',
    });
  }
  if (sub === 'installs' || sub === 'installed') {
    return renderWebRequest(parsed.options, '/api/skills/installs', undefined, {
      label: 'Render-web skills',
      requireAuth: true,
    });
  }
  if (sub === 'install') {
    const id = parsed.positionals[2];
    if (!id) {
      throw new Error('Usage: solana-agent-wallet skills install <skill-id> --manifest-version <vN> --caps <caps.json> [--accept-monetization]');
    }
    const manifestVersion = optionValue(parsed.positionals, '--manifest-version');
    const capsFile = optionValue(parsed.positionals, '--caps');
    const acceptMonetization = parsed.positionals.includes('--accept-monetization');
    if (!manifestVersion || !capsFile) {
      throw new Error('skills install requires --manifest-version <vN> and --caps <caps.json>. The server rejects partial installs.');
    }
    const caps = await readJsonFile(capsFile, 'caps');
    const body = removeUndefined({
      skillId: id,
      manifestVersion,
      caps,
      acceptMonetization,
    });
    return renderWebRequest(parsed.options, '/api/skills/installs', {
      method: 'POST',
      body: JSON.stringify(body),
    }, { label: 'Render-web skills', requireAuth: true });
  }
  if (sub === 'pause' || sub === 'resume' || sub === 'uninstall') {
    const installId = parsed.positionals[2];
    if (!installId) {
      throw new Error(`Usage: solana-agent-wallet skills ${sub} <install-id>`);
    }
    return renderWebRequest(parsed.options, `/api/skills/installs/${encodeURIComponent(installId)}/${sub}`, {
      method: 'POST',
      body: '{}',
    }, { label: 'Render-web skills', requireAuth: true });
  }
  if (sub === 'earnings') {
    const author = parsed.positionals[2];
    const path = author
      ? `/api/skills/authors/${encodeURIComponent(author)}/earnings`
      : '/api/skills/platform-earnings';
    return renderWebRequest(parsed.options, path, undefined, {
      label: 'Render-web skills',
      requireAuth: !author, // platform-earnings is treasury-only; author endpoints are public read
    });
  }
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    return {
      authoring: [...PROXY_SUBS],
      cloud: ['list', 'detail <id>', 'installs', 'install <id>', 'pause/resume/uninstall <install-id>', 'earnings [author]'],
      note: 'authoring commands proxy to the local `agentic-skill` binary (skills-cli package).',
    };
  }
  // Forward unknowns to skills-cli so the upstream CLI can evolve.
  return spawnSkillsCli(sub, parsed.positionals.slice(2));
}

function spawnSkillsCli(sub: string, args: string[]): Promise<{ exitCode: number }> {
  const binary = resolveAgenticSkillBinary();
  return new Promise((resolveOuter, rejectOuter) => {
    const child = spawn(binary.command, [...binary.preArgs, sub, ...args], {
      stdio: 'inherit',
    });
    child.once('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        rejectOuter(new Error(
          'agentic-skill binary not found. Install it with `npm i -g @solana-agent-wallet-adapter/skills-cli` or run from a checkout where node_modules/.bin/agentic-skill exists.',
        ));
        return;
      }
      if (code === 'EACCES') {
        rejectOuter(new Error(
          `agentic-skill binary at ${binary.command} is not executable. Try chmod +x ${binary.command}, or reinstall the skills-cli package.`,
        ));
        return;
      }
      rejectOuter(err);
    });
    child.once('exit', (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        // Reject so scripted callers can `&&` chain; the caller's catch surfaces
        // the original exit code in the error message for diagnostics.
        rejectOuter(new Error(`agentic-skill ${sub} exited with code ${exitCode}`));
        return;
      }
      resolveOuter({ exitCode });
    });
  });
}

interface ResolvedSkillsBinary {
  command: string;
  preArgs: string[];
}

function resolveAgenticSkillBinary(): ResolvedSkillsBinary {
  // 1. Local node_modules/.bin (workspace / install dir). Inside the pkg-built
  //    standalone binary, fileURLToPath(import.meta.url) returns `/snapshot/...`
  //    so existsSync is always false — we fall through to the PATH case.
  const candidates: string[] = [];
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(here, '..', 'node_modules', '.bin', 'agentic-skill'));
    candidates.push(join(here, '..', '..', 'node_modules', '.bin', 'agentic-skill'));
    candidates.push(join(here, '..', '..', '..', 'node_modules', '.bin', 'agentic-skill'));
  } catch {
    // import.meta.url unavailable in some bundled contexts; skip.
  }
  for (const path of candidates) {
    if (existsSync(path)) {
      return { command: path, preArgs: [] };
    }
  }
  // 2. Workspace dist (pnpm dev mode)
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const workspaceDist = join(here, '..', '..', '..', 'skills-cli', 'dist', 'index.js');
    if (existsSync(workspaceDist)) {
      return { command: process.execPath, preArgs: [workspaceDist] };
    }
  } catch { /* ignore */ }
  // 3. PATH fallback. Standalone binary users without a global install will
  //    hit ENOENT — the spawnSkillsCli error handler surfaces an install hint.
  return { command: 'agentic-skill', preArgs: [] };
}
