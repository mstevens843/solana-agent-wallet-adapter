#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, process.argv[2] ?? 'apps/browser-demo/dist');
const indexPath = resolve(dist, 'index.html');

const html = await readFile(indexPath, 'utf8').catch((err) => {
  fail(`Unable to read ${indexPath}: ${err.message}`);
});

const references = localReferences(html);
const missing = [];
const empty = [];

for (const reference of references) {
  const path = resolve(dist, reference);
  if (!path.startsWith(dist)) {
    missing.push(reference);
    continue;
  }
  if (!existsSync(path)) {
    missing.push(reference);
    continue;
  }
  if (statSync(path).size === 0) {
    empty.push(reference);
  }
}

if (!references.some((reference) => /^assets\/index-[^/]+\.js$/.test(reference))) {
  fail('index.html does not reference a hashed browser entry script under assets/.');
}

if (!references.some((reference) => /^assets\/index-[^/]+\.css$/.test(reference))) {
  fail('index.html does not reference a hashed browser stylesheet under assets/.');
}

if (missing.length > 0 || empty.length > 0) {
  const lines = [
    missing.length ? `Missing referenced dist assets:\n${missing.map((item) => `  - ${item}`).join('\n')}` : '',
    empty.length ? `Empty referenced dist assets:\n${empty.map((item) => `  - ${item}`).join('\n')}` : '',
  ].filter(Boolean);
  fail(lines.join('\n'));
}

console.log(`[browser-dist] Verified ${references.length} local asset reference(s) in ${indexPath}.`);

function localReferences(source) {
  const values = new Set();
  const attrPattern = /\b(?:src|href)=["']([^"']+)["']/g;
  for (const match of source.matchAll(attrPattern)) {
    const raw = match[1]?.trim();
    if (!raw || isExternal(raw) || raw.startsWith('#') || raw.startsWith('data:')) continue;
    const clean = raw.split(/[?#]/, 1)[0];
    if (!clean) continue;
    values.add(clean.startsWith('/') ? clean.slice(1) : clean);
  }
  return [...values].sort();
}

function isExternal(value) {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//');
}

function fail(message) {
  console.error(`[browser-dist] ${message}`);
  process.exit(1);
}
