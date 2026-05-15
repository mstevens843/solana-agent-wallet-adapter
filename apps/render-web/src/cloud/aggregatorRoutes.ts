import type { ServerResponse } from 'node:http';

import {
  registerDevApiHandler,
  type DevApiHandler,
  type DevApiHandlerContext,
} from './devApiRegistry.js';
import { isAllowedDevWallet } from './devGate.js';
import { isAggregatorStore, type AggregatorStore } from './store.js';

const PREFIX = '/api/aggregator/';
const SKILL_PATTERN = /^\/api\/aggregator\/skills\/([a-z0-9-]+)\/?$/i;
const WALLET_PATTERN = /^\/api\/aggregator\/wallets\/([1-9A-HJ-NP-Za-km-z]{32,44})\/?$/;

const aggregatorHandler: DevApiHandler = {
  prefix: PREFIX,
  methods: ['GET'],
  publicRoute: true,
  async handle(_req, res, url, context) {
    const skillId = url.pathname.match(SKILL_PATTERN)?.[1];
    if (skillId) {
      return handleSkillStats(skillId, res, context);
    }
    const walletAddress = url.pathname.match(WALLET_PATTERN)?.[1];
    if (walletAddress) {
      return handleWalletStats(walletAddress, res, context);
    }
    writeJsonNoStore(res, 404, { error: 'not_found' });
    return true;
  },
};

async function handleSkillStats(
  skillId: string,
  res: ServerResponse,
  context: DevApiHandlerContext,
): Promise<boolean> {
  if (!isAggregatorStore(context.workflowStore)) {
    writeJsonNoStore(res, 503, { error: 'aggregator_unavailable' });
    return true;
  }
  const aggregatorStore = context.workflowStore as unknown as AggregatorStore;
  const record = await aggregatorStore.getAggregatorSnapshot(`skill:${skillId}`);
  if (!record) {
    writeJsonNoStore(res, 404, { error: 'snapshot_not_found' });
    return true;
  }
  writeJsonCached(res, 200, {
    snapshot: record.snapshot,
    computedAt: record.computedAt,
    kind: record.kind,
    key: record.key,
  });
  return true;
}

async function handleWalletStats(
  walletAddress: string,
  res: ServerResponse,
  context: DevApiHandlerContext,
): Promise<boolean> {
  if (!isAllowedDevWallet(walletAddress)) {
    writeJsonNoStore(res, 404, { error: 'not_found' });
    return true;
  }
  if (!isAggregatorStore(context.workflowStore)) {
    writeJsonNoStore(res, 503, { error: 'aggregator_unavailable' });
    return true;
  }
  const aggregatorStore = context.workflowStore as unknown as AggregatorStore;
  const record = await aggregatorStore.getAggregatorSnapshot(`wallet:${walletAddress}`);
  if (!record) {
    writeJsonNoStore(res, 404, { error: 'snapshot_not_found' });
    return true;
  }
  writeJsonCached(res, 200, {
    snapshot: record.snapshot,
    computedAt: record.computedAt,
    kind: record.kind,
    key: record.key,
  });
  return true;
}

function writeJsonCached(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'public, max-age=60');
  res.end(JSON.stringify(payload));
}

function writeJsonNoStore(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

registerDevApiHandler(aggregatorHandler);
