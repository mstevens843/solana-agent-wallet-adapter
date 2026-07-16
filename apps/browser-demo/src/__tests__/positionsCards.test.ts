import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

const CATALOG_LANGS = ['en', 'zh-Hans', 'zh-Hant', 'es', 'ja', 'de', 'it', 'fr', 'pt', 'ko', 'ru'];
function catalog(lang: string): Record<string, string> {
  return JSON.parse(readFileSync(new URL(`../demo-i18n/catalog/${lang}.json`, import.meta.url), 'utf8')).entries;
}

function sourceBetween(start: string, end: string): string {
  const startIndex = mainSource.indexOf(start);
  const endIndex = mainSource.indexOf(end, startIndex + start.length);
  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`Source markers not found: ${start} -> ${end}`);
  }
  return mainSource.slice(startIndex, endIndex);
}

describe('positions cards redesign', () => {
  it('seeded card drops the raw summary + New action / Move to Done for a clean chat-style card', () => {
    const card = sourceBetween('function positionCard(p: PositionRecord): string', 'function positionsSectionTitle');
    // The garbage-summary render and the wrong buttons are gone.
    expect(card).not.toContain('p.summary');
    expect(card).not.toContain("data-position-manage");
    expect(card).not.toContain("data-position-close");
    expect(card).not.toContain("t('New action')");
    expect(card).not.toContain("t('Move to Done')");
    // Reuses the chat approval-card building blocks (title + connector logo + token-logo hero).
    expect(card).toContain('preparedActionCardTitle(action)');
    expect(card).toContain('chatActionConnectorIconHtml(connectorMeta?.id, connectorMeta?.name)');
    expect(card).toContain('positions-title--bold');
    expect(card).toContain('positions-hero');
    // The per-type manage action routes through the shared [data-position-cancel] → openManageForm handler.
    expect(card).toContain('data-position-cancel=');
    expect(card).toContain('positionSeedManage(p)');
  });

  it('the dead position-manage / position-close click handlers are removed', () => {
    expect(mainSource).not.toContain("querySelectorAll<HTMLButtonElement>('[data-position-manage]')");
    expect(mainSource).not.toContain("querySelectorAll<HTMLButtonElement>('[data-position-close]')");
  });

  it('maps every stateful category to its per-type manage action + label', () => {
    const map = sourceBetween('function positionSeedManage', 'function positionCard(p: PositionRecord): string');
    expect(map).toContain("kind: 'jupiter_lend_earn_withdraw'");
    expect(map).toContain("label: t('Withdraw')");
    expect(map).toContain("kind: 'jupiter_lend_borrow_repay'");
    expect(map).toContain("label: t('Repay')");
    expect(map).toContain("label: t('Unstake')");
    expect(map).toContain("label: t('Remove')");
    expect(map).toContain("kind: 'jupiter_trigger_cancel_order'");
    expect(map).toContain("kind: 'jupiter_recurring_cancel_order'");
    expect(map).toContain("label: t('Cancel')");
  });

  it('live card gains a bold title, connector logo badge and inline token logo', () => {
    const card = sourceBetween('function positionLiveCard(row: PositionLiveRow): string', 'const MANAGE_ID_FIELD_BY_KIND');
    expect(card).toContain('chatActionConnectorIconHtml(row.connectorId');
    expect(card).toContain('positions-title--bold');
    expect(card).toContain('row.heroMint ? tokenLogoChipHtml(row.heroMint)');
    expect(card).toContain('positions-headline-row');
    // Per-type labels for the primary manage button remain.
    expect(card).toContain("row.kind === 'lend' ? t('Withdraw')");
  });

  it('the lend parser supplies the headline mint so the SOL logo shows on the hero', () => {
    const parser = sourceBetween('function parseLendRows', 'function parseBorrowRows');
    expect(parser).toContain('heroMint: assetMint || sym');
  });
});

describe('positions selector: All default + mobile dropdown', () => {
  it("defaults the Positions filter to 'all'", () => {
    expect(mainSource).toContain("positionsCategory: 'all',");
    expect(mainSource).toContain("state.positionsCategory = 'all';");
    expect(mainSource).toContain("type PositionsFilterId = PositionSectionId | 'all'");
  });

  it('renders a WebView-safe dropdown on mobile and pills (incl. an All pill) on desktop', () => {
    const selector = sourceBetween('function positionsSelector(open: PositionRecord[], mobile: boolean)', 'function positionsEmpty');
    expect(selector).toContain('if (mobile) {');
    expect(selector).toContain('selectPicker({');
    expect(selector).toContain("'data-positions-section-select': true");
    expect(selector).toContain("value: 'all'");
    expect(selector).toContain('data-positions-tab="all"');
    // The mobile <select> change handler drives state + re-render.
    expect(mainSource).toContain("querySelectorAll<HTMLSelectElement>('select[data-positions-section-select]')");
  });

  it("aggregates every section under the All view and uses '{n} open' for its state line", () => {
    const panel = sourceBetween('function positionsPanel(): string', 'const REQUIRED_MORE_SURFACES');
    expect(panel).toContain('const isAll = filter === \'all\';');
    expect(panel).toContain('renderPositionsSection(s.id, open, { showRefresh: false })');
    expect(panel).toContain('positions-group');
    expect(panel).toContain("tf('{n} open', { n: positionsAllCount(open) })");
    expect(panel).toContain("positionsRefreshButton('all', positionsAllAggregateEntry())");
    // The All Refresh button re-fetches every section.
    expect(mainSource).toContain("if (id === 'all') {");
  });
});

describe('positions live-read gating (no false Sign in)', () => {
  it('never renders a Sign-in wall in the Positions section body', () => {
    const section = sourceBetween('function renderPositionsSection', 'function positionsAllAggregateEntry');
    expect(section).not.toContain("data-cloud-action=\"sign-in\"");
    expect(section).not.toContain("t('Sign in')");
    expect(section).toContain("Couldn't reach live data right now");
  });

  it('connectorRead falls back to the public read-facts endpoint', () => {
    const fn = sourceBetween('async function connectorRead(', 'function posArray(');
    expect(fn).toContain("cloudRequest<Record<string, unknown>>('/api/connector/read-facts'");
    expect(fn).not.toContain('return null; // not signed in / no bridge');
  });
});

describe('positions lifecycle: partial withdraw + auto-Done', () => {
  it('manage actions record a settle intent instead of hard-closing the position', () => {
    expect(mainSource).toContain('function markManagePendingForAction');
    expect(mainSource).not.toContain('function closePositionsForManageAction');
    const mark = sourceBetween('function markManagePendingForAction', 'function positionIsSettling');
    expect(mark).toContain("phase: 'pending',");
    expect(mark).toContain('settleDeadlineAt: new Date(Date.now() + POSITION_SETTLE_MS).toISOString(),');
    expect(mark).not.toContain("match.status = 'closed'");
    // Targeting is wallet-scoped (reconcile REQUIRES it) and asset-discriminated, so withdrawing one
    // Jupiter lend asset can't mark another's card.
    expect(mark).toContain('p.walletAddress === action.walletAddress');
    expect(mark).toContain('candidates.find((p) => positionJoinKey(p) === String(targetId))');
    // The settle watch is armed here so the pill resolves in seconds rather than at the deadline.
    expect(mark).toContain('ensurePositionSettleInterval();');
  });

  it('reconciles against live: survivor → reduced, clean-empty → closed, partial+gone → unconfirmed', () => {
    const rec = sourceBetween('function reconcileManagePendingForSection', 'function positionManagePillLabel');
    // The old 2-minute guard made the post-withdraw refetch a guaranteed no-op; the tx is already
    // confirmed by this point, so only indexer lag is left to wait out.
    expect(rec).toContain('new Date(manage.requestedAt).getTime() < POSITION_SETTLE_MIN_AGE_MS) continue');
    expect(rec).not.toContain('POSITION_PENDING_MS');
    expect(rec).toContain('const match = liveRowForPosition(rows, p, positionJoinKey(p));');
    expect(rec).toContain("manage.phase = 'reduced';");
    expect(rec).toContain('} else if (!partial) {');
    expect(rec).toContain("manage.phase = 'closed';");
    expect(rec).toContain("p.status = 'closed';");
    // `partial && gone` matched NEITHER arm before — the silent no-op that wedged the card.
    expect(rec).toContain("manage.phase = 'unconfirmed';");
    expect(rec).toContain('p.walletAddress !== state.address');
  });

  it('seed expiry is per-connector, not gated on a clean whole-section read', () => {
    const expire = sourceBetween('function expireStaleSeededForSection', 'function reconcileManagePendingForSection');
    expect(expire).toContain('okConnectors: ReadonlySet<string>');
    expect(expire).toContain('(!p.connector || okConnectors.has(p.connector))');
    expect(expire).toContain('!positionIsSettling(p)');
    // One chronically-failing connector must no longer pin `partial` and freeze every seed forever.
    expect(mainSource).toContain('expireStaleSeededForSection(section, cluster, okConnectors);');
    expect(mainSource).not.toContain('if (!partial) expireStaleSeededForSection(');
  });

  it('completion side-effects force an authoritative refetch for stateful actions', () => {
    const effects = sourceBetween('function applyActionCompletionSideEffects', 'function showCompletedHistoryForAction');
    expect(effects).toContain('markManagePendingForAction(action, category as ActionCategory);');
    expect(effects).toContain('void fetchPositionCategory(sectionForCategory(category as ActionCategory), true);');
  });

  it('the pill resolves from the record alone, and a legacy stuck flag is migrated away on load', () => {
    // The never-stuck guarantee: no network, no timer, no reconcile in the render path.
    const display = sourceBetween('function positionManageDisplayState', 'function positionManagePillHtml');
    expect(display).toContain('positionManagePhaseAt(manage, Date.now())');
    const pill = sourceBetween('function positionManagePillLabel', 'function positionManagePillTone');
    expect(pill).toContain("case 'closed': return t('Complete');");
    expect(pill).toContain("case 'reduced': return t('Confirmed');");
    expect(pill).toContain("case 'unconfirmed': return t('Confirmed');");
    // Nothing writes the old flag any more.
    expect(mainSource).not.toContain('manageRequestedAt = new Date().toISOString()');
    const migrate = sourceBetween('function migrateLegacyManageFlag', 'function loadPositions');
    expect(migrate).toContain('delete p.manageRequestedAt;');
    expect(migrate).toContain('Date.now() - requestedAt < POSITION_SETTLE_MS');
  });

  it('a finished card lingers on Complete before retiring, and settling seeds survive an empty read', () => {
    const open = sourceBetween('function openPositions', 'const POSITION_PENDING_MS');
    expect(open).toContain('positionIsLingeringComplete(p)');
    // Without this a full withdraw's clean-empty read would hit positionsEmpty() and the Complete pill
    // would never render — positionIsRecentlyOpened only admits positions opened in the last 2 minutes.
    const section = sourceBetween('function renderPositionsSection', 'function positionsAllAggregateEntry');
    expect(section).toContain('positionIsSettling(p) || positionIsLingeringComplete(p)');
    expect(section).toContain('!liveRowForPosition(entry.rows, p, positionJoinKey(p))');
  });

  it('Max prefills a TOKEN amount, never the USD hero', () => {
    // Jupiter lend / LP / Drift promote the USD 'Value' to the hero, so reading it here typed "$7.50"
    // into a SOL amount field.
    const max = sourceBetween('function positionManageMaxAmount', 'function executePositionManage');
    expect(max).toContain('positionLiveTokenAmountText(liveRow)');
    expect(max).not.toContain('liveRow?.headline?.value');
    const tokenText = sourceBetween('function positionLiveTokenAmountText', 'function positionAmountUnit');
    expect(tokenText).toContain('POSITION_BALANCE_DETAIL_LABELS[row.kind]');
    expect(tokenText).toContain('posIsTokenAmountText');
  });
});

describe('positions i18n + css', () => {
  it('adds the new user-facing strings to every catalog', () => {
    const keys = [
      'All positions', 'Filter positions', 'Updating…',
      'Every open position across orders, lending, borrowing, staking and liquidity.',
      "Couldn't reach live data right now. Showing what you opened. Tap Refresh to retry.",
      // The manage-settle pill + its per-type "what just happened" tile.
      'Complete', 'Confirmed', 'Withdrew', 'Repaid', 'Unstaked', 'Removed',
    ];
    for (const lang of CATALOG_LANGS) {
      const entries = catalog(lang);
      for (const key of keys) {
        expect(entries[key], `${lang} missing "${key}"`).toBeTruthy();
      }
    }
  });

  it('ships the new positions card + selector styles', () => {
    expect(stylesSource).toContain('.positions-title--bold');
    expect(stylesSource).toContain('.positions-hero');
    expect(stylesSource).toContain('.positions-headline-row');
    expect(stylesSource).toContain('.positions-selector-mobile');
    expect(stylesSource).toContain('.positions-group-head');
  });
});

describe('Jupiter limit position card: Edit prefill', () => {
  it('parseLimitRows carries current order values into the Edit form', () => {
    const limit = sourceBetween('function parseLimitRows', 'function parseDcaRows');
    expect(limit).toContain("kind: 'jupiter_trigger_edit_order'");
    expect(limit).toContain('editFields.orderType');
    expect(limit).toContain('editFields.newTriggerPriceUsd');
    expect(limit).toContain('editFields.newSlippageBps');
    expect(limit).toContain('editFields.newExpiresAt');
    expect(limit).toContain('fields: editFields');
  });

  it('adds the 3 plain-English order-type strings to every catalog', () => {
    const keys = [
      'Limit order',
      'Take-profit / Stop-loss',
      'Auto-entry with exits',
      "Swap automatically when a token reaches your target USD price. The amount received isn't guaranteed at trigger time.",
      'Set a take-profit and a stop-loss together — whichever fills first cancels the other (OCO).',
      'Wait for an entry price, then automatically arm a paired take-profit and stop-loss (OTOCO).',
    ];
    for (const lang of CATALOG_LANGS) {
      const entries = catalog(lang);
      for (const key of keys) {
        expect(entries[key], `${lang} missing "${key}"`).toBeTruthy();
      }
    }
  });
});

describe('single-option sub-action dropdown is hidden', () => {
  it('connectorSubActionPicker renders nothing when only one creation option remains (e.g. DCA)', () => {
    const picker = sourceBetween('function connectorSubActionPicker', 'function connectorDraftStatusPanel');
    expect(picker).toContain('const options = scopedSubActionOptions(group);');
    expect(picker).toContain('if (options.length <= 1) return \'\';');
  });
});
