import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

function sourceBetween(start: string, end: string): string {
  const startIndex = mainSource.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = mainSource.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return mainSource.slice(startIndex, endIndex);
}

describe('connector connect native sheet', () => {
  it('dismisses connector prompts without resetting route, tab, or New Request draft', () => {
    const connectorConnectBlock = sourceBetween('function openConnectorConnect', 'function selectConnectorActionForCreate');
    const closeBody = sourceBetween('function closeConnectorConnect(): void', 'function reconcileConnectorConnectSession');

    expect(closeBody).toContain('state.connectorConnect = null;');
    expect(closeBody).not.toContain('clearConnectorCreateSelection');
    expect(closeBody).not.toContain('navigateTo');
    expect(connectorConnectBlock).not.toContain("'/demo'");
    expect(connectorConnectBlock).not.toContain('"/demo"');
    expect(mainSource).not.toContain('closeConnectorConnect({ revert: true })');
  });

  it('keeps connector prompts scoped to the surface that opened them', () => {
    const openBody = sourceBetween('function openConnectorConnect', 'function closeConnectorConnect');
    const reconcileBody = sourceBetween('function reconcileConnectorConnectSession', 'function connectorConnectIsByo');

    expect(mainSource).toContain('interface ConnectorConnectSession');
    expect(openBody).toContain('openerRoute: currentRoute()');
    expect(openBody).toContain('openerTab: state.activeTab');
    expect(reconcileBody).toContain('route !== session.openerRoute');
    expect(reconcileBody).toContain('state.activeTab !== session.openerTab');
    expect(mainSource).toContain('reconcileConnectorConnectSession(currentRoute())');
    expect(mainSource).toContain('reconcileConnectorConnectSession(route)');
  });

  it('keeps connector enablement separate from wallet signing APIs', () => {
    const enableBody = sourceBetween('function connectorConnectEnable', 'function connectorConnectFinish');
    const bindBody = sourceBetween('function bindConnectorConnectSurface', 'function selectConnectorActionForCreate');

    expect(enableBody).not.toMatch(/signMessage|signTransaction|signAndSendTransaction/);
    expect(bindBody).not.toMatch(/signMessage|signTransaction|signAndSendTransaction/);
    expect(bindBody).toContain('No wallet signature was requested.');
    expect(bindBody).toContain('runPasteProtocolConnectorCredential');
    expect(mainSource).toContain('data-connector-connect-key-paste');
  });

  it('renders connector-specific credential controls instead of the old global client-key row', () => {
    const panelBody = sourceBetween('function connectedDappsPanel', 'function connectedDappRow');

    expect(panelBody).toContain('protocolConnectorCredentialInline(selectedCatalogConnector)');
    expect(panelBody).toContain('data-protocol-connector-credential-paste');
    expect(panelBody).not.toContain('Dialect client key');
    expect(mainSource).toContain('function enableProtocolConnectorFromPreferences');
  });

  it('renders a branded native bottom sheet instead of inline-styled popover controls', () => {
    expect(mainSource).toContain("brandLogo(protocolConnectorLogoId(connector.id), 'connector-connect-logo')");
    expect(mainSource).toContain("'connector-connect-popover connector-connect-sheet'");
    expect(mainSource).toContain('class="connector-connect-overlay ${nativeSheet ?');
    expect(mainSource).not.toContain('connector-connect-actions" style=');
    expect(mainSource).not.toContain('style="${sheet ?');

    expect(stylesSource).toContain('.connector-connect-overlay.native-sheet');
    expect(stylesSource).toContain('.connector-connect-sheet');
    expect(stylesSource).toContain('grid-template-columns: minmax(104px, 0.72fr) minmax(132px, 1fr);');
    expect(stylesSource).toContain('.connector-connect-secondary,');
    expect(stylesSource).toContain('white-space: nowrap;');
  });
});
