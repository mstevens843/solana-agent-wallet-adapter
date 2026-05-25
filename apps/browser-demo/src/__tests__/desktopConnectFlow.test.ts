import { describe, expect, it } from 'vitest';

import {
  initialDesktopConnectFlowState,
  reduceDesktopConnectFlow,
  type DesktopConnectFlowState,
} from '../desktopConnectFlow.js';

const initial = (): DesktopConnectFlowState => initialDesktopConnectFlowState();

describe('initialDesktopConnectFlowState', () => {
  it('starts at idle with no brand and no poll start', () => {
    expect(initial()).toEqual({
      step: 'idle',
      selectedBrandId: null,
      awaitingBrowserStartedAt: null,
    });
  });
});

describe('reduceDesktopConnectFlow — startMethod', () => {
  it('transitions idle → method', () => {
    const next = reduceDesktopConnectFlow(initial(), { type: 'startMethod' });
    expect(next.step).toBe('method');
  });

  it('is a no-op when already past idle (prevents accidental state loss)', () => {
    const atMethod = reduceDesktopConnectFlow(initial(), { type: 'startMethod' });
    const again = reduceDesktopConnectFlow(atMethod, { type: 'startMethod' });
    expect(again).toBe(atMethod);
  });
});

describe('reduceDesktopConnectFlow — pickMethod', () => {
  const method = (): DesktopConnectFlowState =>
    reduceDesktopConnectFlow(initial(), { type: 'startMethod' });

  it('extension → extension-brands', () => {
    const next = reduceDesktopConnectFlow(method(), {
      type: 'pickMethod',
      method: 'extension',
    });
    expect(next.step).toBe('extension-brands');
    expect(next.selectedBrandId).toBeNull();
  });

  it('qr → qr (no brand yet)', () => {
    const next = reduceDesktopConnectFlow(method(), { type: 'pickMethod', method: 'qr' });
    expect(next.step).toBe('qr');
    expect(next.selectedBrandId).toBeNull();
  });

  it('ledger → ledger', () => {
    const next = reduceDesktopConnectFlow(method(), { type: 'pickMethod', method: 'ledger' });
    expect(next.step).toBe('ledger');
  });

  it('is ignored when not in method step', () => {
    const next = reduceDesktopConnectFlow(initial(), {
      type: 'pickMethod',
      method: 'extension',
    });
    expect(next.step).toBe('idle');
  });
});

describe('reduceDesktopConnectFlow — pickBrand', () => {
  it('attaches brand inside extension-brands', () => {
    const step1 = reduceDesktopConnectFlow(initial(), { type: 'startMethod' });
    const step2 = reduceDesktopConnectFlow(step1, {
      type: 'pickMethod',
      method: 'extension',
    });
    const step3 = reduceDesktopConnectFlow(step2, {
      type: 'pickBrand',
      brandId: 'phantom',
    });
    expect(step3.selectedBrandId).toBe('phantom');
    expect(step3.step).toBe('extension-brands');
  });

  it('attaches brand inside qr', () => {
    const step1 = reduceDesktopConnectFlow(initial(), { type: 'startMethod' });
    const step2 = reduceDesktopConnectFlow(step1, { type: 'pickMethod', method: 'qr' });
    const step3 = reduceDesktopConnectFlow(step2, { type: 'pickBrand', brandId: 'solflare' });
    expect(step3.selectedBrandId).toBe('solflare');
    expect(step3.step).toBe('qr');
  });

  it('is ignored from idle / method', () => {
    const ignored = reduceDesktopConnectFlow(initial(), {
      type: 'pickBrand',
      brandId: 'phantom',
    });
    expect(ignored.selectedBrandId).toBeNull();
  });
});

describe('reduceDesktopConnectFlow — beginAwaitingBrowser', () => {
  it('moves to awaiting-browser and stamps the start time', () => {
    const next = reduceDesktopConnectFlow(initial(), {
      type: 'beginAwaitingBrowser',
      brandId: 'phantom',
      startedAt: 1000,
    });
    expect(next.step).toBe('awaiting-browser');
    expect(next.selectedBrandId).toBe('phantom');
    expect(next.awaitingBrowserStartedAt).toBe(1000);
  });
});

describe('reduceDesktopConnectFlow — back', () => {
  it('method → idle', () => {
    const atMethod = reduceDesktopConnectFlow(initial(), { type: 'startMethod' });
    const back = reduceDesktopConnectFlow(atMethod, { type: 'back' });
    expect(back.step).toBe('idle');
  });

  it('extension-brands → method (clears brand)', () => {
    const atMethod = reduceDesktopConnectFlow(initial(), { type: 'startMethod' });
    const atBrands = reduceDesktopConnectFlow(atMethod, {
      type: 'pickMethod',
      method: 'extension',
    });
    const withBrand = reduceDesktopConnectFlow(atBrands, {
      type: 'pickBrand',
      brandId: 'backpack',
    });
    const back = reduceDesktopConnectFlow(withBrand, { type: 'back' });
    expect(back.step).toBe('method');
    expect(back.selectedBrandId).toBeNull();
  });

  it('qr with brand → qr without brand (sub-step back)', () => {
    const atMethod = reduceDesktopConnectFlow(initial(), { type: 'startMethod' });
    const atQr = reduceDesktopConnectFlow(atMethod, { type: 'pickMethod', method: 'qr' });
    const withBrand = reduceDesktopConnectFlow(atQr, {
      type: 'pickBrand',
      brandId: 'phantom',
    });
    const back = reduceDesktopConnectFlow(withBrand, { type: 'back' });
    expect(back.step).toBe('qr');
    expect(back.selectedBrandId).toBeNull();
  });

  it('qr without brand → method', () => {
    const atMethod = reduceDesktopConnectFlow(initial(), { type: 'startMethod' });
    const atQr = reduceDesktopConnectFlow(atMethod, { type: 'pickMethod', method: 'qr' });
    const back = reduceDesktopConnectFlow(atQr, { type: 'back' });
    expect(back.step).toBe('method');
  });

  it('ledger → method', () => {
    const atMethod = reduceDesktopConnectFlow(initial(), { type: 'startMethod' });
    const atLedger = reduceDesktopConnectFlow(atMethod, {
      type: 'pickMethod',
      method: 'ledger',
    });
    const back = reduceDesktopConnectFlow(atLedger, { type: 'back' });
    expect(back.step).toBe('method');
  });

  it('awaiting-browser → method (clears brand + start time)', () => {
    const at = reduceDesktopConnectFlow(initial(), {
      type: 'beginAwaitingBrowser',
      brandId: 'phantom',
      startedAt: 1000,
    });
    const back = reduceDesktopConnectFlow(at, { type: 'back' });
    expect(back.step).toBe('method');
    expect(back.selectedBrandId).toBeNull();
    expect(back.awaitingBrowserStartedAt).toBeNull();
  });

  it('idle is a no-op (returns same state object)', () => {
    const initialState = initial();
    expect(reduceDesktopConnectFlow(initialState, { type: 'back' })).toBe(initialState);
  });
});

describe('reduceDesktopConnectFlow — reset', () => {
  it('jumps from any step straight to idle', () => {
    const at = reduceDesktopConnectFlow(initial(), {
      type: 'beginAwaitingBrowser',
      brandId: 'phantom',
      startedAt: 1000,
    });
    const r = reduceDesktopConnectFlow(at, { type: 'reset' });
    expect(r).toEqual(initialDesktopConnectFlowState());
  });

  it('idle → idle is a no-op (returns same object)', () => {
    const initialState = initial();
    expect(reduceDesktopConnectFlow(initialState, { type: 'reset' })).toBe(initialState);
  });
});
