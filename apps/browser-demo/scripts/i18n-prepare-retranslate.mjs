#!/usr/bin/env node
// Quality re-translation prep. Emits, per language, the keys whose translation is still IDENTICAL to
// the English source EXCEPT the universal set (keys identical across ALL languages — brands/code/tickers
// that legitimately stay verbatim). These leftovers are a mix of genuine untranslated misses and
// loanword cognates; a strict loanword-aware re-translation pass + `i18n-merge-chunks.mjs --overwrite`
// fills the real misses while leaving cognates (translator returns English → not overwritten).
// Writes scripts/_i18n_work/<lang>__<idx>.json (value = English source to translate).
//   node scripts/i18n-prepare-retranslate.mjs            # all languages
//   node scripts/i18n-prepare-retranslate.mjs --only=de,fr,it
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const catalogDir = join(here, '..', 'src', 'demo-i18n', 'catalog');
const workDir = join(here, '_i18n_work');
const LANGS = ['zh-Hans', 'zh-Hant', 'es', 'ja', 'de', 'it', 'fr', 'pt', 'ko', 'ru'];
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean) : null;
const CHUNK = 120;

const en = JSON.parse(readFileSync(join(catalogDir, 'en.json'), 'utf8')).entries;
const enKeys = Object.keys(en);

// Universal set: identical to English in ALL 10 languages -> brand/code/ticker, do not re-translate.
const idCount = {};
const cats = {};
for (const lang of LANGS) {
  cats[lang] = JSON.parse(readFileSync(join(catalogDir, `${lang}.json`), 'utf8')).entries;
  for (const k of enKeys) if (cats[lang][k] === en[k]) idCount[k] = (idCount[k] || 0) + 1;
}
const universal = new Set(enKeys.filter((k) => idCount[k] === 10));

if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });
for (const f of readdirSync(workDir)) if (/__\d+(\.out)?\.json$/.test(f) || f === '_chunks.json') unlinkSync(join(workDir, f));

const targets = LANGS.filter((l) => !only || only.includes(l));
const chunkFiles = [];
let total = 0;
for (const lang of targets) {
  const cand = enKeys.filter((k) => cats[lang][k] === en[k] && !universal.has(k));
  total += cand.length;
  for (let i = 0; i < cand.length; i += CHUNK) {
    const slice = cand.slice(i, i + CHUNK);
    const idx = String(Math.floor(i / CHUNK)).padStart(3, '0');
    const obj = {};
    for (const k of slice) obj[k] = en[k];
    writeFileSync(join(workDir, `${lang}__${idx}.json`), JSON.stringify({ language: lang, entries: obj }, null, 0));
    chunkFiles.push(`${lang}__${idx}.json`);
  }
  console.log(`${lang}: ${cand.length} re-translate candidates -> ${Math.ceil(cand.length / CHUNK)} chunk(s)`);
}
writeFileSync(join(workDir, '_chunks.json'), JSON.stringify(chunkFiles, null, 0));
console.log(`\nTotal candidates: ${total}; ${chunkFiles.length} chunk file(s). (universal/brand set excluded: ${universal.size})`);
