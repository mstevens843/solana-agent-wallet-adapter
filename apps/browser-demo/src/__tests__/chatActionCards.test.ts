import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

function sourceBetween(start: string, end: string): string {
  const startIndex = mainSource.indexOf(start);
  const endIndex = mainSource.indexOf(end, startIndex + start.length);
  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`Source markers not found: ${start} -> ${end}`);
  }
  return mainSource.slice(startIndex, endIndex);
}

function cssBlock(selector: string): string {
  const start = stylesSource.indexOf(selector);
  const end = stylesSource.indexOf('}', start);
  if (start === -1 || end === -1) {
    throw new Error(`CSS selector not found: ${selector}`);
  }
  return stylesSource.slice(start, end + 1);
}

describe('chat wallet action cards', () => {
  it('renders swaps with estimates and a manual quote refresh control', () => {
    const hero = sourceBetween('function chatActionHeroHtml', 'function chatActionTerminalHtml');
    const bindBlock = sourceBetween('function bind(): void', 'for (const button of document.querySelectorAll<HTMLButtonElement>(\'[data-inline-receipt-kind]\')');
    expect(hero).toContain('chat-action-swap-route');
    expect(hero).toContain('chatSwapQuoteEstimateLabel(action)');
    expect(hero).toContain('chatSwapQuoteRefreshButtonHtml(action)');
    expect(mainSource).toContain('Est. {amount} {token}');
    expect(bindBlock).toContain('[data-chat-quote-refresh]');
    expect(mainSource).toContain('async function runRefreshChatSwapQuote');
  });

  it('keeps connector logos compact and next to the chat card title', () => {
    const card = sourceBetween('function chatActionCard', 'function preparedActionCard');
    expect(card).toContain('chatActionConnectorIconHtml(connectorMeta?.id, connectorMeta?.name)');
    expect(card).not.toContain('connectorChip(connectorMeta?.id, connectorMeta?.name)');
    expect(stylesSource).toContain('.chat-action-connector-icon');
    expect(stylesSource).toContain('.chat-action-connector-logo');
  });

  it('hydrates token market estimates for active chat prepared actions', () => {
    const visibleMints = sourceBetween('function visibleTokenMarketMints', 'function marketAmountSubjectForGeneratedPlan');
    expect(visibleMints).toContain("state.activeTab === 'chat'");
    expect(visibleMints).toContain('visibleChatPreparedActions().map(marketAmountSubjectForAction)');
    expect(mainSource).toContain('function visibleChatPreparedActions');
  });

  it('uses Positions and Done-specific automated follow-up copy', () => {
    const destination = sourceBetween('function chatActionDestinationLine', 'function postChatActionSuccessMessage');
    expect(destination).toContain('Track it in Positions');
    expect(destination).toContain('Solscan link is saved in Done');
    expect(destination).toContain('Position updated. Receipt saved in Done.');
    expect(destination).not.toContain('Track it in Monitor');
    expect(mainSource).toContain('Request denied. Denial receipt saved in Done.');
    expect(mainSource).toContain('Request deleted from Sign Approval and Chat.');
  });

  it('opens the chat overflow menu wide, upward, and leftward', () => {
    const menu = cssBlock('.chat-action-menu-body');
    expect(menu).toContain('bottom: calc(100% + 8px)');
    expect(menu).toContain('right: 0');
    expect(menu).toContain('min-width: min(284px, calc(100vw - 32px))');
    const buttons = cssBlock('.chat-action-menu-body button');
    expect(buttons).toContain('justify-content: flex-start');
    expect(buttons).toContain('white-space: nowrap');
  });
});
