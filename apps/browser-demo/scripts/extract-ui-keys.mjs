// Scans main.ts AND src/devTabs/*.ts for every t('...') / tf('...') / td('...') literal, adds any
// not yet present in the unified catalog (en.json) as identity entries, and writes the new-key list
// to scripts/_missing-ui-keys.json for the translator fan-out. Single-quoted literals only
// (escaped apostrophes handled). Run from apps/browser-demo: node scripts/extract-ui-keys.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');

// main.ts + every .ts under src/devTabs (recursively) — the devTab modules render via demo-i18n/uiLang.
const sources = [join(srcDir, 'main.ts')];
function collectDevTabs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectDevTabs(full);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) sources.push(full);
  }
}
collectDevTabs(join(srcDir, 'devTabs'));
const src = sources.map((f) => readFileSync(f, 'utf8')).join('\n');

const enPath = join(srcDir, 'demo-i18n', 'catalog', 'en.json');
const en = JSON.parse(readFileSync(enPath, 'utf8'));
const enKeys = new Set(Object.keys(en.entries));

const found = new Set();
for (const m of src.matchAll(/\bt(?:d)?\('((?:[^'\\]|\\.)*)'\)/g)) found.add(m[1]);
for (const m of src.matchAll(/\btf\('((?:[^'\\]|\\.)*)'\s*,/g)) found.add(m[1]);

const unescape = (s) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
const all = [...found].map(unescape);
const missing = all.filter((s) => !enKeys.has(s)).sort();

for (const s of missing) en.entries[s] = s;
writeFileSync(enPath, `${JSON.stringify(en, null, 2)}\n`);
writeFileSync(join(here, '_missing-ui-keys.json'), `${JSON.stringify(missing, null, 2)}\n`);

console.log(`wrapped literals: ${all.length}, already in catalog: ${all.length - missing.length}, ADDED: ${missing.length}`);
console.log(`en.json now ${Object.keys(en.entries).length} keys; new keys written to scripts/_missing-ui-keys.json`);
for (const s of missing) console.log('  + ' + JSON.stringify(s));
