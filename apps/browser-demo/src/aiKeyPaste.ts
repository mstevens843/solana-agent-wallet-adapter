export type AiKeyPasteClipboardSource = 'android-native' | 'ios-native' | 'web';

export type AiKeyPasteClipboardUnavailableReason =
  | 'android-native-missing'
  | 'android-native-failed'
  | 'ios-native-missing'
  | 'ios-native-failed'
  | 'web-unavailable'
  | 'web-failed';

export type AiKeyPasteClipboardResult =
  | {
      kind: 'text';
      source: AiKeyPasteClipboardSource;
      text: string;
    }
  | {
      kind: 'unavailable';
      reason: AiKeyPasteClipboardUnavailableReason;
    };

export interface AiKeyPasteAndroidClipboard {
  clipboardRead?: () => string;
}

export interface AiKeyPasteIosClipboard {
  clipboardRead?: () => Promise<{ text?: string }> | { text?: string };
}

export interface AiKeyPasteWebClipboard {
  readText?: () => Promise<string>;
}

export interface AiKeyPasteClipboardOptions {
  android?: AiKeyPasteAndroidClipboard;
  ios?: AiKeyPasteIosClipboard;
  isAndroidApp: boolean;
  isIosApp?: boolean;
  web?: AiKeyPasteWebClipboard;
}

export async function readAiKeyPasteClipboardText(
  options: AiKeyPasteClipboardOptions,
): Promise<AiKeyPasteClipboardResult> {
  const androidRead = options.android?.clipboardRead;
  if (options.isAndroidApp) {
    if (typeof androidRead !== 'function') {
      return { kind: 'unavailable', reason: 'android-native-missing' };
    }
    try {
      return { kind: 'text', source: 'android-native', text: androidRead() };
    } catch {
      return { kind: 'unavailable', reason: 'android-native-failed' };
    }
  }

  const iosRead = options.ios?.clipboardRead;
  if (options.isIosApp && typeof iosRead !== 'function') {
    return { kind: 'unavailable', reason: 'ios-native-missing' };
  }
  if (typeof iosRead === 'function') {
    try {
      const result = await iosRead();
      if (result && typeof result.text === 'string') {
        return { kind: 'text', source: 'ios-native', text: result.text };
      }
    } catch {
      return { kind: 'unavailable', reason: 'ios-native-failed' };
    }
  }

  const webRead = options.web?.readText;
  if (typeof webRead !== 'function') {
    return { kind: 'unavailable', reason: 'web-unavailable' };
  }
  try {
    return { kind: 'text', source: 'web', text: await webRead() };
  } catch {
    return { kind: 'unavailable', reason: 'web-failed' };
  }
}

export function aiKeyPasteUnavailableCopy(reason: AiKeyPasteClipboardUnavailableReason): {
  message: string;
  title: string;
} {
  if (reason === 'android-native-missing') {
    return {
      title: 'App update required',
      message: 'This installed Android build does not expose one-tap paste. Update the app, or type the key manually.',
    };
  }
  if (reason === 'android-native-failed') {
    return {
      title: 'Paste blocked',
      message: 'Android blocked clipboard access. Copy the key again, then tap Paste.',
    };
  }
  if (reason === 'ios-native-missing') {
    return {
      title: 'App update required',
      message: 'This installed iOS build does not expose one-tap paste. Update the app, or type the key manually.',
    };
  }
  if (reason === 'ios-native-failed') {
    return {
      title: 'Paste blocked',
      message: 'iOS blocked clipboard access. Copy the key again, then tap Paste.',
    };
  }
  return {
    title: 'Paste manually',
    message: 'Clipboard access is unavailable here. Type the key or use the system paste menu.',
  };
}
