// Post-build prerender for the three legal SPA routes (/privacy, /terms,
// /delete-account). Reads dist/index.html as the SPA shell, splices the
// route-specific HTML into <main id="app">, rewrites the title and SEO meta
// tags, and writes dist/<route>/index.html. The render-web static file server
// (apps/render-web/src/server.ts) auto-resolves a directory request to its
// index.html, so no server-side change is needed.
//
// Why this exists: Solana dApp Store policy review fetches the submitted
// privacy/terms URLs as plain HTTP. Without prerendering, the SPA shell
// contains zero policy text in the initial response and the reviewer marks
// the policy as "Missing or Invalid".

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { privacyPage, termsPage, deleteAccountPage } from '../src/legal/pages.js';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '../dist');
const ORIGIN = 'https://agentic-signer.com';

const pages = [
  {
    route: '/privacy',
    title: 'Privacy Policy · Agentic',
    desc: 'Agentic Privacy Policy — what data SolPulse LLC collects, how it is used, retained, and shared, and the rights you have.',
    body: privacyPage(),
  },
  {
    route: '/terms',
    title: 'Terms of Service · Agentic',
    desc: 'Agentic Terms of Service — the agreement governing your use of the Agentic non-custodial wallet authority adapter operated by SolPulse LLC.',
    body: termsPage(),
  },
  {
    route: '/delete-account',
    title: 'Delete Account · Agentic',
    desc: 'Delete your Agentic Cloud data and any wallet-scoped state held by SolPulse LLC — in-app flow and email request instructions.',
    body: deleteAccountPage(),
  },
];

function replaceOnce(html, pattern, replacement, label) {
  if (!pattern.test(html)) {
    throw new Error(`prerender-legal: shell missing expected tag: ${label}`);
  }
  return html.replace(pattern, replacement);
}

async function main() {
  const shellPath = join(distDir, 'index.html');
  let shell;
  try {
    shell = await readFile(shellPath, 'utf-8');
  } catch (err) {
    throw new Error(`prerender-legal: could not read ${shellPath} — did vite build run first? (${err.message})`);
  }

  for (const { route, title, desc, body } of pages) {
    const url = `${ORIGIN}${route}`;
    let html = shell;
    html = replaceOnce(html, /<title>[^<]*<\/title>/, `<title>${title}</title>`, '<title>');
    html = replaceOnce(html, /<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${desc}" />`, 'meta description');
    html = replaceOnce(html, /<link rel="canonical" href="[^"]*"\s*\/?>/, `<link rel="canonical" href="${url}" />`, 'link canonical');
    html = replaceOnce(html, /<meta property="og:url" content="[^"]*"\s*\/?>/, `<meta property="og:url" content="${url}" />`, 'meta og:url');
    html = replaceOnce(html, /<meta property="og:title" content="[^"]*"\s*\/?>/, `<meta property="og:title" content="${title}" />`, 'meta og:title');
    html = replaceOnce(html, /<meta property="og:description" content="[^"]*"\s*\/?>/, `<meta property="og:description" content="${desc}" />`, 'meta og:description');
    html = replaceOnce(html, /<meta name="twitter:title" content="[^"]*"\s*\/?>/, `<meta name="twitter:title" content="${title}" />`, 'meta twitter:title');
    html = replaceOnce(html, /<meta name="twitter:description" content="[^"]*"\s*\/?>/, `<meta name="twitter:description" content="${desc}" />`, 'meta twitter:description');
    if (!html.includes('<main id="app"></main>')) {
      throw new Error('prerender-legal: shell missing <main id="app"></main> placeholder');
    }
    html = html.replace('<main id="app"></main>', `<main id="app">${body}</main>`);

    const outDir = join(distDir, route.slice(1));
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'index.html'), html, 'utf-8');
  }

  console.log(`prerender-legal: wrote ${pages.map((p) => p.route).join(', ')}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
