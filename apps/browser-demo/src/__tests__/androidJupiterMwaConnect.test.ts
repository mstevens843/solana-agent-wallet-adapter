import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');

function sourceBetween(start: string, end: string): string {
  const startIndex = mainSource.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = mainSource.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return mainSource.slice(startIndex, endIndex);
}

describe('Android Jupiter MWA connect routing', () => {
  it('routes Jupiter WalletConnect attempts to Android native MWA before WalletConnect setup', () => {
    const brandedBody = sourceBetween(
      'async function handleScanQrForBrand',
      'function desktopWalletConnectQrPayload',
    );
    const anyWalletBody = sourceBetween(
      'async function handleScanQrAnyWallet',
      'async function copyWalletConnectUri',
    );
    const desktopPickerHandler = sourceBetween(
      'function handleDesktopQrWalletSelect',
      'function generatePairingUuid',
    );

    expect(brandedBody.indexOf('isAndroidNativeJupiterWalletConnectRequest(brandId)'))
      .toBeLessThan(brandedBody.indexOf('isWalletConnectSupportedBrand(brandId)'));
    expect(brandedBody.indexOf('await routeAndroidNativeJupiterWalletConnectToMwa();'))
      .toBeLessThan(brandedBody.indexOf('ensureWalletConnectClient()'));

    expect(anyWalletBody.indexOf('isAndroidNativeJupiterWalletConnectRequest(displayBrandId)'))
      .toBeLessThan(anyWalletBody.indexOf('WALLETCONNECT_PROJECT_ID'));
    expect(anyWalletBody.indexOf('await routeAndroidNativeJupiterWalletConnectToMwa();'))
      .toBeLessThan(anyWalletBody.indexOf('ensureWalletConnectClient()'));

    expect(desktopPickerHandler.indexOf('isAndroidNativeJupiterWalletConnectRequest(wallet)'))
      .toBeLessThan(desktopPickerHandler.indexOf('!WALLETCONNECT_PROJECT_ID'));
    expect(desktopPickerHandler.indexOf('void routeAndroidNativeJupiterWalletConnectToMwa();'))
      .toBeLessThan(desktopPickerHandler.indexOf('void handleScanQrAnyWallet(wallet);'));
  });

  it('uses runConnect for Android Jupiter and suppresses the Jupiter WalletConnect deeplink', () => {
    const routeBody = sourceBetween(
      'async function routeAndroidNativeJupiterWalletConnectToMwa',
      'async function copyWalletConnectUri',
    );
    const overlayBody = sourceBetween(
      'function walletConnectOverlayBlock()',
      'function walletConnectQrSurface()',
    );
    const inlineQrBody = sourceBetween(
      'function desktopQrBody()',
      'function desktopQrWalletPicker()',
    );

    expect(routeBody).toContain('await runConnect();');
    expect(routeBody).not.toContain('handleScanQrForBrand');
    expect(routeBody).not.toContain('handleScanQrAnyWallet');
    expect(overlayBody).toContain(
      'suppressDeepLink: isAndroidNativeJupiterWalletConnectRequest(walletConnect.overlay.brandId)',
    );
    expect(inlineQrBody).toContain(
      'suppressDeepLink: isAndroidNativeJupiterWalletConnectRequest(wallet)',
    );
  });

  it('does not disable the Jupiter QR picker on Android native when WalletConnect is unconfigured', () => {
    const pickerBody = sourceBetween(
      'function desktopQrWalletPicker()',
      'function desktopBrowserExtensionBody',
    );
    const walletConnectProjectGateIndex = pickerBody.indexOf('!WALLETCONNECT_PROJECT_ID');

    expect(walletConnectProjectGateIndex).toBeGreaterThanOrEqual(0);
    expect(pickerBody.indexOf('!isAndroidNativeJupiterWalletConnectRequest(entry.id)'))
      .toBeLessThan(walletConnectProjectGateIndex);
  });
});
