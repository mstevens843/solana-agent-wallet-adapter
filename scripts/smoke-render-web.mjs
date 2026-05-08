#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

import { publicAppRoutes } from './public-routes.mjs';

const routes = publicAppRoutes;
const serverPort = await freePort();
const chromePort = await freePort();
const chromePath = resolveChromePath();
const userDataDir = mkdtempSync(join(tmpdir(), 'agentic-render-smoke-chrome-'));
const server = spawn(process.execPath, ['apps/render-web/dist/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(serverPort),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let chrome;

try {
  await waitForHttp(`http://127.0.0.1:${serverPort}/api/ai/status`);
  chrome = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--disable-gpu',
    'about:blank',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await waitForHttp(`http://127.0.0.1:${chromePort}/json/list`);
  const page = await connectPage(chromePort);

  for (const route of routes) {
    const result = await page.inspect(`http://127.0.0.1:${serverPort}${route}`);
    const exception = result.events.find((event) => event.method === 'Runtime.exceptionThrown');
    if (exception) {
      throw new Error(`Browser runtime error on ${route}: ${eventSummary(exception)}`);
    }
    if (result.page.startupFailure) {
      throw new Error(`Startup failure panel rendered on ${route}: ${result.page.appText}`);
    }
    if (!result.page.appText.trim() && result.page.appHtmlLength < 80) {
      throw new Error(`App root stayed empty on ${route}.`);
    }
    console.log(`[smoke-render-web] ${route} rendered ${result.page.appHtmlLength} HTML byte(s).`);
  }

  page.close();
} finally {
  await terminate(chrome);
  await terminate(server);
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
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
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        if (!address || typeof address === 'string') {
          reject(new Error('Unable to allocate a TCP port.'));
          return;
        }
        resolve(address.port);
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
    if (message.method === 'Runtime.exceptionThrown' || message.method === 'Log.entryAdded') {
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

  const send = (method, params = {}) => new Promise((resolve) => {
    const callId = ++id;
    pending.set(callId, resolve);
    ws.send(JSON.stringify({ id: callId, method, params }));
  });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  return {
    async inspect(url) {
      events = [];
      await send('Page.navigate', { url });
      await sleep(1_000);
      const expression = `(${async function inspectApp() {
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
      }.toString()})()`;
      const inspected = await send('Runtime.evaluate', {
        awaitPromise: true,
        expression,
        returnByValue: true,
      });
      return {
        events: [...events],
        page: inspected.result.result.value,
      };
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
  return event.params?.entry?.text ?? 'browser log error';
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
