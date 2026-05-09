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
    } else if (options.mode === 'workflow') {
      await verifyWorkflowSmoke({ requireLocalBridge: options.requireLocalBridge });
    } else {
      await verifyLocalRender();
    }
    process.exit(0);
  } catch (err) {
    console.error(`[smoke-render-web] ${err instanceof Error ? err.message : String(err)}`);
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
    } else if (arg === '--live') {
      setMode('live', arg);
      const candidate = normalized[index + 1];
      if (candidate && !candidate.startsWith('-')) {
        parsed.liveOrigin = candidate;
        index += 1;
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
  return parsed;
}

function printUsage() {
  console.log(`Usage:
  pnpm smoke:render-web
  pnpm smoke:render-web -- --layout
  pnpm smoke:render-web -- --workflow
  pnpm smoke:render-web -- --workflow --require-local-bridge
  pnpm smoke:render-web -- --live [origin]

Modes:
  default                 Build-output route smoke against local Render server.
  --layout                Browser geometry smoke for deterministic /app layout.
  --workflow              End-to-end cloud/browser workflow release smoke.
  --live [origin]         Content-type smoke against a deployed origin.

Options:
  --require-local-bridge  Also require a real bridge at AGENTIC_BRIDGE_URL.
  -h, --help              Show this help.
`);
}

async function verifyLocalRender() {
  await withLocalServer(async ({ origin, serverPort }) => {
    await waitForHostedAiStatus(`${origin}/api/ai/status`);
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
        for (const viewport of viewports) {
          await page.setViewport(viewport.width, viewport.height);
          await page.inspect(`${origin}/app`);
          await connectFakeWallet(page);
          for (const tab of tabs) {
            await clickAndWait(page, `[data-tab="${tab}"]`, `layout tab ${tab}`);
            await page.waitFor(`document.querySelector('[data-tab="${tab}"]')?.classList.contains('active')`);
            const report = await appLayoutReport(page, `${viewport.width}x${viewport.height} ${tab}`);
            if (report.errors.length) {
              throw new Error(`Layout failed for ${report.label}: ${report.errors.join('; ')}\n${formatLayoutRects(report)}`);
            }
            console.log(`[smoke-render-web] PASS layout ${report.label} scroll=${report.scrollWidth}/${report.innerWidth}`);
          }
        }
      });
    });
  });
}

async function appLayoutReport(page, label) {
  return page.evaluate(`(() => {
    const label = ${JSON.stringify(label)};
    const required = {
      nav: '[data-layout="app-nav"]',
      intro: '[data-layout="app-intro"]',
      shell: '[data-layout="app-shell"]',
      rail: '[data-layout="app-rail"]',
      main: '[data-layout="app-main"]',
      tabs: '[data-layout="app-tabs"]',
      workflow: '[data-layout="workflow-status"]',
      trust: '[data-layout="trust-strip"]',
      activePanel: '[data-layout="active-panel"]',
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
    return { errors, innerWidth, label, rects, scrollWidth };
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
        body: {
          settings: { provider: 'openai', model: 'gpt-5', apiKey },
          request: hostedAiRequest(),
        },
      });
      assert(drafted.intent === 'Hosted BYOK smoke intent', `unexpected hosted BYOK draft: ${JSON.stringify(drafted)}`);
      assert(!JSON.stringify(drafted).includes(apiKey), 'hosted BYOK draft leaked a provider key');
      const missingKey = await apiRaw(origin, '/api/ai/generate-plan', {
        method: 'POST',
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
            await waitForBrowserReceipt(page, actionId, 'approved');
            await waitForFirstRunStep(page, 'receipt', 'complete');
            const completedVisible = await page.evaluate(`document.body.innerText.includes('Completed Plans') && Boolean(document.querySelector('[data-completed-focus="true"]'))`);
            assert(completedVisible, 'completed receipt history was not shown after browser approval');
            snapshot = await browserWorkflowSnapshot(page);
            assert(!snapshot.activeActions.some((entry) => entry.id === actionId), 'approved browser workflow action remained active');
            assert(snapshot.completedActions.some((entry) => entry.id === actionId && entry.status === 'approved'), 'approved browser workflow action was not terminal');
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
            const bodyText = await page.evaluate(`document.body.innerText`);
            assert(browserRecurring.length === 1, `expected one browser recurring schedule, found ${browserRecurring.length}`);
            assert(recurringActions.length === 1, `expected one browser recurring occurrence, found ${recurringActions.length}`);
            assert(/does not run background schedules after this tab closes/i.test(bodyText), 'browser recurring fallback did not explain the scheduler limitation');
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
            await page.inspect(`${browserOrigin}/app`);
            await connectFakeWallet(page);
            await clickAndWait(page, '[data-bridge-action="connect"]', 'check mocked local bridge for recurring isolation');
            await page.waitFor(`Boolean(document.querySelector('[data-workflow-mode="local-bridge"]:not([disabled])')) || document.body.innerText.includes('Bridge connected')`);
            await clickAndWait(page, '[data-workflow-mode="local-bridge"]', 'use private local mode for recurring isolation');
            await clickAndWait(page, '[data-tab="schedule"]', 'private local recurring schedule tab');
            const localCount = await recurringCardCount(page);
            assert(localCount === 0, `browser recurring schedule leaked into private local mode; visible cards=${localCount}`);

            await clickAndWait(page, '[data-workflow-mode="auto"]', 'return to browser workflow mode');
            await clickAndWait(page, '[data-tab="schedule"]', 'browser recurring schedule tab');
            const browserCount = await recurringCardCount(page);
            assert(browserCount === 1, `browser recurring schedule was not restored after leaving private local mode; visible cards=${browserCount}`);
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
            await page.inspect(`${browserOrigin}/app`);
            await connectFakeWallet(page);
            await clickAndWait(page, '[data-bridge-action="connect"]', 'check mocked local bridge');
            await page.waitFor(`Boolean(document.querySelector('[data-workflow-mode="local-bridge"]:not([disabled])')) || document.body.innerText.includes('Bridge connected')`);
            await clickAndWait(page, '[data-workflow-mode="local-bridge"]', 'use private local mode');
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
  const connected = await page.evaluate(`document.body.innerText.includes('Wallet connected') || document.body.innerText.includes('Agentic Smoke Wallet')`);
  if (!connected) {
    await page.waitFor(`Boolean(document.querySelector('[data-start-action="discover"]'))`);
    await clickAndWait(page, '[data-start-action="discover"]', 'discover wallet button');
    await page.waitFor(`Array.from(document.querySelectorAll('[data-start-action="connect"]')).some((el) => !el.disabled)`);
    await clickAndWait(page, '[data-start-action="connect"]', 'connect wallet button');
    await page.waitFor(`document.body.innerText.includes('Wallet connected') || document.body.innerText.includes('Agentic Smoke Wallet')`);
  }
  if (!await page.evaluate(`Boolean(document.querySelector('#generatePlan'))`)) {
    await clickAndWait(page, '[data-tab="agent"]', 'one-time plan tab');
  }
  await ensureCreatePlanView(page);
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

async function configureBridgeStorage(page, { bridgeOrigin, bridgeToken, workflowModePreference = 'auto' }) {
  await page.evaluate(`(() => {
    const storageKey = ${JSON.stringify(DEMO_STORAGE_KEY)};
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : {};
    localStorage.setItem(storageKey, JSON.stringify({
      ...parsed,
      bridgeUrl: ${JSON.stringify(bridgeOrigin)},
      bridgeToken: ${JSON.stringify(bridgeToken)},
      workflowModePreference: ${JSON.stringify(workflowModePreference)},
    }));
  })()`);
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
  await page.waitFor(`document.body.innerText.includes('Recurring schedule created') || document.body.innerText.includes('Agentic Cloud recurring')`);
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
  await page.waitFor(`document.body.innerText.includes('Recurring schedule created')`);
}

async function recurringCardCount(page) {
  return page.evaluate(`document.querySelectorAll('.recurring-item').length`);
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
    name: 'Agentic Smoke Wallet',
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
  const register = (api) => api.register(wallet);
  window.addEventListener('wallet-standard:app-ready', (event) => register(event.detail));
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
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
      AGENTIC_MOCK_FINALIZATION: process.env.AGENTIC_MOCK_FINALIZATION ?? '1',
      HOST: '127.0.0.1',
      PORT: String(serverPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const origin = `http://127.0.0.1:${serverPort}`;
  try {
    await waitForHostedAiStatus(`${origin}/api/ai/status`);
    await callback({ origin, serverPort });
  } finally {
    await terminate(server);
    if (preload) rmSync(preload.dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
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
  throw new Error('Chrome or Chromium was not found. Set CHROME_PATH to run render smoke.');
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

async function waitForHostedAiStatus(url) {
  const deadline = Date.now() + 15_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await verifyHostedAiStatus(url);
      return;
    } catch (err) {
      lastError = err;
    }
    await sleep(200);
  }
  throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for ${url}`);
}

async function connectPage(port) {
  const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const page = pages.find((candidate) => candidate.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new Error('No Chrome page target was available.');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
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
    },
    async inspect(url) {
      events = [];
      await send('Page.navigate', { url });
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
