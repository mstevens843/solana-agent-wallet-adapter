import { describe, expect, it } from 'vitest';

import {
  checkboxInputType,
  computeDisclosureOrdinal,
  formatDisclosureKey,
  isTemplateDrivenDisclosureClasses,
  stableDisclosureClassName,
  TEMPLATE_DRIVEN_DISCLOSURE_CLASSES,
} from '../webViewControlFix.js';

describe('webViewControlFix pure logic', () => {
  describe('stableDisclosureClassName', () => {
    it('strips volatile state tokens and sorts the rest', () => {
      expect(stableDisclosureClassName(['agent-evidence-drawer', 'open', 'active'])).toBe(
        'agent-evidence-drawer',
      );
      expect(stableDisclosureClassName(['recipient-rules-panel', 'enabled'])).toBe(
        'recipient-rules-panel',
      );
      expect(stableDisclosureClassName(['recipient-rules-panel', 'disabled'])).toBe(
        'recipient-rules-panel',
      );
    });

    it('produces the SAME signature across renders when only volatile classes flip', () => {
      // The whole point: a disclosure that gains/loses open/checked/active/busy
      // between renders must still derive to the same key so its persisted open
      // state restores.
      const closed = stableDisclosureClassName(['mobile-card-action-menu']);
      const opened = stableDisclosureClassName(['mobile-card-action-menu', 'open']);
      const busy = stableDisclosureClassName(['mobile-card-action-menu', 'busy', 'has-active']);
      expect(closed).toBe(opened);
      expect(closed).toBe(busy);
    });

    it('keeps distinct stable tokens distinct and order-independent', () => {
      expect(stableDisclosureClassName(['b-panel', 'a-panel'])).toBe('a-panel.b-panel');
      expect(stableDisclosureClassName(['a-panel', 'b-panel'])).toBe('a-panel.b-panel');
    });

    it('ignores empty tokens', () => {
      expect(stableDisclosureClassName(['', 'agent-ask-panel', ''])).toBe('agent-ask-panel');
    });
  });

  describe('isTemplateDrivenDisclosureClasses', () => {
    it('treats audit records as template-driven regardless of class', () => {
      expect(isTemplateDrivenDisclosureClasses(['evidence-details'], true)).toBe(true);
    });

    it('detects the excluded (template-authoritative) panel classes', () => {
      for (const cls of TEMPLATE_DRIVEN_DISCLOSURE_CLASSES) {
        expect(isTemplateDrivenDisclosureClasses([cls], false)).toBe(true);
      }
      // workspace-more is a transient nav menu that must reset on re-render.
      expect(isTemplateDrivenDisclosureClasses(['workspace-more', 'has-active'], false)).toBe(true);
    });

    it('treats the user-reported presentational drawers as persistable (not template-driven)', () => {
      for (const cls of [
        'agent-evidence-drawer',
        'agent-ask-panel',
        'generated-plan-inline-details',
        'mobile-card-action-menu',
      ]) {
        expect(isTemplateDrivenDisclosureClasses([cls], false)).toBe(false);
      }
    });
  });

  describe('checkboxInputType', () => {
    it('accepts only checkbox and radio', () => {
      expect(checkboxInputType('checkbox')).toBe('checkbox');
      expect(checkboxInputType('radio')).toBe('radio');
    });

    it('rejects text/select/other so those labels keep native behavior', () => {
      for (const type of ['text', 'number', 'email', 'search', 'select-one', '', null, undefined]) {
        expect(checkboxInputType(type)).toBeNull();
      }
    });
  });

  describe('computeDisclosureOrdinal + formatDisclosureKey', () => {
    it('numbers repeated identical disclosures within the same record', () => {
      const entries = [
        { recordId: 'plan-1', className: 'mobile-card-action-menu' },
        { recordId: 'plan-1', className: 'agent-ask-panel' },
        { recordId: 'plan-1', className: 'mobile-card-action-menu' },
      ];
      expect(computeDisclosureOrdinal(entries, 0)).toBe(0);
      expect(computeDisclosureOrdinal(entries, 1)).toBe(0);
      expect(computeDisclosureOrdinal(entries, 2)).toBe(1);
    });

    it('keeps the same className in different records at ordinal 0 (record id disambiguates)', () => {
      const entries = [
        { recordId: 'plan-1', className: 'agent-evidence-drawer' },
        { recordId: 'plan-2', className: 'agent-evidence-drawer' },
      ];
      expect(computeDisclosureOrdinal(entries, 0)).toBe(0);
      expect(computeDisclosureOrdinal(entries, 1)).toBe(0);
      expect(formatDisclosureKey('plan-1', 'agent-evidence-drawer', 0)).not.toBe(
        formatDisclosureKey('plan-2', 'agent-evidence-drawer', 0),
      );
    });

    it('derives an identical key across a re-render that only flips volatile classes', () => {
      // Render A: drawer closed. Render B: same drawer open + a transient busy class.
      const keyA = formatDisclosureKey(
        'plan-9',
        stableDisclosureClassName(['agent-evidence-drawer']),
        computeDisclosureOrdinal([{ recordId: 'plan-9', className: 'agent-evidence-drawer' }], 0),
      );
      const keyB = formatDisclosureKey(
        'plan-9',
        stableDisclosureClassName(['agent-evidence-drawer', 'open', 'busy']),
        computeDisclosureOrdinal([{ recordId: 'plan-9', className: 'agent-evidence-drawer' }], 0),
      );
      expect(keyA).toBe(keyB);
    });

    it('returns 0 for an out-of-range index', () => {
      expect(computeDisclosureOrdinal([], 0)).toBe(0);
    });
  });
});
