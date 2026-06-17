#!/usr/bin/env node
// Heuristic detector for user-facing UI string literals in main.ts + src/devTabs/*.ts that are
// NOT yet wrapped in t('...') / td('...') / tf('...'). Used to (a) size the i18n wrap work and
// (b) confirm near-complete coverage at the end. Over-reports slightly (catches some aria/type
// literals), so the residual list is meant to be eyeballed, not trusted to zero blindly.
//
//   node scripts/audit-raw-ui.mjs            # summary per file/region
//   node scripts/audit-raw-ui.mjs --list     # also print each candidate (file:line  "text")
//   node scripts/audit-raw-ui.mjs --file=src/devTabs/payOut.ts   # restrict to one file

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const srcDir = join(root, 'src');

const listMode = process.argv.includes('--list');
const fileArg = process.argv.find((a) => a.startsWith('--file='));
const onlyFile = fileArg ? fileArg.slice('--file='.length) : null;

const files = [];
if (onlyFile) {
  files.push(join(root, onlyFile));
} else {
  files.push(join(srcDir, 'main.ts'));
  files.push(join(srcDir, 'connectorKeys.ts'));
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !full.includes('__tests__')) files.push(full);
    }
  };
  walk(join(srcDir, 'devTabs'));
}

// --nodes: advisory detector for the two classes the quoted-literal scan can't see —
// (A) raw HTML text nodes (>prose< not interpolated) and (B) imperatively-set DOM strings
// (.textContent/.innerHTML/.placeholder/.title/.ariaLabel = / setAttribute) with raw English.
// Excludes TS generics (Promise<…>, Record<…>) and code. Eyeball the output; not a hard gate.
if (process.argv.includes('--nodes')) {
  const TS_TYPES = /^(Promise|Record|Array|ReadonlyArray|Map|Set|Partial|Readonly|Pick|Omit|Awaited|ReturnType|Parameters|Required|Exclude|Extract|NonNullable|InstanceType|Iterable|Generator|Capitalize|Uppercase|Lowercase)\b/;
  const looksProse = (raw) => {
    const s = (raw ?? '').trim();
    if (s.length < 3 || !/[A-Za-z]/.test(s)) return false;
    if (s.includes('${') || /[<>{}=|]/.test(s)) return false; // interpolation / code / generics
    if (TS_TYPES.test(s)) return false;
    if (/^[a-z][a-z0-9-]*$/.test(s)) return false;            // css class / identifier
    if (/^[A-Za-z][a-zA-Z]*([A-Z][a-z]+)+$/.test(s) && !/\s/.test(s)) return false; // CamelCase ident
    const words = s.split(/\s+/).filter(Boolean);
    if (words.length >= 2 && /[a-z]\s+[a-z]/i.test(s)) return true; // multi-word prose
    if (/^[A-Z][a-z]{2,}$/.test(s)) return true;              // single Capitalized word label
    return false;
  };
  let a = 0, b = 0;
  for (const file of files) {
    let src;
    try { src = readFileSync(file, 'utf8'); } catch { continue; }
    const rel = relative(root, file);
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const m of line.matchAll(/>([^<>{}]+)</g)) {
        if (looksProse(m[1])) { a++; console.log(`A ${rel}:${i + 1}  ${JSON.stringify(m[1].trim())}`); }
      }
      for (const m of line.matchAll(/\.(textContent|innerHTML|placeholder|title|ariaLabel)\s*=\s*(['"`])((?:[^\\]|\\.)*?)\2/g)) {
        if (looksProse(m[3])) { b++; console.log(`B ${rel}:${i + 1}  .${m[1]}= ${JSON.stringify(m[3])}`); }
      }
      for (const m of line.matchAll(/\.setAttribute\(\s*(['"])(aria-label|title|placeholder|alt)\1\s*,\s*(['"])((?:[^\\]|\\.)*?)\3/g)) {
        if (looksProse(m[4])) { b++; console.log(`B ${rel}:${i + 1}  setAttribute(${m[2]}) ${JSON.stringify(m[4])}`); }
      }
    }
  }
  console.log(`\n[--nodes] advisory: ${a} raw text-node + ${b} imperative-DOM candidates (eyeball; excludes TS generics & code).`);
  process.exit(0);
}

// --attrs: detector for raw English inside HTML ATTRIBUTE values written in template-literal HTML
// (aria-label / aria-description / title / placeholder / alt = "literal"). These are neither JS
// string literals (the main scan below) nor >text< nodes (--nodes), so they are a THIRD blind spot.
// Excludes ${...} interpolations, data-*, urls, emails, css/identifier tokens. Advisory, not a gate.
if (process.argv.includes('--attrs')) {
  const TS_TYPES = /^(Promise|Record|Array|ReadonlyArray|Map|Set|Partial|Readonly|Pick|Omit|Awaited|ReturnType|Parameters|Required|Exclude|Extract|NonNullable|InstanceType|Iterable|Generator)\b/;
  const looksAttrCopy = (raw) => {
    const s = (raw ?? '').trim();
    if (s.length < 2 || !/[A-Za-z]/.test(s)) return false;
    if (s.includes('${') || /[<>{}|]/.test(s)) return false;     // interpolation / code / generics
    if (TS_TYPES.test(s)) return false;
    if (/@/.test(s)) return false;                               // email-like format example
    if (/^(https?:|www\.|\/[a-z]|\.\/|#|data:|mailto:|tel:)/i.test(s)) return false;
    if (/^[a-z][a-z0-9-]*$/.test(s)) return false;               // css class / single lowercase token
    if (/^[A-Za-z][a-zA-Z]*([A-Z][a-z]+)+$/.test(s) && !/\s/.test(s)) return false; // CamelCase ident
    if (/^[A-Z0-9_]+$/.test(s)) return false;                    // CONSTANT_CASE / acronym-only
    return true;
  };
  const ATTR = /\b(aria-label|aria-description|aria-roledescription|aria-placeholder|title|placeholder|alt)\s*=\s*(["'])((?:[^\\]|\\.)*?)\2/g;
  let n = 0;
  for (const file of files) {
    let src;
    try { src = readFileSync(file, 'utf8'); } catch { continue; }
    const rel = relative(root, file);
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(ATTR)) {
        if (looksAttrCopy(m[3])) { n++; console.log(`${rel}:${i + 1}  ${m[1]}=${JSON.stringify(m[3])}`); }
      }
    }
  }
  console.log(`\n[--attrs] advisory: ${n} raw attribute-string candidates (eyeball; excludes \${...}, data-*, urls, emails, idents).`);
  process.exit(0);
}

// A literal is "wrapped" when the opening quote is immediately preceded by t( / td( / tf(
// (optionally with whitespace). We detect the 3 quote styles separately.
const QUOTES = [
  { q: "'", re: /'((?:[^'\\]|\\.)*)'/g },
  { q: '"', re: /"((?:[^"\\]|\\.)*)"/g },
  { q: '`', re: /`((?:[^`\\$]|\\.)*)`/g }, // backtick: skip those with ${...} interpolation (handled as code)
];

// Returns 'A' (high-confidence multi-word copy), 'B' (single-word label, noisier), or null (skip).
function classify(s) {
  const text = s.trim();
  if (text.length < 3) return null;
  if (!/[A-Za-z]/.test(text)) return null;
  if (text.includes('${')) return null; // attribute/template expression — code, not copy
  // SVG path / numeric-heavy data
  if (/^[MmLlHhVvCcSsQqTtAaZz][\d\s.,-]/.test(text)) return null;
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  if (letters / text.length < 0.45) return null; // mostly digits/punctuation (paths, ids, formats)
  // code-ish strings
  if (/^[a-z][a-z0-9-]*(\s+[a-z][a-z0-9-]*)*$/.test(text)) return null; // css class list (all lowercase-hyphen)
  if (/^(https?:|www\.|\/[a-z]|\.\/|#|data:|mailto:|tel:)/i.test(text)) return null;
  if (/\.(css|js|ts|tsx|svg|png|jpg|json|woff2?)\b/.test(text)) return null;
  if (/^[A-Z][a-z]+([A-Z][a-z]+)+$/.test(text)) return null; // CamelCaseIdentifier
  if (/^[a-z]+([A-Z][a-z]+)+$/.test(text)) return null; // camelCaseIdentifier
  if (/^[A-Z0-9_]+$/.test(text)) return null; // CONSTANT_CASE
  if (/^[\d\s.,:%$+-]+$/.test(text)) return null; // numeric/symbol only
  const words = text.split(/\s+/).filter(Boolean);
  if (/^(SOL|USDC|USDT|BTC|ETH|JUP|BONK|PYUSD|WIF|JITO|mSOL|bSOL|USDS|USDP|NFT|DeFi|DCA|bps)\b/.test(text) && words.length <= 2) return null;
  // Tier A: 2+ words AND reads like prose (a lowercase->space->lowercase or sentence punctuation)
  if (words.length >= 2 && (/[a-z]\s+[a-z]/i.test(text) || /[.!?](\s|$)/.test(text))) return 'A';
  // Tier B: a single Capitalized word or short label (UI button/heading) — noisier
  if (/^[A-Z][a-zA-Z]{2,}$/.test(text) || (words.length >= 2 && /^[A-Z]/.test(text))) return 'B';
  return null;
}

function lineIsSkippable(line) {
  const t = line.trim();
  if (t.startsWith('import ') || t.startsWith('export *') || t.startsWith('export {') || t.startsWith('export type')) return true;
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return true;
  if (t.startsWith('console.') || /\bconsole\.(log|warn|error|info|debug)\(/.test(t)) return true;
  if (/^(type|interface)\s/.test(t)) return true;
  return false;
}

let grand = 0;
const perFile = [];
for (const file of files) {
  let src;
  try { src = readFileSync(file, 'utf8'); } catch { continue; }
  const lines = src.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (lineIsSkippable(line)) continue;
    for (const { q, re } of QUOTES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        const content = m[1];
        if (q === '`' && content.includes('${')) continue; // interpolated template = code, skip
        const idx = m.index;
        // wrapped? look back for t( / td( / tf( immediately before the quote
        const before = line.slice(Math.max(0, idx - 4), idx);
        if (/\b(t|td|tf)\(\s*$/.test(before)) continue;
        const tier = classify(content);
        if (!tier) continue;
        hits.push({ line: i + 1, text: content, tier });
      }
    }
  }
  const a = hits.filter((h) => h.tier === 'A').length;
  const b = hits.filter((h) => h.tier === 'B').length;
  grand += a + b;
  perFile.push({ file: relative(root, file), a, b, hits });
}

const tierFilter = process.argv.includes('--tierA') ? 'A' : null;
perFile.sort((x, y) => y.a + y.b - (x.a + x.b));
let totalA = 0, totalB = 0;
for (const f of perFile) {
  totalA += f.a; totalB += f.b;
  if (!f.a && !f.b) continue;
  console.log(`A:${String(f.a).padStart(4)}  B:${String(f.b).padStart(4)}  ${f.file}`);
  if (listMode) for (const h of f.hits) {
    if (tierFilter && h.tier !== tierFilter) continue;
    console.log(`        ${f.file}:${h.line}  [${h.tier}] ${JSON.stringify(h.text)}`);
  }
}
console.log(`\nTOTAL unwrapped: Tier A (high-confidence copy) = ${totalA}, Tier B (single-word labels) = ${totalB}`);
