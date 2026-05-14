import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import type { AgentWalletConfig } from '../../config.js';

import {
  jupiterFetchJson,
  redactJupiterSecrets,
  type JupiterProduct,
} from './client.js';
import { assertPredictionEnabled } from './predictionClient.js';
import { assertJupiterTokenPriceEnabled } from './tokenClient.js';

export const JUPITER_DOCS_INDEX_URL = 'https://developers.jup.ag/docs/llms.txt';

export type JupiterEndpointRisk =
  | 'review_evidence'
  | 'existing_tool'
  | 'approval_only'
  | 'unavailable';

export interface JupiterEndpointCatalogEntry {
  provider: 'jupiter';
  endpointId: string;
  product: JupiterProduct | 'ultra' | 'lock';
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  pathTemplate: string;
  risk: JupiterEndpointRisk;
  requiredPathParams?: string[];
  allowedQueryParams?: string[];
  allowedBodyParams?: string[];
  sourceUrl: string;
  description: string;
  existingTool?: string;
  reason?: string;
}

export interface JupiterReviewEndpointReadInput {
  endpointId: string;
  pathParams?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, string | number | boolean | undefined>;
}

export const JUPITER_ENDPOINT_CATALOG: JupiterEndpointCatalogEntry[] = [
  existing('swap.order', 'swap', 'GET', '/order', 'solana_jupiter_order_preview', 'Swap API V2 Meta-Aggregator order preview; use the existing normalized tool so transaction bytes stay out of generic evidence.', ['inputMint', 'outputMint', 'amount', 'taker', 'slippageBps']),
  approvalOnly('swap.build', 'swap', 'GET', '/build', 'Router build returns raw instructions for transaction assembly, so it is not exposed through review evidence.', ['inputMint', 'outputMint', 'amount', 'taker', 'slippageBps', 'tipAmount', 'mode', 'maxAccounts']),
  approvalOnly('swap.execute', 'swap', 'POST', '/execute', 'Executes a signed /order transaction and remains in the existing approval flow.'),
  approvalOnly('transaction.submit', 'transaction', 'POST', '/submit', 'Submits signed transactions through Jupiter landing infrastructure; never callable from Ask/Check evidence.'),
  read('tokens.search', 'tokens', '/search', 'Search Jupiter Token API V2 metadata.', [], ['query', 'limit']),
  read('tokens.tag', 'tokens', '/tag', 'Read tokens by Jupiter tag.', [], ['query', 'limit']),
  read('tokens.category', 'tokens', '/{category}/{interval}', 'Read Token API V2 categories such as top trending.', ['category', 'interval'], ['limit']),
  read('tokens.recent', 'tokens', '/recent', 'Read recently created liquidity-pool tokens.', [], ['limit']),
  approvalOnly('tokens.express_verification_craft_tx', 'tokens', 'POST', '/verify/express/craft-txn', 'Builds Express Verification transaction bytes; not review evidence.'),
  read('price.mints', 'price', '', 'Read Jupiter Price API V3 USD prices.', [], ['ids']),
  existing('lend.earn_tokens', 'lend', 'GET', '/earn/tokens', 'solana_jupiter_lend_earn_tokens', 'Jupiter Lend Earn markets; use the existing normalized read.'),
  existing('lend.earn_positions', 'lend', 'GET', '/earn/positions', 'solana_jupiter_lend_earn_positions', 'Jupiter Lend Earn wallet positions; use the existing normalized read.', [], ['walletAddress', 'assetMint']),
  existing('lend.borrow_vaults', 'lend', 'GET', '/borrow/vaults', 'solana_jupiter_lend_borrow_vaults', 'Jupiter Borrow vaults; use the existing normalized read.'),
  existing('lend.borrow_positions', 'lend', 'GET', '/borrow/positions', 'solana_jupiter_lend_borrow_positions', 'Jupiter Borrow wallet positions; use the existing normalized read.', [], ['walletAddress', 'vaultId', 'positionId']),
  existing('trigger.auth_status', 'trigger', 'GET', '/auth/status', 'solana_jupiter_trigger_auth_status', 'Trigger auth state uses wallet-scoped volatile JWT handling; use the existing tool.'),
  existing('trigger.vault', 'trigger', 'GET', '/vault', 'solana_jupiter_trigger_vault', 'Trigger vault reads use wallet-scoped auth; use the existing tool.'),
  existing('trigger.orders', 'trigger', 'GET', '/orders/history', 'solana_jupiter_trigger_orders', 'Trigger order reads use wallet-scoped auth; use the existing tool.', [], ['state', 'limit', 'offset']),
  approvalOnly('trigger.deposit_craft', 'trigger', 'POST', '/deposit/craft', 'Builds Trigger deposit transaction bytes; not review evidence.'),
  approvalOnly('trigger.create_order', 'trigger', 'POST', '/orders/price', 'Creates a Trigger order after wallet approval; not review evidence.'),
  approvalOnly('trigger.update_order', 'trigger', 'PATCH', '/orders/price/{orderId}', 'Updates a Trigger order and belongs in a prepared approval flow.', ['orderId']),
  approvalOnly('trigger.cancel_order', 'trigger', 'POST', '/orders/price/cancel/{orderId}', 'Builds cancel/withdraw transaction bytes; not review evidence.', ['orderId']),
  existing('recurring.orders', 'recurring', 'GET', '/getRecurringOrders', 'solana_jupiter_recurring_orders', 'Recurring order reads use the existing normalized tool.', [], ['user', 'orderStatus', 'recurringType', 'page', 'inputMint', 'outputMint', 'includeFailedTx']),
  existing('recurring.quote', 'recurring', 'GET', '/quote', 'solana_jupiter_recurring_quote', 'Recurring quote reads use the existing normalized tool.'),
  approvalOnly('recurring.create_order', 'recurring', 'POST', '/createOrder', 'Builds DCA setup transaction bytes; not generic review evidence.'),
  approvalOnly('recurring.cancel_order', 'recurring', 'POST', '/cancelOrder', 'Builds DCA cancel transaction bytes; not generic review evidence.'),
  read('prediction.events', 'prediction', '/events', 'List prediction events.', [], ['provider', 'includeMarkets', 'category', 'sortBy', 'sortDirection', 'filter', 'start', 'end']),
  read('prediction.search_events', 'prediction', '/events/search', 'Search prediction events.', [], ['query', 'provider', 'limit']),
  read('prediction.event_detail', 'prediction', '/events/{eventId}', 'Read prediction event detail.', ['eventId'], ['includeMarkets']),
  read('prediction.event_markets', 'prediction', '/events/{eventId}/markets', 'Read markets attached to an event.', ['eventId']),
  read('prediction.market_detail', 'prediction', '/markets/{marketId}', 'Read prediction market detail.', ['marketId']),
  read('prediction.orderbook', 'prediction', '/markets/{marketId}/orderbook', 'Read prediction market orderbook.', ['marketId']),
  read('prediction.orders', 'prediction', '/orders', 'Read prediction orders for an owner or market.', [], ['owner', 'marketId', 'status']),
  read('prediction.order_status', 'prediction', '/orders/{orderId}', 'Read a prediction order status.', ['orderId'], ['owner']),
  read('prediction.positions', 'prediction', '/positions', 'Read prediction positions.', [], ['owner', 'marketId', 'eventId']),
  read('prediction.history', 'prediction', '/history', 'Read prediction trading history.', [], ['owner', 'marketId', 'eventId', 'limit']),
  read('prediction.vault', 'prediction', '/vault', 'Read prediction vault information.', [], ['owner']),
  read('prediction.trading_status', 'prediction', '/status', 'Read current prediction trading status.'),
  approvalOnly('prediction.create_order', 'prediction', 'POST', '/orders', 'Creates unsigned prediction order transactions and is not Check evidence.'),
  approvalOnly('prediction.close_position', 'prediction', 'DELETE', '/positions/{positionPubkey}', 'Builds close-position transaction bytes; not Check evidence.', ['positionPubkey']),
  approvalOnly('prediction.claim_position', 'prediction', 'POST', '/positions/{positionPubkey}/claim', 'Builds payout-claim transaction bytes; not Check evidence.', ['positionPubkey']),
  read('portfolio.positions', 'portfolio', '/positions/{address}', 'Read Jupiter Portfolio positions for a wallet.', ['address'], ['platforms']),
  read('portfolio.staked_jup', 'portfolio', '/staked-jup/{address}', 'Read staked JUP information for a wallet.', ['address']),
  read('portfolio.platforms', 'portfolio', '/platforms', 'Read portfolio platform metadata.'),
  read('send.pending_invites', 'send', '/pending-invites', 'Read pending Jupiter Send invites.', [], ['address', 'wallet', 'sender', 'recipient']),
  read('send.invite_history', 'send', '/invite-history', 'Read Jupiter Send invite history.', [], ['address', 'wallet', 'sender', 'recipient', 'limit']),
  approvalOnly('send.craft_send', 'send', 'POST', '/craft-send', 'Builds unsigned Send transactions and stays out of Ask/Check evidence.'),
  approvalOnly('send.craft_clawback', 'send', 'POST', '/craft-clawback', 'Builds unsigned clawback transactions and stays out of Ask/Check evidence.'),
  read('studio.dbc_pool_addresses', 'studio', '/dbc-pool/addresses/{mint}', 'Read Dynamic Bonding Curve pool addresses for a mint.', ['mint']),
  {
    provider: 'jupiter',
    endpointId: 'studio.dbc_fee',
    product: 'studio',
    method: 'POST',
    pathTemplate: '/dbc/fee',
    risk: 'review_evidence',
    allowedBodyParams: ['poolAddress'],
    sourceUrl: 'https://developers.jup.ag/docs/studio/claim-fee',
    description: 'Read unclaimed DBC creator fee information for a pool.',
  },
  approvalOnly('studio.dbc_pool_create_tx', 'studio', 'POST', '/dbc-pool/create-tx', 'Builds token-launch transaction bytes; not Ask/Check evidence.'),
  approvalOnly('studio.dbc_pool_submit', 'studio', 'POST', '/dbc-pool/submit', 'Submits signed Studio transactions and optional media; not Ask/Check evidence.'),
  approvalOnly('studio.dbc_fee_create_tx', 'studio', 'POST', '/dbc/fee/create-tx', 'Builds fee-claim transaction bytes; not Ask/Check evidence.'),
  existing('perps.status', 'perps', 'GET', '/status', 'solana_jupiter_perps_status', 'Perps API docs are work in progress; use the docs-backed status read.'),
  unavailable('perps.accounts', 'perps', 'GET', '/accounts', 'Perps official REST API is not stable enough for generic account reads.'),
  unavailable('lock.vesting', 'lock', 'GET', '/lock', 'Jupiter Lock docs are program-oriented and no stable review endpoint is exposed here.'),
  unavailable('ultra.order', 'ultra', 'GET', '/order', 'Ultra is superseded by Swap API V2 /order for this app; use solana_jupiter_order_preview.'),
];

export function listJupiterEndpointCatalog(): Record<string, unknown> {
  return {
    provider: 'jupiter',
    docs: JUPITER_DOCS_INDEX_URL,
    boundary: 'review_evidence_only',
    endpoints: JUPITER_ENDPOINT_CATALOG,
  };
}

export async function requestJupiterReviewEndpoint(
  config: AgentWalletConfig,
  input: JupiterReviewEndpointReadInput,
): Promise<Record<string, unknown>> {
  const entry = jupiterEndpointById(input.endpointId);
  if (entry.risk !== 'review_evidence') {
    throw new ProtocolError(
      'unsupported_method',
      `Jupiter endpoint ${entry.endpointId} is cataloged as ${entry.risk}; use ${entry.existingTool ?? 'the existing approval/check flow'} instead.`,
    );
  }
  if (!isFetchableProduct(entry.product)) {
    throw new ProtocolError('unsupported_method', `Jupiter product ${entry.product} is not fetchable as review evidence.`);
  }
  const method = entry.method;
  if (method !== 'GET' && method !== 'POST') {
    throw new ProtocolError('unsupported_method', `Jupiter endpoint ${entry.endpointId} method ${method} is not exposed for review evidence.`);
  }
  if (entry.product === 'tokens' || entry.product === 'price') {
    assertJupiterTokenPriceEnabled(config);
  }
  if (entry.product === 'prediction') {
    assertPredictionEnabled(config);
  }
  const path = fillPathTemplate(entry, input.pathParams ?? {});
  const query = validatedParams(entry, 'query', input.query ?? {});
  const body = method === 'POST'
    ? validatedParams(entry, 'body', input.body ?? {})
    : undefined;
  if (method === 'GET' && input.body && Object.keys(input.body).length > 0) {
    throw new ProtocolError('invalid_request', `Jupiter endpoint ${entry.endpointId} is GET and does not accept a body.`);
  }
  const data = await jupiterFetchJson(config, entry.product, path, {
    method,
    searchParams: query,
    ...(body && Object.keys(body).length ? { body } : {}),
  });
  return {
    provider: 'jupiter',
    endpointId: entry.endpointId,
    product: entry.product,
    checkedAt: new Date().toISOString(),
    source: entry.sourceUrl,
    data: redactJupiterSecrets(data),
  };
}

function read(
  endpointId: string,
  product: JupiterProduct,
  pathTemplate: string,
  description: string,
  requiredPathParams: string[] = [],
  allowedQueryParams: string[] = [],
): JupiterEndpointCatalogEntry {
  return {
    provider: 'jupiter',
    endpointId,
    product,
    method: 'GET',
    pathTemplate,
    risk: 'review_evidence',
    ...(requiredPathParams.length ? { requiredPathParams } : {}),
    ...(allowedQueryParams.length ? { allowedQueryParams } : {}),
    sourceUrl: JUPITER_DOCS_INDEX_URL,
    description,
  };
}

function existing(
  endpointId: string,
  product: JupiterProduct,
  method: JupiterEndpointCatalogEntry['method'],
  pathTemplate: string,
  existingTool: string,
  description: string,
  requiredPathParams: string[] = [],
  allowedQueryParams: string[] = [],
): JupiterEndpointCatalogEntry {
  return {
    provider: 'jupiter',
    endpointId,
    product,
    method,
    pathTemplate,
    risk: 'existing_tool',
    existingTool,
    ...(requiredPathParams.length ? { requiredPathParams } : {}),
    ...(allowedQueryParams.length ? { allowedQueryParams } : {}),
    sourceUrl: JUPITER_DOCS_INDEX_URL,
    description,
  };
}

function approvalOnly(
  endpointId: string,
  product: JupiterEndpointCatalogEntry['product'],
  method: JupiterEndpointCatalogEntry['method'],
  pathTemplate: string,
  reason: string,
  requiredPathParams: string[] = [],
  allowedQueryParams: string[] = [],
): JupiterEndpointCatalogEntry {
  return {
    provider: 'jupiter',
    endpointId,
    product,
    method,
    pathTemplate,
    risk: 'approval_only',
    reason,
    ...(requiredPathParams.length ? { requiredPathParams } : {}),
    ...(allowedQueryParams.length ? { allowedQueryParams } : {}),
    sourceUrl: JUPITER_DOCS_INDEX_URL,
    description: reason,
  };
}

function unavailable(
  endpointId: string,
  product: JupiterEndpointCatalogEntry['product'],
  method: JupiterEndpointCatalogEntry['method'],
  pathTemplate: string,
  reason: string,
): JupiterEndpointCatalogEntry {
  return {
    provider: 'jupiter',
    endpointId,
    product,
    method,
    pathTemplate,
    risk: 'unavailable',
    reason,
    sourceUrl: JUPITER_DOCS_INDEX_URL,
    description: reason,
  };
}

function jupiterEndpointById(endpointId: string): JupiterEndpointCatalogEntry {
  const entry = JUPITER_ENDPOINT_CATALOG.find((candidate) => candidate.endpointId === endpointId);
  if (!entry) {
    throw new ProtocolError('invalid_request', `Unknown Jupiter endpointId ${endpointId}.`);
  }
  return entry;
}

function fillPathTemplate(entry: JupiterEndpointCatalogEntry, pathParams: Record<string, string | number>): string {
  let path = entry.pathTemplate;
  for (const param of entry.requiredPathParams ?? []) {
    const value = pathParams[param];
    if (value === undefined || String(value).trim() === '') {
      throw new ProtocolError('invalid_request', `Jupiter endpoint ${entry.endpointId} requires pathParams.${param}.`);
    }
    path = path.replace(`{${param}}`, encodeURIComponent(String(value).trim()));
  }
  const unresolved = path.match(/\{[^}]+\}/);
  if (unresolved) {
    throw new ProtocolError('invalid_request', `Jupiter endpoint ${entry.endpointId} is missing ${unresolved[0]}.`);
  }
  return path;
}

function validatedParams(
  entry: JupiterEndpointCatalogEntry,
  kind: 'query' | 'body',
  params: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean | undefined> {
  const allowedList = kind === 'query' ? entry.allowedQueryParams : entry.allowedBodyParams;
  const allowed = new Set(allowedList ?? []);
  if (!allowed.size) {
    const unexpected = Object.keys(params).filter((key) => params[key] !== undefined);
    if (unexpected.length) {
      throw new ProtocolError('invalid_request', `Jupiter endpoint ${entry.endpointId} does not accept ${kind} params: ${unexpected.join(', ')}.`);
    }
    return {};
  }
  const out: Record<string, string | number | boolean | undefined> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (!allowed.has(key)) {
      throw new ProtocolError('invalid_request', `Jupiter endpoint ${entry.endpointId} does not allow ${kind} param ${key}.`);
    }
    out[key] = value;
  }
  return out;
}

function isFetchableProduct(product: JupiterEndpointCatalogEntry['product']): product is JupiterProduct {
  return product !== 'ultra' && product !== 'lock';
}
