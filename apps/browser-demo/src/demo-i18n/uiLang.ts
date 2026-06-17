// Shared UI-language helpers for self-contained modules (e.g. src/devTabs/*) that cannot
// reach main.ts's t()/tf() without creating an import cycle. main.ts owns the active
// language (see activeUiLanguage()) and pushes it here via setUiLanguage() on every render,
// so these helpers stay in lock-step with the rest of the app. Dependency direction is
// one-way: main.ts -> uiLang <- devTabs (no cycle).
//
// Behaviour mirrors main.ts's t()/tf() exactly: exact-string-match catalog lookup with
// English fallback (tDemo) plus the protected-token safety net, and {placeholder}
// interpolation after translation (tDemoFormat).

import { tDemo, tDemoFormat, type DemoLanguage } from './tDemo.js';

let currentLanguage: DemoLanguage = 'en';

/** Set the active UI language. Called by main.ts's activeUiLanguage() on each render. */
export function setUiLanguage(language: DemoLanguage): void {
  currentLanguage = language;
}

/** The language most recently pushed from main.ts (defaults to English). */
export function uiLanguage(): DemoLanguage {
  return currentLanguage;
}

/** Translate a static string into the active UI language (English fallback). */
export function t(text: string): string {
  return tDemo(text, currentLanguage);
}

/** Translate a template, then substitute `{placeholder}` vars verbatim (IDs/amounts stay raw). */
export function tf(template: string, vars: Record<string, string | number>): string {
  const stringVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) stringVars[key] = String(value);
  return tDemoFormat(template, currentLanguage, stringVars);
}
