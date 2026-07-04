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
    // The toggle is a single on/off for the whole 2-step flow: lit while typing conditions OR armed,
    // a tap cancels (clearChatDecisionFlow), otherwise it starts step 1.
    expect(toggle).toContain('chatDecisionFlowActive()');
    expect(toggle).toContain('clearChatDecisionFlow()');
    expect(toggle).toContain('state.chatDecisionCheckActive = true');
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

describe('chat wallet-actions menu is a scrimmed popover on native mobile (not a sheet)', () => {
  it('the "+" toggle keeps the upward popover (no chat-action sheet reroute)', () => {
    const handler = sourceBetween("const plusToggle = document.querySelector<HTMLButtonElement>('[data-chat-plus-toggle]')", 'Native-mobile scrim behind the Wallet Actions popover');
    // popover toggle, not a sheet: no openChatActionSheet in the "+" handler
    expect(handler).toContain('state.chatComposerOpen = !state.chatComposerOpen');
    expect(handler).not.toContain('openChatActionSheet()');
  });

  it('renders a full-screen scrim behind the popover on native mobile + a tap-to-close binding', () => {
    // scrim is rendered as a sibling of the composer (root stacking context), native-mobile only
    expect(mainSource).toContain("chatUsesSheet() && state.chatComposerOpen ? '<div class=\"chat-plus-scrim\" data-chat-plus-close");
    // tapping the scrim closes the menu
    expect(mainSource).toContain("document.querySelector<HTMLElement>('[data-chat-plus-close]')");
    // CSS: scrim above the dock (z-index 300) + composer lifted above the scrim while open
    expect(stylesSource).toContain('.chat-plus-scrim {');
    expect(stylesSource).toContain('z-index: 300;');
    expect(stylesSource).toContain('.chat-composer-mobile:has(.chat-plus-menu.open) { z-index: 310; }');
  });
});

describe('every wallet action → structured message → Send → card (held-draft)', () => {
  it('connector Confirm stashes the resolved action + a picker-answer label instead of materializing the card', () => {
    const confirm = sourceBetween('function confirmChatConnectorAction', 'function chatRecurringConfirmText');
    expect(confirm).toContain('compileConnectorDraftToMessage(plan)');
    expect(confirm).toContain("stageChatHeldAction({ kind: 'connector'");
    // no longer pushes/promotes the card at Confirm time
    expect(confirm).not.toContain('state.preparedActions = mergePreparedActions([action], state.preparedActions)');
    expect(confirm).not.toContain('preparedActionId: action.id');
  });

  it('recurring Confirm defers createRecurringFromDraft to Send', () => {
    const confirm = sourceBetween('async function confirmChatRecurringAction', 'function chatRecurringCardHtml');
    expect(confirm).toContain('compileRecurringDraftToMessage(draft)');
    expect(confirm).toContain("stageChatHeldAction({ kind: 'recurring'");
    expect(confirm).not.toContain('await createRecurringFromDraft');
  });

  it('Send materializes the held draft, checked BEFORE decision routing and disarming on consume', () => {
    const submit = sourceBetween('async function submitChatMessage', 'const signMatch =');
    // held-draft consumption must come BEFORE the Decision-Check routing so an armed user who built
    // a connector action isn't dead-ended.
    const consumeIdx = submit.indexOf('if (await tryConsumeHeldChatAction(content))');
    const decisionIdx = submit.indexOf('if (chatDecisionCheckModeActive() && !state.chatDecisionArmed)');
    expect(consumeIdx).toBeGreaterThan(-1);
    expect(decisionIdx).toBeGreaterThan(-1);
    expect(consumeIdx).toBeLessThan(decisionIdx);
    const consume = sourceBetween('async function tryConsumeHeldChatAction', 'function confirmChatConnectorAction');
    expect(consume).toContain('content.trim() !== held.composerText.trim()');
    expect(consume).toContain('mergePreparedActions([held.preparedAction], state.preparedActions)');
    expect(consume).toContain('await createRecurringFromDraft(held.recurringDraft');
    // supersede an armed decision policy + re-check the wallet at Send.
    expect(consume).toContain('state.chatDecisionArmed = null');
    expect(consume).toContain('if (!state.address)');
  });

  it('builds a concise connector label from the card summary primitives, not a plan.fields join', () => {
    const compile = sourceBetween('function compileConnectorDraftToMessage', 'function compileRecurringDraftToMessage');
    // Reuse the approval CARD's own deduped, sub-action-scoped summary (title + amount), NOT a per-field
    // join of plan.fields — the old join repeated shared sub-action fields (Earn asset/Amount) and
    // emitted irrelevant other-branch rows (Repay/Withdraw amount), because readableParameters ignores
    // showWhen. The card primitives resolve the form + selected branch from plan.parameters.
    expect(compile).toContain('connectorActionDisplayParts(plan.actionType, plan.parameters)');
    expect(compile).toContain('connectorPlanAmountInfo(plan)?.label');
    // preview seed shows an [amount] placeholder while the amount is still blank (mirrors Swap's
    // template) — but ONLY when the form actually has an amount field (no stray [amount] on votes)
    expect(compile).toContain('opts.amountPlaceholder');
    expect(compile).toContain("segments.push('[amount]')");
    // note/memo is appended when present
    expect(compile).toContain('plan.parameters.memo');
    expect(compile).toContain('note: ${note}');
    // the old per-field id-scanning primitives are gone (the summary is already id-free + deduped)
    expect(compile).not.toContain('/mint$/i.test(label)');
    expect(compile).not.toContain('CHAT_BASE58_MINT.test(value)');
    // recurring resolves its tokens too
    const recurring = sourceBetween('function compileRecurringDraftToMessage', 'function stageChatHeldAction');
    expect(recurring).toContain('tokenDisplayLabel(draft.inputToken)');
    expect(recurring).toContain('tokenDisplayLabel(draft.token)');
  });

  it('drops the held draft when the composer diverges or is wiped', () => {
    const input = sourceBetween("bindOnce(input, 'input'", "bindOnce(input, 'keydown'");
    expect(input).toContain('state.chatHeldAction = null');
    const clear = sourceBetween('function clearChatComposerDraft', 'function');
    expect(clear).toContain('state.chatHeldAction = null');
  });
});

describe('advanced actions: live composer preview + web token picker defaults', () => {
  it('advanced connector surface seeds + live-updates a composer template like Swap', () => {
    const preview = sourceBetween('function applyChatConnectorDraftPreview', 'function applyChatTokenPickFor');
    // builds a plan from the CURRENT form state (same pipeline confirm uses) and compiles it in preview mode
    expect(preview).toContain("if (!state.chatConnectorSession?.active) return;");
    expect(preview).toContain('normalizeConnectorDraftParameters(template, readTemplateFields(template))');
    expect(preview).toContain('buildTemplatePlan(template, parameters');
    expect(preview).toContain('compileConnectorDraftToMessage(plan, { amountPlaceholder: connectorFormHasAmountInput() })');
    expect(preview).toContain('chatConnectorPreviewDraft = text');
    // seeded when the advanced surface opens
    const open = sourceBetween('function openChatActionSurface', 'function restoreChatConnectorPlannerSnapshot');
    expect(open).toContain('applyChatConnectorDraftPreview()');
    // live-updated on every field input/change + choice pick (the connector field funnel)
    const funnel = sourceBetween('const shouldRerender = syncConnectorTemplateFieldChange(fieldId);', "querySelectorAll<HTMLButtonElement>('button[data-cascading-retry]')");
    expect((funnel.match(/applyChatConnectorDraftPreview\(\)/g) || []).length).toBeGreaterThanOrEqual(3);
    // cancelling an un-confirmed preview clears the composer; Confirm releases ownership so its label survives
    const close = sourceBetween('function closeChatConnectorSurface', 'function reconcileChatConnectorSession');
    expect(close).toContain('chatDraft === chatConnectorPreviewDraft');
    expect(close).toContain('clearChatComposerDraft()');
    const stage = sourceBetween('function stageChatHeldAction', 'async function tryConsumeHeldChatAction');
    expect(stage).toContain("chatConnectorPreviewDraft = ''");
  });

  it('a fresh swap defaults the OUTPUT token to the MINT (search) pill, input stays LIST', () => {
    const handler = sourceBetween('function handleChatPowerAction', 'function syncChatTextareaFromDraft');
    // both mobile-sheet and web-popover branches set the fresh-swap output to mint search mode
    expect((handler.match(/chatTokenPickerModes\.toToken = 'mint'/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(handler).toContain("chatTokenPickerModes.fromToken = 'list'");
    // default resolver still falls back to LIST for everything else
    expect(mainSource).toContain("return chatTokenPickerModes[field] ?? 'list';");
  });

  it('web popover token field is a positioning context so the LIST dropdown opens under its trigger', () => {
    // without this the absolute .chat-sheet-token-list anchored to .chat-action-popover and top:100%
    // dropped it below the whole (overflow-y:auto) popover, where it was clipped — looked like it never opened
    expect(stylesSource).toContain('.chat-action-popover .token-choice-field { position: relative; }');
  });
});

describe('chat swap balance guard + balance refresh', () => {
  it('uses a small realistic SOL fee reserve (not the oversized 0.01) in every spend-balance guard', () => {
    expect(mainSource).toContain('const SOL_FEE_RESERVE = 0.001;');
    // all four native-SOL reserve sites go through the constant
    const balanceErr = sourceBetween('function chatAmountBalanceError', 'function parseChatWalletAction');
    expect(balanceErr).toContain('asset.mint === WSOL_MINT ? SOL_FEE_RESERVE : 0');
    const resolveAmt = sourceBetween('function resolveChatAmount', 'function chatAmountBalanceError');
    expect(resolveAmt).toContain('amount - SOL_FEE_RESERVE');
    const pct = sourceBetween('function chatPercentAmount', 'function');
    expect(pct).toContain('tokenAmount - SOL_FEE_RESERVE');
    const insufficient = sourceBetween('function insufficientBalanceError', 'function');
    expect(insufficient).toContain('asset.amount - SOL_FEE_RESERVE');
    // no bare 0.01 SOL reserve remains in these guards
    expect(balanceErr).not.toContain('? 0.01 :');
    expect(insufficient).not.toContain('- 0.01');
  });

  it('force-refreshes balances after a completed action + on every balance-surface open', () => {
    // no balance load stays on the 60s cache (force=false) — opening a surface always re-fetches
    expect(mainSource).not.toContain('startWalletBalanceFullLoad(false');
    // post-action refresh (+ delayed indexer catch-up) in the single completion funnel
    const sideEffects = sourceBetween('function applyActionCompletionSideEffects', 'function showCompletedHistoryForAction');
    expect(sideEffects).toContain('startWalletBalanceFullLoad(true, { openOverlay: false })');
    expect(sideEffects).toContain('window.setTimeout(');
  });
});

describe('Jupiter Trigger Buy/Sell/Auto-entry polish', () => {
  it('marks New Request planner fields by template and spans tall trigger fields on desktop', () => {
    expect(mainSource).toContain('class="planner-fields ${isMobileAppViewport() ? \'mobile-planner-fields\' : \'\'}" data-template-id="${escapeHtml(template.id)}"');
    expect(stylesSource).toContain('.planner-fields[data-template-id="connector-jupiter-trigger-limit-orders"]:not(.mobile-planner-fields) > .amount-control-field');
    expect(stylesSource).toContain('.planner-fields[data-template-id="connector-jupiter-trigger-limit-orders"]:not(.mobile-planner-fields) > *:has([data-template-field="memo"])');
  });

  it('resets the spend token when switching trigger tabs without clearing amount/prices/receive token', () => {
    const helper = sourceBetween('function defaultTriggerInputMintForSubAction', 'function isRecipientTemplateField');
    expect(helper).toContain("if (subAction !== 'oco-tpsl') return USDC_MINT;");
    expect(helper).toContain('owned.find((asset) => !isStablecoinMint(asset.mint))?.mint ?? owned[0]?.mint ?? WSOL_MINT');
    expect(helper).toContain('delete state.templateTokenModes.inputMint;');
    expect(helper).toContain('delete state.templateTokenSelections.inputMint;');
    expect(helper).toContain('delete state.templateFieldErrors.inputMint;');
    expect(helper).not.toContain('delete state.templateFields.outputMint');
    expect(helper).not.toContain('delete state.templateFields.amount');
    const handler = sourceBetween("querySelectorAll<HTMLButtonElement>('button[data-template-field-choice][data-template-field-value]')", "querySelectorAll<HTMLButtonElement>('button[data-cascading-retry]')");
    expect(handler).toContain('state.templateFields[fieldId] = fieldValue;');
    expect(handler).toContain('resetTriggerSpendTokenForSubAction(fieldId, fieldValue);');
  });

  it('normalizes connector params again before browser prepared actions are built from AI plans', () => {
    const prepared = sourceBetween('function browserPreparedActionFromPlan', 'async function browserPreparedBlinkActionFromPlan');
    expect(prepared).toContain('const actionPlan = planWithNormalizedBrowserActionParams(plan, sourceRecord);');
    expect(prepared).toContain('params: browserActionParams(actionPlan, kind)');
    expect(prepared).toContain('CONNECTOR_APPROVAL_ACTION_TYPES.has(plan.actionType)');
    expect(prepared).toContain('connectorActionFormByActionType(plan.actionType)?.templateId');
    expect(prepared).toContain('normalizeConnectorDraftParameters(template, plan.parameters)');
  });
});

describe('DCA is a first-class chat Advanced action (Jupiter on-chain, → Positions)', () => {
  it('registers DCA as the 3rd Advanced action — after Limit, before Borrow — matching New Request', () => {
    const list = sourceBetween('const CHAT_ADVANCED_ACTIONS', 'interface ChatResearchAction');
    expect(list).toContain("{ id: 'dca', eyebrow: 'Trading', title: 'DCA'");
    const limitIdx = list.indexOf("id: 'limit'");
    const dcaIdx = list.indexOf("id: 'dca'");
    const borrowIdx = list.indexOf("id: 'borrow'");
    expect(limitIdx).toBeGreaterThan(-1);
    expect(dcaIdx).toBeGreaterThan(limitIdx);
    expect(borrowIdx).toBeGreaterThan(dcaIdx);
  });

  it('gives DCA its own menu icon instead of the generic grid glyph', () => {
    const icon = sourceBetween('function chatActionIcon', 'function chatResearchIcon');
    expect(icon).toContain("id === 'dca'");
  });

  it('renames the Primary "Recurring / DCA" scheduler to "Recurring" so DCA lives only in Advanced', () => {
    const power = sourceBetween('const CHAT_POWER_ACTIONS', 'function predictionActionEnabled');
    expect(power).toContain("id: 'recurring', eyebrow: 'Automation', title: 'Recurring'");
    expect(power).not.toContain("title: 'Recurring / DCA'");
    // no chat surface still labels a control "Recurring / DCA"
    expect(mainSource).not.toContain("t('Recurring / DCA')");
  });

  it('resolves the DCA total-spend amount on BOTH the composer preview and the approval card', () => {
    // both amount resolvers previously omitted totalAmount → the composer never filled + the card showed "n/a"
    const planAmount = sourceBetween('function connectorPlanAmountInfo', 'function connectorPlanAmountToken');
    expect(planAmount).toContain("'totalAmount'");
    const actionAmount = sourceBetween('function connectorActionAmountInfo', 'function connectorSemanticAmountInfo');
    expect(actionAmount).toContain("{ key: 'totalAmount' }");
  });

  it('shows the DCA spend → receive route on the card', () => {
    const route = sourceBetween('function connectorActionTokenRoute', 'function connectorActionInputToken');
    expect(route).toContain("case 'jupiter_recurring_create_time_order':");
    expect(route).toContain('inputToken: connectorActionInputToken(action), outputToken: connectorActionOutputToken(action)');
  });

  it('leads the DCA card sub-line with the schedule (orders · cadence)', () => {
    const hero = sourceBetween('function chatActionHeroHtml', 'function dcaScheduleSummary');
    expect(hero).toContain("action.kind === 'jupiter_recurring_create_time_order' ? dcaScheduleSummary(action)");
    const schedule = sourceBetween('function dcaScheduleSummaryFrom', 'function chatActionTerminalHtml');
    expect(schedule).toContain("read('numberOfOrders')");
    expect(schedule).toContain('dcaCadenceLabel(');
    expect(schedule).toContain("t('daily')");
    expect(mainSource).toContain('{n} orders');
  });

  it('compiles the DCA composer/held label as a Swap-style sentence ("DCA {spend} to {to}")', () => {
    const compile = sourceBetween('function compileConnectorDraftToMessage', 'function connectorFormHasAmountInput');
    expect(compile).toContain("plan.actionType === 'jupiter_recurring_create_time_order'");
    expect(compile).toContain('compileDcaConnectorMessage(plan, opts)');
    const dca = sourceBetween('function compileDcaConnectorMessage', 'function connectorFormHasAmountInput');
    expect(dca).toContain("planParameter(plan, ['inputMint'])");
    expect(dca).toContain("planParameter(plan, ['outputMint'])");
    expect(dca).toContain("planParameter(plan, ['totalAmount'])");
    expect(dca).toContain('DCA {spend} to {to}');
  });
});

describe('DCA card parity across chat / Sign Approval / New Request', () => {
  it('gives the DCA card a clean title on every surface (no verbose/base58 connector title)', () => {
    expect(mainSource).toContain("if (action.kind === 'jupiter_recurring_create_time_order') return t('DCA order');");
    expect(mainSource).toContain("if (record.plan.actionType === 'jupiter_recurring_create_time_order') return t('DCA order');");
  });

  it('shares one reader-based schedule summary between the PreparedAction and plan cards', () => {
    expect(mainSource).toContain('function dcaScheduleSummaryFrom(read: (key: string) => string)');
    expect(mainSource).toContain('function dcaPlanScheduleSummary(plan: AgentPlan)');
    // full card hero surfaces the schedule in the connector context slot
    expect(mainSource).toContain("action.kind === 'jupiter_recurring_create_time_order' ? dcaScheduleSummary(action) : '')");
  });

  it('New Request DCA metric shows amount + resolved route + schedule (not the base58-leaking title)', () => {
    const metric = sourceBetween('function reviewPlanMetric', 'function generatedPlanReviewSummaryGrid');
    expect(metric).toContain("plan.actionType === 'jupiter_recurring_create_time_order'");
    expect(metric).toContain('dcaPlanScheduleSummary(plan)');
    expect(metric).toContain("tokenRouteDisplaySummary(");
  });

  it('New Request Route row resolves the DCA route to symbols instead of a truncated inputMint base58', () => {
    // The DCA route is resolved via tokenRouteDisplaySummary in BOTH the summary-grid routeSummary and the
    // metric — so planRecipientOrRoute (which leaks the raw inputMint) is never the DCA fallback.
    const grid = sourceBetween('function generatedPlanReviewSummaryGrid', 'function reviewPlanDetailRows');
    expect(grid).toContain("plan.actionType === 'jupiter_recurring_create_time_order'");
    expect(grid).toContain("tokenRouteDisplaySummary(planParameter(plan, ['inputMint']) || 'input', planParameter(plan, ['outputMint']) || 'output')");
  });

  it('discloses the automation model on the DCA create form (both surfaces)', () => {
    expect(mainSource).toContain('function dcaAutomationNoteHtml(): string');
    expect((mainSource.match(/\$\{dcaAutomationNoteHtml\(\)\}/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('DCA lifecycle: per-fill + completion Done receipts + live poll', () => {
  it('reconciles observed Jupiter-automation fills into Done receipts (deduped, persisted)', () => {
    const rec = sourceBetween('function reconcileDcaLifecycle', 'function parseLendRows');
    expect(rec).toContain('Array.isArray(o.fills)');
    expect(rec).toContain('browser-dca-fill-');
    expect(rec).toContain('explorerUrl(txId, state.cluster)');
    // idempotent: skip fills already recorded, merge dedupes by actionId, and persist
    expect(rec).toContain('if (seen.has(id)) continue');
    expect(rec).toContain('mergeActionReceipts(additions, state.receipts)');
    expect(rec).toContain('saveBrowserWorkflowState()');
  });

  it('posts a completion record once an order fills all its cycles', () => {
    const rec = sourceBetween('function reconcileDcaLifecycle', 'function parseLendRows');
    expect(rec).toContain('browser-dca-complete-');
    expect(rec).toContain('executed >= total || recordedFills >= total');
    expect(rec).toContain('DCA complete');
  });

  it('runs the reconciliation on every recurring-orders read', () => {
    const fetchOrders = sourceBetween('if (section === \'orders\')', "} else if (section === 'lending')");
    expect(fetchOrders).toContain('reconcileDcaLifecycle(rec)');
  });

  it('polls active DCA orders so progress + fills advance live, and self-clears when none remain', () => {
    const poll = sourceBetween('function ensureDcaPollInterval', 'function clearDcaPollInterval');
    expect(poll).toContain('hasActiveDcaPosition()');
    expect(poll).toContain("fetchPositionCategory('orders', true)");
    expect(mainSource).toContain("(state.positionsLive.orders?.rows ?? []).some((row) => row.kind === 'dca')");
    // wired into the positions fetch
    expect(mainSource).toContain('ensureDcaPollInterval();');
  });

  it('retires a completed DCA seed on a clean empty read so it cannot resurface on a later fetch error', () => {
    expect(mainSource).toContain('if (!partial) expireStaleSeededForSection(section, cluster);');
    expect(mainSource).not.toContain('if (rows.length > 0) expireStaleSeededForSection(section, cluster);');
  });
});
