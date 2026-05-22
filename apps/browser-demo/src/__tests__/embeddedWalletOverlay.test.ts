import { describe, expect, it } from 'vitest';

import {
  MIN_PASSWORD_LENGTH,
  embeddedWalletOverlayHtml,
  initialEmbeddedWalletOverlayState,
  reduceEmbeddedWalletOverlay,
  validateCreate,
  validateImport,
  validateResetConfirm,
  validateUnlock,
  type EmbeddedWalletOverlayState,
} from '../embeddedWalletOverlay.js';

const goodPassword = 'hunter2hunter';
const sample24 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

describe('validateCreate', () => {
  it('rejects passwords shorter than the minimum', () => {
    const res = validateCreate({ password: 'short', confirm: 'short' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain(String(MIN_PASSWORD_LENGTH));
  });

  it('rejects mismatched confirmation', () => {
    const res = validateCreate({ password: goodPassword, confirm: `${goodPassword}!` });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/do not match/i);
  });

  it('accepts a valid pair', () => {
    expect(validateCreate({ password: goodPassword, confirm: goodPassword })).toEqual({
      ok: true,
      error: '',
    });
  });
});

describe('validateImport', () => {
  it('rejects 11-word phrases', () => {
    const eleven = 'word '.repeat(11).trim();
    const res = validateImport({ mnemonic: eleven, password: goodPassword, confirm: goodPassword });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/12 or 24/);
  });

  it('rejects 13-word phrases', () => {
    const thirteen = 'word '.repeat(13).trim();
    const res = validateImport({ mnemonic: thirteen, password: goodPassword, confirm: goodPassword });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/12 or 24/);
  });

  it('rejects mismatched confirmation even with a good phrase', () => {
    const res = validateImport({
      mnemonic: sample24,
      password: goodPassword,
      confirm: 'different',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/match/i);
  });

  it('accepts a 24-word phrase with matching passwords', () => {
    expect(validateImport({ mnemonic: sample24, password: goodPassword, confirm: goodPassword })).toEqual({
      ok: true,
      error: '',
    });
  });

  it('accepts a 12-word phrase', () => {
    const twelve = 'a '.repeat(12).trim();
    expect(validateImport({ mnemonic: twelve, password: goodPassword, confirm: goodPassword }).ok).toBe(true);
  });

  it('tolerates trailing whitespace and tab separators', () => {
    const messy = `${sample24}\n\t`;
    expect(validateImport({ mnemonic: messy, password: goodPassword, confirm: goodPassword }).ok).toBe(true);
  });
});

describe('validateUnlock + validateResetConfirm', () => {
  it('rejects empty passwords', () => {
    expect(validateUnlock({ password: '' }).ok).toBe(false);
    expect(validateResetConfirm({ password: '' }).ok).toBe(false);
  });

  it('accepts any non-empty password', () => {
    expect(validateUnlock({ password: 'x' }).ok).toBe(true);
  });
});

describe('reduceEmbeddedWalletOverlay', () => {
  const initial = initialEmbeddedWalletOverlayState();

  it('open(create) resets to a fresh draft', () => {
    const dirty: EmbeddedWalletOverlayState = {
      ...initial,
      mode: 'unlock',
      busy: true,
      error: 'old',
      draft: { password: 'x', confirm: 'y', mnemonic: 'z' },
    };
    const next = reduceEmbeddedWalletOverlay(dirty, { type: 'open', mode: 'create' });
    expect(next.mode).toBe('create');
    expect(next.busy).toBe(false);
    expect(next.error).toBe('');
    expect(next.draft).toEqual({ password: '', confirm: '', mnemonic: '' });
  });

  it('setTab create → import keeps password drafts', () => {
    const create = reduceEmbeddedWalletOverlay(initial, { type: 'open', mode: 'create' });
    const withPw = reduceEmbeddedWalletOverlay(create, { type: 'setField', name: 'password', value: 'pw' });
    const switched = reduceEmbeddedWalletOverlay(withPw, { type: 'setTab', mode: 'import' });
    expect(switched.mode).toBe('import');
    expect(switched.draft.password).toBe('pw');
  });

  it('setTab import → create clears any partial mnemonic', () => {
    const importMode: EmbeddedWalletOverlayState = {
      ...initial,
      mode: 'import',
      draft: { password: 'pw', confirm: '', mnemonic: 'partial' },
    };
    const back = reduceEmbeddedWalletOverlay(importMode, { type: 'setTab', mode: 'create' });
    expect(back.mode).toBe('create');
    expect(back.draft.mnemonic).toBe('');
    expect(back.draft.password).toBe('pw');
  });

  it('setField updates only the named field and clears errors', () => {
    const withError: EmbeddedWalletOverlayState = { ...initial, mode: 'create', error: 'old' };
    const next = reduceEmbeddedWalletOverlay(withError, {
      type: 'setField',
      name: 'password',
      value: 'x',
    });
    expect(next.draft.password).toBe('x');
    expect(next.draft.confirm).toBe('');
    expect(next.error).toBe('');
  });

  it('submitStart flips busy on and clears any error', () => {
    const withError: EmbeddedWalletOverlayState = { ...initial, mode: 'unlock', error: 'invalid password' };
    const started = reduceEmbeddedWalletOverlay(withError, { type: 'submitStart' });
    expect(started.busy).toBe(true);
    expect(started.error).toBe('');
  });

  it('submitSuccessCreated transitions to show-phrase and clears password drafts', () => {
    const creating: EmbeddedWalletOverlayState = {
      ...initial,
      mode: 'create',
      busy: true,
      draft: { password: goodPassword, confirm: goodPassword, mnemonic: '' },
    };
    const next = reduceEmbeddedWalletOverlay(creating, {
      type: 'submitSuccessCreated',
      mnemonic: sample24,
    });
    expect(next.mode).toBe('show-phrase');
    expect(next.busy).toBe(false);
    expect(next.createdMnemonic).toBe(sample24);
    expect(next.phraseRevealed).toBe(false);
    expect(next.phraseSavedAcknowledged).toBe(false);
    expect(next.draft.password).toBe('');
  });

  it('submitError clears busy and surfaces the message', () => {
    const submitting: EmbeddedWalletOverlayState = { ...initial, mode: 'unlock', busy: true };
    const failed = reduceEmbeddedWalletOverlay(submitting, {
      type: 'submitError',
      error: 'invalid password',
    });
    expect(failed.busy).toBe(false);
    expect(failed.error).toBe('invalid password');
  });

  it('togglePhraseRevealed only fires in show-phrase mode', () => {
    const create: EmbeddedWalletOverlayState = { ...initial, mode: 'create' };
    expect(
      reduceEmbeddedWalletOverlay(create, { type: 'togglePhraseRevealed' }).phraseRevealed,
    ).toBe(false);

    const show: EmbeddedWalletOverlayState = {
      ...initial,
      mode: 'show-phrase',
      createdMnemonic: sample24,
    };
    const revealed = reduceEmbeddedWalletOverlay(show, { type: 'togglePhraseRevealed' });
    expect(revealed.phraseRevealed).toBe(true);
    const hidden = reduceEmbeddedWalletOverlay(revealed, { type: 'togglePhraseRevealed' });
    expect(hidden.phraseRevealed).toBe(false);
  });

  it('acknowledgePhraseSaved gates the continue action', () => {
    const show: EmbeddedWalletOverlayState = {
      ...initial,
      mode: 'show-phrase',
      createdMnemonic: sample24,
    };
    const acked = reduceEmbeddedWalletOverlay(show, {
      type: 'acknowledgePhraseSaved',
      checked: true,
    });
    expect(acked.phraseSavedAcknowledged).toBe(true);
    const unacked = reduceEmbeddedWalletOverlay(acked, {
      type: 'acknowledgePhraseSaved',
      checked: false,
    });
    expect(unacked.phraseSavedAcknowledged).toBe(false);
  });

  it('close returns to the initial state', () => {
    const dirty: EmbeddedWalletOverlayState = {
      ...initial,
      mode: 'show-phrase',
      createdMnemonic: sample24,
      phraseRevealed: true,
      phraseSavedAcknowledged: true,
      draft: { password: 'x', confirm: 'x', mnemonic: 'x' },
    };
    expect(reduceEmbeddedWalletOverlay(dirty, { type: 'close' })).toEqual(initial);
  });
});

describe('embeddedWalletOverlayHtml', () => {
  it('returns empty string when closed', () => {
    expect(embeddedWalletOverlayHtml(initialEmbeddedWalletOverlayState())).toBe('');
  });

  it('renders create mode with both tab buttons and password fields', () => {
    const state: EmbeddedWalletOverlayState = { ...initialEmbeddedWalletOverlayState(), mode: 'create' };
    const html = embeddedWalletOverlayHtml(state);
    expect(html).toContain('data-embedded-wallet-tab="create"');
    expect(html).toContain('data-embedded-wallet-tab="import"');
    expect(html).toContain('data-embedded-wallet-form="create"');
    expect(html).toContain('data-embedded-wallet-field="password"');
    expect(html).toContain('data-embedded-wallet-field="confirm"');
    expect(html).toContain('Create wallet');
  });

  it('renders import mode with a mnemonic textarea', () => {
    const state: EmbeddedWalletOverlayState = { ...initialEmbeddedWalletOverlayState(), mode: 'import' };
    const html = embeddedWalletOverlayHtml(state);
    expect(html).toContain('data-embedded-wallet-form="import"');
    expect(html).toContain('data-embedded-wallet-field="mnemonic"');
    expect(html).toContain('Import wallet');
  });

  it('renders show-phrase grid with all 24 cells and reveal toggle', () => {
    const state: EmbeddedWalletOverlayState = {
      ...initialEmbeddedWalletOverlayState(),
      mode: 'show-phrase',
      createdMnemonic: sample24,
    };
    const html = embeddedWalletOverlayHtml(state);
    expect((html.match(/embedded-wallet-overlay-phrase-cell/g) ?? []).length).toBe(24);
    expect(html).toContain('Reveal phrase');
    expect(html).toContain('data-embedded-wallet-action="acknowledge-phrase"');
    // bullets when hidden, real words when revealed
    expect(html).toContain('•••••••');
    expect(html).not.toContain('abandon</span>');
  });

  it('reveals actual words when phraseRevealed is true', () => {
    const state: EmbeddedWalletOverlayState = {
      ...initialEmbeddedWalletOverlayState(),
      mode: 'show-phrase',
      createdMnemonic: sample24,
      phraseRevealed: true,
    };
    const html = embeddedWalletOverlayHtml(state);
    expect(html).toContain('Hide phrase');
    expect(html).toContain('abandon');
    expect(html).not.toContain('•••••••');
  });

  it('disables Continue until phrase saved is acknowledged', () => {
    const before: EmbeddedWalletOverlayState = {
      ...initialEmbeddedWalletOverlayState(),
      mode: 'show-phrase',
      createdMnemonic: sample24,
    };
    expect(embeddedWalletOverlayHtml(before)).toContain('data-embedded-wallet-action="phrase-continue" disabled');

    const after: EmbeddedWalletOverlayState = { ...before, phraseSavedAcknowledged: true };
    expect(embeddedWalletOverlayHtml(after)).toContain(
      'data-embedded-wallet-action="phrase-continue" >',
    );
  });

  it('renders unlock mode with password field and reset link', () => {
    const state: EmbeddedWalletOverlayState = { ...initialEmbeddedWalletOverlayState(), mode: 'unlock' };
    const html = embeddedWalletOverlayHtml(state);
    expect(html).toContain('data-embedded-wallet-form="unlock"');
    expect(html).toContain('data-embedded-wallet-action="open-reset"');
    expect(html).toContain('Unlock');
  });

  it('renders error row when error is set', () => {
    const state: EmbeddedWalletOverlayState = {
      ...initialEmbeddedWalletOverlayState(),
      mode: 'unlock',
      error: 'invalid password',
    };
    const html = embeddedWalletOverlayHtml(state);
    expect(html).toContain('class="embedded-wallet-overlay-error"');
    expect(html).toContain('invalid password');
  });

  it('disables submit + cancel buttons while busy', () => {
    const state: EmbeddedWalletOverlayState = {
      ...initialEmbeddedWalletOverlayState(),
      mode: 'create',
      busy: true,
    };
    const html = embeddedWalletOverlayHtml(state);
    expect(html).toContain('Creating…');
    expect((html.match(/disabled/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('wires aria-labelledby on the dialog to the rendered h2 (a11y)', () => {
    const state: EmbeddedWalletOverlayState = {
      ...initialEmbeddedWalletOverlayState(),
      mode: 'unlock',
    };
    const html = embeddedWalletOverlayHtml(state);
    expect(html).toContain('aria-labelledby="embedded-wallet-overlay-title"');
    expect(html).toContain('<h2 id="embedded-wallet-overlay-title">');
    expect(html).not.toContain('aria-label="Unlock Agentic Wallet"');
  });

  it('escapes user-supplied error and draft values in the HTML', () => {
    const state: EmbeddedWalletOverlayState = {
      ...initialEmbeddedWalletOverlayState(),
      mode: 'create',
      error: '<script>alert(1)</script>',
      draft: { password: '"><img src=x>', confirm: '', mnemonic: '' },
    };
    const html = embeddedWalletOverlayHtml(state);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&quot;&gt;&lt;img');
  });
});
