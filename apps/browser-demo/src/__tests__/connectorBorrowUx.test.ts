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

describe('Jupiter borrow create UX polish', () => {
  it('renders borrow risk as a segmented data-template-field-choice control', () => {
    const risk = sourceBetween('function borrowRiskSegmentedFieldInput', 'function borrowRiskSizingFraction');
    expect(risk).toContain('borrow-risk-segments');
    expect(risk).toContain('borrow-risk-chip');
    expect(risk).toContain('data-template-field-choice="${escapeHtml(fieldDef.id)}"');
    expect(risk).toContain('data-template-field-value="${escapeHtml(option)}"');
    const templateFieldInput = sourceBetween('function templateFieldInput', 'function plannerNumericInputAttrs');
    expect(templateFieldInput).toContain("fieldDef.id === 'borrowRisk'");
    expect(templateFieldInput).toContain('borrowRiskSegmentedFieldInput');
  });

  it('derives max-safe borrow and liquidation-drop readouts from preview LTV bps', () => {
    const preview = sourceBetween('function borrowPreviewMaxSafeAmount', 'function borrowRiskMinHealthRatio');
    expect(preview).toContain('debt * data.maxLtvBps / data.projectedLtvBps');
    expect(preview).toContain('1 - data.projectedLtvBps / liquidationThresholdBps');
    expect(preview).toContain('Liquidated if {symbol} falls ~{pct}%');
    const panel = sourceBetween('function borrowTermsPanelHtml', 'function borrowRiskMinHealthRatio');
    expect(panel).toContain("t('Max-safe borrow')");
    expect(panel).toContain("t('Liquidation drop')");
    expect(panel).toContain('borrowLiquidationDropText');
  });

  it('adds max-safe chips, slider, and risk-preset amount sizing', () => {
    const maxSafe = sourceBetween('function currentBorrowMaxSafeEstimate', 'function borrowTermsPanelHtml');
    expect(maxSafe).toContain('BORROW_MAX_SAFE_PROBE_DEBT');
    const sizer = sourceBetween('function borrowAmountSizerHtml', 'function templateFieldInput');
    expect(sizer).toContain('data-borrow-amount-fraction');
    expect(sizer).toContain('data-borrow-amount-slider');
    expect(sizer).toContain("tf('Max-safe {amount}'");
    const riskSizing = sourceBetween('function borrowRiskSizingFraction', 'function borrowAmountSizerHtml');
    expect(riskSizing).toContain("case 'Safe': return 0.4");
    expect(riskSizing).toContain("case 'Max': return 0.9");
    expect(riskSizing).toContain('return 0.6');
    const bind = sourceBetween("for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-template-field-choice][data-template-field-value]'))", "for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-cascading-retry]')");
    expect(bind).toContain("if (fieldId === 'borrowRisk') applyBorrowRiskPresetAmount(fieldValue)");
  });

  it('keeps borrow refreshes and validation stable around mobile/picker edge cases', () => {
    const refresh = sourceBetween('function scheduleBorrowTermsRefresh', 'async function requestBorrowTerms');
    expect(refresh).toContain("document.querySelector('.select-picker.open')");
    const width = sourceBetween('function mobilePlannerFieldWidth', 'function isLongPlannerFieldId');
    expect(width).toContain("selectedTemplate().id === 'connector-jupiter-lend'");
    expect(width).toContain("fieldDef.id === 'collateralAmount' || fieldDef.id === 'borrowAmount'");
    const context = sourceBetween('function withReadFactsContext', 'async function connectorOptionBridgeFetch');
    expect(context).toContain('walletAddressForCascading() || state.address');
    const balance = sourceBetween('function templateSpendBalanceError', 'function templateRequiresUserNotes');
    expect(balance).toContain("template.id === 'connector-jupiter-lend'");
    expect(balance).toContain("parameters.subAction === 'borrow-create'");
    expect(balance).toContain('selectedBorrowVaultOption(parameters)');
    expect(balance).toContain('collateralAmount');
  });

  it('includes compact CSS for borrow risk and amount sizing controls', () => {
    expect(stylesSource).toContain('.borrow-risk-segments');
    expect(stylesSource).toContain('.borrow-risk-chip');
    expect(stylesSource).toContain('.borrow-amount-sizer');
    expect(stylesSource).toContain('.borrow-amount-chip-row');
    expect(stylesSource).toContain('.borrow-amount-slider');
  });
});
