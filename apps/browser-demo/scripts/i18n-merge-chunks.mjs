#!/usr/bin/env node
// Translation step 3 (deterministic, no model). Merge every <lang>__<idx>.out.json produced by the
// translator agents back into the language catalogs. A protected-token guard reverts any unsafe
// translation to English (same rule as check-demo-i18n.mjs), so the committed catalog is always safe.
//
//   node scripts/i18n-merge-chunks.mjs              # merge real translations only (leaves gaps for re-runs)
//   node scripts/i18n-merge-chunks.mjs --finalize   # ALSO fill any still-missing key with English (parity-safe)
//
// During iterative rounds run WITHOUT --finalize so re-prepare re-attempts the still-missing keys.
// Run --finalize once at the end to guarantee key parity (English fallback for anything untranslated).

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const catalogDir = join(here, '..', 'src', 'demo-i18n', 'catalog');
const workDir = join(here, '_i18n_work');

const LANGS = ['zh-Hans', 'zh-Hant', 'es', 'ja', 'de', 'it', 'fr', 'pt', 'ko', 'ru'];
const FINALIZE = process.argv.includes('--finalize');
// --overwrite: replace EXISTING entries with a re-translation, but only when the new value differs
// from English and passes the guards (used for the quality re-translate of English-identical keys).
// Never clobbers a good existing translation: in overwrite mode it only touches keys whose .out value
// is a real, valid, non-English translation.
const OVERWRITE = process.argv.includes('--overwrite');

function protectedTokens(value) {
  const tokens = new Set();
  const patterns = [
    /https?:\/\/[^\s),;]+/giu,
    /\bwww\.[^\s),;]+/giu,
    /[$€£¥]\s?\d[\d,.]*(?:\/(?:month|mo|year|yr))?/giu,
    /\b\d+(?:\.\d+)?%/gu,
    /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g,
    /\b(?:SOL|USDC|USDT|BTC|ETH|JUP|BONK|POPCAT|PYUSD|WIF|JITO|JitoSOL|mSOL|bSOL|USDS|USDP|INF)\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const token = (match[0] ?? '').trim().replace(/[.,;:]+$/u, '');
      if (token) tokens.add(token);
    }
  }
  return [...tokens];
}
function preservesProtectedTokens(source, candidate) {
  for (const token of protectedTokens(source)) {
    if (candidate.includes(token)) continue;
    if (/[$€£¥]/u.test(token)) {
      const numeric = token.replace(/[^\d.,]/gu, '').replace(/[.,]+$/u, '');
      if (numeric && candidate.includes(numeric)) continue;
    }
    return false;
  }
  return true;
}

if (!existsSync(workDir)) {
  console.error('No work dir; run i18n-prepare-chunks.mjs first.');
  process.exit(1);
}

const en = JSON.parse(readFileSync(join(catalogDir, 'en.json'), 'utf8'));
const enEntries = en.entries;
const allOut = readdirSync(workDir).filter((f) => f.endsWith('.out.json'));

for (const lang of LANGS) {
  const catPath = join(catalogDir, `${lang}.json`);
  const cat = JSON.parse(readFileSync(catPath, 'utf8'));
  cat.entries = cat.entries || {};
  let added = 0, reverted = 0, badPlaceholder = 0;
  const outs = allOut.filter((f) => f.startsWith(`${lang}__`));
  for (const f of outs) {
    let data;
    try { data = JSON.parse(readFileSync(join(workDir, f), 'utf8')); } catch { continue; }
    const entries = data.entries && typeof data.entries === 'object' ? data.entries : data;
    for (const [k, v] of Object.entries(entries)) {
      if (!(k in enEntries)) continue;       // only real en keys
      const present = k in cat.entries;
      if (present && !OVERWRITE) continue;   // default: keep what we already have
      if (typeof v !== 'string' || !v.trim()) { continue; }
      // {placeholder} NAMES must survive (unique set), else interpolation breaks. Duplicates are OK
      // (tf replaces all occurrences), so compare unique sets — matches check-demo-i18n.mjs.
      const enPh = [...new Set(k.match(/\{[a-zA-Z0-9_]+\}/g) || [])].sort().join(',');
      const vPh = [...new Set(v.match(/\{[a-zA-Z0-9_]+\}/g) || [])].sort().join(',');
      // On a guard failure: fall back to English only when the key is NEW; never clobber an existing entry.
      if (enPh !== vPh) { if (!present) { cat.entries[k] = enEntries[k]; badPlaceholder++; } continue; }
      if (!preservesProtectedTokens(k, v)) { if (!present) { cat.entries[k] = enEntries[k]; reverted++; } continue; }
      if (OVERWRITE && v === enEntries[k]) continue; // translator kept English (legit loanword) — leave as is
      if (present && cat.entries[k] === v) continue; // no change
      cat.entries[k] = v;
      added++;
    }
  }
  let filled = 0;
  if (FINALIZE) {
    for (const k of Object.keys(enEntries)) if (!(k in cat.entries)) { cat.entries[k] = enEntries[k]; filled++; }
  }
  // Always drop stale keys not present in en.json.
  let stale = 0;
  for (const k of Object.keys(cat.entries)) if (!(k in enEntries)) { delete cat.entries[k]; stale++; }
  writeFileSync(catPath, `${JSON.stringify({ language: lang, entries: cat.entries }, null, 2)}\n`);
  const total = Object.keys(cat.entries).length;
  const missing = Object.keys(enEntries).filter((k) => !(k in cat.entries)).length;
  console.log(
    `${lang.padEnd(8)} +${added} translated, ${reverted} token-reverted, ${badPlaceholder} ph-reverted` +
      `${filled ? `, ${filled} filled-EN` : ''}${stale ? `, ${stale} stale-dropped` : ''} -> ${total} keys${missing ? `, STILL MISSING ${missing}` : ''}`,
  );
}
console.log(`\nen baseline: ${Object.keys(enEntries).length} keys. ${FINALIZE ? 'FINALIZED (parity guaranteed).' : 'Run again after more chunks, or with --finalize to lock parity.'}`);
