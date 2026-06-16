import { describe, expect, it, vi } from 'vitest';

import {
  aiKeyPasteUnavailableCopy,
  readAiKeyPasteClipboardText,
} from '../aiKeyPaste.js';

describe('ai key paste clipboard policy', () => {
  it('uses Android native clipboardRead and skips web clipboard fallback', async () => {
    const webRead = vi.fn(async () => 'web-key');
    const android = {
      marker: 'android-key',
      clipboardRead(this: { marker: string }) {
        return this.marker;
      },
    };
    const result = await readAiKeyPasteClipboardText({
      android,
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
    const ios = {
      marker: 'ios-key',
      async clipboardRead(this: { marker: string }) {
        return { text: this.marker };
      },
    };
    const result = await readAiKeyPasteClipboardText({
      ios,
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

  it('falls through to web clipboard on plain web even though the Capacitor ios proxy is present', async () => {
    // Mirrors production wiring (main.ts readClipboardText always supplies the Capacitor
    // registerPlugin proxy as `ios`): every property read on that proxy is a function that
    // rejects with "not implemented on web". With isIosApp false we must NOT invoke it.
    const webRead = vi.fn(async () => 'web-key');
    const iosProxyRead = vi.fn(async () => {
      throw new Error('"AgenticSystem" plugin is not implemented on web');
    });
    const result = await readAiKeyPasteClipboardText({
      ios: { clipboardRead: iosProxyRead },
      isAndroidApp: false,
      isIosApp: false,
      web: { readText: webRead },
    });

    expect(result).toEqual({ kind: 'text', source: 'web', text: 'web-key' });
    expect(iosProxyRead).not.toHaveBeenCalled();
    expect(webRead).toHaveBeenCalledTimes(1);
  });

  it('surfaces iOS native read failures immediately inside the iOS app', async () => {
    const webRead = vi.fn(async () => 'web-key');
    const result = await readAiKeyPasteClipboardText({
      ios: {
        clipboardRead: async () => {
          throw new Error('blocked');
        },
      },
      isAndroidApp: false,
      isIosApp: true,
      web: { readText: webRead },
    });

    expect(result).toEqual({ kind: 'unavailable', reason: 'ios-native-failed' });
    expect(webRead).not.toHaveBeenCalled();
  });

  it('falls through to web when the iOS bridge resolves an empty pasteboard', async () => {
    const webRead = vi.fn(async () => 'web-key');
    for (const empty of [{}, { text: undefined }]) {
      webRead.mockClear();
      const result = await readAiKeyPasteClipboardText({
        ios: { clipboardRead: async () => empty },
        isAndroidApp: false,
        isIosApp: true,
        web: { readText: webRead },
      });

      expect(result).toEqual({ kind: 'text', source: 'web', text: 'web-key' });
      expect(webRead).toHaveBeenCalledTimes(1);
    }
  });

  it('reports web-unavailable when no web clipboard reader exists', async () => {
    const result = await readAiKeyPasteClipboardText({
      isAndroidApp: false,
      web: {},
    });

    expect(result).toEqual({ kind: 'unavailable', reason: 'web-unavailable' });
  });

  it('reports web-failed when the web clipboard read rejects', async () => {
    const result = await readAiKeyPasteClipboardText({
      isAndroidApp: false,
      web: {
        readText: async () => {
          throw new Error('denied');
        },
      },
    });

    expect(result).toEqual({ kind: 'unavailable', reason: 'web-failed' });
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

  it('returns the generic paste-manually copy for web clipboard reasons', () => {
    const expected = {
      title: 'Paste manually',
      message: 'Clipboard access is unavailable here. Type the key or use the system paste menu.',
    };
    expect(aiKeyPasteUnavailableCopy('web-unavailable')).toEqual(expected);
    expect(aiKeyPasteUnavailableCopy('web-failed')).toEqual(expected);
  });

  it('returns explicit paste-blocked copy for native clipboard failures', () => {
    expect(aiKeyPasteUnavailableCopy('android-native-failed')).toEqual({
      title: 'Paste blocked',
      message: 'Android blocked clipboard access. Copy the key again, then tap Paste.',
    });
    expect(aiKeyPasteUnavailableCopy('ios-native-failed')).toEqual({
      title: 'Paste blocked',
      message: 'iOS blocked clipboard access. Copy the key again, then tap Paste.',
    });
  });
});
