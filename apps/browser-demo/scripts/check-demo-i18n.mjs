#!/usr/bin/env node
// Validates the /demo translation catalogs against the English source of truth.
//   - every en.json key exists in every language catalog (no missing / no stale keys)
//   - the `language` field matches the filename
//   - no value is empty
//   - protected tokens (token symbols, $amounts, %, URLs, wallet addresses) survive
//     translation — mirrors packages/workflow preservesProtectedTokens so a bad
//     catalog entry fails CI instead of silently reverting to English at runtime.
//
// Pure JSON + regex; no build step or API key required. Wired into the browser-demo
// typecheck/build chain via `pnpm demo:i18n:check`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const catalogDir = join(here, '..', 'src', 'demo-i18n', 'catalog');

const LANGS = ['en', 'zh-Hans', 'zh-Hant', 'es', 'ja', 'de', 'it', 'fr', 'pt', 'ko', 'ru'];

function load(lang) {
  return JSON.parse(readFileSync(join(catalogDir, `${lang}.json`), 'utf8'));
}

function protectedTokens(value) {
  const tokens = new Set();
  const patterns = [
    /https?:\/\/[^\s),;]+/giu,
    /\bwww\.[^\s),;]+/giu,
    /[$€£¥]\s?\d[\d,.]*(?:\/(?:month|mo|year|yr))?/giu,
    /\b\d+(?:\.\d+)?%/gu,
    /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g,
    /\b(?:SOL|USDC|USDT|BTC|ETH|JUP|BONK|PYUSD|WIF|JITO|mSOL|bSOL|USDS|USDP)\b/g,
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

const en = load('en');
const enKeys = Object.keys(en.entries);
const enKeySet = new Set(enKeys);
let problems = 0;

for (const lang of LANGS) {
  if (lang === 'en') continue;
  let cat;
  try {
    cat = load(lang);
  } catch (err) {
    console.error(`[${lang}] failed to load: ${err.message}`);
    problems++;
    continue;
  }
  if (cat.language !== lang) {
    console.error(`[${lang}] "language" field is ${JSON.stringify(cat.language)}, expected ${JSON.stringify(lang)}`);
    problems++;
  }
  const entries = cat.entries ?? {};
  const keys = Object.keys(entries);
  const keySet = new Set(keys);
  const missing = enKeys.filter((k) => !keySet.has(k));
  const stale = keys.filter((k) => !enKeySet.has(k));
  if (missing.length) {
    console.error(`[${lang}] missing ${missing.length} key(s), e.g. ${JSON.stringify(missing.slice(0, 3))}`);
    problems++;
  }
  if (stale.length) {
    console.error(`[${lang}] ${stale.length} stale key(s) not in en.json, e.g. ${JSON.stringify(stale.slice(0, 3))}`);
    problems++;
  }
  let empties = 0;
  let tokenFails = 0;
  for (const key of keys) {
    if (!enKeySet.has(key)) continue;
    const value = entries[key];
    if (typeof value !== 'string' || !value.trim()) {
      empties++;
      if (empties <= 5) console.error(`[${lang}] empty value for ${JSON.stringify(key)}`);
      continue;
    }
    if (!preservesProtectedTokens(key, value)) {
      tokenFails++;
      if (tokenFails <= 5) console.error(`[${lang}] protected-token loss: ${JSON.stringify(key)} -> ${JSON.stringify(value)}`);
    }
  }
  if (empties) problems++;
  if (tokenFails) {
    console.error(`[${lang}] ${tokenFails} protected-token violation(s)`);
    problems++;
  }
  if (!missing.length && !stale.length && !empties && !tokenFails) {
    console.log(`[${lang}] OK (${keys.length} keys)`);
  }
}

if (problems) {
  console.error(`\ndemo-i18n check FAILED with ${problems} problem group(s).`);
  process.exit(1);
}
console.log(`\ndemo-i18n check passed: ${LANGS.length - 1} translated languages, ${enKeys.length} keys each.`);
