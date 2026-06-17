// Runtime translation wrapper for the /demo page (Android dApp language switcher).
//
// The /demo page is authored ONCE in English. A committed, generated catalog
// (one JSON per language under ./catalog) carries the translations. tDemo() does
// an exact-string-match lookup with English fallback, mirroring the existing
// `agentReviewLocalizedProse` pattern, plus a protected-token safety net so a bad
// catalog entry can never drop or swap a token symbol, $amount, %, URL or address.
//
// To regenerate the catalogs after editing English copy, run:
//   pnpm demo:i18n:generate   (model-assisted, offline, validated)
// and to verify completeness:
//   pnpm demo:i18n:check

import { preservesProtectedTokens } from '@solana-agent-wallet-adapter/workflow';

import enCatalog from './catalog/en.json' with { type: 'json' };
import zhHansCatalog from './catalog/zh-Hans.json' with { type: 'json' };
import zhHantCatalog from './catalog/zh-Hant.json' with { type: 'json' };
import esCatalog from './catalog/es.json' with { type: 'json' };
import jaCatalog from './catalog/ja.json' with { type: 'json' };
import deCatalog from './catalog/de.json' with { type: 'json' };
import itCatalog from './catalog/it.json' with { type: 'json' };
import frCatalog from './catalog/fr.json' with { type: 'json' };
import ptCatalog from './catalog/pt.json' with { type: 'json' };
import koCatalog from './catalog/ko.json' with { type: 'json' };
import ruCatalog from './catalog/ru.json' with { type: 'json' };

export type DemoLanguage =
  | 'en'
  | 'zh-Hans'
  | 'zh-Hant'
  | 'es'
  | 'ja'
  | 'de'
  | 'it'
  | 'fr'
  | 'pt'
  | 'ko'
  | 'ru';

export interface DemoLanguageOption {
  code: DemoLanguage;
  native: string;
}

// English first (default), then the order the agent multilingual feature uses.
export const DEMO_LANGUAGE_OPTIONS: ReadonlyArray<DemoLanguageOption> = [
  { code: 'en', native: 'English' },
  { code: 'zh-Hans', native: '简体中文' },
  { code: 'zh-Hant', native: '繁體中文' },
  { code: 'es', native: 'Español' },
  { code: 'ja', native: '日本語' },
  { code: 'de', native: 'Deutsch' },
  { code: 'it', native: 'Italiano' },
  { code: 'fr', native: 'Français' },
  { code: 'pt', native: 'Português' },
  { code: 'ko', native: '한국어' },
  { code: 'ru', native: 'Русский' },
];

export function isDemoLanguage(value: string | undefined | null): value is DemoLanguage {
  return typeof value === 'string' && DEMO_LANGUAGE_OPTIONS.some((option) => option.code === value);
}

export function demoLanguageOption(code: DemoLanguage): DemoLanguageOption {
  return DEMO_LANGUAGE_OPTIONS.find((option) => option.code === code) ?? DEMO_LANGUAGE_OPTIONS[0]!;
}

interface DemoCatalogFile {
  language: string;
  entries: Record<string, string>;
}

// `en` is intentionally omitted — tDemo short-circuits English to the identity,
// so the English render path stays byte-identical and allocation-free.
const CATALOGS: Partial<Record<DemoLanguage, Record<string, string>>> = {
  'zh-Hans': (zhHansCatalog as DemoCatalogFile).entries,
  'zh-Hant': (zhHantCatalog as DemoCatalogFile).entries,
  es: (esCatalog as DemoCatalogFile).entries,
  ja: (jaCatalog as DemoCatalogFile).entries,
  de: (deCatalog as DemoCatalogFile).entries,
  it: (itCatalog as DemoCatalogFile).entries,
  fr: (frCatalog as DemoCatalogFile).entries,
  pt: (ptCatalog as DemoCatalogFile).entries,
  ko: (koCatalog as DemoCatalogFile).entries,
  ru: (ruCatalog as DemoCatalogFile).entries,
};

/** The canonical English string set — exported so the DEV completeness check can compare. */
export const DEMO_EN_ENTRIES: Record<string, string> = (enCatalog as DemoCatalogFile).entries;

const warnedMisses = new Set<string>();

function devWarnMiss(text: string, language: DemoLanguage): void {
  // Vite exposes import.meta.env.DEV; guard defensively so this stays type-safe
  // without depending on vite/client types being present during tsc.
  let isDev = false;
  try {
    const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
    isDev = Boolean(env?.DEV);
  } catch {
    isDev = false;
  }
  if (!isDev) return;
  const key = `${language}::${text}`;
  if (warnedMisses.has(key)) return;
  warnedMisses.add(key);
  console.warn(`[demo-i18n] no ${language} translation for ${JSON.stringify(text)} — falling back to English.`);
}

/**
 * Translate a demo string into `language`. Returns the input unchanged for English,
 * an uncatalogued string, or a catalog entry that would drop/introduce a protected
 * token (token symbol, $amount, %, URL, wallet address). Never throws.
 */
export function tDemo(text: string, language: DemoLanguage, opts?: { quiet?: boolean }): string {
  if (!text) return text;
  if (language === 'en') return text;
  const table = CATALOGS[language];
  if (!table) return text;
  const hit = table[text.trim()];
  if (hit === undefined) {
    // `quiet` is used where a miss is expected (e.g. text already localized by the shared
    // evidence system before our catalog post-translate) so the DEV miss-warning stays meaningful.
    if (!opts?.quiet) devWarnMiss(text, language);
    return text;
  }
  // Belt-and-suspenders over generation-time validation: a corrupted/hand-edited
  // entry that mangles a protected token reverts to the English source.
  if (!preservesProtectedTokens(text, hit)) return text;
  return hit;
}

/** Replace `{key}` placeholders after translating the template (so IDs/tx stay verbatim). */
export function tDemoFormat(
  template: string,
  language: DemoLanguage,
  vars: Record<string, string>,
): string {
  let out = tDemo(template, language);
  for (const [name, value] of Object.entries(vars)) {
    out = out.split(`{${name}}`).join(value);
  }
  return out;
}
