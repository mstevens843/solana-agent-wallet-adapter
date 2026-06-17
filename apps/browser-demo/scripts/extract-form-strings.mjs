#!/usr/bin/env node
// Seed the i18n catalog with FORM-FACING strings from the data modules (planner.ts,
// connectorDrafting.ts, connectedDapps.ts). These are built into module-level consts and rendered
// raw (the render layer wraps them in t(value) at display time), so extract-ui-keys.mjs (which only
// sees t('literal')) never catches them. This script targets ONLY form content — template/connector
// titles, descriptions, field labels, prose placeholders, helper text, connector descriptions and
// action lists — then filters through the same prose classifier as audit-raw-ui.mjs so token symbols,
// ids, amounts, addresses and numeric example values are dropped. Adds new keys to en.json as identity
// entries. Over-seeding is harmless (extra en keys translate, never go stale); under-seeding surfaces
// via the DEV miss-warning. Run from apps/browser-demo: node scripts/extract-form-strings.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const enPath = join(srcDir, 'demo-i18n', 'catalog', 'en.json');

// ---- prose classifier (mirrors scripts/audit-raw-ui.mjs `classify`, accept Tier A or B) ----
function isSeedableProse(s) {
  const text = (s ?? '').trim();
  if (text.length < 2) return false;
  if (!/[A-Za-z]/.test(text)) return false;
  if (text.includes('${')) return false;
  if (/^[MmLlHhVvCcSsQqTtAaZz][\d\s.,-]/.test(text)) return false; // svg path
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  if (letters / text.length < 0.45) return false;
  if (/^[a-z][a-z0-9-]*(\s+[a-z][a-z0-9-]*)*$/.test(text)) return false; // css-ish lowercase
  if (/^(https?:|www\.|\/[a-z]|\.\/|#|data:|mailto:|tel:)/i.test(text)) return false;
  if (/\.(css|js|ts|tsx|svg|png|jpg|json|woff2?)\b/.test(text)) return false;
  if (/^[A-Z][a-z]+([A-Z][a-z]+)+$/.test(text)) return false; // CamelCase
  if (/^[a-z]+([A-Z][a-z]+)+$/.test(text)) return false; // camelCase
  if (/^[A-Z0-9_]+$/.test(text)) return false; // CONSTANT_CASE
  if (/^[\d\s.,:%$+-]+$/.test(text)) return false; // numeric/symbol only
  const words = text.split(/\s+/).filter(Boolean);
  // pure token symbol / short ticker phrase
  if (/^(SOL|USDC|USDT|BTC|ETH|JUP|BONK|PYUSD|WIF|JITO|POPCAT|mSOL|bSOL|USDS|USDP|JitoSOL|INF)\b/.test(text) && words.length <= 2) return false;
  // Tier A: multi-word prose
  if (words.length >= 2 && (/[a-z]\s+[a-z]/i.test(text) || /[.!?](\s|$)/.test(text))) return true;
  // Tier B: a single Capitalized word or short Capitalized label (Reason, Amount, Scope, ...)
  if (/^[A-Z][a-zA-Z]{2,}$/.test(text) || (words.length >= 2 && /^[A-Z]/.test(text))) return true;
  return false;
}

function unquote(arg) {
  if (!arg) return null;
  const m = arg.match(/^(['"`])((?:[^\\]|\\.)*)\1$/s);
  if (!m) return null;
  return m[2].replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n');
}

// Return the inner text of each `name( ... )` call (quote- and depth-aware).
function findCalls(src, name) {
  const out = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    const start = i;
    let depth = 1, q = null;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
      if (c === "'" || c === '"' || c === '`') { q = c; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

function splitTopLevelArgs(s) {
  const args = [];
  let depth = 0, cur = '', q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === '\\') { cur += s[++i] ?? ''; } else if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; cur += c; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; cur += c; continue; }
    if (c === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) args.push(cur);
  return args.map((a) => a.trim());
}

const found = new Set();
const add = (s) => { if (typeof s === 'string' && isSeedableProse(s)) found.add(s.trim()); };

// Pull form-facing keyed strings from an object-literal text.
function addObjectKeys(text) {
  for (const m of text.matchAll(/\b(label|placeholder|helperText|title|description|operationLabel|summary|detail|whatThisProves|recommendedUse)\s*:\s*(['"])((?:[^\\]|\\.)*?)\2/g)) {
    add(unquote(`'${m[3].replace(/'/g, "\\'")}'`) ?? m[3]);
  }
}

// Return the literal text of a `const NAME ... = [ ... ]` / `{ ... }` block (depth- & quote-aware).
function findConstBlock(src, name) {
  const re = new RegExp(`\\bconst ${name}\\b[^=]*=\\s*`, 'g');
  const m = re.exec(src);
  if (!m) return '';
  let i = m.index + m[0].length;
  const open = src[i];
  if (open !== '[' && open !== '{') return '';
  const close = open === '[' ? ']' : '}';
  let depth = 0, q = null;
  const start = i;
  for (; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

// ---- planner.ts: template / field / textareaField / selectField ----
const planner = readFileSync(join(srcDir, 'planner.ts'), 'utf8');
for (const inner of findCalls(planner, 'template')) {
  const a = splitTopLevelArgs(inner);
  add(unquote(a[2])); // title
  add(unquote(a[3])); // description
}
for (const fn of ['field', 'textareaField']) {
  for (const inner of findCalls(planner, fn)) {
    const a = splitTopLevelArgs(inner);
    add(unquote(a[1])); // label
    add(unquote(a[2])); // placeholder (prose only; numeric examples dropped by classifier)
  }
}
for (const inner of findCalls(planner, 'selectField')) {
  const a = splitTopLevelArgs(inner);
  add(unquote(a[1])); // label
  // options array (arg 2): seed PROSE options only — the classifier drops tickers (SOL/USDC) and
  // lowercase values (weekly), keeping visible prose like "SOL + configured tokens", "All SPL tokens".
  if (a[2]) for (const s of a[2].matchAll(/(['"])((?:[^\\]|\\.)*?)\1/g)) add(s[2]);
}
addObjectKeys(planner); // inline field objects / shared consts

// ---- connectorDrafting.ts: connectorActionForm / formField / form*Field + object keys ----
const drafting = readFileSync(join(srcDir, 'connectorDrafting.ts'), 'utf8');
for (const inner of findCalls(drafting, 'connectorActionForm')) {
  const a = splitTopLevelArgs(inner);
  add(unquote(a[2])); // operationLabel
  add(unquote(a[4])); // description
}
for (const fn of ['formField', 'formDateTimeField', 'formTextareaField', 'formSelectField', 'formNumberField']) {
  for (const inner of findCalls(drafting, fn)) {
    const a = splitTopLevelArgs(inner);
    add(unquote(a[1])); // label
    if (a[3]) addObjectKeys(a[3]); // { placeholder, helperText }
  }
}
addObjectKeys(drafting); // catches inline field objects, shared field consts, variants

// ---- connectedDapps.ts: PROTOCOL_CONNECTORS description + supportedActions (skip name) ----
const connectors = readFileSync(join(srcDir, 'connectedDapps.ts'), 'utf8');
for (const m of connectors.matchAll(/\bdescription\s*:\s*(['"])((?:[^\\]|\\.)*?)\1/g)) add(m[2]);
for (const m of connectors.matchAll(/supportedActions\s*:\s*\[([\s\S]*?)\]/g)) {
  for (const s of m[1].matchAll(/(['"])((?:[^\\]|\\.)*?)\1/g)) add(s[2]);
}

// ---- main.ts BOUNDED const blocks (Save Proof labs + Preferences records) ----
// Only these named const blocks are scanned (not all of main.ts) to avoid over-extraction.
const mainSrc = readFileSync(join(srcDir, 'main.ts'), 'utf8');
for (const name of ['RECEIPT_LABS', 'ADVANCED_EVIDENCE_LABS']) {
  const block = findConstBlock(mainSrc, name);
  addObjectKeys(block); // title/description/summary/whatThisProves/recommendedUse/label/placeholder
  for (const m of block.matchAll(/\boptions\s*:\s*\[([^\]]*)\]/g)) {
    for (const s of m[1].matchAll(/(['"])((?:[^\\]|\\.)*?)\1/g)) add(s[2]); // select options (tickers dropped by classifier)
  }
}
for (const name of ['FAILURE_KIND_LABEL', 'FAILURE_KIND_HELP']) {
  const block = findConstBlock(mainSrc, name);
  for (const m of block.matchAll(/:\s*(['"])((?:[^\\]|\\.)*?)\1/g)) add(m[2]); // record VALUES (kind -> label/help)
}
addObjectKeys(findConstBlock(mainSrc, 'CONNECTOR_TARGET_FIELD_LABELS')); // label: 'Vault' etc.

// ---- merge into en.json ----
const en = JSON.parse(readFileSync(enPath, 'utf8'));
const enKeys = new Set(Object.keys(en.entries));
const all = [...found];
const missing = all.filter((s) => !enKeys.has(s)).sort();
for (const s of missing) en.entries[s] = s;
writeFileSync(enPath, `${JSON.stringify(en, null, 2)}\n`);
writeFileSync(join(here, '_missing-form-keys.json'), `${JSON.stringify(missing, null, 2)}\n`);

console.log(`form-facing candidates: ${all.length}, already in catalog: ${all.length - missing.length}, ADDED: ${missing.length}`);
console.log(`en.json now ${Object.keys(en.entries).length} keys; new keys -> scripts/_missing-form-keys.json`);
for (const s of missing.slice(0, 30)) console.log('  + ' + JSON.stringify(s));
if (missing.length > 30) console.log(`  … and ${missing.length - 30} more`);
