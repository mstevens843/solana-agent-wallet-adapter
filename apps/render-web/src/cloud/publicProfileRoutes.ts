import type { IncomingMessage, ServerResponse } from 'node:http';

import * as DevLayer1 from '@solana-agent-wallet-adapter/workflow/dev';

import { isAllowedDevWallet } from './devGate.js';
import {
  registerPublicSsrHandler,
  type PublicSsrContext,
  type PublicSsrHandler,
} from './publicSsrRegistry.js';
import {
  isAggregatorStore,
  isSkillsStore,
  type SkillInstallStoreRecord,
} from './store.js';
import { seedLaunchSkillsIfNeeded } from './launchSkillSeeder.js';

type SkillManifest = DevLayer1.skills.SkillManifest;
type SkillInstallRecord = DevLayer1.skills.SkillInstallRecord;
type SkillStatsSnapshot = DevLayer1.aggregator.SkillStatsSnapshot;
type WalletStatsSnapshot = DevLayer1.aggregator.WalletStatsSnapshot;

const CACHE_CONTROL = 'public, max-age=60';

const WALLET_PATTERN = /^\/u\/([1-9A-HJ-NP-Za-km-z]{32,44})$/;
const SKILL_PATTERN = /^\/skills\/([a-z0-9-]+)$/;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function originForRequest(req: IncomingMessage): string {
  const explicit = process.env.AGENTIC_PUBLIC_ORIGIN?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const host = String(req.headers.host || 'localhost');
  return `${proto}://${host}`;
}

function formatPercent(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

function formatInteger(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return String(Math.trunc(value));
}

function formatUsd(value: string | undefined): string {
  if (!value) return '—';
  return `$${value}`;
}

function shortenWallet(wallet: string): string {
  if (wallet.length <= 12) return wallet;
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

const SHARED_STYLE = `
:root { color-scheme: light dark; }
body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  background: #0b0c10;
  color: #e6e9ef;
  line-height: 1.5;
}
.page { max-width: 880px; margin: 0 auto; padding: 48px 24px 96px; }
h1 { font-size: 28px; margin: 0 0 8px; }
h2 { font-size: 18px; margin: 32px 0 12px; letter-spacing: 0.02em; text-transform: uppercase; color: #9aa3b2; }
.subtitle { color: #9aa3b2; margin: 0 0 32px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin: 0; padding: 0; }
.stats > div { background: #14161d; border: 1px solid #1f2330; border-radius: 12px; padding: 16px; }
.stats dt { font-size: 12px; color: #9aa3b2; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 8px; }
.stats dd { font-size: 22px; margin: 0; font-weight: 600; }
.empty { color: #9aa3b2; font-style: italic; margin: 24px 0; }
ul.skill-list { list-style: none; padding: 0; margin: 0; }
ul.skill-list li { background: #14161d; border: 1px solid #1f2330; border-radius: 12px; padding: 16px; margin-bottom: 12px; }
ul.skill-list a { color: #7aa7ff; text-decoration: none; font-weight: 600; }
ul.skill-list a:hover { text-decoration: underline; }
.meta { color: #6f7689; font-size: 13px; margin-top: 4px; }
.cta { display: inline-block; padding: 10px 18px; background: #2c66f5; color: white; border-radius: 8px; text-decoration: none; font-weight: 600; margin-top: 16px; }
.cta:hover { background: #1f54d6; }
footer { margin-top: 48px; color: #6f7689; font-size: 13px; }
footer a { color: #7aa7ff; text-decoration: none; }
`;

const NOT_FOUND_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Not found · Agentic Signer</title>
<meta name="robots" content="noindex" />
<style>${SHARED_STYLE}</style>
</head><body>
<main class="page">
<h1>Not found</h1>
<p class="subtitle">No public profile is available at this URL.</p>
<p><a href="/">Back to Agentic Signer</a></p>
</main>
</body></html>
`;

function writeHtml(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: string,
): true {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', CACHE_CONTROL);
  if (req.method === 'HEAD') {
    res.end();
  } else {
    res.end(body);
  }
  return true;
}

function notFound(req: IncomingMessage, res: ServerResponse): true {
  return writeHtml(req, res, 404, NOT_FOUND_HTML);
}

function renderWalletPage(input: {
  walletAddress: string;
  snapshot: WalletStatsSnapshot | undefined;
  installs: readonly SkillInstallRecord[];
  origin: string;
}): string {
  const { walletAddress, snapshot, installs, origin } = input;
  const safeWallet = escapeHtml(walletAddress);
  const shortWallet = escapeHtml(shortenWallet(walletAddress));
  const totalSkills = snapshot ? snapshot.totalSkillsInstalled : installs.length;
  const totalExecutions = snapshot?.totalExecutions;
  const successRateStr = formatPercent(snapshot?.successRate);
  const description = snapshot
    ? `Verified on-chain track record for ${shortenWallet(walletAddress)}: ` +
      `${formatInteger(totalSkills)} skills installed, ` +
      `${formatInteger(totalExecutions)} executions, ` +
      `${successRateStr} success rate.`
    : `Verified on-chain track record for ${shortenWallet(walletAddress)} on Agentic Signer.`;
  const canonical = `${origin}/u/${walletAddress}`;
  const installItems = installs.length
    ? `<ul class="skill-list">${installs
        .map((install) => {
          const safeId = escapeHtml(install.skillId);
          const status = escapeHtml(install.status);
          const installedAt = escapeHtml(install.installedAt);
          return `<li><a href="/skills/${safeId}">${safeId}</a><div class="meta">Status: ${status} · Installed ${installedAt}</div></li>`;
        })
        .join('')}</ul>`
    : `<p class="empty">No skills installed yet.</p>`;
  const trackRecordBlock = snapshot
    ? `<dl class="stats">
<div><dt>Skills installed</dt><dd>${escapeHtml(formatInteger(snapshot.totalSkillsInstalled))}</dd></div>
<div><dt>Executions</dt><dd>${escapeHtml(formatInteger(snapshot.totalExecutions))}</dd></div>
<div><dt>Success rate</dt><dd>${escapeHtml(successRateStr)}</dd></div>
<div><dt>Total profit</dt><dd>${escapeHtml(formatUsd(snapshot.totalProfitUsd))}</dd></div>
<div><dt>Total gas</dt><dd>${escapeHtml(formatUsd(snapshot.totalGasUsd))}</dd></div>
</dl>
<p class="meta">Computed ${escapeHtml(snapshot.computedAt)}</p>`
    : `<dl class="stats">
<div><dt>Skills installed</dt><dd>—</dd></div>
<div><dt>Executions</dt><dd>—</dd></div>
<div><dt>Success rate</dt><dd>—</dd></div>
</dl>
<p class="empty">No track record yet.</p>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${shortWallet} · track record · Agentic Signer</title>
<meta name="description" content="${escapeHtml(description)}" />
<meta name="robots" content="index,follow" />
<meta property="og:type" content="profile" />
<meta property="og:title" content="${shortWallet} · track record · Agentic Signer" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:url" content="${escapeHtml(canonical)}" />
<link rel="canonical" href="${escapeHtml(canonical)}" />
<style>${SHARED_STYLE}</style>
</head><body>
<main class="page">
<h1>${shortWallet}</h1>
<p class="subtitle">Verified on-chain track record · <code>${safeWallet}</code></p>
<h2>Track record</h2>
${trackRecordBlock}
<h2>Installed skills</h2>
${installItems}
<footer>
<p>Receipts aggregated from <a href="/">Agentic Signer</a>. Every execution is wallet-signed and cryptographically verifiable.</p>
</footer>
</main>
</body></html>
`;
}

function renderSkillPage(input: {
  manifest: SkillManifest;
  snapshot: SkillStatsSnapshot | undefined;
  origin: string;
}): string {
  const { manifest, snapshot, origin } = input;
  const safeName = escapeHtml(manifest.name);
  const safeDescription = escapeHtml(manifest.description);
  const safeId = escapeHtml(manifest.id);
  const safeCategory = escapeHtml(manifest.category);
  const safeVersion = escapeHtml(manifest.version);
  const safeAuthor = escapeHtml(manifest.authorWallet);
  const shortAuthor = escapeHtml(shortenWallet(manifest.authorWallet));
  const canonical = `${origin}/skills/${manifest.id}`;
  const installsStr = formatInteger(snapshot?.installs);
  const executionsStr = formatInteger(snapshot?.totalExecutions);
  const successStr = formatPercent(snapshot?.successRate);
  const trackRecordBlock = snapshot
    ? `<dl class="stats">
<div><dt>Installs</dt><dd>${escapeHtml(installsStr)}</dd></div>
<div><dt>Executions</dt><dd>${escapeHtml(executionsStr)}</dd></div>
<div><dt>Success rate</dt><dd>${escapeHtml(successStr)}</dd></div>
<div><dt>Median gas</dt><dd>${escapeHtml(formatUsd(snapshot.medianGasUsd))}</dd></div>
<div><dt>Median APY</dt><dd>${escapeHtml(snapshot.medianApyPercent ? `${snapshot.medianApyPercent}%` : '—')}</dd></div>
<div><dt>Max drawdown</dt><dd>${escapeHtml(snapshot.maxDrawdownPercent ? `${snapshot.maxDrawdownPercent}%` : '—')}</dd></div>
</dl>
<p class="meta">Computed ${escapeHtml(snapshot.computedAt)}${snapshot.lastExecutionAt ? ` · last execution ${escapeHtml(snapshot.lastExecutionAt)}` : ''}</p>`
    : `<dl class="stats">
<div><dt>Installs</dt><dd>—</dd></div>
<div><dt>Executions</dt><dd>—</dd></div>
<div><dt>Success rate</dt><dd>—</dd></div>
</dl>
<p class="empty">No track record yet.</p>`;
  const description = snapshot
    ? `${manifest.description} · ${installsStr} installs · ${successStr} success rate.`
    : manifest.description;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeName} · Agentic Skill</title>
<meta name="description" content="${escapeHtml(description)}" />
<meta name="robots" content="index,follow" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${safeName} · Agentic Skill" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:url" content="${escapeHtml(canonical)}" />
<link rel="canonical" href="${escapeHtml(canonical)}" />
<style>${SHARED_STYLE}</style>
</head><body>
<main class="page">
<h1>${safeName}</h1>
<p class="subtitle">${safeDescription}</p>
<dl class="stats">
<div><dt>Category</dt><dd>${safeCategory}</dd></div>
<div><dt>Version</dt><dd>${safeVersion}</dd></div>
<div><dt>Author</dt><dd><a href="/u/${safeAuthor}">${shortAuthor}</a></dd></div>
</dl>
<p><a class="cta" href="/app#skills/install/${safeId}">Install this skill</a></p>
<h2>Track record</h2>
${trackRecordBlock}
<footer>
<p>Every run requires explicit wallet approval. <a href="/">Browse all skills</a>.</p>
</footer>
</main>
</body></html>
`;
}

async function handleWalletProfileSsr(
  req: IncomingMessage,
  res: ServerResponse,
  match: RegExpMatchArray,
  ctx: PublicSsrContext,
): Promise<boolean> {
  const walletAddress = match[1];
  if (!walletAddress || !isAllowedDevWallet(walletAddress)) {
    return notFound(req, res);
  }

  let snapshot: WalletStatsSnapshot | undefined;
  if (isAggregatorStore(ctx.store)) {
    const rec = await ctx.store.getAggregatorSnapshot(`wallet:${walletAddress}`);
    if (rec && rec.kind === 'wallet') {
      snapshot = rec.snapshot as WalletStatsSnapshot;
    }
  }

  let installs: SkillInstallRecord[] = [];
  if (isSkillsStore(ctx.store)) {
    const records: SkillInstallStoreRecord[] = await ctx.store.listSkillInstallsForWallet(
      walletAddress,
    );
    installs = records.map((record) => record.install as SkillInstallRecord);
  }

  const html = renderWalletPage({
    walletAddress,
    snapshot,
    installs,
    origin: originForRequest(req),
  });
  return writeHtml(req, res, 200, html);
}

async function handleSkillProfileSsr(
  req: IncomingMessage,
  res: ServerResponse,
  match: RegExpMatchArray,
  ctx: PublicSsrContext,
): Promise<boolean> {
  const skillId = match[1];
  if (!skillId || !isSkillsStore(ctx.store)) {
    return notFound(req, res);
  }

  await seedLaunchSkillsIfNeeded(ctx.store, ctx.clock);
  const manifestRec = await ctx.store.getSkillManifest(skillId);
  if (!manifestRec) return notFound(req, res);

  const manifest = manifestRec.manifest as SkillManifest;
  if (!isAllowedDevWallet(manifest.authorWallet)) {
    return notFound(req, res);
  }

  let snapshot: SkillStatsSnapshot | undefined;
  if (isAggregatorStore(ctx.store)) {
    const rec = await ctx.store.getAggregatorSnapshot(`skill:${skillId}`);
    if (rec && rec.kind === 'skill') {
      snapshot = rec.snapshot as SkillStatsSnapshot;
    }
  }

  const html = renderSkillPage({
    manifest,
    snapshot,
    origin: originForRequest(req),
  });
  return writeHtml(req, res, 200, html);
}

const walletProfileHandler: PublicSsrHandler = {
  pattern: WALLET_PATTERN,
  handle: handleWalletProfileSsr,
};

const skillProfileHandler: PublicSsrHandler = {
  pattern: SKILL_PATTERN,
  handle: handleSkillProfileSsr,
};

registerPublicSsrHandler(walletProfileHandler);
registerPublicSsrHandler(skillProfileHandler);

export const __testing = {
  WALLET_PATTERN,
  SKILL_PATTERN,
  walletProfileHandler,
  skillProfileHandler,
  renderWalletPage,
  renderSkillPage,
  escapeHtml,
};
