#!/usr/bin/env node
// Translation step 1 (deterministic, no model). For each target language, compute the delta
// (en.json keys NOT yet in that language catalog) and split it into small chunk files under
// scripts/_i18n_work/. A translator agent later fills each chunk's <lang>__<idx>.out.json.
// Re-running is safe and self-healing: it recomputes the CURRENT delta, so already-merged keys
// are skipped and only still-missing keys get chunked again.
//
//   node scripts/i18n-prepare-chunks.mjs            # default 100 keys/chunk
//   node scripts/i18n-prepare-chunks.mjs --chunk=80

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const catalogDir = join(here, '..', 'src', 'demo-i18n', 'catalog');
const workDir = join(here, '_i18n_work');

const LANGS = ['zh-Hans', 'zh-Hant', 'es', 'ja', 'de', 'it', 'fr', 'pt', 'ko', 'ru'];
const chunkArg = process.argv.find((a) => a.startsWith('--chunk='));
const CHUNK = chunkArg ? Math.max(10, parseInt(chunkArg.slice('--chunk='.length), 10) || 100) : 100;

const en = JSON.parse(readFileSync(join(catalogDir, 'en.json'), 'utf8'));
const enEntries = en.entries;
const enKeys = Object.keys(enEntries);

if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });
// Fresh round: clear BOTH input chunks and any .out.json. Self-healing is round-based — each round
// re-chunks the CURRENT (shrinking) delta, so previously-failed keys are retried next round. The
// merge step persists successes into the catalog before the next prepare runs.
for (const f of readdirSync(workDir)) {
  if (/__\d+(\.out)?\.json$/.test(f)) unlinkSync(join(workDir, f));
}

const chunkFiles = [];
let totalMissing = 0;
for (const lang of LANGS) {
  const cat = JSON.parse(readFileSync(join(catalogDir, `${lang}.json`), 'utf8'));
  const have = new Set(Object.keys(cat.entries || {}));
  const missing = enKeys.filter((k) => !have.has(k));
  totalMissing += missing.length;
  for (let i = 0; i < missing.length; i += CHUNK) {
    const slice = missing.slice(i, i + CHUNK);
    const idx = String(Math.floor(i / CHUNK)).padStart(3, '0');
    const name = `${lang}__${idx}.json`;
    const obj = {};
    for (const k of slice) obj[k] = enEntries[k];
    writeFileSync(join(workDir, name), JSON.stringify({ language: lang, entries: obj }, null, 0));
    chunkFiles.push(name);
  }
  console.log(`${lang}: missing ${missing.length} -> ${Math.ceil(missing.length / CHUNK)} chunk(s)`);
}
writeFileSync(join(workDir, '_chunks.json'), JSON.stringify(chunkFiles, null, 0));
console.log(`\nTotal missing across langs: ${totalMissing}; ${chunkFiles.length} chunk file(s).`);
console.log(`Chunk list: scripts/_i18n_work/_chunks.json`);
