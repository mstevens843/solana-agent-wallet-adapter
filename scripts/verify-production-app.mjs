#!/usr/bin/env node

const args = parseArgs(process.argv.slice(2));
const origin = normalizeOrigin(
  args.options.origin ??
    process.env.AGENTIC_PUBLIC_ORIGIN ??
    'https://agentic-signer.com',
);
const expectedCommit = (args.options['expected-commit'] ?? process.env.EXPECTED_COMMIT ?? '').trim();

const failures = [];

const build = await fetchJson(new URL('/api/app-build', origin));
const deployedCommit = typeof build.commit === 'string' ? build.commit.trim() : '';
if (!deployedCommit || deployedCommit === 'unknown') {
  failures.push(`/api/app-build returned unusable commit: ${JSON.stringify(build)}`);
}
if (expectedCommit && deployedCommit !== expectedCommit.slice(0, 12)) {
  failures.push(`/api/app-build commit ${deployedCommit} does not match expected ${expectedCommit.slice(0, 12)}`);
}

const app = await fetchText(new URL('/app', origin));
const html = app.text;
if (!/no-store/i.test(app.headers.get('cache-control') ?? '')) {
  failures.push('/app must be served with Cache-Control: no-store');
}
if (!html.includes('interactive-widget=resizes-content')) {
  failures.push('/app HTML is missing interactive-widget=resizes-content viewport policy');
}

const jsPath = firstMatch(html, /\bsrc="([^"]*\/assets\/index-[^"]+\.js)"/);
const cssPath = firstMatch(html, /\bhref="([^"]*\/assets\/index-[^"]+\.css)"/);
if (!jsPath) failures.push('/app HTML does not reference a hashed index JS asset');
if (!cssPath) failures.push('/app HTML does not reference a hashed index CSS asset');

if (jsPath) {
  const js = (await fetchText(new URL(jsPath, origin))).text;
  for (const required of [
    deployedCommit,
    'currentBuildCommit',
    'agentic_build',
    '__agenticAndroidKeyboardInsetBridge',
    'keyboardInsets',
    'focused-control-fallback',
  ]) {
    if (!required || !js.includes(required)) {
      failures.push(`production JS ${jsPath} is missing ${required || 'deployed commit'}`);
    }
  }
}

if (cssPath) {
  const css = (await fetchText(new URL(cssPath, origin))).text;
  if (!css.includes('mobile-rail-keyboard-inset')) {
    failures.push(`production CSS ${cssPath} is missing mobile-rail-keyboard-inset`);
  }
  if (!/bottom:\s*var\(--mobile-rail-keyboard-inset\)/.test(css)) {
    failures.push(`production CSS ${cssPath} does not position the mobile rail sheet with keyboard inset`);
  }
}

if (failures.length > 0) {
  console.error('[production-app] Verification failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`[production-app] Verified ${origin} commit=${deployedCommit}`);
console.log(`[production-app] Verified live-update and mobile keyboard sheet assets.`);

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) failFetch(url, response);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) failFetch(url, response);
  return { text: await response.text(), headers: response.headers };
}

function failFetch(url, response) {
  console.error(`[production-app] ${url} returned HTTP ${response.status}`);
  process.exit(1);
}

function firstMatch(value, pattern) {
  const match = value.match(pattern);
  return match?.[1] ?? '';
}

function normalizeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    console.error(`[production-app] Invalid origin: ${value}`);
    process.exit(1);
  }
}

function parseArgs(values) {
  const options = {};
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2);
    const next = values[i + 1];
    if (!next || next.startsWith('--')) {
      options[key] = '1';
      continue;
    }
    options[key] = next;
    i += 1;
  }
  return { options };
}
