import { describe, expect, it, vi } from 'vitest';

import {
  aiKeyPasteUnavailableCopy,
  readAiKeyPasteClipboardText,
} from '../aiKeyPaste.js';

describe('ai key paste clipboard policy', () => {
  it('uses Android native clipboardRead and skips web clipboard fallback', async () => {
    const webRead = vi.fn(async () => 'web-key');
    const result = await readAiKeyPasteClipboardText({
      android: { clipboardRead: () => 'android-key' },
      isAndroidApp: true,
      web: { readText: webRead },
    });

    expect(result).toEqual({ kind: 'text', source: 'android-native', text: 'android-key' });
    expect(webRead).not.toHaveBeenCalled();
  });

  it('does not use web clipboard fallback when Android native clipboardRead is missing', async () => {
    const webRead = vi.fn(async () => 'web-key');
    const result = await readAiKeyPasteClipboardText({
      android: {},
      isAndroidApp: true,
      web: { readText: webRead },
    });

    expect(result).toEqual({ kind: 'unavailable', reason: 'android-native-missing' });
    expect(webRead).not.toHaveBeenCalled();
  });

  it('surfaces Android native read failures immediately', async () => {
    const webRead = vi.fn(async () => 'web-key');
    const result = await readAiKeyPasteClipboardText({
      android: {
        clipboardRead: () => {
          throw new Error('blocked');
        },
      },
      isAndroidApp: true,
      web: { readText: webRead },
    });

    expect(result).toEqual({ kind: 'unavailable', reason: 'android-native-failed' });
    expect(webRead).not.toHaveBeenCalled();
  });

  it('uses native iOS clipboard before web fallback on non-Android surfaces', async () => {
    const webRead = vi.fn(async () => 'web-key');
    const result = await readAiKeyPasteClipboardText({
      ios: { clipboardRead: async () => ({ text: 'ios-key' }) },
      isAndroidApp: false,
      isIosApp: true,
      web: { readText: webRead },
    });

    expect(result).toEqual({ kind: 'text', source: 'ios-native', text: 'ios-key' });
    expect(webRead).not.toHaveBeenCalled();
  });

  it('does not use web clipboard fallback when iOS native clipboardRead is missing inside the app', async () => {
    const webRead = vi.fn(async () => 'web-key');
    const result = await readAiKeyPasteClipboardText({
      ios: {},
      isAndroidApp: false,
      isIosApp: true,
      web: { readText: webRead },
    });

    expect(result).toEqual({ kind: 'unavailable', reason: 'ios-native-missing' });
    expect(webRead).not.toHaveBeenCalled();
  });

  it('keeps web clipboard fallback for browser surfaces', async () => {
    const result = await readAiKeyPasteClipboardText({
      isAndroidApp: false,
      web: { readText: async () => 'web-key' },
    });

    expect(result).toEqual({ kind: 'text', source: 'web', text: 'web-key' });
  });

  it('returns explicit app update copy for Android builds without clipboardRead', () => {
    expect(aiKeyPasteUnavailableCopy('android-native-missing')).toEqual({
      title: 'App update required',
      message: 'This installed Android build does not expose one-tap paste. Update the app, or type the key manually.',
    });
  });

  it('returns explicit app update copy for iOS builds without clipboardRead', () => {
    expect(aiKeyPasteUnavailableCopy('ios-native-missing')).toEqual({
      title: 'App update required',
      message: 'This installed iOS build does not expose one-tap paste. Update the app, or type the key manually.',
    });
  });
});
