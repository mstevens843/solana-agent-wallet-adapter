#!/usr/bin/env node
// Regenerates the /demo translation catalogs from the English source of truth.
//
// The /demo page is authored ONCE in English (src/demo-i18n/catalog/en.json is the
// canonical string set, kept honest by the runtime DEV miss-warning in tDemo.ts and by
// scripts/check-demo-i18n.mjs). This tool translates every English value into each
// supported language with strict protected-token rules, validates the result, and writes
// src/demo-i18n/catalog/<lang>.json. Re-run it whenever you edit English demo copy so you
// never hand-maintain N copies of the page.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-... node scripts/generate-demo-i18n.mjs            # all languages
//   ANTHROPIC_API_KEY=sk-... node scripts/generate-demo-i18n.mjs --only=es,ja
//   DEMO_I18N_MODEL=claude-sonnet-4-5 node scripts/generate-demo-i18n.mjs
//
// Then run `pnpm demo:i18n:check` to validate completeness + protected tokens, and commit
// the updated JSON. (Runs offline at request time against the Anthropic API; the catalogs
// it produces are static, so the demo itself never makes a network call.)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const catalogDir = join(here, '..', 'src', 'demo-i18n', 'catalog');

const LANG_NAMES = {
  'zh-Hans': 'Simplified Chinese (简体中文)',
  'zh-Hant': 'Traditional Chinese (繁體中文)',
  es: 'Spanish (Español)',
  ja: 'Japanese (日本語)',
  de: 'German (Deutsch)',
  it: 'Italian (Italiano)',
  fr: 'French (Français)',
  pt: 'Portuguese (Português)',
  ko: 'Korean (한국어)',
  ru: 'Russian (Русский)',
};

const MODEL = process.env.DEMO_I18N_MODEL || 'claude-sonnet-4-5';
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean) : null;
const targets = Object.keys(LANG_NAMES).filter((lang) => !only || only.includes(lang));

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

const RULES = [
  'Translate every VALUE fluently and naturally for native speakers; this is product UI copy for a guided wallet-approval demo.',
  'Return ONLY a JSON object mapping each English key to its translation, with the EXACT same keys as the input (do not add, drop, reorder, or alter keys).',
  'Keep these verbatim inside the translated sentence: token tickers (SOL, USDC, USDT, BTC, ETH, JUP, BONK, POPCAT, WIF, JITO, mSOL, bSOL, USDS, USDP, PYUSD, NFT, DeFi, DCA, bps, F&G); all numbers, currency amounts and percentages exactly as written; the arrow "->"; the decision keywords APPROVE and DENY (uppercase English); the literal value "true"; the placeholders "{id}" and "{tx}"; paths "/app" and "/docs"; and brand/proper nouns (Solana, Agentic, MWA, Jupiter, Solscan, Helium Mobile, Helium, Coinbase, Magic Eden, Mad Lads, Mad Lad, POPCAT).',
  'If a value is purely protected tokens with no natural-language words, return it unchanged.',
];

async function translate(lang, entries) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required to regenerate catalogs.');
  const system = `You are a professional localizer producing a UI string catalog in ${LANG_NAMES[lang]}.\n${RULES.map((r) => `- ${r}`).join('\n')}`;
  const user = `Translate the VALUES of this JSON object into ${LANG_NAMES[lang]}. Respond with only the JSON object.\n\n${JSON.stringify(entries, null, 0)}`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content ?? []).map((block) => block.text ?? '').join('');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error(`No JSON object in model response for ${lang}.`);
  return JSON.parse(text.slice(start, end + 1));
}

async function main() {
  const en = JSON.parse(readFileSync(join(catalogDir, 'en.json'), 'utf8'));
  const enEntries = en.entries;
  const enKeys = Object.keys(enEntries);

  for (const lang of targets) {
    process.stdout.write(`Translating ${lang} (${enKeys.length} strings) … `);
    const translated = await translate(lang, enEntries);
    const out = {};
    let reverted = 0;
    for (const key of enKeys) {
      const value = typeof translated[key] === 'string' ? translated[key] : '';
      // Fall back to English on a missing/empty entry or a protected-token violation so the
      // committed catalog is always complete and safe; the check script will flag fallbacks.
      if (!value.trim() || !preservesProtectedTokens(key, value)) {
        out[key] = enEntries[key];
        reverted++;
      } else {
        out[key] = value;
      }
    }
    writeFileSync(join(catalogDir, `${lang}.json`), `${JSON.stringify({ language: lang, entries: out }, null, 2)}\n`);
    console.log(`done${reverted ? ` (${reverted} reverted to English — review these)` : ''}.`);
  }
  console.log('\nRegenerated. Run `pnpm demo:i18n:check` and commit the catalog changes.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
