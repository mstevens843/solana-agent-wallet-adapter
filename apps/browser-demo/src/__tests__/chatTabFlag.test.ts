import { describe, expect, it } from 'vitest';

import { isChatTabHiddenForSurface, parseHideChatTab, type AppSurfaceType } from '../chatTabFlag.js';

const ALL: AppSurfaceType[] = ['web', 'android', 'ios', 'desktop'];

describe('parseHideChatTab', () => {
  it('returns an empty set for unset/empty/whitespace values', () => {
    expect(parseHideChatTab(undefined).size).toBe(0);
    expect(parseHideChatTab('').size).toBe(0);
    expect(parseHideChatTab('   ').size).toBe(0);
    expect(parseHideChatTab(',, ,').size).toBe(0);
  });

  it('parses a comma list, trimming and lowercasing', () => {
    expect(parseHideChatTab(' Web , ANDROID ,ios ')).toEqual(new Set(['web', 'android', 'ios']));
  });
});

describe('isChatTabHiddenForSurface', () => {
  it('shows Chat everywhere when the flag is empty/unset', () => {
    for (const s of ALL) {
      expect(isChatTabHiddenForSurface(undefined, s)).toBe(false);
      expect(isChatTabHiddenForSurface('', s)).toBe(false);
    }
  });

  it('hides only the listed surface for a single value', () => {
    expect(isChatTabHiddenForSurface('web', 'web')).toBe(true);
    expect(isChatTabHiddenForSurface('web', 'android')).toBe(false);
    expect(isChatTabHiddenForSurface('web', 'ios')).toBe(false);
    expect(isChatTabHiddenForSurface('web', 'desktop')).toBe(false);
  });

  it('hides every listed surface for a multi value', () => {
    const raw = 'web,android,ios,desktop';
    for (const s of ALL) expect(isChatTabHiddenForSurface(raw, s)).toBe(true);
  });

  it('is case-insensitive and tolerates whitespace', () => {
    expect(isChatTabHiddenForSurface(' DESKTOP ', 'desktop')).toBe(true);
    expect(isChatTabHiddenForSurface('Web, Desktop', 'web')).toBe(true);
    expect(isChatTabHiddenForSurface('Web, Desktop', 'desktop')).toBe(true);
    expect(isChatTabHiddenForSurface('Web, Desktop', 'android')).toBe(false);
  });

  it('supports the `mobile` alias for android + ios only', () => {
    expect(isChatTabHiddenForSurface('mobile', 'android')).toBe(true);
    expect(isChatTabHiddenForSurface('mobile', 'ios')).toBe(true);
    expect(isChatTabHiddenForSurface('mobile', 'web')).toBe(false);
    expect(isChatTabHiddenForSurface('mobile', 'desktop')).toBe(false);
  });

  it('ignores unknown tokens', () => {
    expect(isChatTabHiddenForSurface('foo,bar', 'web')).toBe(false);
    expect(isChatTabHiddenForSurface('foo,web', 'web')).toBe(true);
  });
});
