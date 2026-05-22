#!/usr/bin/env node
// Build-time validator: every alias declared in src/commands/prepareAliases.ts must
// reference a `kind` that the bridge's executePrepared switch knows about. If a
// new connector lands and its kind isn't yet in our table, this guard catches it
// before we ship a broken alias to users.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, '..');
const repoRoot = join(cliRoot, '..', '..');
const aliasesFile = join(cliRoot, 'src', 'commands', 'prepareAliases.ts');
const actionServiceFile = join(repoRoot, 'packages', 'mcp-server', 'src', 'actionService.ts');

if (!existsSync(aliasesFile) || !existsSync(actionServiceFile)) {
  console.error('[validate-aliases] Source files missing; cannot validate.');
  process.exit(1);
}

const aliasSrc = await readFile(aliasesFile, 'utf8');
const actionSrc = await readFile(actionServiceFile, 'utf8');

// Pull every `kind: 'foo_bar'` out of the alias entries.
const aliasKinds = [...aliasSrc.matchAll(/kind:\s*'([a-z0-9_]+)'/gi)].map((m) => m[1]);

if (aliasKinds.length === 0) {
  console.error('[validate-aliases] No aliases found — prepareAliases.ts may be malformed.');
  process.exit(1);
}

// Build the set of kinds the bridge knows by scanning the executePrepared switch.
const knownKinds = new Set([
  ...[...actionSrc.matchAll(/case\s+'([a-z0-9_]+)':/gi)].map((m) => m[1]),
]);

const missing = aliasKinds.filter((k) => !knownKinds.has(k));
if (missing.length > 0) {
  console.error('[validate-aliases] The following alias kinds are not registered in actionService.ts:');
  for (const m of missing) console.error(`  - ${m}`);
  console.error('Either fix the alias mapping in src/commands/prepareAliases.ts or add a case in actionService.ts.');
  process.exit(1);
}

console.log(`[validate-aliases] ok — ${aliasKinds.length} alias kinds all registered in actionService.ts`);
