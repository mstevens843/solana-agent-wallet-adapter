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

describe('chat decision planner surface', () => {
  it('renders the mobile decision button independently from the research button', () => {
    const strip = sourceBetween('function chatMobileToolStripHtml', 'function chatEmptyState');
    expect(strip).toContain("if (!chatUsesSheet()) return ''");
    expect(strip).toContain("const researchButton = chatResearchButtonHtml('mobile')");
    expect(strip).toContain("const decisionButton = decisionCheckVisible() ? chatDecisionButtonHtml('mobile') : ''");
    expect(strip).toContain("if (!researchButton && !pending && !decisionButton) return ''");
    expect(strip).toContain('chat-mobile-tool-strip--decision-only');
    expect(strip).not.toContain("if (!chatUsesSheet() || !researchTabsVisible()) return ''");
  });

  it('keeps decision mode as a reversible overlay instead of clearing wallet action builder state', () => {
    const toggle = sourceBetween("for (const button of document.querySelectorAll<HTMLButtonElement>('[data-chat-decision-toggle]'))", "for (const button of document.querySelectorAll<HTMLButtonElement>('[data-chat-research-tab]'))");
    expect(toggle).toContain('state.chatDecisionCheckActive = !state.chatDecisionCheckActive');
    expect(toggle).toContain('closeChatActionSheet()');
    expect(toggle).not.toContain('resetChatActionBuilder()');
  });

  it('exposes an active/inactive decision planner button on web and mobile', () => {
    const button = sourceBetween('function chatDecisionButtonHtml', 'function chatComposerHtml');
    expect(button).toContain("if (!decisionCheckVisible()) return ''");
    expect(button).toContain("surface === 'mobile' ? t('Decision') : t('Decision Check')");
    expect(button).toContain('aria-pressed="${active ? \'true\' : \'false\'}"');
    expect(button).toContain("title = t('Agent Decision Planner')");
    expect(stylesSource).toContain('.chat-decision-trigger-wrap.active .chat-decision-trigger');
    expect(stylesSource).toContain('.chat-mobile-tool-strip .chat-decision-trigger-wrap.active .chat-decision-trigger');
  });

  it('preserves rich decision review evidence when chat history is normalized', () => {
    const parser = sourceBetween('function parseAgentPlanReviewState', 'function parseAgentReviewChecks');
    expect(parser).toContain('parseAgentEvidenceRequirements(value.evidenceRequirements)');
    expect(parser).toContain('parseAgentEvidenceFacts(value.evidenceFacts)');
    expect(parser).toContain('parseAgentEvidenceGateResult(value.evidenceGate)');
    expect(parser).toContain('parseAgentDecisionContract(value.decisionContract)');
    expect(parser).toContain('parseAgentDecisionAuditReceipt(value.auditReceipt)');
    expect(parser).toContain('decisionViolations');
  });

  it('guards decision mode behind the staged hide flag in render and submit paths', () => {
    expect(mainSource).toContain('const HIDE_DECISION_CHECK = /^(true|1)$/i.test');
    expect(mainSource).toContain('function decisionCheckVisible()');
    expect(mainSource).toContain('function chatDecisionCheckModeActive()');
    expect(mainSource).toContain('!chatUsesSheet() && decisionCheckVisible() ? chatDecisionButtonHtml');
    expect(mainSource).toContain('if (chatDecisionCheckModeActive())');
  });

  it('renders a chat-native verdict card with pass/fail reasons and collapsed evidence', () => {
    const card = sourceBetween('function chatDecisionCheckCardHtml', 'function chatResearchToneClass');
    expect(card).toContain('Agent Decision Planner');
    expect(card).toContain('chat-decision-verdict-pill');
    expect(card).toContain('Pass/fail reasons');
    expect(card).toContain('chatDecisionReasonRows');
    expect(card).toContain('chatDecisionEvidenceDetailsHtml');
    expect(stylesSource).toContain('.chat-decision-reason-row');
    expect(stylesSource).toContain('.chat-decision-evidence-details');
  });
});
