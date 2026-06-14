#!/usr/bin/env node
import { generateKeyPairSync, sign as signDetached } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  workflowDecisionProofMessage as sharedWorkflowDecisionProofMessage,
  workflowFinalizationProofMessage as sharedWorkflowFinalizationProofMessage,
} from '../packages/workflow/dist/index.js';

import { canonicalize as ap2Canonicalize } from '../packages/ap2-adapter/dist/verifier.js';

import { publicAppRoutes } from './public-routes.mjs';

const DEFAULT_RENDER_ORIGIN = 'https://agentic-signer.com';
const DEFAULT_BRIDGE_TOKEN = 'local-agent-wallet';
const RENDER_SERVER_ENTRY = 'apps/render-web/dist/server.js';
const DEMO_STORAGE_KEY = 'solana-agent-wallet-demo-v2';
const GENERATED_PLANS_STORAGE_KEY = 'solana-agent-wallet-generated-plans-v1';
const BROWSER_WORKFLOW_STORAGE_KEY = 'solana-agent-wallet-browser-workflow-v1';
const TERMINAL_WORKFLOW_STATUSES = ['approved', 'rejected', 'cancelled', 'blocked', 'failed', 'expired'];
const options = parseArgs(process.argv.slice(2));

async function main() {
  try {
    if (options.help) {
      printUsage();
    } else if (options.mode === 'live') {
      await verifyLiveRender(options.liveOrigin);
    } else if (options.mode === 'layout') {
      await verifyLayoutSmoke();
    } else if (options.mode === 'android-layout') {
      await verifyAndroidLayoutSmoke();
    } else if (options.mode === 'workflow') {
      await verifyWorkflowSmoke({ requireLocalBridge: options.requireLocalBridge });
    } else if (options.mode === 'ap2') {
      await verifyAp2Smoke({ live: options.ap2Live, liveOrigin: options.liveOrigin });
    } else if (options.mode === 'skills') {
      await verifySkillsSmoke({ live: options.skillsLive, liveOrigin: options.liveOrigin });
    } else {
      await verifyLocalRender();
    }
    process.exit(0);
  } catch (err) {
    console.error(`[smoke-render-web] ${formatErrorForLog(err)}`);
    process.exit(1);
  }
}

function parseArgs(rawArgs) {
  const normalized = rawArgs.filter((arg) => arg !== '--');
  const parsed = {
    help: false,
    liveOrigin: process.env.AGENTIC_RENDER_ORIGIN ?? DEFAULT_RENDER_ORIGIN,
    mode: 'local',
    requireLocalBridge: false,
    ap2Live: false,
    skillsLive: false,
  };
  const setMode = (mode, flag) => {
    if (parsed.mode !== 'local' && parsed.mode !== mode) {
      throw new Error(`Cannot combine ${flag} with another smoke mode.`);
    }
    parsed.mode = mode;
  };

  for (let index = 0; index < normalized.length; index += 1) {
    const arg = normalized[index];
    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
    } else if (arg === '--workflow') {
      setMode('workflow', arg);
    } else if (arg === '--layout') {
      setMode('layout', arg);
    } else if (arg === '--android-layout') {
      setMode('android-layout', arg);
    } else if (arg === '--ap2') {
      setMode('ap2', arg);
    } else if (arg === '--skills') {
      setMode('skills', arg);
    } else if (arg === '--live') {
      if (parsed.mode === 'ap2') {
        parsed.ap2Live = true;
        const candidate = normalized[index + 1];
        if (candidate && !candidate.startsWith('-')) {
          parsed.liveOrigin = candidate;
          index += 1;
        }
      } else if (parsed.mode === 'skills') {
        parsed.skillsLive = true;
        const candidate = normalized[index + 1];
        if (candidate && !candidate.startsWith('-')) {
          parsed.liveOrigin = candidate;
          index += 1;
        }
      } else {
        setMode('live', arg);
        const candidate = normalized[index + 1];
        if (candidate && !candidate.startsWith('-')) {
          parsed.liveOrigin = candidate;
          index += 1;
        }
      }
    } else if (arg === '--require-local-bridge') {
      parsed.requireLocalBridge = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (parsed.requireLocalBridge && parsed.mode !== 'workflow') {
    throw new Error('--require-local-bridge can only be used with --workflow.');
  }
  if (parsed.ap2Live && parsed.mode !== 'ap2') {
    throw new Error('--live can only modify --ap2/--skills (or be used as a standalone mode).');
  }
  if (parsed.skillsLive && parsed.mode !== 'skills') {
    throw new Error('--live can only modify --ap2/--skills (or be used as a standalone mode).');
  }
  return parsed;
}

function printUsage() {
  console.log(`Usage:
  pnpm smoke:render-web
  pnpm smoke:render-web -- --layout
  pnpm smoke:render-web -- --android-layout
  pnpm smoke:render-web -- --workflow
  pnpm smoke:render-web -- --workflow --require-local-bridge
  pnpm smoke:render-web -- --live [origin]
  pnpm smoke:render-web -- --ap2
  pnpm smoke:render-web -- --ap2 --live [origin]
  pnpm smoke:render-web -- --skills
  pnpm smoke:render-web -- --skills --live [origin]

Modes:
  default                 Build-output route smoke against local Render server.
  --layout                Browser geometry smoke for deterministic /app layout.
  --android-layout        Android-shell geometry and touch-scroll smoke for /demo and /app.
  --workflow              End-to-end cloud/browser workflow release smoke.
  --live [origin]         Content-type smoke against a deployed origin.
  --ap2                   End-to-end AP2 inbound smoke against a local Render server.
  --skills                End-to-end Skills smoke against a local in-process Render server.

Options:
  --require-local-bridge  Also require a real bridge at AGENTIC_BRIDGE_URL.
  --live (with --ap2)     Thin live-mode probe of the deployed AP2 surfaces.
  --live (with --skills)  Thin live-mode probe of deployed Skills public surfaces.
  -h, --help              Show this help.
`);
}

async function verifyLocalRender() {
  await withLocalServer(async ({ origin, serverPort }) => {
    await waitForHostedAiStatus(`${origin}/api/ai/status`);
    if (process.env.AGENTIC_SMOKE_FORCE_HTTP_FALLBACK === '1' || !findChromePath()) {
      await verifyLocalRenderHttpFallback(origin);
      console.log('[smoke-render-web] SKIP browser public-host local bridge startup probe: Chrome/Chromium is unavailable or HTTP fallback was forced. Set CHROME_PATH to run browser runtime smoke.');
      return;
    }
    await withChrome(async (page) => {
      for (const route of publicAppRoutes) {
        const result = await page.inspect(`${origin}${route}`);
        const exception = result.events.find((event) => event.method === 'Runtime.exceptionThrown');
        if (exception) throw new Error(`Browser runtime error on ${route}: ${eventSummary(exception)}`);
        if (result.page.startupFailure) {
          throw new Error(`Startup failure panel rendered on ${route}: ${result.page.appText}`);
        }
        if (!result.page.appText.trim() && result.page.appHtmlLength < 80) {
          throw new Error(`App root stayed empty on ${route}.`);
        }
        console.log(`[smoke-render-web] PASS route ${route} rendered ${result.page.appHtmlLength} HTML byte(s).`);
      }

      const publicHostResult = await page.inspect(`http://agentic-smoke.test:${serverPort}/app`);
      const publicHostBridgeProbe = publicHostResult.events.find(isLocalBridgeConfigRequest);
      if (publicHostBridgeProbe) {
        throw new Error(`Public-host startup requested the local bridge: ${eventSummary(publicHostBridgeProbe)}`);
      }
      console.log('[smoke-render-web] PASS public-host startup did not request the local bridge.');
    });
  });
}

async function verifyLocalRenderHttpFallback(origin) {
  for (const route of publicAppRoutes) {
    const response = await fetch(`${origin}${route}`);
    const contentType = response.headers.get('content-type') ?? '';
    const raw = await response.text();
    if (!response.ok) throw new Error(`${route} returned HTTP ${response.status}: ${snippet(raw)}`);
    if (!/text\/html/i.test(contentType)) {
      throw new Error(`${route} returned ${contentType || 'missing content-type'} instead of text/html: ${snippet(raw)}`);
    }
    if (!raw.includes('id="app"')) throw new Error(`${route} did not include the app shell.`);
    const assetRefs = Array.from(raw.matchAll(/\b(?:src|href)="([^"]+)"/g))
      .map((match) => match[1])
      .filter((value) => typeof value === 'string' && value.startsWith('/assets/'));
    const scriptRefs = assetRefs.filter((value) => value.endsWith('.js'));
    if (scriptRefs.length === 0) {
      throw new Error(`${route} did not include a built JavaScript asset.`);
    }
    await verifyReferencedAssets(origin, route, assetRefs.slice(0, 8));
    console.log(`[smoke-render-web] PASS route ${route} returned HTML app shell with ${assetRefs.length} local asset reference(s).`);
  }
}

async function verifyReferencedAssets(origin, route, assetRefs) {
  for (const href of assetRefs) {
    const response = await fetch(`${origin}${href}`);
    if (!response.ok) {
      throw new Error(`${route} referenced missing asset ${href}: HTTP ${response.status}`);
    }
  }
}

async function verifyLayoutSmoke() {
  const viewports = [
    { width: 1440, height: 1000 },
    { width: 1280, height: 900 },
    { width: 1024, height: 900 },
    { width: 768, height: 900 },
    { width: 430, height: 932 },
    { width: 390, height: 844 },
  ];
  const tabs = ['overview', 'agent', 'schedule', 'inbox', 'completed', 'labs'];
  await withLocalServer(async ({ origin }) => {
    const wallet = createTestWallet();
    await withWalletSigner(wallet, async ({ origin: signerOrigin }) => {
      await withChrome(async (page) => {
        await page.addInitScript(fakeWalletScript(wallet, signerOrigin));
        await verifyPublicRouteLayoutSmoke(page, origin);
        for (const viewport of viewports) {
          await page.setViewport(viewport.width, viewport.height);
          await page.inspect(`${origin}/app`);
          await connectFakeWallet(page);
          for (const tab of tabs) {
            await page.evaluate('window.scrollTo(0, 0)');
            await page.waitFor('window.scrollY < 3');
            await clickAppLayoutTab(page, tab, viewport.width);
            await page.waitFor(`Array.from(document.querySelectorAll('[data-tab="${tab}"]')).some((el) => el.classList.contains('active') || el.getAttribute('aria-current') === 'page')`);
            const maxScroll = await page.evaluate(`Math.max(0, document.documentElement.scrollHeight - window.innerHeight)`);
            const scrollChecks = [
              ['top', 0],
              ['middle', Math.round(maxScroll / 2)],
              ['bottom', maxScroll],
            ];
            for (const [scrollName, scrollY] of scrollChecks) {
              await page.evaluate(`window.scrollTo(0, ${Number(scrollY)})`);
              await page.waitFor(`Math.abs(window.scrollY - ${Number(scrollY)}) < 3 || document.documentElement.scrollHeight <= window.innerHeight + 3`);
              const report = await appLayoutReport(page, `${viewport.width}x${viewport.height} ${tab} ${scrollName}`);
              if (report.errors.length) {
                throw new Error(`Layout failed for ${report.label}: ${report.errors.join('; ')}\n${formatLayoutRects(report)}`);
              }
              console.log(`[smoke-render-web] PASS layout ${report.label} scroll=${report.scrollWidth}/${report.innerWidth} y=${report.scrollY}`);
            }
          }
        }
        await verifyAppInteractionContracts(page, origin, wallet);
      });
    });
  });
}

async function verifyAndroidLayoutSmoke() {
  const viewports = [
    { width: 430, height: 932 },
    { width: 390, height: 844 },
  ];
  const tabs = ['overview', 'agent', 'inbox', 'completed', 'schedule', 'skills', 'agent-protocols', 'sessions'];
  await withLocalServer(async ({ origin }) => {
    const wallet = createTestWallet();
    await withWalletSigner(wallet, async ({ origin: signerOrigin }) => {
      await withChrome(async (page) => {
        await page.addInitScript(fakeAndroidShellBridgeScript());
        await page.addInitScript(fakeWalletScript(wallet, signerOrigin));
        for (const viewport of viewports) {
          await page.setViewport(viewport.width, viewport.height);
          await page.inspect(`${origin}/demo`);
          await assertAndroidShellGestureScrolls(page, `${viewport.width}x${viewport.height} /demo`, { requireScrollable: true });
          await page.inspect(`${origin}/app`);
          await connectFakeWallet(page);
          for (const tab of tabs) {
            await resetPageScrollToTop(page);
            await clickAppLayoutTab(page, tab, viewport.width);
            await page.waitFor(`Array.from(document.querySelectorAll('[data-tab="${tab}"]')).some((el) => el.classList.contains('active') || el.getAttribute('aria-current') === 'page')`);
            const report = await appLayoutReport(page, `android ${viewport.width}x${viewport.height} ${tab}`);
            const androidLayoutErrors = report.errors.filter((error) => {
              if (error.startsWith('connection trigger ')) return false;
              if (tab !== 'overview' && error.startsWith('rail ')) return false;
              return true;
            });
            if (androidLayoutErrors.length) {
              throw new Error(`Android layout failed for ${report.label}: ${androidLayoutErrors.join('; ')}\n${formatLayoutRects(report)}`);
            }
            await assertAndroidShellGestureScrolls(page, `android ${viewport.width}x${viewport.height} ${tab}`);
          }
        }
      });
    });
  });
}

async function verifyPublicRouteLayoutSmoke(page, origin) {
  const viewports = [
    { width: 430, height: 932 },
    { width: 390, height: 844 },
    { width: 360, height: 800 },
  ];
  const routes = ['/', '/docs', '/demo', '/app'];
  for (const viewport of viewports) {
    await page.setViewport(viewport.width, viewport.height);
    for (const route of routes) {
      await page.inspect(`${origin}${route}`);
      await page.evaluate('window.scrollTo(0, 0)');
      await page.waitFor('window.scrollY < 3');
      const report = await publicRouteLayoutReport(page, `${viewport.width}x${viewport.height} ${route}`);
      if (report.errors.length) {
        throw new Error(`Public route layout failed for ${report.label}: ${report.errors.join('; ')}\n${JSON.stringify(report, null, 2)}`);
      }
      console.log(`[smoke-render-web] PASS public layout ${report.label} nav=${report.visibleNavLabels.join('|')} scroll=${report.scrollWidth}/${report.innerWidth}`);
    }
  }
}

async function assertAndroidShellGestureScrolls(page, label, { requireScrollable = false } = {}) {
  await resetPageScrollToTop(page);
  const before = await androidShellScrollState(page, label);
  const errors = androidShellScrollErrors(before, { requireScrollable });
  if (errors.length) {
    throw new Error(`Android scroll lock failed for ${label}: ${errors.join('; ')}\n${JSON.stringify(before, null, 2)}`);
  }
  if (before.maxScroll < 40) {
    console.log(`[smoke-render-web] SKIP android touch-scroll ${label}: content is not scrollable (max=${before.maxScroll}).`);
    return;
  }
  const startX = Math.round(before.innerWidth / 2);
  const startY = Math.round(Math.min(before.innerHeight - 128, before.innerHeight * 0.74));
  const endY = Math.round(Math.max(96, before.innerHeight * 0.24));
  await page.touchDrag(startX, startY, startX, endY);
  await page.waitFor('window.scrollY > 20', 5_000);
  const after = await androidShellScrollState(page, label);
  if (after.scrollY <= 20) {
    throw new Error(`Android touch drag did not move page for ${label}.\n${JSON.stringify({ before, after }, null, 2)}`);
  }
  console.log(`[smoke-render-web] PASS android touch-scroll ${label} y=${after.scrollY}/${after.maxScroll}`);
}

async function resetPageScrollToTop(page) {
  await page.evaluate(`(() => {
    const html = document.documentElement;
    const body = document.body;
    const scroller = document.scrollingElement || html;
    const previousHtmlBehavior = html.style.scrollBehavior;
    const previousBodyBehavior = body.style.scrollBehavior;
    html.style.scrollBehavior = 'auto';
    body.style.scrollBehavior = 'auto';
    window.scrollTo(0, 0);
    scroller.scrollTop = 0;
    html.scrollTop = 0;
    body.scrollTop = 0;
    html.style.scrollBehavior = previousHtmlBehavior;
    body.style.scrollBehavior = previousBodyBehavior;
  })()`);
  await page.waitFor('window.scrollY < 3 || Math.max(0, document.documentElement.scrollHeight - window.innerHeight) < 3', 5_000);
}

async function androidShellScrollState(page, label) {
  return page.evaluate(`(() => {
    const label = ${JSON.stringify(label)};
    const shell = document.querySelector('.shell');
    const htmlStyle = window.getComputedStyle(document.documentElement);
    const bodyStyle = window.getComputedStyle(document.body);
    const shellStyle = shell ? window.getComputedStyle(shell) : null;
    return {
      bodyExpandNoteSheet: document.body.dataset.expandNoteSheet || '',
      bodyMobileRailSheet: document.body.dataset.mobileRailSheet || '',
      bodyOverflowY: bodyStyle.overflowY,
      bodyTouchAction: bodyStyle.touchAction,
      hasAndroidShell: Boolean(document.querySelector('.shell.android-shell')),
      htmlOverflowY: htmlStyle.overflowY,
      htmlTouchAction: htmlStyle.touchAction,
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
      label,
      maxScroll: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
      scrollHeight: document.documentElement.scrollHeight,
      scrollY: window.scrollY,
      shellOverflowY: shellStyle?.overflowY ?? '',
      shellTouchAction: shellStyle?.touchAction ?? '',
    };
  })()`);
}

function androidShellScrollErrors(state, { requireScrollable = false } = {}) {
  const errors = [];
  if (!state.hasAndroidShell) errors.push('android shell class missing');
  if (state.bodyMobileRailSheet) errors.push(`stale mobile rail sheet lock: ${state.bodyMobileRailSheet}`);
  if (state.bodyExpandNoteSheet) errors.push(`stale expand note lock: ${state.bodyExpandNoteSheet}`);
  if (state.htmlOverflowY === 'hidden') errors.push('html overflow-y hidden');
  if (state.bodyOverflowY === 'hidden') errors.push('body overflow-y hidden');
  if (state.shellOverflowY === 'hidden') errors.push('shell overflow-y hidden');
  if (state.htmlTouchAction === 'none') errors.push('html touch-action none');
  if (state.bodyTouchAction === 'none') errors.push('body touch-action none');
  if (state.shellTouchAction === 'none') errors.push('shell touch-action none');
  if (requireScrollable && state.maxScroll < 40) errors.push(`page is not scrollable: max=${state.maxScroll}`);
  return errors;
}

async function publicRouteLayoutReport(page, label) {
  return page.evaluate(`(() => {
    const label = ${JSON.stringify(label)};
    const errors = [];
    const innerWidth = window.innerWidth;
    const scrollWidth = document.documentElement.scrollWidth;
    const rectData = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return {
        bottom: rect.bottom,
        display: style.display,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        text: element.innerText.trim().replace(/\\s+/g, ' '),
        top: rect.top,
        visibility: style.visibility,
        width: rect.width,
      };
    };
    if (scrollWidth > innerWidth + 1) errors.push('document has horizontal overflow');
    const nav = document.querySelector('[data-site-nav]');
    if (!nav) {
      errors.push('site nav missing');
    } else {
      const navRect = rectData(nav);
      if (navRect.display === 'none' || navRect.visibility === 'hidden') errors.push('site nav hidden');
      if (navRect.left < -1 || navRect.right > innerWidth + 1) errors.push('site nav clips offscreen');
      if (navRect.width <= 0 || navRect.height <= 0) errors.push('site nav has empty geometry');
    }
    const visibleLinks = Array.from(document.querySelectorAll('[data-site-links] [data-site-link]'))
      .map((link) => ({ route: link.getAttribute('data-site-link'), rect: rectData(link) }))
      .filter((entry) => entry.rect.display !== 'none' && entry.rect.visibility !== 'hidden' && entry.rect.width > 0 && entry.rect.height > 0);
    const visibleNavRoutes = visibleLinks.map((entry) => entry.route);
    const visibleNavLabels = visibleLinks.map((entry) => entry.rect.text);
    const expectedRoutes = ['/', '/docs', '/demo', '/app'];
    const expectedLabels = ['Home', 'Docs', 'Demo', 'App'];
    if (visibleNavRoutes.join('|') !== expectedRoutes.join('|')) {
      errors.push('visible nav route order changed: ' + visibleNavRoutes.join('|'));
    }
    if (visibleNavLabels.join('|') !== expectedLabels.join('|')) {
      errors.push('visible nav labels changed: ' + visibleNavLabels.join('|'));
    }
    for (const entry of visibleLinks) {
      if (entry.rect.left < -1 || entry.rect.right > innerWidth + 1) {
        errors.push('nav link ' + entry.route + ' clips offscreen');
      }
    }
    for (let index = 1; index < visibleLinks.length; index += 1) {
      if (visibleLinks[index - 1].rect.right > visibleLinks[index].rect.left + 1) {
        errors.push('nav links overlap around ' + visibleLinks[index - 1].route + ' and ' + visibleLinks[index].route);
      }
    }
    const isDocs = document.querySelector('.route-docs') !== null;
    const docsCards = isDocs
      ? Array.from(document.querySelectorAll('.docs-card, .protocol-connector-flow-card, .protocol-connector-card')).map((card, index) => {
          const cardRect = rectData(card);
          const title = card.querySelector('h3, h4');
          const status = card.querySelector('.protocol-connector-status');
          const titleRect = title ? rectData(title) : null;
          const statusRect = status ? rectData(status) : null;
          if (cardRect.left < -1 || cardRect.right > innerWidth + 1) errors.push('docs card ' + index + ' clips offscreen');
          if (titleRect && titleRect.width <= 16) errors.push('docs card ' + index + ' title is squeezed');
          if (titleRect && statusRect) {
            const overlap = titleRect.left < statusRect.right - 1 &&
              titleRect.right > statusRect.left + 1 &&
              titleRect.top < statusRect.bottom - 1 &&
              titleRect.bottom > statusRect.top + 1;
            if (overlap) errors.push('docs card ' + index + ' title overlaps status');
          }
          return { card: cardRect, index, status: statusRect, title: titleRect };
        })
      : [];
    return {
      docsCards: docsCards.slice(0, 8),
      errors,
      innerWidth,
      label,
      scrollWidth,
      visibleNavLabels,
      visibleNavRoutes,
    };
  })()`);
}

async function verifyAppInteractionContracts(page, origin, wallet) {
  await page.setViewport(1280, 900);
  await page.inspect(`${origin}/app`);
  if (await page.evaluate(`Boolean(document.querySelector('#disconnect'))`)) {
    await clickAndWait(page, '#disconnect', 'disconnect before no-wallet cloud CTA check');
    await page.waitFor(`!Boolean(document.querySelector('#disconnect'))`);
  }
  const noWalletCloudCta = await page.evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll('.rail-cloud-actions button'));
    return buttons.some((button) => (
      /Connect (Cloud Storage|wallet to sign in)/i.test(button.textContent || '') &&
      (button.dataset.cloudAction === 'sign-in' || Boolean(button.dataset.firstRunAction))
    ));
  })()`);
  assert(noWalletCloudCta, 'cloud sign-in CTA did not route through wallet connect when no wallet is connected');

  await connectFakeWallet(page);
  const aiSetupOpen = await page.evaluate(`document.querySelector('details[data-layout="ai-setup-panel"]')?.open === true`);
  if (!aiSetupOpen) {
    await clickAndWait(page, 'details[data-layout="ai-setup-panel"] > summary, [data-first-run-action="open-ai-setup"]', 'open AI setup from sidebar');
  }
  await page.waitFor(`document.querySelector('details[data-layout="ai-setup-panel"]')?.open === true`);
  await assertRailBridgeAiSetupLayout(page);
  await clickAndWait(page, 'details[data-layout="ai-setup-panel"] > summary', 'collapse AI setup after open check');
  await page.waitFor(`document.querySelector('details[data-layout="ai-setup-panel"]')?.open === false`);
  await ensureCreatePlanView(page);
  await page.evaluate('window.scrollTo(0, 0)');
  await page.waitFor('window.scrollY < 3');
  await assertSelectorAboveFold(page, '#generatePlan', 'create draft primary action');
  await clickAndWait(page, '#generatePlan', 'create draft for review layout');
  await clickAndWait(page, '[data-one-time-view="review"]', 'review drafted plans');
  await page.waitFor(`Boolean(document.querySelector('[data-layout="review-plan-card"]'))`);
  const report = await appLayoutReport(page, '1280x900 agent review contract');
  if (report.errors.length) {
    throw new Error(`Layout failed for ${report.label}: ${report.errors.join('; ')}\n${formatLayoutRects(report)}`);
  }
  const reviewContract = await page.evaluate(`(() => {
    const walletAddress = ${JSON.stringify(wallet.walletAddress)};
    const card = document.querySelector('[data-layout="review-plan-card"]');
    if (!card) return { ok: false, reason: 'missing review card' };
    const visibleText = Array.from(card.children)
      .filter((child) => !child.matches('.generated-plan-inline-details'))
      .map((child) => child.textContent || '')
      .join('\\n');
    const buttons = Array.from(card.querySelectorAll('.review-plan-actions button')).map((button) => ({
      action: button.dataset.generatedPlanAction || '',
      primary: button.classList.contains('primary'),
      text: (button.textContent || '').trim(),
    }));
    const labels = Array.from(card.querySelectorAll('.wallet-action-grid dt')).map((node) => (node.textContent || '').trim());
    const walletValue = card.querySelector('.wallet-action-wallet dd')?.textContent?.trim() || '';
    return {
      buttons,
      labels,
      ok: true,
      visibleHasActionQuickFact: /\\bAction\\b/.test(visibleText),
      visibleHasNetworkQuickFact: /\\bNetwork\\b/.test(visibleText),
      visibleHasRiskQuickFact: /\\bRisk\\b/.test(visibleText),
      walletExpected: walletAddress,
      walletValue,
    };
  })()`);
  assert(reviewContract.ok, `review contract failed: ${reviewContract.reason || 'unknown'}`);
  assert(reviewContract.buttons.some((button) => button.action === 'queue' && button.text === 'Send for approval'), `review card approval action is wrong: ${JSON.stringify(reviewContract.buttons)}`);
  assert(!reviewContract.visibleHasNetworkQuickFact, 'review card still exposes Network in the visible summary');
  if (reviewContract.labels.length > 0) {
    assert(reviewContract.labels.join('|') === 'Wallet|Amount|Route or recipient', `review summary labels changed: ${reviewContract.labels.join('|')}`);
  }
  if (reviewContract.walletValue) {
    assert(
      reviewContract.walletValue === reviewContract.walletExpected ||
        reviewContract.walletValue.includes(reviewContract.walletExpected.slice(0, 6)),
      `review card wallet is not recognizable: ${reviewContract.walletValue}`,
    );
  }
  await ensureCreatePlanView(page);
  await selectPlanTemplate(page, 'balances');
  await clickAndWait(page, '#generatePlan', 'create proof-only draft for Done navigation');
  await page.waitFor(`Array.from(document.querySelectorAll('[data-generated-plan-action="sign-proof"]')).some((el) => !el.disabled)`);
  const proofPlanId = await page.evaluate(`document.querySelector('[data-generated-plan-action="sign-proof"]')?.dataset.generatedPlanId ?? ''`);
  assert(proofPlanId, 'proof-only generated plan id is missing');
  await clickAndWait(
    page,
    `[data-generated-plan-action="sign-proof"][data-generated-plan-id="${proofPlanId}"]`,
    'sign proof-only draft',
  );
  await page.waitFor(`document.querySelector('[data-layout="app-shell"]')?.getAttribute('data-active-tab') === 'completed'`);
  await page.waitFor(`Boolean(document.querySelector('[data-completed-focus="true"]'))`);
  const proofDoneContract = await page.evaluate(`(() => {
    const focused = document.querySelector('[data-completed-focus="true"]');
    const activeFilter = document.querySelector('[data-completed-filter="all"]');
    const toastText = document.querySelector('.toast-stack')?.textContent || '';
    const focusedText = focused?.textContent || '';
    return {
      allFilterActive: Boolean(activeFilter?.classList.contains('active')),
      focusedHasProof: /proof signed|Review proof|Proof/i.test(focusedText),
      focusedText,
      toastHasSuccess: /Proof signed/i.test(toastText) && /Saved in Done/i.test(toastText),
      toastText,
    };
  })()`);
  assert(proofDoneContract.allFilterActive, 'proof signing did not switch Done to the All filter');
  assert(proofDoneContract.focusedHasProof, `focused Done card is not the signed proof: ${proofDoneContract.focusedText}`);
  assert(proofDoneContract.toastHasSuccess, `proof signing success toast missing: ${proofDoneContract.toastText}`);
  await clickAndWait(page, '[data-layout="app-tabs"] [data-tab="schedule"]', 'recurring tab for fold check');
  await page.evaluate('window.scrollTo(0, 0)');
  await page.waitFor('window.scrollY < 3');
  await assertSelectorAboveFold(page, '#createRecurring', 'create recurring primary action');
  console.log(`[smoke-render-web] PASS interaction contracts ${report.label} reviewCards=${report.reviewCards?.length ?? 0}`);
}

async function assertSelectorAboveFold(page, selector, label) {
  const result = await page.evaluate(`(() => {
    const selector = ${JSON.stringify(selector)};
    const element = document.querySelector(selector);
    if (!element) return { ok: false, reason: 'missing' };
    const rect = element.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      innerHeight: window.innerHeight,
      ok: rect.top < window.innerHeight - 1 && rect.bottom <= window.innerHeight + 80 && rect.top >= -1,
      reason: 'geometry',
      top: rect.top,
    };
  })()`);
  assert(result.ok, `${label} is not above the fold: ${JSON.stringify(result)}`);
}

async function assertRailBridgeAiSetupLayout(page) {
  const setup = await page.evaluate(`(() => {
    const panel = document.querySelector('details.rail-ai-settings[data-layout="ai-setup-panel"]');
    const mode = panel?.querySelector('[data-ai-control="mode"]');
    if (!panel || !mode) return { ok: false, reason: 'missing rail AI mode control' };
    panel.open = true;
    const previousMode = mode.value || 'hosted';
    if (mode.value !== 'bridge') {
      mode.value = 'bridge';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { ok: true, previousMode };
  })()`);
  assert(setup.ok, `rail AI setup could not select local bridge: ${JSON.stringify(setup)}`);
  await page.waitFor(`(() => {
    const panel = document.querySelector('details.rail-ai-settings[data-layout="ai-setup-panel"]');
    return Boolean(panel?.open && panel.querySelector('.local-bridge-ai-setup-card') && panel.querySelector('[data-ai-control="provider"]') && panel.querySelector('[data-ai-control="model-select"]'));
  })()`);
  const result = await page.evaluate(`(() => {
    const panel = document.querySelector('details.rail-ai-settings[data-layout="ai-setup-panel"]');
    if (!panel) return { ok: false, reason: 'missing rail AI setup panel' };
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      return element.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const fieldFor = (selector) => panel.querySelector(selector)?.closest('.ai-setting-field') ?? panel.querySelector(selector);
    const provider = fieldFor('[data-ai-control="provider"]');
    const model = fieldFor('[data-ai-control="model-select"]');
    const keySurface = panel.querySelector('.ai-key-configured-note:not(.ai-inactive-config-note), .ai-setting-key');
    const actions = panel.querySelector('.ai-actions');
    const compactNote = panel.querySelector('.ai-security-note.compact');
    const bridge = panel.querySelector('.local-bridge-ai-setup-card');
    const body = bridge?.querySelector('.local-bridge-ai-setup-body');
    const required = { provider, model, keySurface, actions, compactNote, bridge, body };
    const missing = Object.entries(required)
      .filter(([, element]) => !visible(element))
      .map(([name]) => name);
    if (missing.length) return { ok: false, reason: 'missing visible elements', missing };
    const bridgeTop = bridge.getBoundingClientRect().top;
    const orderedBeforeBridge = [
      ['provider', provider],
      ['model', model],
      ['keySurface', keySurface],
      ['actions', actions],
      ['compactNote', compactNote],
    ].filter(([, element]) => element.getBoundingClientRect().top >= bridgeTop)
      .map(([name]) => name);
    const style = window.getComputedStyle(body);
    const maxHeight = Number.parseFloat(style.maxHeight);
    const scrollBounded = ['auto', 'scroll'].includes(style.overflowY)
      && Number.isFinite(maxHeight)
      && maxHeight > 0
      && body.clientHeight <= 320;
    return {
      bodyClientHeight: body.clientHeight,
      bodyMaxHeight: style.maxHeight,
      bodyOverflowY: style.overflowY,
      bridgeTop,
      ok: orderedBeforeBridge.length === 0 && scrollBounded,
      orderedBeforeBridge,
      panelHeight: panel.getBoundingClientRect().height,
      reason: orderedBeforeBridge.length ? 'bridge rendered before primary controls' : scrollBounded ? '' : 'bridge body is not internally scroll-bounded',
    };
  })()`);
  assert(result.ok, `rail Local Bridge AI setup layout regressed: ${JSON.stringify(result)}`);
  if (setup.previousMode && setup.previousMode !== 'bridge') {
    await page.evaluate(`(() => {
      const previousMode = ${JSON.stringify(setup.previousMode)};
      const panel = document.querySelector('details.rail-ai-settings[data-layout="ai-setup-panel"]');
      const mode = panel?.querySelector('[data-ai-control="mode"]');
      if (mode) {
        mode.value = previousMode;
        mode.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`);
  }
}

async function appLayoutReport(page, label) {
  return page.evaluate(`(() => {
    const label = ${JSON.stringify(label)};
    const usesMobileTabs = window.innerWidth < 900;
    const activeTab = document.querySelector('[data-layout="app-shell"]')?.getAttribute('data-active-tab') ?? '';
    const required = {
      nav: '[data-layout="app-nav"]',
      intro: '[data-layout="app-intro"]',
      shell: '[data-layout="app-shell"]',
      rail: '[data-layout="app-rail"]',
      main: '[data-layout="app-main"]',
      tabs: usesMobileTabs ? '[data-layout="app-mobile-tabs"]' : '[data-layout="app-tabs"]',
      activePanel: '[data-layout="active-panel"]',
      ...(activeTab === 'overview' ? {
        workflow: '[data-layout="workflow-status"]',
        trust: '[data-layout="trust-strip"]',
      } : {}),
    };
    const rectFor = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return {
        bottom: rect.bottom,
        display: style.display,
        height: rect.height,
        left: rect.left,
        position: style.position,
        right: rect.right,
        top: rect.top,
        visibility: style.visibility,
        width: rect.width,
      };
    };
    const rects = Object.fromEntries(Object.entries(required).map(([key, selector]) => [key, rectFor(selector)]));
    const errors = [];
    const innerWidth = window.innerWidth;
    const scrollWidth = document.documentElement.scrollWidth;
    if (scrollWidth > innerWidth + 1) {
      errors.push('document has horizontal overflow');
    }
    for (const [key, rect] of Object.entries(rects)) {
      if (!rect) {
        errors.push(key + ' missing');
        continue;
      }
      if (rect.display === 'none' || rect.visibility === 'hidden') errors.push(key + ' hidden');
      if (rect.width <= 0 || rect.height <= 0) errors.push(key + ' has empty geometry');
      if (rect.left < -1) errors.push(key + ' starts offscreen left');
      if (rect.right > innerWidth + 1) errors.push(key + ' clips offscreen right');
    }
    const nav = rects.nav;
    const intro = rects.intro;
    if (nav && intro && (nav.position === 'fixed' || nav.position === 'sticky') && nav.bottom > intro.top + 1) {
      errors.push('nav overlaps intro');
    }
    const rail = rects.rail;
    const main = rects.main;
    if (rail && main) {
      const verticalOverlap = rail.bottom > main.top + 1 && main.bottom > rail.top + 1;
      const horizontalOverlap = rail.right > main.left + 1 && main.right > rail.left + 1;
      if (verticalOverlap && horizontalOverlap) errors.push('rail overlaps main');
    }
    const tabs = rects.tabs;
    if (tabs && main) {
      if (tabs.left < main.left - 1) errors.push('tabs start outside main');
      if (tabs.right > main.right + 1) errors.push('tabs end outside main');
    }
    const activePanel = rects.activePanel;
    if (nav && activePanel && (nav.position === 'fixed' || nav.position === 'sticky')) {
      const activeVisible = activePanel.bottom > 0 && activePanel.top < window.innerHeight;
      if (activeVisible && nav.bottom > activePanel.top + 1 && nav.top < activePanel.bottom - 1) {
        errors.push('nav overlaps active panel');
      }
    }
    const reviewCards = Array.from(document.querySelectorAll('[data-layout="review-plan-card"]')).map((card, index) => {
      const rect = card.getBoundingClientRect();
      const actions = card.querySelector('.review-plan-actions')?.getBoundingClientRect();
      const summary = card.querySelector('.wallet-action-summary')?.getBoundingClientRect();
      return {
        actions: actions ? { bottom: actions.bottom, left: actions.left, right: actions.right, top: actions.top } : null,
        bottom: rect.bottom,
        index,
        left: rect.left,
        right: rect.right,
        summary: summary ? { bottom: summary.bottom, left: summary.left, right: summary.right, top: summary.top } : null,
        top: rect.top,
        width: rect.width,
      };
    });
    const within = activePanel ?? main;
    for (const card of reviewCards) {
      if (card.width <= 0) errors.push('review card ' + card.index + ' has empty geometry');
      if (within && (card.left < within.left - 1 || card.right > within.right + 1)) {
        errors.push('review card ' + card.index + ' clips outside active panel');
      }
      for (const [name, child] of [['actions', card.actions], ['summary', card.summary]]) {
        if (!child) continue;
        if (child.left < card.left - 1 || child.right > card.right + 1) {
          errors.push('review card ' + card.index + ' ' + name + ' clips outside card');
        }
      }
    }
    for (let i = 0; i < reviewCards.length; i += 1) {
      for (let j = i + 1; j < reviewCards.length; j += 1) {
        const a = reviewCards[i];
        const b = reviewCards[j];
        const overlaps = a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
        if (overlaps) errors.push('review cards ' + i + ' and ' + j + ' overlap');
      }
    }
    const visible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const mobileCardContracts = usesMobileTabs
      ? Array.from(document.querySelectorAll('[data-layout="review-plan-card"], .approval-ticket.inbox-approval-card, .recurring-item.recurring-card')).map((card, index) => {
        const rect = card.getBoundingClientRect();
        const approvalEffectVisible = Array.from(card.querySelectorAll('.approval-effect')).some(visible);
        const desktopAgentCopyVisible = Array.from(card.querySelectorAll('.agent-review-desktop-copy')).some(visible);
        const mobileAgentCopyVisible = Array.from(card.querySelectorAll('.agent-review-mobile-copy')).some(visible);
        const directDeleteVisible = Array.from(card.querySelectorAll(':scope .review-plan-footer-actions > .review-delete-mini, :scope .inbox-approval-footer-row > .recurring-delete-mini, :scope .recurring-card-footer-actions > .recurring-delete-mini')).some(visible);
        const hasAgentReview = Boolean(card.querySelector('.agent-review-strip'));
        const kind = card.matches('[data-layout="review-plan-card"]')
          ? 'review'
          : card.matches('.inbox-approval-card')
            ? 'approval'
            : 'recurring';
        return {
          approvalEffectVisible,
          desktopAgentCopyVisible,
          directDeleteVisible,
          hasAgentReview,
          height: rect.height,
          index,
          kind,
          mobileAgentCopyVisible,
        };
      })
      : [];
    for (const card of mobileCardContracts) {
      if (card.height > window.innerHeight * 1.12) {
        errors.push('mobile ' + card.kind + ' card ' + card.index + ' exceeds one viewport');
      }
      if (card.approvalEffectVisible) errors.push('mobile ' + card.kind + ' card ' + card.index + ' shows approval effect copy');
      if (card.desktopAgentCopyVisible) errors.push('mobile ' + card.kind + ' card ' + card.index + ' shows desktop agent review copy');
      if (card.directDeleteVisible) errors.push('mobile ' + card.kind + ' card ' + card.index + ' exposes direct delete action');
      if (card.hasAgentReview && !card.mobileAgentCopyVisible) {
        errors.push('mobile ' + card.kind + ' card ' + card.index + ' hides compact agent decision copy');
      }
    }
    const connectionTriggers = Array.from(document.querySelectorAll('.rail-conn-trigger')).map((trigger, index) => {
      const rect = trigger.getBoundingClientRect();
      const action = trigger.querySelector('.rail-conn-action');
      const actionRect = action?.getBoundingClientRect();
      return {
        actionText: action?.textContent?.trim() ?? '',
        afterContent: window.getComputedStyle(trigger, '::after').content,
        index,
        rect: { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top, width: rect.width },
        actionRect: actionRect ? { bottom: actionRect.bottom, left: actionRect.left, right: actionRect.right, top: actionRect.top, width: actionRect.width } : null,
      };
    });
    for (const trigger of connectionTriggers) {
      if (!['Sign in', 'Manage', 'Set up'].includes(trigger.actionText)) {
        errors.push('connection trigger ' + trigger.index + ' missing expected action chip');
      }
      const after = String(trigger.afterContent ?? '').replace(/["']/g, '').trim();
      if (after === '+' || after === '-') {
        errors.push('connection trigger ' + trigger.index + ' still uses plus/minus affordance');
      }
      if (!trigger.actionRect || trigger.actionRect.width <= 0) {
        errors.push('connection trigger ' + trigger.index + ' action has empty geometry');
      } else if (trigger.actionRect.left < trigger.rect.left - 1 || trigger.actionRect.right > trigger.rect.right + 1) {
        errors.push('connection trigger ' + trigger.index + ' action clips outside row');
      }
    }
    return { connectionTriggers, errors, innerWidth, label, mobileCardContracts, rects, reviewCards, scrollWidth, scrollY: window.scrollY };
  })()`);
}

function formatLayoutRects(report) {
  return Object.entries(report.rects)
    .map(([key, rect]) => {
      if (!rect) return `${key}: missing`;
      return `${key}: x=${Math.round(rect.left)} y=${Math.round(rect.top)} w=${Math.round(rect.width)} h=${Math.round(rect.height)}`;
    })
    .join('\n');
}

async function verifyWorkflowSmoke({ requireLocalBridge: bridgeRequired }) {
  const report = new SmokeReport();
  await withLocalServer(async ({ origin, serverPort }) => {
    await report.check('Render server returns JSON for /api/* and SPA shell for app routes', async () => {
      await verifyHostedAiStatus(`${origin}/api/ai/status`);
      await verifyJson404(`${origin}/api/not-a-real-route`);
      await verifyHtmlRoute(`${origin}/app`, '/app');
    });

    const wallet = createTestWallet();
    const session = await createSignedSession(origin, wallet);

    await report.check('Signed-in cloud one-time approve flow moves terminal inbox records to Completed Plans', async () => {
      const plan = await apiJson(origin, '/api/plans', {
        method: 'POST',
        cookie: session.cookie,
        body: createManualReviewPlanBody('Approve smoke review'),
      }).then((payload) => requiredObject(payload.plan, 'plan'));
      const approval = await apiJson(origin, '/api/approvals', {
        method: 'POST',
        cookie: session.cookie,
        body: { planId: plan.id },
      }).then((payload) => requiredObject(payload.approval, 'approval'));
      await apiJson(origin, `/api/approvals/${encodeURIComponent(approval.id)}/approve`, {
        method: 'POST',
        cookie: session.cookie,
        body: {
          ...decisionProofBody(approval, 'approved', wallet),
          note: 'Approved in workflow smoke.',
        },
      });
      const inbox = await apiJson(origin, '/api/approvals', { cookie: session.cookie });
      const completed = await apiJson(origin, '/api/completed', { cookie: session.cookie });
      assert(!arrayPayload(inbox.approvals).some((entry) => entry.id === approval.id), 'approved item stayed in active inbox');
      assert(arrayPayload(completed.completed).some((entry) => entry.approvalRequestId === approval.id && entry.status === 'approved'), 'approved item missing from completed history');
    });

    await report.check('Signed-in cloud approval deny flow writes completed rejection history', async () => {
      const approval = await apiJson(origin, '/api/approvals', {
        method: 'POST',
        cookie: session.cookie,
        body: {
          summary: 'Deny smoke transfer',
          kind: 'transfer_sol',
          params: { recipient: 'Recipient111111111111111111111111111111111', amountSol: '0.01' },
          cluster: 'devnet',
        },
      }).then((payload) => requiredObject(payload.approval, 'approval'));
      await apiJson(origin, `/api/approvals/${encodeURIComponent(approval.id)}/deny`, {
        method: 'POST',
        cookie: session.cookie,
        body: {
          ...decisionProofBody(approval, 'rejected', wallet),
          note: 'Denied in workflow smoke.',
        },
      });
      const completed = await apiJson(origin, '/api/completed', { cookie: session.cookie });
      assert(arrayPayload(completed.completed).some((entry) => entry.approvalRequestId === approval.id && entry.status === 'rejected'), 'denied item missing from completed history');
    });

    await report.check('Completed history refresh is stable for signed-in cloud users', async () => {
      const first = await apiJson(origin, '/api/completed', { cookie: session.cookie });
      const second = await apiJson(origin, '/api/completed', { cookie: session.cookie });
      assert(arrayPayload(second.completed).length >= arrayPayload(first.completed).length, 'completed refresh lost records');
    });

    await report.check('Signed-in cloud recurring schedule creates one due Approval Inbox item', async () => {
      const created = await apiJson(origin, '/api/recurring', {
        method: 'POST',
        cookie: session.cookie,
        body: {
          cluster: 'devnet',
          token: 'SOL',
          recipient: 'Recipient111111111111111111111111111111111',
          amount: '0.02',
          cadence: 'interval_minutes',
          intervalMinutes: 10,
          startAt: '2020-01-01T00:00:00.000Z',
          note: 'Recurring workflow smoke',
        },
      });
      const schedule = requiredObject(created.schedule, 'schedule');
      const first = await apiJson(origin, '/api/recurring/materialize-due', {
        method: 'POST',
        cookie: session.cookie,
        body: {},
      });
      const second = await apiJson(origin, '/api/recurring/materialize-due', {
        method: 'POST',
        cookie: session.cookie,
        body: {},
      });
      assert(arrayPayload(first.results)[0]?.reason === 'created', 'first materialization did not create due work');
      assert(arrayPayload(second.results)[0]?.reason === 'duplicate', 'second materialization duplicated due work');
      const inbox = await apiJson(origin, '/api/approvals', { cookie: session.cookie });
      const recurringApprovals = arrayPayload(inbox.approvals).filter((entry) => entry.recurringScheduleId === schedule.id);
      assert(recurringApprovals.length === 1, `expected one recurring approval, found ${recurringApprovals.length}`);
    });

    await report.check('Evidence receipt creation and archive works for signed-in cloud users', async () => {
      const created = await apiJson(origin, '/api/evidence', {
        method: 'POST',
        cookie: session.cookie,
        body: createEvidenceBody(wallet),
      });
      const receipt = requiredObject(created.receipt, 'receipt');
      const listed = await apiJson(origin, '/api/evidence', { cookie: session.cookie });
      assert(arrayPayload(listed.receipts).some((entry) => entry.id === receipt.id), 'evidence receipt missing from archive');
    });

    await report.check('No API route stores private signing material or unlimited authority', async () => {
      const checks = [
        ['plan private key', '/api/plans', { ...createPlanBody('Bad secret'), privateKey: 'not-allowed' }],
        ['approval delegated signer', '/api/approvals', {
          summary: 'Bad delegated approval',
          kind: 'transfer_sol',
          params: {},
          delegatedSigner: 'server-wallet',
        }],
        ['approval unlimited authority', '/api/approvals', {
          summary: 'Bad unlimited approval',
          kind: 'transfer_sol',
          params: {},
          approvalAuthority: 'unlimited',
        }],
        ['recurring seed phrase', '/api/recurring', {
          ...recurringSmokeBody(),
          seedPhrase: 'not-allowed',
        }],
        ['recurring unlimited authority', '/api/recurring', {
          ...recurringSmokeBody(),
          approvalAuthority: 'unlimited',
        }],
        ['evidence private key', '/api/evidence', {
          ...createEvidenceBody(wallet),
          privateKey: 'not-allowed',
        }],
        ['evidence unlimited authority', '/api/evidence', {
          ...createEvidenceBody(wallet),
          metadata: { approvalAuthority: 'unlimited' },
        }],
      ];
      for (const [label, path, body] of checks) {
        const response = await apiRaw(origin, path, {
          method: 'POST',
          cookie: session.cookie,
          body,
        });
        assert(response.status === 400, `${label} returned HTTP ${response.status}`);
      }
    });

    await report.check('Hosted BYOK status and drafting work without leaking provider keys', async () => {
      const status = await apiJson(origin, '/api/ai/status');
      assert(status.available === true && status.mode === 'hosted-byok', 'hosted BYOK status was not available');
      const apiKey = 'sk-smoke-hosted-secret';
      const drafted = await apiJson(origin, '/api/ai/generate-plan', {
        method: 'POST',
        cookie: session.cookie,
        body: {
          settings: { provider: 'openai', model: 'gpt-5', apiKey },
          request: hostedAiRequest(),
        },
      });
      assert(drafted.intent === 'Hosted BYOK smoke intent', `unexpected hosted BYOK draft: ${JSON.stringify(drafted)}`);
      assert(!JSON.stringify(drafted).includes(apiKey), 'hosted BYOK draft leaked a provider key');
      const missingKey = await apiRaw(origin, '/api/ai/generate-plan', {
        method: 'POST',
        cookie: session.cookie,
        body: {
          settings: { provider: 'openai', model: 'gpt-5' },
          request: hostedAiRequest(),
        },
      });
      assert(missingKey.status === 400, `missing hosted key returned HTTP ${missingKey.status}`);
      assert(!JSON.stringify(missingKey.body).includes('sk-test-secret'), 'hosted BYOK error leaked a provider key');
    });

    await withWalletSigner(wallet, async ({ origin: signerOrigin }) => {
      await withMockBridge(wallet, async ({ origin: bridgeOrigin, token: bridgeToken }) => {
        await withChrome(async (page) => {
          const browserOrigin = `http://agentic-smoke.test:${serverPort}`;
          await page.addInitScript(fakeWalletScript(wallet, signerOrigin));
          await report.check('Signed-out browser fallback one-time flow queues and completes locally', async () => {
            await page.inspect(`${browserOrigin}/app`);
            await resetBrowserWorkflow(page);
            await page.inspect(`${browserOrigin}/app`);
            await assertFirstRunSteps(page);
            await connectFakeWallet(page);
            await waitForFirstRunStep(page, 'wallet', 'complete');
            await ensureCreatePlanView(page);
            await clickAndWait(page, '#generatePlan');
            await waitForFirstRunStep(page, 'plan', 'complete');
            const actionId = await queueCurrentPlan(page);
            await waitForFirstRunStep(page, 'decision', 'active');
            assert(actionId, 'browser fallback did not expose a queued action id');
            let snapshot = await browserWorkflowSnapshot(page);
            assert(snapshot.activeActions.some((entry) => entry.id === actionId), 'browser fallback did not persist an active prepared action');
            await clickAndWait(page, `[data-action-op="execute"][data-action-id="${actionId}"]`, 'browser fallback approval action');
            snapshot = await browserWorkflowSnapshot(page);
            assert(
              [...snapshot.activeActions, ...snapshot.completedActions].some((entry) => entry.id === actionId),
              'browser fallback approval action disappeared from workflow storage',
            );
          });

          await report.check('Signed-out browser fallback rejects queued work and removes it from the active inbox', async () => {
            await page.inspect(`${browserOrigin}/app`);
            await resetBrowserWorkflow(page);
            await page.inspect(`${browserOrigin}/app`);
            await connectFakeWallet(page);
            await ensureCreatePlanView(page);
            await clickAndWait(page, '#generatePlan');
            const actionId = await queueCurrentPlan(page);
            await clickAndWait(page, `[data-action-op="reject"][data-action-id="${actionId}"]`, 'browser fallback rejection action');
            await waitForBrowserReceipt(page, actionId, 'rejected');
            const snapshot = await browserWorkflowSnapshot(page);
            assert(!snapshot.activeActions.some((entry) => entry.id === actionId), 'rejected browser workflow action remained active');
            assert(snapshot.completedActions.some((entry) => entry.id === actionId && entry.status === 'rejected'), 'rejected browser workflow action was not terminal');
          });

          await report.check('Browser recurring fallback creates one local occurrence and explains scheduler limits', async () => {
            await page.inspect(`${browserOrigin}/app`);
            await resetBrowserWorkflow(page);
            await page.inspect(`${browserOrigin}/app`);
            await connectFakeWallet(page);
            await createBrowserRecurringViaUi(page, wallet.walletAddress);
            const snapshot = await browserWorkflowSnapshot(page);
            const browserRecurring = snapshot.recurringPayments.filter((entry) => String(entry.id).startsWith('browser-recurring'));
            const recurringActions = snapshot.activeActions.filter((entry) => entry.recurringId === browserRecurring[0]?.id);
            assert(browserRecurring.length === 1, `expected one browser recurring schedule, found ${browserRecurring.length}`);
            assert(recurringActions.length === 1, `expected one browser recurring occurrence, found ${recurringActions.length}`);
          });

          await report.check('Browser recurring schedules do not leak into private local mode', async () => {
            await page.inspect(`${browserOrigin}/app`);
            await resetBrowserWorkflow(page);
            await page.inspect(`${browserOrigin}/app`);
            await connectFakeWallet(page);
            await createBrowserRecurringViaUi(page, wallet.walletAddress);
            const snapshot = await browserWorkflowSnapshot(page);
            const browserRecurring = snapshot.recurringPayments.filter((entry) => String(entry.id).startsWith('browser-recurring'));
            assert(browserRecurring.length === 1, `expected one browser recurring seed, found ${browserRecurring.length}`);

            await configureBridgeStorage(page, { bridgeOrigin, bridgeToken });
            await page.inspect(localBridgeAppUrl(browserOrigin, bridgeOrigin, bridgeToken));
            await connectFakeWallet(page);
            await ensureLocalBridgeReady(page, 'check mocked local bridge for recurring isolation');
            await clickAndWait(page, '[data-workflow-mode="local-bridge"]', 'use private local mode for recurring isolation');
            await clickAndWait(page, '[data-tab="schedule"]', 'private local recurring schedule tab');
            const localCount = await recurringCardCount(page);
            assert(localCount === 0, `browser recurring schedule leaked into private local mode; visible cards=${localCount}`);

            await clickAndWait(page, '[data-workflow-mode="auto"]', 'return to browser workflow mode');
            await clickAndWait(page, '[data-tab="schedule"]', 'browser recurring schedule tab');
            const restoredSnapshot = await browserWorkflowSnapshot(page);
            const restoredBrowserRecurring = restoredSnapshot.recurringPayments.filter((entry) => String(entry.id).startsWith('browser-recurring'));
            assert(restoredBrowserRecurring.length === 1, `browser recurring schedule was not restored after leaving private local mode; browser schedules=${restoredBrowserRecurring.length}`);
          });

          await report.check('Local bridge AI status survives app reload', async () => {
            await page.inspect(localBridgeAppUrl(browserOrigin, bridgeOrigin, bridgeToken));
            await page.waitFor(`Boolean(document.querySelector('[data-ai-control="mode"]'))`);
            await page.evaluate(`(() => {
              for (const control of document.querySelectorAll('[data-ai-control="mode"]')) {
                control.value = 'bridge';
                control.dispatchEvent(new Event('change', { bubbles: true }));
              }
            })()`);
            await page.waitFor(`document.body.innerText.includes('Local Bridge AI') || document.body.innerText.includes('Local bridge AI')`);
            await page.evaluate(`(() => {
              for (const control of document.querySelectorAll('[data-ai-control="provider"]')) {
                control.value = 'gemini';
                control.dispatchEvent(new Event('change', { bubbles: true }));
              }
            })()`);
            await page.waitFor(`Boolean(document.querySelector('[data-ai-control="api-key"]'))`);
            await page.evaluate(`(() => {
              for (const input of document.querySelectorAll('[data-ai-control="api-key"]')) {
                input.value = 'sk-smoke-bridge-ai';
                input.dispatchEvent(new Event('input', { bubbles: true }));
              }
            })()`);
            await page.waitFor(`Array.from(document.querySelectorAll('[data-ai-action="save-bridge-key"]')).some((button) => !button.disabled)`);
            await clickAndWait(page, '[data-ai-action="save-bridge-key"]', 'set mock bridge AI key');
            await waitForBridgeAiConfirmed(page);

            await page.inspect(`${browserOrigin}/app`);
            await waitForBridgeAiConfirmed(page);
            const keyInputStillVisible = await page.evaluate(`Boolean(document.querySelector('[data-ai-control="api-key"]'))`);
            assert(!keyInputStillVisible, 'bridge AI key input reappeared after reload even though bridge status was configured');
            await page.evaluate(`(() => {
              for (const control of document.querySelectorAll('[data-ai-control="mode"]')) {
                control.value = 'hosted';
                control.dispatchEvent(new Event('change', { bubbles: true }));
              }
            })()`);
          });

          await report.check('Browser AI unavailable does not block template workflow', async () => {
            await ensureCreatePlanView(page);
            await page.evaluate(`(() => {
              const mode = document.querySelector('#aiMode');
              if (mode) {
                mode.value = 'session';
                mode.dispatchEvent(new Event('change', { bubbles: true }));
              }
              const provider = document.querySelector('#aiProvider');
              if (provider) {
                provider.value = 'openai';
                provider.dispatchEvent(new Event('change', { bubbles: true }));
              }
            })()`);
            await clickAndWait(page, '#generatePlan');
            const text = await page.evaluate(`document.body.innerText`);
            assert(/Review|Approval Inbox|Send to Approval Inbox|Create plan/i.test(text), 'template plan was not usable while browser AI was unavailable');
          });

          await report.check('Signed-in cloud one-time browser flow works without localhost', async () => {
            const beforeApprovals = await apiJson(origin, '/api/approvals', { cookie: session.cookie });
            const beforeApprovalIds = new Set(arrayPayload(beforeApprovals.approvals).map((entry) => entry.id).filter(Boolean));
            await page.inspect(`${browserOrigin}/app`);
            await resetBrowserWorkflow(page);
            await page.inspect(`${browserOrigin}/app`);
            await connectFakeWallet(page);
            await ensureCloudSignedIn(page);
            await ensureCreatePlanView(page);
            await selectPlanTemplate(page, 'transfer-sol');
            await setTemplateField(page, 'recipient', wallet.walletAddress);
            await setTemplateField(page, 'amount', '0.000001');
            await setTemplateField(page, 'memo', 'Signed-in cloud browser workflow smoke');
            await clickAndWait(page, '#generatePlan');
            await queueCurrentPlan(page, { waitForInboxAction: false });
            const approvalId = await waitForNewApproval(origin, session.cookie, beforeApprovalIds);
            const inbox = await apiJson(origin, '/api/approvals', { cookie: session.cookie });
            const approval = arrayPayload(inbox.approvals).find((entry) => entry.id === approvalId);
            assert(approval, `queued cloud approval ${approvalId} was not found`);
            await finalizeApprovalViaApi(origin, session.cookie, approval, wallet, 'tx_browser_cloud_finalized');
            await waitForCompletedApproval(origin, session.cookie, approvalId, 'approved');
          });

          await report.check('Signed-in cloud recurring schedule can be created from the browser UI', async () => {
            const before = await apiJson(origin, '/api/recurring', { cookie: session.cookie });
            const beforeIds = new Set(arrayPayload(before.schedules).map((entry) => entry.id).filter(Boolean));
            await createCloudRecurringViaUi(page);
            const schedule = await waitForNewRecurringSchedule(origin, session.cookie, beforeIds);
            assert(schedule.note === 'Recurring browser workflow smoke', 'browser UI recurring schedule did not preserve note');
          });

          await report.check('Private local bridge mode works with a mocked local bridge', async () => {
            await configureBridgeStorage(page, { bridgeOrigin, bridgeToken });
            await page.inspect(localBridgeAppUrl(browserOrigin, bridgeOrigin, bridgeToken));
            await connectFakeWallet(page);
            await ensureLocalBridgeReady(page, 'check mocked local bridge');
            await clickAndWait(page, '[data-workflow-mode="local-bridge"]', 'use private local mode');
            await page.inspect(`${browserOrigin}/app`);
            await page.waitFor(`Boolean(document.querySelector('[data-workflow-mode="auto"]')) || document.body.innerText.includes('Private local mode')`);
            await ensureCreatePlanView(page);
            await clickAndWait(page, '#generatePlan');
            const actionId = await queueCurrentPlan(page);
            assert(actionId.startsWith('mock-bridge-action-'), `mock bridge returned unexpected action id: ${actionId}`);
            await clickAndWait(page, `[data-action-op="execute"][data-action-id="${actionId}"]`, 'mock bridge approval action');
            await waitForMockBridgeReceipt(bridgeOrigin, bridgeToken, actionId);
          });

          await report.check('Public-host startup does not require localhost for the default web app', async () => {
            await configureBridgeStorage(page, { bridgeOrigin, bridgeToken, workflowModePreference: 'auto' });
            const publicHostResult = await page.inspect(`${browserOrigin}/app`);
            await assertFirstRunSteps(page);
            const bridgeProbe = publicHostResult.events.find(isLocalBridgeConfigRequest);
            assert(!bridgeProbe, `public-host startup requested local bridge: ${eventSummary(bridgeProbe)}`);
            assert(!/local bridge required|bridge required|localhost is required|required.*localhost/i.test(publicHostResult.page.bodyText), 'UI says local bridge or localhost is required for the default app');
          });
        });
      });
    });

    await report.checkOptional('Private local bridge still responds when explicitly required', bridgeRequired, async () => {
      const bridgeOrigin = process.env.AGENTIC_BRIDGE_URL ?? 'http://127.0.0.1:8787';
      const response = await fetch(`${bridgeOrigin.replace(/\/+$/, '')}/bridge/config`, {
        headers: { authorization: `Bearer ${process.env.AGENTIC_BRIDGE_TOKEN ?? 'local-agent-wallet'}` },
      });
      assert(response.ok, `local bridge returned HTTP ${response.status}`);
    });
  }, { mockHostedAi: true });

  report.finish();
}

async function createSignedSession(origin, wallet) {
  const nonce = await apiJson(origin, '/api/auth/nonce', {
    method: 'POST',
    body: { walletAddress: wallet.walletAddress },
  });
  const message = String(nonce.message);
  const signature = encodeBase58(signDetached(null, Buffer.from(message, 'utf8'), wallet.privateKey));
  const response = await apiRaw(origin, '/api/auth/verify-wallet', {
    method: 'POST',
    body: {
      walletAddress: wallet.walletAddress,
      nonce: nonce.nonce,
      message,
      signature,
      domain: nonce.domain,
      issuedAt: nonce.issuedAt,
      expiresAt: nonce.expiresAt,
      signatureEncoding: 'base58',
    },
  });
  if (response.status !== 200) {
    throw new Error(`wallet auth failed with HTTP ${response.status}: ${JSON.stringify(response.body)}`);
  }
  const setCookie = response.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0];
  const token = cookie.split('=')[1] ?? '';
  if (!cookie || !token) throw new Error('wallet auth did not return a session cookie');
  return { cookie, token };
}

function decisionProofBody(approval, decision, wallet) {
  const message = workflowDecisionProofMessage(approval, decision);
  return {
    proofSignature: encodeBase58(signDetached(null, Buffer.from(message, 'utf8'), wallet.privateKey)),
    decisionProofMessage: message,
    signatureEncoding: 'base58',
  };
}

function workflowDecisionProofMessage(approval, decision) {
  return sharedWorkflowDecisionProofMessage({ approval, decision });
}

function finalizationProofBody(approval, finalization, wallet) {
  const message = workflowFinalizationProofMessage(approval, finalization);
  return {
    proofSignature: encodeBase58(signDetached(null, Buffer.from(message, 'utf8'), wallet.privateKey)),
    decisionProofMessage: message,
    signatureEncoding: 'base58',
  };
}

function workflowFinalizationProofMessage(approval, finalization) {
  return sharedWorkflowFinalizationProofMessage({ approval, finalization });
}

function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry !== undefined) sorted[key] = sortJson(entry);
    }
    return sorted;
  }
  return value;
}

async function connectFakeWallet(page) {
  const connected = await page.evaluate(`Boolean(document.querySelector('#disconnect')) || document.body.innerText.includes('Wallet connected on')`);
  if (!connected) {
    const discoverSelector = '[data-start-action="discover"], [data-first-run-action="discover-wallets"], #discover';
    const connectSelector = '[data-start-action="connect"], [data-first-run-action="connect-wallet"], #connect';
    await page.waitFor(`Boolean(document.querySelector(${JSON.stringify(discoverSelector)}))`);
    await waitForSmokeWalletRegistered(page);
    await clickAndWait(page, discoverSelector, 'discover wallet button');
    const hasMultiPathChooser = await page.evaluate(`Boolean(document.querySelector('[data-desktop-flow-action="method:extension"]'))`);
    if (hasMultiPathChooser) {
      await clickAndWait(page, '[data-desktop-flow-action="method:extension"]', 'browser extension wallet method');
      await page.waitFor(`Boolean(document.querySelector('[data-desktop-flow-action="pick-extension-wallet"][data-desktop-extension-wallet="backpack"]'))`);
      await clickAndWait(page, '[data-desktop-flow-action="pick-extension-wallet"][data-desktop-extension-wallet="backpack"]', 'Backpack extension wallet');
    } else {
      await page.evaluate(`(() => {
        const select = document.querySelector('#walletSelect');
        if (!select || select.value) return;
        const option = Array.from(select.options).find((entry) => !entry.disabled && entry.value);
        if (!option) return;
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      try {
        await page.waitFor(`Array.from(document.querySelectorAll(${JSON.stringify(connectSelector)})).some((el) => !el.disabled)`);
      } catch (err) {
        const debug = await browserWalletConnectDebug(page, discoverSelector, connectSelector);
        throw new Error(`${err instanceof Error ? err.message : String(err)}\n${debug}`);
      }
      await clickAndWait(page, connectSelector, 'connect wallet button');
    }
    await page.waitFor(`Boolean(document.querySelector('#disconnect')) || document.body.innerText.includes('Wallet connected on')`);
  }
  if (!await page.evaluate(`Boolean(document.querySelector('#generatePlan'))`)) {
    await clickAndWait(page, '[data-tab="agent"]', 'one-time plan tab');
  }
  await ensureCreatePlanView(page);
}

async function waitForSmokeWalletRegistered(page) {
  await page.waitFor(`Number(window.__agenticSmokeWalletRegistered?.registrations || 0) > 0`, 10_000);
}

async function browserWalletConnectDebug(page, discoverSelector, connectSelector) {
  const snapshot = await page.evaluate(`(async () => {
    const describeButton = (el) => ({
      text: (el.textContent || '').trim(),
      disabled: Boolean(el.disabled),
      ariaDisabled: el.getAttribute('aria-disabled'),
      hidden: el.hidden,
      display: getComputedStyle(el).display,
      visibility: getComputedStyle(el).visibility,
    });
    const walletSelect = document.querySelector('#walletSelect');
    const walletOptions = walletSelect
      ? Array.from(walletSelect.options).map((option) => ({
          value: option.value,
          label: option.label || option.textContent || '',
          disabled: option.disabled,
          selected: option.selected,
        }))
      : [];
    return {
      bodyExcerpt: document.body.innerText.slice(0, 800),
      connectButtons: Array.from(document.querySelectorAll(${JSON.stringify(connectSelector)})).map(describeButton),
      discoverButtons: Array.from(document.querySelectorAll(${JSON.stringify(discoverSelector)})).map(describeButton),
      smokeWallet: window.__agenticSmokeWalletRegistered || null,
      startupFailure: Boolean(document.querySelector('[data-agentic-startup-failure]')),
      walletStandardProbe: await (async () => {
        const href = Array.from(document.querySelectorAll('link[href], script[src]'))
          .map((el) => el.getAttribute('href') || el.getAttribute('src') || '')
          .find((value) => /wallet-standard.*\\.js/.test(value));
        if (!href) return { found: false };
        try {
          const mod = await import(new URL(href, window.location.href).href);
          const probes = [];
          for (const [key, value] of Object.entries(mod)) {
            if (typeof value !== 'function') continue;
            try {
              const result = value();
              if (result && typeof result === 'object' && typeof result.get === 'function') {
                probes.push({
                  key,
                  kind: 'registry',
                  names: result.get().map((wallet) => wallet?.name || ''),
                });
              } else if (Array.isArray(result) && result.every((entry) => entry && typeof entry === 'object' && 'name' in entry)) {
                probes.push({
                  key,
                  kind: 'wallet-list',
                  names: result.map((entry) => entry.name),
                });
              }
            } catch {}
          }
          return { found: true, href, probes };
        } catch (err) {
          return { found: true, href, error: err instanceof Error ? err.message : String(err) };
        }
      })(),
      walletOptions,
      walletSelectValue: walletSelect?.value || '',
    };
  })()`);
  return `wallet connect debug: ${JSON.stringify(snapshot, null, 2)}`;
}

async function ensureCloudSignedIn(page) {
  if (await page.evaluate(`Boolean(document.querySelector('.rail-cloud-card.signed-in'))`)) return;
  await page.waitFor(`Boolean(document.querySelector('#cloudSignIn'))`);
  await clickAndWait(page, '#cloudSignIn', 'cloud sign-in button');
  await page.waitFor(`Boolean(document.querySelector('.rail-cloud-card.signed-in'))`, 15_000);
}

async function ensureCreatePlanView(page) {
  if (!await page.evaluate(`Boolean(document.querySelector('#generatePlan'))`)) {
    if (!await page.evaluate(`Boolean(document.querySelector('[data-one-time-view="create"]'))`)) {
      await clickAndWait(page, '[data-tab="agent"]', 'one-time plan tab');
    }
    await clickAndWait(page, '[data-one-time-view="create"]', 'create plan view');
  }
  await page.waitFor(`Boolean(document.querySelector('#generatePlan'))`);
}

async function selectPlanTemplate(page, templateId) {
  const selector = `[data-template-option="${templateId}"]`;
  if (!await page.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) {
    for (const filter of ['queueable', 'proof', 'audit', 'all']) {
      const filterSelector = `[data-template-filter="${filter}"]`;
      if (!await page.evaluate(`Boolean(document.querySelector(${JSON.stringify(filterSelector)}))`)) continue;
      await clickAndWait(page, filterSelector, `template filter ${filter}`);
      if (await page.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) break;
    }
  }
  await clickAndWait(page, '#templatePickerButton', 'template picker');
  await page.waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  await clickAndWait(page, selector, `template option ${templateId}`);
}

async function setTemplateField(page, fieldId, value) {
  const selector = `[data-template-field="${fieldId}"]`;
  await page.waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  await page.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement || input instanceof HTMLSelectElement)) {
      throw new Error('Template field not found: ${fieldId}');
    }
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(100);
}

async function queueCurrentPlan(page, { waitForInboxAction = true } = {}) {
  await page.waitFor(`(() => {
    const elements = Array.from(document.querySelectorAll('#queueAgentPlan, [data-generated-plan-action="queue"]'));
    const isDisabled = (el) => Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true');
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      return el.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    return elements.some((el) => !isDisabled(el) && isVisible(el));
  })()`);
  await clickAndWait(page, '#queueAgentPlan, [data-generated-plan-action="queue"]', 'queue plan action');
  if (!waitForInboxAction) return '';
  await page.waitFor(`Boolean(document.querySelector('[data-action-op="execute"]'))`);
  return page.evaluate(`document.querySelector('[data-action-op="execute"]')?.dataset.actionId ?? ''`);
}

async function resetBrowserWorkflow(page) {
  await page.evaluate(`(() => {
    for (const key of ${JSON.stringify([DEMO_STORAGE_KEY, GENERATED_PLANS_STORAGE_KEY, BROWSER_WORKFLOW_STORAGE_KEY])}) {
      localStorage.removeItem(key);
    }
  })()`);
}

async function assertFirstRunSteps(page) {
  const steps = await page.evaluate(`Array.from(document.querySelectorAll('[data-first-run-step]')).map((el) => el.dataset.firstRunStep)`);
  const expected = ['wallet', 'plan', 'review', 'decision', 'receipt'];
  assert(expected.every((step) => steps.includes(step)), `first-run steps missing; found=${steps.join(',')}`);
  const action = await page.evaluate(`document.querySelector('[data-first-run-action]')?.dataset.firstRunAction ?? ''`);
  assert(Boolean(action), 'first-run primary action is missing');
}

async function waitForFirstRunStep(page, step, className) {
  if (step === 'wallet' && className === 'complete') {
    await page.waitFor(`Boolean(document.querySelector('#disconnect')) || document.querySelector('[data-first-run-step="wallet"]')?.classList.contains('complete')`);
    return;
  }
  if (step === 'plan' && className === 'complete') {
    await page.waitFor(`document.querySelector('[data-first-run-step="plan"]')?.classList.contains('complete') || Boolean(document.querySelector('#queueAgentPlan, [data-generated-plan-action="queue"]')) || (() => {
      const raw = localStorage.getItem(${JSON.stringify(GENERATED_PLANS_STORAGE_KEY)});
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) && parsed.length > 0;
    })()`);
    return;
  }
  if (step === 'decision' && className === 'active') {
    await page.waitFor(`document.querySelector('[data-first-run-step="decision"]')?.classList.contains('active') || Boolean(document.querySelector('[data-action-op="execute"]')) || (() => {
      const raw = localStorage.getItem(${JSON.stringify(BROWSER_WORKFLOW_STORAGE_KEY)});
      const parsed = raw ? JSON.parse(raw) : {};
      return Array.isArray(parsed.preparedActions) && parsed.preparedActions.some((entry) => entry && entry.status === 'ready');
    })()`);
    return;
  }
  await page.waitFor(`document.querySelector('[data-first-run-step="${step}"]')?.classList.contains('${className}')`);
}

async function browserWorkflowSnapshot(page) {
  return page.evaluate(`(() => {
    const raw = localStorage.getItem(${JSON.stringify(BROWSER_WORKFLOW_STORAGE_KEY)});
    const parsed = raw ? JSON.parse(raw) : {};
    const preparedActions = Array.isArray(parsed.preparedActions) ? parsed.preparedActions : [];
    const receipts = Array.isArray(parsed.receipts) ? parsed.receipts : [];
    const recurringPayments = Array.isArray(parsed.recurringPayments) ? parsed.recurringPayments : [];
    const terminalStatuses = new Set(${JSON.stringify(TERMINAL_WORKFLOW_STATUSES)});
    const activeActions = preparedActions.filter((entry) =>
      !entry.archived && !terminalStatuses.has(entry.status)
    );
    const completedActions = preparedActions.filter((entry) =>
      Boolean(entry.archived) || terminalStatuses.has(entry.status)
    );
    return { activeActions, completedActions, receipts, recurringPayments };
  })()`);
}

async function waitForBrowserReceipt(page, actionId, status) {
  await page.waitFor(`(() => {
    const raw = localStorage.getItem(${JSON.stringify(BROWSER_WORKFLOW_STORAGE_KEY)});
    const parsed = raw ? JSON.parse(raw) : {};
    return Array.isArray(parsed.receipts) && parsed.receipts.some((receipt) =>
      receipt.actionId === ${JSON.stringify(actionId)} && receipt.status === ${JSON.stringify(status)}
    );
  })()`);
}

async function waitForBridgeReceipt(page, actionId) {
  await page.waitFor(`(() => {
    const text = document.body.innerText;
    return text.includes(${JSON.stringify(actionId)}) && /Completed Plans|Approval completed|approved/i.test(text);
  })()`);
}

async function waitForMockBridgeReceipt(bridgeOrigin, bridgeToken, actionId) {
  const deadline = Date.now() + 10_000;
  let lastReceipts = [];
  while (Date.now() < deadline) {
    const response = await fetch(`${bridgeOrigin}/bridge/receipts`, {
      headers: { 'x-agent-wallet-token': bridgeToken },
    });
    const payload = await response.json();
    lastReceipts = arrayPayload(payload.receipts);
    if (lastReceipts.some((receipt) => receipt.actionId === actionId && receipt.status === 'approved')) return;
    await sleep(250);
  }
  throw new Error(`mock bridge receipt did not appear for ${actionId}; receipts=${lastReceipts.map((entry) => entry.actionId).join(',')}`);
}

async function ensureLocalBridgeReady(page, label) {
  const connectSelector = '[data-bridge-action="connect"]';
  if (await page.evaluate(`Boolean(document.querySelector(${JSON.stringify(connectSelector)}))`)) {
    await clickAndWait(page, connectSelector, label);
  }
  await page.waitFor(`Boolean(document.querySelector('[data-workflow-mode="local-bridge"]:not([disabled])')) || Boolean(document.querySelector('[data-workflow-mode="auto"]')) || document.body.innerText.includes('Bridge connected') || document.body.innerText.includes('Private local mode')`);
}

async function waitForBridgeAiConfirmed(page) {
  await page.waitFor(`(() => {
    return Array.from(document.querySelectorAll('[data-layout="ai-setup-panel"]')).some((panel) => {
      const text = panel.innerText || '';
      const badge = panel.querySelector('summary strong')?.textContent?.trim();
      return badge === 'confirmed' && text.includes('Bridge AI verified') && text.includes('Status confirmed');
    });
  })()`);
}

async function configureBridgeStorage(page, {
  bridgeOrigin,
  bridgeToken,
  workflowModePreference = 'auto',
  bridgeAutoReconnect = false,
}) {
  await page.evaluate(`(() => {
    const storageKey = ${JSON.stringify(DEMO_STORAGE_KEY)};
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : {};
    localStorage.setItem(storageKey, JSON.stringify({
      ...parsed,
      bridgeUrl: ${JSON.stringify(bridgeOrigin)},
      workflowModePreference: ${JSON.stringify(workflowModePreference)},
      bridgeAutoReconnect: ${JSON.stringify(bridgeAutoReconnect)},
    }));
    sessionStorage.setItem('agentic-local-bridge-token', ${JSON.stringify(bridgeToken)});
  })()`);
}

function localBridgeAppUrl(browserOrigin, bridgeOrigin, bridgeToken) {
  const url = new URL('/app', browserOrigin);
  url.searchParams.set('bridgeUrl', bridgeOrigin);
  url.searchParams.set('token', bridgeToken);
  return String(url);
}

async function createCloudRecurringViaUi(page) {
  await clickAndWait(page, '[data-tab="schedule"]', 'recurring schedule tab');
  await page.waitFor(`Boolean(document.querySelector('#createRecurring'))`);
  await page.evaluate(`(() => {
    const setValue = (selector, value) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error('Missing recurring field: ' + selector);
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setValue('#recurringToken', 'SOL');
    setValue('#recurringAmount', '0.03');
    setValue('#recurringRecipient', 'Recipient111111111111111111111111111111111');
    setValue('#recurringCadence', 'interval_minutes');
    setValue('#recurringIntervalMinutes', '10');
    setValue('#recurringStartAt', '2020-01-01T00:00');
    setValue('#recurringNote', 'Recurring browser workflow smoke');
  })()`);
  await clickAndWait(page, '#createRecurring', 'create recurring schedule');
  await page.waitFor(`document.body.innerText.includes('Recurring schedule created') || document.body.innerText.includes('Repeat payment created') || document.body.innerText.includes('Agentic Cloud recurring')`);
}

async function createBrowserRecurringViaUi(page, recipient) {
  await clickAndWait(page, '[data-tab="schedule"]', 'recurring schedule tab');
  await page.waitFor(`Boolean(document.querySelector('#createRecurring'))`);
  await page.evaluate(`(() => {
    const setValue = (selector, value) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error('Missing recurring field: ' + selector);
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setValue('#recurringToken', 'SOL');
    setValue('#recurringAmount', '0.03');
    setValue('#recurringRecipient', ${JSON.stringify(recipient)});
    setValue('#recurringCadence', 'weekly');
    setValue('#recurringDayOfWeek', '1');
    setValue('#recurringLocalTime', '09:00');
    setValue('#recurringNote', 'Browser local recurring fallback smoke');
  })()`);
  await clickAndWait(page, '#createRecurring', 'create browser recurring schedule');
  await page.waitFor(`document.body.innerText.includes('Recurring schedule created') || document.body.innerText.includes('Repeat payment created')`);
}

async function recurringCardCount(page) {
  return page.evaluate(`document.querySelectorAll('.recurring-item').length`);
}

async function clickAppLayoutTab(page, tab, viewportWidth) {
  if (viewportWidth < 900) {
    const directMobileSelector = `[data-layout="app-mobile-tabs"] [data-tab="${tab}"]`;
    const hasDirectMobileTab = await page.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(directMobileSelector)});
      if (!el) return false;
      const style = getComputedStyle(el);
      return !el.disabled && el.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })()`);
    if (hasDirectMobileTab) {
      await clickAndWait(page, directMobileSelector, `mobile layout tab ${tab}`);
      return;
    }
    const hasMobileTabs = await page.evaluate(`Boolean(document.querySelector('[data-layout="app-mobile-tabs"]'))`);
    if (hasMobileTabs) {
      await clickAndWait(page, '[data-layout="app-mobile-tabs"] [data-more-menu-trigger]', `open mobile layout tab menu for ${tab}`);
      await clickAndWait(page, `[data-layout="app-mobile-tabs"] [data-tab="${tab}"]`, `mobile layout tab ${tab}`);
      return;
    }
  }
  await clickDesktopAppLayoutTab(page, tab);
}

async function clickDesktopAppLayoutTab(page, tab) {
  if (['labs', 'agent-protocols', 'skills', 'sessions'].includes(tab)) {
    await clickAndWait(page, '[data-layout="app-tabs"] .workspace-more-trigger', `open layout more menu for ${tab}`);
    await clickAndWait(page, `[data-layout="app-tabs"] [data-tab="${tab}"]`, `layout more tab ${tab}`);
    return;
  }
  await clickAndWait(page, `[data-layout="app-tabs"] [data-tab="${tab}"]`, `layout tab ${tab}`);
}

async function clickAndWait(page, selector, label = selector) {
  await page.evaluate(`(() => {
    const selector = ${JSON.stringify(selector)};
    const label = ${JSON.stringify(label)};
    const elements = Array.from(document.querySelectorAll(selector));
    const isDisabled = (el) => Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true');
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      return el.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const el = elements.find((candidate) => !isDisabled(candidate) && isVisible(candidate))
      ?? elements.find((candidate) => !isDisabled(candidate))
      ?? elements[0];
    if (!el) throw new Error('Missing selector: ' + label + ' (' + selector + ')');
    if (isDisabled(el)) throw new Error('Disabled selector: ' + label + ' (' + selector + ')');
    el.click();
    return true;
  })()`);
  await sleep(650);
}

async function waitForNewRecurringSchedule(origin, cookie, beforeIds) {
  const deadline = Date.now() + 10_000;
  let lastSchedules = [];
  while (Date.now() < deadline) {
    const response = await apiJson(origin, '/api/recurring', { cookie });
    lastSchedules = arrayPayload(response.schedules);
    const created = lastSchedules.find((entry) => typeof entry.id === 'string' && !beforeIds.has(entry.id));
    if (created?.id) return created;
    await sleep(250);
  }
  throw new Error(`new recurring schedule did not appear; active=${lastSchedules.map((entry) => entry.id).join(',')}`);
}

async function waitForNewApproval(origin, cookie, beforeIds) {
  const deadline = Date.now() + 10_000;
  let lastApprovals = [];
  while (Date.now() < deadline) {
    const response = await apiJson(origin, '/api/approvals', { cookie });
    lastApprovals = arrayPayload(response.approvals);
    const created = lastApprovals.find((entry) => typeof entry.id === 'string' && !beforeIds.has(entry.id));
    if (created?.id) return created.id;
    await sleep(250);
  }
  throw new Error(`new cloud approval did not appear; active=${lastApprovals.map((entry) => entry.id).join(',')}`);
}

async function waitForCompletedApproval(origin, cookie, approvalId, status) {
  const deadline = Date.now() + 10_000;
  let lastCompleted = [];
  while (Date.now() < deadline) {
    const response = await apiJson(origin, '/api/completed', { cookie });
    lastCompleted = arrayPayload(response.completed);
    const completed = lastCompleted.find((entry) =>
      entry.approvalRequestId === approvalId &&
      entry.status === status
    );
    if (completed) return completed;
    await sleep(250);
  }
  throw new Error(`completed ${status} record did not appear for ${approvalId}; completed=${lastCompleted.map((entry) => `${entry.approvalRequestId}:${entry.status}`).join(',')}`);
}

async function apiJson(origin, path, options = {}) {
  const response = await apiRaw(origin, path, options);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

async function apiRaw(origin, path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.cookie) headers.set('cookie', options.cookie);
  const response = await fetch(`${origin}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const raw = await response.text();
  const body = raw ? JSON.parse(raw) : {};
  return { status: response.status, body, headers: response.headers };
}

async function verifyLiveRender(origin) {
  const base = origin.replace(/\/+$/, '');
  await verifyHostedAiStatus(`${base}/api/ai/status`);
  await verifyJsonSession(`${base}/api/session`);
  await verifyJsonApiRoute(`${base}/api/plans`, [401]);
  await verifyJsonApiRoute(`${base}/api/approvals`, [401]);
  await verifyJsonApiRoute(`${base}/api/completed`, [401]);
  await verifyJsonApiRoute(`${base}/api/recurring`, [401]);
  await verifyJsonApiRoute(`${base}/api/evidence`, [401]);
  await verifyJson404(`${base}/api/not-a-real-route`);
  for (const route of ['/app', '/demo']) {
    await verifyHtmlRoute(`${base}${route}`, route);
  }
}

const AP2_SMOKE_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const AP2_SMOKE_SOL_MINT = 'So11111111111111111111111111111111111111112';
const SKILLS_SMOKE_FRIDAY_TICK = '2026-05-15T14:00:00.000Z';

function nextFridayDcaTickAfter(value) {
  const installedAt = new Date(value);
  if (Number.isNaN(installedAt.getTime())) return new Date(SKILLS_SMOKE_FRIDAY_TICK);
  const tick = new Date(installedAt);
  tick.setUTCSeconds(0, 0);
  tick.setUTCHours(14, 0, 0, 0);
  const daysUntilFriday = (5 - tick.getUTCDay() + 7) % 7;
  tick.setUTCDate(tick.getUTCDate() + daysUntilFriday);
  if (tick.getTime() < installedAt.getTime()) {
    tick.setUTCDate(tick.getUTCDate() + 7);
  }
  return tick;
}

async function verifyAp2Smoke({ live, liveOrigin }) {
  if (live) {
    await verifyAp2LiveSmoke(liveOrigin);
    return;
  }
  await verifyAp2LocalSmoke();
}

async function verifySkillsSmoke({ live, liveOrigin }) {
  if (live) {
    await verifySkillsLiveSmoke(liveOrigin);
    return;
  }

  const wallet = createTestWallet();
  await withDevLayerEnv(wallet.walletAddress, async () => {
    await withLocalServerInProcess(async ({ origin, store }) => {
      const session = await createSignedSession(origin, wallet);
      const catalog = await apiJson(origin, '/api/skills', { cookie: session.cookie });
      const skills = arrayPayload(catalog.skills);
      const fridayDca = skills.find((entry) => entry?.id === 'friday-dca');
      assert(fridayDca, 'GET /api/skills did not include friday-dca');
      console.log('[smoke-render-web] PASS Skills catalog includes friday-dca.');

      const installResponse = await apiJson(origin, '/api/skills/installs', {
        method: 'POST',
        cookie: session.cookie,
        body: {
          skillId: fridayDca.id,
          manifestVersion: fridayDca.version,
          acceptMonetization: false,
          caps: {
            perRunMaxAmount: '50',
            lifetimeMaxAmount: '50',
            allowlistedTokens: arrayPayload(fridayDca.caps?.allowlistedTokens),
          },
        },
      });
      const install = requiredObject(installResponse.install, 'skill install');
      assert(install.skillId === 'friday-dca', `install skillId was ${install.skillId}`);
      console.log(`[smoke-render-web] PASS installed friday-dca as ${install.id}.`);

      const { runSkillsExecuteTick } = await import(pathToFileURL(join(process.cwd(), 'apps/render-web/dist/cloud/skillExecutorService.js')).href);
      const skillsSmokeTick = nextFridayDcaTickAfter(install.installedAt);
      const executeResult = await runSkillsExecuteTick({
        store,
        clock: { now: () => skillsSmokeTick },
      });
      if (executeResult.proposed !== 1) {
        const auditEvents = await store.forWallet(wallet.walletAddress).listAuditEvents();
        const lastSkillAudit = auditEvents.filter((entry) => String(entry.type ?? '').startsWith('skill.')).at(-1);
        const reason = lastSkillAudit?.metadata?.reason ? `; last skill audit reason=${lastSkillAudit.metadata.reason}` : '';
        const stage = lastSkillAudit?.metadata?.stage ? `; stage=${lastSkillAudit.metadata.stage}` : '';
        throw new Error(`skills execute proposed=${executeResult.proposed}, expected 1${reason}${stage}`);
      }
      const executions = await store.listSkillExecutionsForSkill('friday-dca');
      assert(executions.length === 1, `expected one skill execution, found ${executions.length}`);
      const pendingExecution = executions[0];
      assert(pendingExecution?.approvalRequestId, 'skill execution did not link an approval request');
      console.log(`[smoke-render-web] PASS skills executor proposed approval ${pendingExecution.approvalRequestId}.`);

      const inbox = await apiJson(origin, '/api/approvals', { cookie: session.cookie });
      const approval = arrayPayload(inbox.approvals).find((entry) => entry?.id === pendingExecution.approvalRequestId);
      assert(approval, `approval ${pendingExecution.approvalRequestId} did not appear in inbox`);
      await apiJson(origin, `/api/approvals/${encodeURIComponent(approval.id)}/wallet-execution`, {
        method: 'POST',
        cookie: session.cookie,
        body: {
          ...decisionProofBody(approval, 'approved', wallet),
          txid: `skills_smoke_${approval.id}`,
          txStatus: 'confirmed',
          explorerUrl: `https://solscan.io/tx/skills_smoke_${approval.id}`,
          note: 'Approved in Skills smoke.',
          metadata: { transactionBoundary: 'skills_smoke_wallet_execution' },
        },
      });
      console.log(`[smoke-render-web] PASS wallet-executed skill approval ${approval.id}.`);

      const completedExecutions = await store.listSkillExecutionsForSkill('friday-dca');
      const completedExecution = completedExecutions.find((entry) => entry.id === pendingExecution.id);
      assert(completedExecution?.result === 'success', `skill execution result=${completedExecution?.result}`);
      assert(completedExecution.evidenceReceiptId, 'skill execution did not link an evidence receipt');
      const evidence = await apiJson(origin, '/api/evidence', { cookie: session.cookie });
      const receipt = arrayPayload(evidence.receipts).find((entry) => entry?.id === completedExecution.evidenceReceiptId);
      assert(receipt, `evidence receipt ${completedExecution.evidenceReceiptId} was not listed`);
      assert(receipt.verified === true, 'skill evidence receipt was not verified');
      console.log(`[smoke-render-web] PASS skill evidence receipt ${receipt.id} was written.`);

      const { runAggregatorRoll } = await import(pathToFileURL(join(process.cwd(), 'apps/render-web/dist/cloud/aggregatorJob.js')).href);
      const rollResult = await runAggregatorRoll({
        store,
        clock: { now: () => new Date('2026-05-15T14:05:00.000Z') },
      });
      assert(rollResult.skillSnapshots >= 1, `aggregator skillSnapshots=${rollResult.skillSnapshots}`);
      const statsResponse = await apiJson(origin, '/api/aggregator/skills/friday-dca');
      const stats = requiredObject(statsResponse.snapshot, 'friday-dca stats snapshot');
      assert(stats.totalExecutions >= 1, `friday-dca totalExecutions=${stats.totalExecutions}`);
      assert(stats.successRate === 1, `friday-dca successRate=${stats.successRate}`);
      console.log('[smoke-render-web] PASS aggregator reports friday-dca execution.');

      const profileResponse = await fetch(`${origin}/u/${encodeURIComponent(wallet.walletAddress)}`);
      const profileHtml = await profileResponse.text();
      assert(profileResponse.status === 200, `/u/${wallet.walletAddress} returned HTTP ${profileResponse.status}: ${snippet(profileHtml)}`);
      assert(/text\/html/i.test(profileResponse.headers.get('content-type') ?? ''), 'profile route did not return HTML');
      assert(profileHtml.includes('friday-dca'), 'profile HTML did not list friday-dca');
      console.log(`[smoke-render-web] PASS public profile /u/${wallet.walletAddress} lists friday-dca.`);

      console.log('[smoke-render-web] PASS Skills smoke completed.');
    });
  });
}

async function verifySkillsLiveSmoke(origin) {
  const base = origin.replace(/\/+$/, '');
  await verifyHostedAiStatus(`${base}/api/ai/status`);
  await verifyJsonSession(`${base}/api/session`);
  await verifyJsonApiRoute(`${base}/api/skills`, [200, 401, 403]);

  const skillUrl = `${base}/skills/friday-dca`;
  const response = await fetch(skillUrl);
  const contentType = response.headers.get('content-type') ?? '';
  const raw = await response.text();
  if (!response.ok) throw new Error(`${skillUrl} returned HTTP ${response.status}: ${snippet(raw)}`);
  if (!/text\/html/i.test(contentType)) {
    throw new Error(`${skillUrl} returned ${contentType || 'missing content-type'} instead of text/html.`);
  }
  if (!raw.includes('Friday DCA')) throw new Error(`${skillUrl} did not render the Friday DCA launch skill.`);
  if (!raw.includes('/app#skills/install/friday-dca')) {
    throw new Error(`${skillUrl} did not include the skill install deep link.`);
  }
  if (!raw.includes(`${base}/skills/friday-dca`)) {
    throw new Error(`${skillUrl} did not include the configured canonical origin.`);
  }
  console.log(`[smoke-render-web] PASS ${skillUrl} returned launch skill SSR HTML.`);
}

async function verifyAp2LocalSmoke() {
  const wallet = createTestWallet();
  await withDevLayerEnv(wallet.walletAddress, async () => {
    await withLocalServer(async ({ origin }) => {
      const session = await createSignedSession(origin, wallet);
      const agentKey = generateAp2AgentKey();
      const inboundBody = createAp2InboundBody({
        recipient: wallet.walletAddress,
        agentKey,
        agentLabel: 'Smoke Operator',
        amount: '0.01',
        tokenMint: AP2_SMOKE_SOL_MINT,
        tokenSymbol: 'SOL',
        memo: 'Headline AP2 smoke',
      });

      const inboundResponse = await apiRaw(origin, '/api/ap2/inbound', {
        method: 'POST',
        cookie: session.cookie,
        body: inboundBody,
      });
      if (inboundResponse.status === 404) {
        throw new Error('POST /api/ap2/inbound returned HTTP 404 — the route is not registered on this server. Run `pnpm -F @solana-agent-wallet-adapter/render-web build` and retry.');
      }
      if (inboundResponse.status < 200 || inboundResponse.status >= 300) {
        throw new Error(`POST /api/ap2/inbound returned HTTP ${inboundResponse.status}: ${JSON.stringify(inboundResponse.body)}`);
      }
      const inbound = inboundResponse.body ?? {};
      assert(typeof inbound.inboundId === 'string' && inbound.inboundId.length > 0, 'POST /api/ap2/inbound did not return an inboundId string');
      assert(typeof inbound.approvalId === 'string' && inbound.approvalId.length > 0, 'POST /api/ap2/inbound did not return an approvalId string');
      const { inboundId, approvalId } = inbound;
      console.log(`[smoke-render-web] PASS POST /api/ap2/inbound → inboundId=${inboundId} approvalId=${approvalId}.`);

      const list = await apiJson(origin, '/api/ap2/inbound', { cookie: session.cookie });
      const inboundList = arrayPayload(list.items ?? list.inbound ?? list.records);
      const inboundIdMatches = (entry) =>
        entry && (entry.inboundId === inboundId || entry.id === inboundId || entry.approvalId === approvalId);
      assert(inboundList.some(inboundIdMatches), `GET /api/ap2/inbound did not include new record ${inboundId}`);
      console.log(`[smoke-render-web] PASS GET /api/ap2/inbound list includes ${inboundId}.`);

      const single = await apiJson(origin, `/api/ap2/inbound/${encodeURIComponent(inboundId)}`, { cookie: session.cookie });
      const singleRecord = requiredObject(single.item ?? single.inbound ?? single.record ?? single, 'ap2 inbound detail');
      const singleId = singleRecord.inboundId ?? singleRecord.id ?? singleRecord.approvalId;
      assert(singleId === inboundId, `GET /api/ap2/inbound/${inboundId} returned id=${singleId}`);
      console.log(`[smoke-render-web] PASS GET /api/ap2/inbound/${inboundId} returned matching record.`);

      const inbox = await apiJson(origin, '/api/approvals', { cookie: session.cookie });
      const approval = arrayPayload(inbox.approvals).find((entry) => entry && entry.id === approvalId);
      assert(approval, `approval ${approvalId} did not appear in /api/approvals inbox`);
      console.log(`[smoke-render-web] PASS approval ${approvalId} materialized into inbox.`);

      // Money-moving approvals (transfer_sol/transfer_spl) skip the explicit
      // /approve decision and progress directly through the finalization
      // chain — the server gates this with HTTP 409 if you try /approve.
      const preview = await apiJson(origin, `/api/approvals/${encodeURIComponent(approvalId)}/finalization/prepare`, {
        method: 'POST',
        cookie: session.cookie,
        body: {},
      }).then((payload) => requiredObject(payload.finalization, 'finalization preview'));
      const finalizationId = String(preview.id ?? '');
      assert(finalizationId.length > 0, 'finalization prepare did not return a finalization id');
      await apiJson(origin, `/api/approvals/${encodeURIComponent(approvalId)}/finalization/${encodeURIComponent(finalizationId)}/submit`, {
        method: 'POST',
        cookie: session.cookie,
        body: {
          ...finalizationProofBody(approval, preview, wallet),
          finalizationId,
          finalizationStatus: 'confirmed',
          txStatus: 'confirmed',
          txid: 'ap2-smoke-tx',
          transactionHash: preview.transactionHash,
          messageHash: preview.messageHash,
          quoteHash: preview.quote?.quoteHash,
          simulationHash: preview.simulation?.simulationHash,
          explorerUrl: 'https://explorer.solana.com/tx/ap2-smoke-tx',
          note: 'Finalized in AP2 smoke.',
        },
      });
      console.log(`[smoke-render-web] PASS approval ${approvalId} finalized.`);

      const receiptResponse = await apiRaw(origin, `/api/ap2/inbound/${encodeURIComponent(inboundId)}/receipt`, {
        method: 'POST',
        cookie: session.cookie,
        body: {},
      });
      if (receiptResponse.status < 200 || receiptResponse.status >= 300) {
        throw new Error(`POST /api/ap2/inbound/${inboundId}/receipt returned HTTP ${receiptResponse.status}: ${JSON.stringify(receiptResponse.body)}`);
      }
      const receiptBody = receiptResponse.body ?? {};
      const receipt = receiptBody.receipt ?? receiptBody;
      assert(receipt && typeof receipt === 'object', 'AP2 receipt response was not an object');
      assert(
        receipt.schema === 'ap2/inbound/0.1',
        `AP2 receipt schema was ${receipt.schema}, expected ap2/inbound/0.1`,
      );
      assert(
        typeof receipt.artifactHash === 'string' && /^[a-f0-9]{64}$/i.test(receipt.artifactHash),
        `AP2 receipt artifactHash was not a 64-char hex string: ${receipt.artifactHash}`,
      );
      assert(
        receipt.mandateId === inboundBody.mandate.mandateId,
        `AP2 receipt mandateId did not round-trip: ${receipt.mandateId} vs ${inboundBody.mandate.mandateId}`,
      );
      assert(
        receipt.approval?.id === approvalId,
        `AP2 receipt approval.id mismatch: ${receipt.approval?.id} vs ${approvalId}`,
      );
      console.log(`[smoke-render-web] PASS POST /api/ap2/inbound/${inboundId}/receipt produced a receipt with schema=${receipt.schema}, mandateId=${receipt.mandateId}.`);

      console.log(`[smoke-render-web] PASS AP2 inbound lifecycle: ${inboundId} → ${approvalId} → finalized → receipted.`);
    });
  });
}

async function verifyAp2LiveSmoke(liveOrigin) {
  const base = liveOrigin.replace(/\/+$/, '');
  const wellKnown = await fetch(`${base}/.well-known/agent.json`);
  if (wellKnown.status === 404) {
    console.log(`[smoke-render-web] SKIP ${base}/.well-known/agent.json is not deployed at this origin yet.`);
  } else {
    const contentType = wellKnown.headers.get('content-type') ?? '';
    const raw = await wellKnown.text();
    if (!wellKnown.ok) {
      throw new Error(`GET /.well-known/agent.json returned HTTP ${wellKnown.status}: ${snippet(raw)}`);
    }
    if (!/application\/json/i.test(contentType)) {
      throw new Error(`GET /.well-known/agent.json returned ${contentType || 'missing content-type'} instead of application/json: ${snippet(raw)}`);
    }
    const payload = parseJson(raw, `${base}/.well-known/agent.json`);
    assert(payload && typeof payload === 'object', '/.well-known/agent.json body was not an object');
    for (const field of ['name', 'description', 'walletAddress']) {
      assert(typeof payload[field] === 'string' && payload[field].length > 0, `/.well-known/agent.json missing required string field "${field}"`);
    }
    console.log(`[smoke-render-web] PASS ${base}/.well-known/agent.json returned valid AgentCard JSON.`);
  }

  const inboundProbe = await fetch(`${base}/api/ap2/inbound`);
  if (inboundProbe.status === 404) {
    console.log(`[smoke-render-web] SKIP ${base}/api/ap2/inbound is not deployed at this origin yet.`);
  } else if (inboundProbe.status === 401 || inboundProbe.status === 403) {
    console.log(`[smoke-render-web] PASS ${base}/api/ap2/inbound rejected unauthenticated caller with HTTP ${inboundProbe.status}.`);
  } else {
    const body = await inboundProbe.text();
    throw new Error(`GET /api/ap2/inbound returned HTTP ${inboundProbe.status} unauthenticated; expected 401 or 403: ${snippet(body)}`);
  }
}

function generateAp2AgentKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
  const publicKeyBytes = Buffer.from(publicKeyDer).subarray(-32);
  return {
    publicKeyBase58: encodeBase58(publicKeyBytes),
    publicKeyBytes,
    privateKey,
  };
}

function createAp2InboundBody({
  recipient,
  agentKey,
  agentLabel,
  amount,
  tokenMint,
  memo,
  cluster = 'mainnet-beta',
  tokenSymbol = 'USDC',
}) {
  const mandateId = `smoke-${randomHex(12)}`;
  const now = new Date();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 60 * 60_000).toISOString();
  const intent = {
    description: memo ?? 'Agent 10 smoke mandate',
    cap: {
      amount,
      tokenSymbol,
      tokenMint,
      recipient,
      cluster,
      ...(memo ? { memo } : {}),
    },
  };
  const signedFields = {
    mandateId,
    mandateType: 'intent_mandate',
    protocolVersion: 'ap2/0.1',
    issuedAt,
    expiresAt,
    intent,
  };
  const canonical = ap2Canonicalize(signedFields);
  const signatureBytes = signDetached(null, Buffer.from(canonical, 'utf8'), agentKey.privateKey);
  const mandate = {
    mandateId,
    mandateType: 'intent_mandate',
    protocolVersion: 'ap2/0.1',
    issuedAt,
    expiresAt,
    agent: {
      agentId: `smoke-agent-${randomHex(6)}`,
      agentLabel,
      publicKey: agentKey.publicKeyBase58,
    },
    signature: encodeBase58(signatureBytes),
    signedFields,
    intent,
  };
  return { mandate };
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function withDevLayerEnv(walletAddress, callback) {
  const prior = {
    AGENTIC_DEV_AP2_ACP: process.env.AGENTIC_DEV_AP2_ACP,
    AGENTIC_DEV_WALLET_ALLOWLIST: process.env.AGENTIC_DEV_WALLET_ALLOWLIST,
  };
  process.env.AGENTIC_DEV_AP2_ACP = '1';
  process.env.AGENTIC_DEV_WALLET_ALLOWLIST = walletAddress;
  try {
    return await callback();
  } finally {
    if (prior.AGENTIC_DEV_AP2_ACP === undefined) {
      delete process.env.AGENTIC_DEV_AP2_ACP;
    } else {
      process.env.AGENTIC_DEV_AP2_ACP = prior.AGENTIC_DEV_AP2_ACP;
    }
    if (prior.AGENTIC_DEV_WALLET_ALLOWLIST === undefined) {
      delete process.env.AGENTIC_DEV_WALLET_ALLOWLIST;
    } else {
      process.env.AGENTIC_DEV_WALLET_ALLOWLIST = prior.AGENTIC_DEV_WALLET_ALLOWLIST;
    }
  }
}

async function verifyHostedAiStatus(url) {
  const response = await fetch(url);
  const contentType = response.headers.get('content-type') ?? '';
  const raw = await response.text();
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${snippet(raw)}`);
  if (!/application\/json/i.test(contentType)) {
    throw new Error(`${url} returned ${contentType || 'missing content-type'} instead of application/json: ${snippet(raw)}`);
  }
  const payload = parseJson(raw, url);
  if (payload?.available !== true || payload?.mode !== 'hosted-byok') {
    throw new Error(`${url} returned unexpected hosted AI status: ${JSON.stringify(payload)}`);
  }
  console.log(`[smoke-render-web] PASS ${url} returned hosted BYOK JSON.`);
}

async function verifyJsonSession(url) {
  const response = await fetch(url);
  const contentType = response.headers.get('content-type') ?? '';
  const raw = await response.text();
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${snippet(raw)}`);
  if (!/application\/json/i.test(contentType)) {
    throw new Error(`${url} returned ${contentType || 'missing content-type'} instead of application/json.`);
  }
  const payload = parseJson(raw, url);
  if (payload?.signedIn !== false) throw new Error(`${url} returned unexpected session JSON: ${JSON.stringify(payload)}`);
  console.log(`[smoke-render-web] PASS ${url} returned signed-out session JSON.`);
}

async function verifyJson404(url) {
  const response = await fetch(url);
  const contentType = response.headers.get('content-type') ?? '';
  const raw = await response.text();
  if (response.status !== 404) throw new Error(`${url} returned HTTP ${response.status} instead of 404.`);
  if (!/application\/json/i.test(contentType)) {
    throw new Error(`${url} returned ${contentType || 'missing content-type'} instead of application/json.`);
  }
  const payload = parseJson(raw, url);
  if (payload?.error !== 'not_found') throw new Error(`${url} returned unexpected 404 JSON: ${JSON.stringify(payload)}`);
}

async function verifyJsonApiRoute(url, allowedStatuses) {
  const response = await fetch(url);
  const contentType = response.headers.get('content-type') ?? '';
  const raw = await response.text();
  if (!allowedStatuses.includes(response.status)) {
    throw new Error(`${url} returned HTTP ${response.status}; expected ${allowedStatuses.join(' or ')}: ${snippet(raw)}`);
  }
  if (!/application\/json/i.test(contentType)) {
    throw new Error(`${url} returned ${contentType || 'missing content-type'} instead of application/json: ${snippet(raw)}`);
  }
  parseJson(raw, url);
  console.log(`[smoke-render-web] PASS ${url} returned JSON HTTP ${response.status}.`);
}

async function verifyHtmlRoute(url, route) {
  const response = await fetch(url);
  const contentType = response.headers.get('content-type') ?? '';
  const raw = await response.text();
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${snippet(raw)}`);
  if (!/text\/html/i.test(contentType)) throw new Error(`${url} returned ${contentType || 'missing content-type'} instead of text/html.`);
  if (!raw.includes('id="app"')) throw new Error(`${url} did not include the app shell.`);
  console.log(`[smoke-render-web] PASS ${route} returned HTML app shell.`);
}

function createPlanBody(intent) {
  return {
    plan: {
      intent,
      route: 'Wallet approval required.',
      risk: 'Medium risk.',
      approval: 'Review in wallet before signing.',
      source: 'template',
      category: 'payments',
      actionType: 'transfer_sol',
      templateTitle: 'Send SOL',
      parameters: {
        recipient: 'Recipient111111111111111111111111111111111',
        amount: '0.01',
        memo: 'Workflow smoke',
      },
      fields: [
        { label: 'Recipient address', value: 'Recipient111111111111111111111111111111111' },
        { label: 'Amount SOL', value: '0.01' },
      ],
      safeguards: ['Wallet approval is required.'],
    },
    source: 'template',
    templateId: 'transfer-sol',
    templateTitle: 'Send SOL',
    prompt: intent,
    cluster: 'devnet',
  };
}

function createManualReviewPlanBody(intent) {
  return {
    plan: {
      intent,
      route: 'Decision proof only.',
      risk: 'Low risk.',
      approval: 'Wallet signs a review decision proof.',
      source: 'template',
      category: 'custom',
      actionType: 'manual_review',
      templateTitle: 'Manual Review',
      parameters: {
        reason: 'Workflow smoke proof-only approval.',
      },
      fields: [
        { label: 'Reason', value: 'Workflow smoke proof-only approval.' },
      ],
      safeguards: ['No transaction is submitted by this approval proof.'],
    },
    source: 'template',
    templateId: 'manual-review',
    templateTitle: 'Manual Review',
    prompt: intent,
    cluster: 'devnet',
  };
}

async function finalizeApprovalViaApi(origin, cookie, approval, wallet, txid) {
  const preview = await apiJson(origin, `/api/approvals/${encodeURIComponent(approval.id)}/finalization/prepare`, {
    method: 'POST',
    cookie,
    body: {},
  }).then((payload) => requiredObject(payload.finalization, 'finalization'));
  await apiJson(origin, `/api/approvals/${encodeURIComponent(approval.id)}/finalization/${encodeURIComponent(preview.id)}/submit`, {
    method: 'POST',
    cookie,
    body: {
      ...finalizationProofBody(approval, preview, wallet),
      finalizationId: preview.id,
      finalizationStatus: 'confirmed',
      txStatus: 'confirmed',
      txid,
      transactionHash: preview.transactionHash,
      messageHash: preview.messageHash,
      quoteHash: preview.quote?.quoteHash,
      simulationHash: preview.simulation?.simulationHash,
      explorerUrl: `https://explorer.solana.com/tx/${encodeURIComponent(txid)}?cluster=${encodeURIComponent(approval.cluster ?? 'devnet')}`,
      note: 'Finalized in workflow smoke.',
    },
  });
}

function recurringSmokeBody() {
  return {
    cluster: 'devnet',
    token: 'SOL',
    recipient: 'Recipient111111111111111111111111111111111',
    amount: '0.02',
    cadence: 'interval_minutes',
    intervalMinutes: 10,
  };
}

function createEvidenceBody(wallet) {
  const hash = `0x${'a'.repeat(64)}`;
  const signingMessage = [
    'Solana Agent Wallet Adapter',
    'Evidence receipt: Intent Receipt',
    'Receipt: smoke',
    `Wallet: ${wallet.walletAddress}`,
    'Cluster: devnet',
    `Hash: ${hash}`,
  ].join('\n');
  return {
    title: 'Intent Receipt',
    kind: 'intent_receipt',
    status: 'approved',
    cluster: 'devnet',
    payload: {
      status: 'approved',
      thesis: 'Workflow smoke evidence receipt.',
      nextSignatureGate: 'Wallet must approve any matching request.',
      metrics: [{ label: 'Effect', value: 'evidence only', tone: 'neutral' }],
      evidence: [{ title: 'Smoke', detail: 'Receipt created during release smoke.', tone: 'good', hash: 'smoke' }],
      receiptType: 'intent_receipt_v1',
    },
    preSignatureHash: hash,
    signingMessage,
    signature: encodeBase58(signDetached(null, Buffer.from(signingMessage, 'utf8'), wallet.privateKey)),
    artifactHash: `0x${'b'.repeat(64)}`,
    receiptType: 'intent_receipt_v1',
    summary: 'Workflow smoke receipt.',
  };
}

function hostedAiRequest() {
  return {
    prompt: 'Prepare a release smoke plan.',
    template: {
      id: 'custom-request',
      category: 'custom',
      title: 'Custom request',
      description: 'Turn request into a plan.',
      actionType: 'custom',
      risk: 'medium',
    },
    parameters: { amount: '0.01' },
  };
}

function fakeWalletScript(wallet, signerOrigin = '') {
  return `
(() => {
  if (window.__agenticSmokeWalletRegistered) return;
  window.__agenticSmokeWalletRegistered = {
    appReadyEvents: 0,
    injectedAt: Date.now(),
    registrations: 0,
  };
  const publicKey = new Uint8Array(${JSON.stringify([...wallet.publicKeyBytes])});
  const signerOrigin = ${JSON.stringify(signerOrigin)};
  const signMessage = async (message) => {
    if (!signerOrigin) return new Uint8Array(64).fill(7);
    const response = await fetch(signerOrigin + '/sign-message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bytes: Array.from(message) }),
    });
    if (!response.ok) throw new Error('Smoke signer returned HTTP ' + response.status);
    const payload = await response.json();
    return new Uint8Array(payload.signature);
  };
  const chains = ['solana:mainnet', 'solana:devnet', 'solana:testnet', 'solana:localnet'];
  const account = {
    address: ${JSON.stringify(wallet.walletAddress)},
    publicKey,
    chains,
    features: ['solana:signMessage', 'solana:signTransaction', 'solana:signAndSendTransaction'],
  };
  const wallet = {
    version: '1.0.0',
    name: 'Backpack',
    icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
    chains,
    accounts: [account],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => undefined },
      'solana:signMessage': {
        version: '1.0.0',
        signMessage: async ({ message }) => [{ signedMessage: message, signature: await signMessage(message) }],
      },
      'solana:signTransaction': {
        version: '1.0.0',
        signTransaction: async ({ transaction }) => [{ signedTransaction: transaction }],
      },
      'solana:signAndSendTransaction': {
        version: '1.0.0',
        signAndSendTransaction: async () => [{ signature: new Uint8Array(64).fill(8) }],
      },
    },
  };
  const register = (api) => {
    window.__agenticSmokeWalletRegistered.registrations += 1;
    return api.register(wallet);
  };
  window.addEventListener('wallet-standard:app-ready', (event) => {
    window.__agenticSmokeWalletRegistered.appReadyEvents += 1;
    register(event.detail);
  });
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
})();
`;
}

function fakeAndroidShellBridgeScript() {
  return `
(() => {
  if (window.AgenticAndroid) return;
  const emptyJson = () => '{}';
  window.AgenticAndroid = {
    bridgePairEnabled: () => false,
    bridgePairStatus: emptyJson,
    bridgeRelayStatus: emptyJson,
    clipboardRead: () => '',
    clipboardWrite: () => true,
    deviceAgentStatus: emptyJson,
    haptic: () => true,
    isDebugBuild: () => true,
    isExampleTabEnabled: () => false,
    openExternal: () => true,
    remoteConfigGet: emptyJson,
    remoteConfigStatus: emptyJson,
    secureDelete: () => true,
    secureGet: () => '',
    secureSet: () => true
  };
})();
`;
}

function createTestWallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
  const publicKeyBytes = Buffer.from(publicKeyDer).subarray(-32);
  return {
    walletAddress: encodeBase58(publicKeyBytes),
    publicKeyBytes,
    privateKey,
  };
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(bytes) {
  if (bytes.length === 0) return '';
  let value = 0n;
  for (const byte of bytes) value = (value * 256n) + BigInt(byte);
  let encoded = '';
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  let leadingZeroes = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    leadingZeroes += '1';
  }
  return leadingZeroes + (encoded || '');
}

async function withLocalServer(callback, { mockHostedAi = false } = {}) {
  if (!existsSync(RENDER_SERVER_ENTRY)) {
    throw new Error(`${RENDER_SERVER_ENTRY} does not exist. Run pnpm -F @solana-agent-wallet-adapter/render-web build before smoke.`);
  }
  const serverPort = await freePort();
  const origin = `http://127.0.0.1:${serverPort}`;
  const preload = mockHostedAi ? createHostedAiPreload() : null;
  const nodeOptions = [
    process.env.NODE_OPTIONS,
    preload ? `--import=${pathToFileURL(preload.file).href}` : '',
  ].filter(Boolean).join(' ');
  const server = spawn(process.execPath, [RENDER_SERVER_ENTRY], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
      AGENTIC_AI_API_KEY: '',
      AGENTIC_HOSTED_AI_API_KEY: '',
      AGENTIC_MANAGED_AI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      AGENTIC_ENV_FILE: process.env.AGENTIC_SMOKE_ENV_FILE ?? '/dev/null',
      AGENTIC_MOCK_FINALIZATION: process.env.AGENTIC_MOCK_FINALIZATION ?? '1',
      AGENTIC_PUBLIC_ORIGIN: origin,
      DATABASE_URL: '',
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      PORT: String(serverPort),
      RENDER: '',
      SESSION_SECRET: 'agentic-render-smoke-session-secret-000000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childOutput = captureChildOutput(server);
  try {
    await waitForHostedAiStatus(`${origin}/api/ai/status`, {
      childOutput,
      childProcess: server,
      label: 'local Render smoke server',
    });
    await callback({ origin, serverPort });
  } finally {
    await terminate(server);
    if (preload) rmSync(preload.dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

async function withLocalServerInProcess(callback) {
  if (!existsSync(RENDER_SERVER_ENTRY)) {
    throw new Error(`${RENDER_SERVER_ENTRY} does not exist. Run pnpm -F @solana-agent-wallet-adapter/render-web build before smoke.`);
  }
  const serverPort = await freePort();
  const [{ createRenderWebServer }, { MemoryWorkflowStore }] = await Promise.all([
    import(pathToFileURL(join(process.cwd(), RENDER_SERVER_ENTRY)).href),
    import(pathToFileURL(join(process.cwd(), 'apps/render-web/dist/cloud/memoryStore.js')).href),
  ]);
  const store = new MemoryWorkflowStore();
  const server = createRenderWebServer({ store });
  await listen(server, serverPort);
  const origin = `http://127.0.0.1:${serverPort}`;
  try {
    await waitForHostedAiStatus(`${origin}/api/ai/status`);
    await callback({ origin, serverPort, store });
  } finally {
    await close(server);
  }
}

function createHostedAiPreload() {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-render-smoke-preload-'));
  const file = join(dir, 'hosted-ai-fetch.mjs');
  writeFileSync(file, `
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url;
  if (url === 'https://api.openai.com/v1/responses') {
    return new Response(JSON.stringify({
      output_text: JSON.stringify({
        intent: 'Hosted BYOK smoke intent',
        route: 'Mocked server-side hosted BYOK provider route.',
        risk: 'Low risk.',
        approval: 'Wallet approval remains separate from hosted AI drafting.',
        safeguards: ['Provider call was intercepted by smoke test harness.'],
      }),
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return originalFetch(input, init);
};
`, 'utf8');
  return { dir, file };
}

async function withChrome(callback) {
  const chromePort = await freePort();
  const chromePath = resolveChromePath();
  const userDataDir = mkdtempSync(join(tmpdir(), 'agentic-render-smoke-chrome-'));
  const chrome = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${userDataDir}`,
    '--host-resolver-rules=MAP agentic-smoke.test 127.0.0.1',
    '--no-first-run',
    '--disable-gpu',
    'about:blank',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForHttp(`http://127.0.0.1:${chromePort}/json/list`);
    const page = await connectPage(chromePort);
    try {
      await callback(page);
    } finally {
      page.close();
    }
  } finally {
    await terminate(chrome);
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

async function withWalletSigner(wallet, callback) {
  const port = await freePort();
  const server = createHttpServer(async (req, res) => {
    writeCorsHeaders(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `127.0.0.1:${port}`}`);
    if (req.method === 'POST' && url.pathname === '/sign-message') {
      const body = await readRequestJson(req);
      const bytes = Array.isArray(body.bytes) ? body.bytes : [];
      const signature = signDetached(null, Buffer.from(bytes), wallet.privateKey);
      writeJson(res, 200, { signature: [...signature] });
      return;
    }
    writeJson(res, 404, { error: 'not_found' });
  });
  await listen(server, port);
  try {
    await callback({ origin: `http://127.0.0.1:${port}` });
  } finally {
    await close(server);
  }
}

async function withMockBridge(wallet, callback) {
  const port = await freePort();
  const token = DEFAULT_BRIDGE_TOKEN;
  const actions = [];
  const receipts = [];
  let nextActionId = 1;
  let connectedAddress = wallet.walletAddress;
  let aiStatus = {
    available: false,
    configured: false,
    source: 'none',
  };

  const server = createHttpServer(async (req, res) => {
    writeCorsHeaders(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `127.0.0.1:${port}`}`);
    if (!hasBridgeToken(req, url, token)) {
      writeJson(res, 401, { error: 'unauthorized' });
      return;
    }
    try {
      if (req.method === 'GET' && url.pathname === '/bridge/config') {
        writeJson(res, 200, { cluster: 'devnet', rpcUrl: 'https://api.devnet.solana.com' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/bridge/connect') {
        const body = await readRequestJson(req);
        connectedAddress = typeof body.address === 'string' && body.address ? body.address : connectedAddress;
        writeJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/bridge/disconnect') {
        writeJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/bridge/health') {
        writeJson(res, 200, {
          walletConnected: true,
          walletAddress: connectedAddress,
          bridgeConnected: true,
          mcpReady: true,
          cluster: 'devnet',
          rpcUrl: 'https://api.devnet.solana.com',
          rpcWritable: { ok: true, message: 'mock bridge' },
          mainnetEnabled: false,
          capsEnabled: false,
          preparedActionStorePath: null,
          labArtifactStorePath: null,
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/bridge/action/health') {
        writeJson(res, 200, { ok: true, cluster: 'devnet', rpcWritable: { ok: true, message: 'mock bridge' } });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/bridge/action/status') {
        writeJson(res, 200, { connected: true, address: connectedAddress, cluster: 'devnet' });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/bridge/action/balances') {
        writeJson(res, 200, { cluster: 'devnet', items: [] });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/bridge/ai/status') {
        writeJson(res, 200, aiStatus);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/bridge/ai/session-key') {
        const body = await readRequestJson(req);
        if (body.clear) {
          aiStatus = { available: false, configured: false, source: 'none' };
        } else {
          aiStatus = {
            available: true,
            configured: true,
            source: 'session',
            provider: body.provider ?? 'openai-compatible',
            apiFormat: body.apiFormat ?? 'openai-compatible',
            baseUrl: body.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta/openai',
            model: body.model ?? 'gemini-2.5-flash-lite',
          };
        }
        writeJson(res, 200, aiStatus);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/bridge/prepared-actions') {
        writeJson(res, 200, { materialized: actions, actions });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/bridge/prepared-actions/tx-status') {
        writeJson(res, 200, { actions });
        return;
      }
      if (req.method === 'POST' && [
        '/bridge/action/prepare-transfer-sol',
        '/bridge/action/prepare-transfer-spl',
        '/bridge/action/prepare-swap',
      ].includes(url.pathname)) {
        const body = await readRequestJson(req);
        const now = new Date().toISOString();
        const kind = url.pathname.endsWith('prepare-swap')
          ? 'swap'
          : url.pathname.endsWith('prepare-transfer-spl')
            ? 'transfer_spl'
            : 'transfer_sol';
        const action = {
          id: `mock-bridge-action-${nextActionId++}`,
          kind,
          status: 'ready',
          walletAddress: connectedAddress,
          cluster: 'devnet',
          summary: mockActionSummary(kind, body),
          params: {
            ...body,
            ...(kind === 'transfer_sol' && { amountSol: body.amountSol ?? body.amount ?? '0.01' }),
            ...(kind !== 'transfer_sol' && { amount: body.amount ?? '0.01' }),
            ...(body.recipient !== undefined && { recipient: body.recipient }),
            memo: '',
          },
          dueAt: now,
          createdAt: now,
          updatedAt: now,
          note: body.note ?? 'Mock bridge smoke action',
        };
        actions.unshift(action);
        writeJson(res, 200, { preparedAction: action });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/bridge/prepared-actions/execute') {
        const body = await readRequestJson(req);
        const action = actions.find((candidate) => candidate.id === body.actionId);
        if (!action) {
          writeJson(res, 404, { error: 'not_found' });
          return;
        }
        const completedAt = new Date().toISOString();
        action.status = 'approved';
        action.confirmedAt = completedAt;
        action.updatedAt = completedAt;
        const receipt = {
          actionId: action.id,
          status: 'approved',
          summary: action.summary,
          note: action.note,
          walletAddress: action.walletAddress,
          recipient: action.params.recipient,
          amount: action.params.amountSol ?? action.params.amount,
          token: action.params.token ?? action.params.inputToken ?? 'SOL',
          cluster: action.cluster,
          createdAt: action.createdAt,
          completedAt,
          proofSignature: 'mock_bridge_proof',
        };
        receipts.unshift(receipt);
        writeJson(res, 200, { preparedAction: action, receipt });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/bridge/prepared-actions/reject') {
        const body = await readRequestJson(req);
        const action = actions.find((candidate) => candidate.id === body.actionId);
        if (!action) {
          writeJson(res, 404, { error: 'not_found' });
          return;
        }
        const completedAt = new Date().toISOString();
        action.status = 'rejected';
        action.updatedAt = completedAt;
        receipts.unshift({
          actionId: action.id,
          status: 'rejected',
          summary: action.summary,
          walletAddress: action.walletAddress,
          cluster: action.cluster,
          createdAt: action.createdAt,
          completedAt,
          proofSignature: 'mock_bridge_rejection_proof',
        });
        writeJson(res, 200, { preparedAction: action });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/bridge/prepared-actions/archive') {
        const body = await readRequestJson(req);
        const action = actions.find((candidate) => candidate.id === body.actionId);
        if (action) action.archived = true;
        writeJson(res, 200, { preparedAction: action ?? null });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/bridge/prepared-actions/delete') {
        const body = await readRequestJson(req);
        const index = actions.findIndex((candidate) => candidate.id === body.actionId);
        if (index !== -1) actions.splice(index, 1);
        writeJson(res, 200, { deleted: index !== -1 });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/bridge/recurring-payments') {
        writeJson(res, 200, { materialized: [], recurringPayments: [] });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/bridge/recurring-payments') {
        writeJson(res, 200, { recurringPayment: { id: 'mock-bridge-recurring-1' } });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/bridge/receipts') {
        writeJson(res, 200, { receipts });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/bridge/lab-artifacts') {
        writeJson(res, 200, { artifacts: [] });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/bridge/lab-artifacts') {
        writeJson(res, 200, { artifact: await readRequestJson(req) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/bridge/lab-artifacts/delete') {
        writeJson(res, 200, { deleted: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/bridge/trace') {
        writeJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/bridge/next') {
        writeJson(res, 200, { request: null });
        return;
      }
      writeJson(res, 404, { error: 'not_found' });
    } catch (err) {
      writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  await listen(server, port);
  try {
    await callback({ origin: `http://127.0.0.1:${port}`, token });
  } finally {
    await close(server);
  }
}

function hasBridgeToken(req, url, token) {
  const header = req.headers['x-agent-wallet-token'];
  const auth = req.headers.authorization;
  return header === token || auth === `Bearer ${token}` || url.searchParams.get('token') === token;
}

function mockActionSummary(kind, body) {
  if (kind === 'swap') {
    return `Swap ${body.amount ?? '0'} ${body.inputToken ?? 'SOL'} to ${body.outputToken ?? 'USDC'}`;
  }
  if (kind === 'transfer_spl') {
    return `Send ${body.amount ?? '0'} ${body.token ?? 'token'}`;
  }
  return `Send ${body.amountSol ?? body.amount ?? '0'} SOL`;
}

function writeCorsHeaders(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,x-agent-wallet-token,authorization');
}

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function resolveChromePath() {
  const chromePath = findChromePath();
  if (chromePath) return chromePath;
  throw new Error('Chrome or Chromium was not found. Set CHROME_PATH to run render smoke.');
}

function findChromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  for (const command of ['google-chrome', 'chromium', 'chromium-browser', 'chrome']) {
    const resolved = spawnSync('which', [command], { encoding: 'utf8' });
    if (resolved.status === 0 && resolved.stdout.trim()) return resolved.stdout.trim();
  }
  return '';
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((err) => {
        if (err) reject(err);
        else if (!address || typeof address === 'string') reject(new Error('Unable to allocate a TCP port.'));
        else resolve(address.port);
      });
    });
  });
}

async function waitForHttp(url) {
  const deadline = Date.now() + 15_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${url} returned HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(200);
  }
  throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for ${url}`);
}

async function waitForHostedAiStatus(url, options = {}) {
  const deadline = Date.now() + 15_000;
  let lastError;
  while (Date.now() < deadline) {
    if (options.childProcess && options.childProcess.exitCode !== null) {
      throw new Error(`${options.label ?? 'child process'} exited before ${url} became ready. ${options.childOutput?.() ?? ''}`.trim());
    }
    try {
      await verifyHostedAiStatus(url);
      return;
    } catch (err) {
      lastError = err;
    }
    await sleep(200);
  }
  const detail = lastError instanceof Error ? formatErrorForLog(lastError) : String(lastError ?? `Timed out waiting for ${url}`);
  const childDetail = options.childOutput?.();
  throw new Error(`Timed out waiting for ${url}: ${detail}${childDetail ? `\n${childDetail}` : ''}`);
}

async function connectPage(port) {
  const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const page = pages.find((candidate) => candidate.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new Error('No Chrome page target was available.');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const initScripts = [];
  const pending = new Map();
  let events = [];

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown' || message.method === 'Log.entryAdded' || message.method === 'Network.requestWillBeSent') {
      events.push(message);
    }
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const callId = ++id;
    pending.set(callId, (message) => {
      if (message.error) reject(new Error(`${method} failed: ${message.error.message}`));
      else resolve(message);
    });
    ws.send(JSON.stringify({ id: callId, method, params }));
  });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Page.enable');

  return {
    async addInitScript(source) {
      initScripts.push(source);
      await send('Page.addScriptToEvaluateOnNewDocument', { source });
    },
    async setCookie(cookie) {
      await send('Network.setCookie', cookie);
    },
    async setViewport(width, height) {
      await send('Emulation.setDeviceMetricsOverride', {
        deviceScaleFactor: 1,
        height,
        mobile: width < 700,
        width,
      });
      if (width < 700) {
        await send('Emulation.setTouchEmulationEnabled', {
          enabled: true,
          maxTouchPoints: 5,
        });
      } else {
        await send('Emulation.setTouchEmulationEnabled', { enabled: false });
      }
    },
    async inspect(url) {
      events = [];
      await send('Page.navigate', { url });
      await sleep(250);
      for (const source of initScripts) {
        await this.evaluate(source);
      }
      await sleep(1_000);
      const page = await this.evaluate(`(${async function inspectApp() {
        for (let index = 0; index < 50; index += 1) {
          const app = document.querySelector('#app');
          const failure = document.querySelector('[data-agentic-startup-failure]');
          if (failure || (app && app.innerHTML.trim().length > 80)) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const app = document.querySelector('#app');
        return {
          appText: app?.innerText ?? document.body.innerText,
          appHtmlLength: app?.innerHTML.length ?? 0,
          bodyText: document.body.innerText,
          href: window.location.href,
          startupFailure: Boolean(document.querySelector('[data-agentic-startup-failure]')),
          title: document.title,
        };
      }.toString()})()`);
      return { events: [...events], page };
    },
    async evaluate(expression) {
      const inspected = await send('Runtime.evaluate', {
        awaitPromise: true,
        expression,
        returnByValue: true,
      });
      if (inspected.result.exceptionDetails) {
        throw new Error(inspected.result.exceptionDetails.exception?.description ?? inspected.result.exceptionDetails.text ?? 'Browser evaluation failed.');
      }
      return inspected.result.result.value;
    },
    async waitFor(expression, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      let lastError;
      while (Date.now() < deadline) {
        try {
          if (await this.evaluate(`Boolean(${expression})`)) return;
        } catch (err) {
          lastError = err;
        }
        await sleep(200);
      }
      throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for browser expression: ${expression}`);
    },
    async touchDrag(startX, startY, endX, endY, steps = 8) {
      const point = (x, y) => ({ x: Math.round(x), y: Math.round(y), radiusX: 2, radiusY: 2, force: 1 });
      await send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [point(startX, startY)],
      });
      for (let index = 1; index <= steps; index += 1) {
        const progress = index / steps;
        const x = startX + ((endX - startX) * progress);
        const y = startY + ((endY - startY) * progress);
        await send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [point(x, y)],
        });
        await sleep(25);
      }
      await send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      await sleep(250);
    },
    close() {
      ws.close();
    },
  };
}

function eventSummary(event) {
  if (!event) return 'unknown error';
  if (event.method === 'Runtime.exceptionThrown') {
    return event.params?.exceptionDetails?.exception?.description ?? event.params?.exceptionDetails?.text ?? 'runtime exception';
  }
  if (event.method === 'Network.requestWillBeSent') {
    return event.params?.request?.url ?? 'network request';
  }
  return event.params?.entry?.text ?? 'browser log error';
}

function isLocalBridgeConfigRequest(event) {
  if (event?.method !== 'Network.requestWillBeSent') return false;
  const raw = event.params?.request?.url;
  if (typeof raw !== 'string') return false;
  try {
    const url = new URL(raw);
    return url.hostname === '127.0.0.1' && url.port === '8787' && url.pathname === '/bridge/config';
  } catch {
    return false;
  }
}

function captureChildOutput(child) {
  let stdout = '';
  let stderr = '';
  const append = (current, chunk) => `${current}${chunk}`.slice(-8_000);
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    stdout = append(stdout, String(chunk));
  });
  child.stderr?.on('data', (chunk) => {
    stderr = append(stderr, String(chunk));
  });
  return () => {
    const sections = [];
    if (stdout.trim()) sections.push(`stdout:\n${stdout.trim()}`);
    if (stderr.trim()) sections.push(`stderr:\n${stderr.trim()}`);
    return sections.length ? sections.join('\n') : '';
  };
}

function formatErrorForLog(err) {
  if (!(err instanceof Error)) return String(err);
  const parts = [err.message];
  let cause = err.cause;
  while (cause instanceof Error) {
    parts.push(cause.message);
    cause = cause.cause;
  }
  return parts.filter(Boolean).join('\ncaused by: ');
}

function requiredObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} was missing or invalid`);
  }
  return value;
}

function arrayPayload(value) {
  return Array.isArray(value) ? value : [];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseJson(raw, url) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${url} returned invalid JSON: ${snippet(raw)}`);
  }
}

function snippet(value) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

class SmokeReport {
  failures = 0;

  async check(label, fn) {
    try {
      await fn();
      console.log(`[smoke-render-web] PASS ${label}`);
    } catch (err) {
      this.failures += 1;
      console.error(`[smoke-render-web] FAIL ${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async checkOptional(label, required, fn) {
    if (!required) {
      console.log(`[smoke-render-web] SKIP ${label}`);
      return;
    }
    await this.check(label, fn);
  }

  finish() {
    if (this.failures > 0) {
      throw new Error(`${this.failures} workflow smoke check(s) failed.`);
    }
    console.log('[smoke-render-web] PASS workflow smoke completed.');
  }
}

await main();
