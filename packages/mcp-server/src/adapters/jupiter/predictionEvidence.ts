import type {
  NormalizedPredictionEventSummary,
  PredictionEventsResult,
} from './predictionEvents.js';
import type {
  NormalizedOrderbook,
  NormalizedPredictionMarket,
  PredictionMarketStatus,
} from './predictionMarkets.js';
import type {
  NormalizedPredictionOrder,
  NormalizedPredictionPosition,
  NormalizedPredictionVault,
  PredictionHistoryResult,
  PredictionOrdersResult,
  PredictionPositionsResult,
} from './predictionWallet.js';

export interface PredictionEvidence {
  label: string;
  value: string;
  detail?: Record<string, unknown>;
}

export function eventsEvidence(result: PredictionEventsResult): PredictionEvidence[] {
  const total = result.total ?? result.events.length;
  return [
    {
      label: 'Jupiter Prediction events (beta)',
      value: total === 0 ? 'No events returned' : `${total} events`,
      detail: { count: result.events.length, total: result.total },
    },
    ...result.events.slice(0, 5).map(eventEvidence),
  ];
}

export function eventEvidence(event: NormalizedPredictionEventSummary): PredictionEvidence {
  return {
    label: event.title ?? event.id ?? 'Event',
    value: event.category ?? 'unknown category',
    detail: {
      id: event.id,
      provider: event.provider,
      closeAt: event.closeAt,
      volume: event.volume,
      marketCount: event.marketCount,
    },
  };
}

export function marketEvidence(market: NormalizedPredictionMarket): PredictionEvidence[] {
  return [
    {
      label: market.question ?? market.id ?? 'Market',
      value: market.status === 'open'
        ? `Open · YES ${market.yesPrice ?? 'n/a'} · NO ${market.noPrice ?? 'n/a'}`
        : `${capitalize(market.status)}${market.result ? ` · ${market.result}` : ''}`,
      detail: {
        id: market.id,
        provider: market.provider,
        rawStatus: market.rawStatus,
        closeAt: market.closeAt,
        resolveAt: market.resolveAt,
        volume: market.volume,
      },
    },
  ];
}

export function orderbookEvidence(book: NormalizedOrderbook): PredictionEvidence[] {
  return [
    {
      label: 'Jupiter Prediction orderbook (beta)',
      value: `Status ${book.status} · YES best bid ${book.yes.bestBid ?? 'n/a'} / ask ${book.yes.bestAsk ?? 'n/a'} · NO best bid ${book.no.bestBid ?? 'n/a'} / ask ${book.no.bestAsk ?? 'n/a'}`,
      detail: {
        marketId: book.marketId,
        yesDepth: book.yes.bids.length + book.yes.asks.length,
        noDepth: book.no.bids.length + book.no.asks.length,
      },
    },
  ];
}

export function ordersEvidence(result: PredictionOrdersResult): PredictionEvidence[] {
  return [
    {
      label: 'Jupiter Prediction orders (beta)',
      value: result.orders.length === 0
        ? `No orders for ${shortAddr(result.owner)}`
        : `${result.orders.length} orders for ${shortAddr(result.owner)}`,
      detail: { owner: result.owner },
    },
    ...result.orders.slice(0, 5).map(orderEvidence),
  ];
}

export function orderEvidence(order: NormalizedPredictionOrder): PredictionEvidence {
  return {
    label: order.orderId ?? order.orderPubkey ?? 'Order',
    value: `${order.side ?? '—'} · price ${order.price ?? 'n/a'} · size ${order.size ?? 'n/a'} · status ${order.status ?? 'unknown'}`,
    detail: { marketId: order.marketId, filled: order.filled, createdAt: order.createdAt },
  };
}

export function positionsEvidence(result: PredictionPositionsResult): PredictionEvidence[] {
  return [
    {
      label: 'Jupiter Prediction positions (beta)',
      value: result.positions.length === 0
        ? `No positions for ${shortAddr(result.owner)}`
        : `${result.positions.length} positions for ${shortAddr(result.owner)}`,
      detail: { owner: result.owner },
    },
    ...result.positions.slice(0, 5).map(positionEvidence),
  ];
}

export function positionEvidence(position: NormalizedPredictionPosition): PredictionEvidence {
  return {
    label: position.positionPubkey ?? position.marketId ?? 'Position',
    value: `${position.outcome ?? '—'} · shares ${position.shares ?? 'n/a'} · avg ${position.averagePrice ?? 'n/a'}${position.settled ? ' · settled' : ''}${position.claimable ? ' · claimable' : ''}`,
    detail: {
      marketId: position.marketId,
      eventId: position.eventId,
      unrealizedPnl: position.unrealizedPnl,
    },
  };
}

export function historyEvidence(result: PredictionHistoryResult): PredictionEvidence[] {
  return [
    {
      label: 'Jupiter Prediction history (beta)',
      value: result.entries.length === 0
        ? `No history for ${shortAddr(result.owner)}`
        : `${result.entries.length} entries for ${shortAddr(result.owner)}`,
      detail: { owner: result.owner },
    },
    ...result.entries.slice(0, 5).map((entry) => ({
      label: entry.kind ?? entry.txid ?? 'Entry',
      value: `${entry.side ?? '—'} · price ${entry.price ?? 'n/a'} · size ${entry.size ?? 'n/a'} · at ${entry.occurredAt ?? 'unknown'}`,
      detail: { marketId: entry.marketId, eventId: entry.eventId, txid: entry.txid },
    })),
  ];
}

export function vaultEvidence(vault: NormalizedPredictionVault): PredictionEvidence[] {
  return [
    {
      label: 'Jupiter Prediction vault (beta)',
      value: vault.balance
        ? `${vault.balance}${vault.currency ? ` ${vault.currency}` : ''}`
        : 'No vault balance reported',
      detail: { owner: vault.owner, vaultAddress: vault.vaultAddress },
    },
  ];
}

export function statusTone(status: PredictionMarketStatus): 'good' | 'warn' | 'neutral' {
  if (status === 'open') return 'good';
  if (status === 'unknown') return 'neutral';
  return 'warn';
}

function capitalize(value: string): string {
  if (value.length === 0) return value;
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}
