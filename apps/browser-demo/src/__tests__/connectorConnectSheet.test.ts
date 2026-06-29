import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const connectorKeysSource = readFileSync(new URL('../connectorKeys.ts', import.meta.url), 'utf8');

function sourceBetween(start: string, end: string): string {
  const startIndex = mainSource.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = mainSource.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return mainSource.slice(startIndex, endIndex);
}

function stylesBetween(start: string, end: string): string {
  const startIndex = stylesSource.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = stylesSource.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return stylesSource.slice(startIndex, endIndex);
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

  it('keeps required-credential inputs visible when saved-key storage has an auth or storage error', () => {
    const preferencesInlineBody = sourceBetween('function protocolConnectorCredentialInline', 'function connectedDappRow');
    const connectSheetBody = sourceBetween('function connectorConnectSurfaceHtml', 'function connectorConnectReadiness');

    expect(preferencesInlineBody).toContain('data-protocol-connector-credential-field="apiKey"');
    expect(preferencesInlineBody).toContain('data-protocol-connector-credential-paste');
    expect(preferencesInlineBody).not.toContain('saved || storageBlocked');
    expect(connectSheetBody).toContain('data-connector-connect-key');
    expect(connectSheetBody).toContain('data-connector-connect-key-paste');
    expect(connectSheetBody).toContain('credentialNotice');
    expect(connectSheetBody).not.toContain('credentialLoading || credentialStorageBlocked');
  });

  it('routes connector-secret storage through the Cloud-authenticated fetch transport', () => {
    expect(connectorKeysSource).toContain('configureConnectorSecretsFetch');
    expect(connectorKeysSource).toContain('connectorSecretsFetch');
    expect(connectorKeysSource).toContain("connectorSecretsFetch('/api/connector-secrets'");
    expect(mainSource).toContain('configureConnectorSecretsFetch(connectorSecretsCloudFetch)');
    expect(mainSource).toContain('await ensureNativeCloudTokenReady()');
    expect(mainSource).toContain('return cloudFetch(path, init)');
  });

  it('keeps Chat connector action pickers from hiding unenabled connectors', () => {
    const chatConnectorListBody = sourceBetween('function chatConnectorsForCreate', 'function chatConnectorSurfaceBodyHtml');
    const chatSurfaceBody = sourceBetween('function chatConnectorSurfaceBodyHtml', 'function chatConnectorSurfaceTitle');
    const connectorPickerOptionsBody = sourceBetween('function connectorCreatePickerOptions', 'function selectedConnectorForCreate');
    const connectSelectBody = sourceBetween('function connectProtocolConnectorThenSelect', 'function openConnectorConnect');
    const finishBody = sourceBetween('function connectorConnectFinish', 'function connectorConnectSurfaceHtml');
    const gateBindBody = sourceBetween('"Enable {connector} to continue" gate', 'bindOnce(document.querySelector<HTMLSelectElement>(\'[data-connector-create-action]\')');

    expect(chatConnectorListBody).toContain('status.selectable || connectorCreateStatusIsConnectable(status.kind)');
    expect(chatConnectorListBody).not.toContain('connectorCreateStatus(connector, env).selectable &&');
    expect(chatSurfaceBody).toContain('connectorCreatePickerOptions(connectors, env)');
    expect(chatSurfaceBody).toContain("connectGateFor(state.createActionCategory, 'chat')");
    expect(connectorPickerOptionsBody).toContain('credentialConnectable');
    expect(connectorPickerOptionsBody).toContain("credentialConnectable ? 'needs-credential' : status.kind");
    expect(connectSelectBody).toContain("state.activeTab === 'chat' && state.chatConnectorSession?.active");
    expect(connectSelectBody).toContain("? 'chat'");
    expect(finishBody).toContain("if (surface === 'chat')");
    expect(gateBindBody).toContain("gate.dataset.connectGateSurface === 'chat'");
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

  it('keeps the command Plan Connector setup out of the API-key form grid', () => {
    const commandAiSettingsCss = stylesBetween(
      '.command-ai-panel .ai-settings-card[data-ai-settings-scope="command"] {',
      '.command-ai-panel .ai-settings-card[data-ai-settings-scope="command"] > .ai-settings-intro,',
    );

    expect(commandAiSettingsCss).toContain('grid-template-columns: repeat(4, minmax(0, 1fr));');
    expect(commandAiSettingsCss).toContain('.command-ai-panel .ai-settings-card.plan-connector-settings-card[data-ai-settings-scope="command"]');
    expect(commandAiSettingsCss).toContain('grid-template-columns: minmax(0, 1fr);');
    expect(commandAiSettingsCss).toContain('.command-ai-panel .ai-settings-card.plan-connector-settings-card[data-ai-settings-scope="command"] > *');
    expect(commandAiSettingsCss).toContain('grid-column: 1 / -1;');
    expect(commandAiSettingsCss).toContain('.command-ai-panel .plan-connector-settings-card[data-ai-settings-scope="command"] .website-plan-connector-command code');
    expect(commandAiSettingsCss).toContain('white-space: nowrap;');
  });
});
