import { describe, expect, it, vi } from 'vitest';

import {
  openExternalUrlForSurface,
  shouldInterceptExternalLink,
} from '../externalLinks.js';

describe('shouldInterceptExternalLink', () => {
  it('intercepts external http links', () => {
    expect(shouldInterceptExternalLink('https://solscan.io/tx/abc', 'https://agentic-signer.com/app')).toBe(true);
  });

  it('does not intercept same-origin app links', () => {
    expect(shouldInterceptExternalLink('/app', 'https://agentic-signer.com/app')).toBe(false);
    expect(shouldInterceptExternalLink('https://agentic-signer.com/app#inbox', 'https://agentic-signer.com/app')).toBe(false);
  });

  it('ignores unsupported URL schemes', () => {
    expect(shouldInterceptExternalLink('mailto:support@example.com', 'https://agentic-signer.com/app')).toBe(false);
  });
});

describe('openExternalUrlForSurface', () => {
  it('opens through Tauri when available', async () => {
    const tauriOpenExternalUrl = vi.fn(async () => true);
    const result = await openExternalUrlForSurface('https://solscan.io/tx/abc', {
      isTauriNative: true,
      tauriOpenExternalUrl,
    });
    expect(result).toEqual({ ok: true, surface: 'tauri' });
    expect(tauriOpenExternalUrl).toHaveBeenCalledWith('https://solscan.io/tx/abc');
  });

  it('opens through Android when Tauri is unavailable', async () => {
    const androidOpenExternalUrl = vi.fn(() => true);
    const result = await openExternalUrlForSurface('https://solscan.io/tx/abc', {
      isAndroidNative: true,
      androidOpenExternalUrl,
    });
    expect(result).toEqual({ ok: true, surface: 'android' });
    expect(androidOpenExternalUrl).toHaveBeenCalledWith('https://solscan.io/tx/abc');
  });

  it('returns a failure result when no native opener is present', async () => {
    const result = await openExternalUrlForSurface('https://solscan.io/tx/abc', {});
    expect(result.ok).toBe(false);
    expect(result.surface).toBe('none');
  });
});
