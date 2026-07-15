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
    const connectSheetBody = sourceBetween('function connectorConnectSurfaceParts', 'function connectorConnectReadiness');

    expect(preferencesInlineBody).toContain('data-protocol-connector-credential-field="apiKey"');
    expect(preferencesInlineBody).toContain('data-protocol-connector-credential-paste');
    expect(preferencesInlineBody).not.toContain('data-protocol-connector-credential-field="baseUrl"');
    expect(preferencesInlineBody).not.toContain('saved || storageBlocked');
    expect(connectSheetBody).toContain('data-connector-connect-key');
    expect(connectSheetBody).toContain('data-connector-connect-key-paste');
    expect(connectSheetBody).not.toContain('data-connector-connect-baseurl');
    expect(connectSheetBody).toContain('credentialNotice');
    expect(connectSheetBody).not.toContain('credentialLoading || credentialStorageBlocked');
    expect(connectorKeysSource).not.toContain('name="baseUrl"');
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

  it('renders native connector prompts through the shared mobile rail sheet', () => {
    expect(mainSource).toContain("brandLogo(protocolConnectorLogoId(connector.id), 'connector-connect-logo')");
    expect(mainSource).toContain("'connector-connect'");
    expect(mainSource).toContain("sheet === 'connector-connect' ? connectorConnectSurfaceParts()");
    expect(mainSource).toContain("state.activeMobileRailSheet = 'connector-connect'");
    expect(mainSource).toContain('function connectorConnectUsesNativeRailSheet()');
    expect(mainSource).toContain("if (!connectorConnectUsesNativeRailSheet() || !connectorSheet) return '';");
    expect(mainSource).toContain("if (connectorConnectUsesNativeRailSheet()) return '';");
    expect(mainSource).toContain('bindConnectorConnectSurface();');
    expect(mainSource).not.toContain('connector-connect-actions" style=');
    expect(mainSource).not.toContain('style="${sheet ?');

    expect(stylesSource).not.toContain('.connector-connect-overlay.native-sheet');
    expect(stylesSource).not.toContain('.connector-connect-sheet');
    expect(stylesSource).toContain('.route-app .mobile-rail-sheet.connector-connect');
    expect(stylesSource).toContain('grid-template-columns: minmax(104px, 0.72fr) minmax(132px, 1fr);');
    expect(stylesSource).toContain('.connector-connect-secondary,');
    expect(stylesSource).toContain('white-space: nowrap;');
  });

  it('shows provider-branded native wallet connection toasts', () => {
    const toastModelBlock = sourceBetween('interface Toast {', 'const LOCAL_WORKSPACE_BOUNDARY_TOAST_KEY');
    const helperBlock = sourceBetween('function walletConnectionToastTitle', 'async function runDiscover');
    const toastStackBlock = sourceBetween('function toastStack()', 'function pushToast(');
    const connectBlock = sourceBetween('async function runConnect(', 'async function runDisconnect()');
    const disconnectBlock = sourceBetween('async function runDisconnect()', 'async function runReconnectAndroidCached()');

    expect(toastModelBlock).toContain('logoId?: WalletProviderLogoId;');
    expect(helperBlock).toContain("const walletLabel = /\\bwallet$/iu.test(name) ? name : `${name} wallet`;");
    expect(helperBlock).toContain("tf('{name} connected', { name: walletLabel })");
    expect(helperBlock).toContain("tf('{name} disconnected', { name: walletLabel })");
    expect(helperBlock).toContain('function walletToastSnapshot()');
    expect(helperBlock).toContain('pushNativeWalletConnectedToast');
    expect(helperBlock).toContain('pushNativeWalletDisconnectedToast');
    expect(helperBlock).toContain('wallet.logoId ? { logoId: wallet.logoId } : {}');
    expect(toastStackBlock).toContain('toastIconContent(toast)');
    expect(stylesSource).toContain('.toast-wallet-logo');

    expect(connectBlock).toContain('pushNativeWalletConnectedToast();');
    expect(disconnectBlock.indexOf('const disconnectedWalletToast = walletToastSnapshot();')).toBeLessThan(disconnectBlock.indexOf('resetWalletConnection();'));
    expect(disconnectBlock).toContain('pushNativeWalletDisconnectedToast(disconnectedWalletToast);');
    expect(disconnectBlock).not.toContain("t('Local signing session cleared.')");
    expect(disconnectBlock).not.toContain("t('Local signing and cloud workspace sessions cleared.')");
    expect(mainSource).not.toContain("pushToast('success', t('iOS wallet connected'), short(state.address))");
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
    expect(commandAiSettingsCss).toContain('.command-ai-panel .ai-settings-card.plan-connector-settings-card[data-ai-settings-scope="command"] > .ai-review-setup-tabs');
    expect(commandAiSettingsCss).toContain('width: 324px;');
    expect(commandAiSettingsCss).toContain('.command-ai-panel .plan-connector-settings-card[data-ai-settings-scope="command"] .website-plan-connector-command code');
    expect(commandAiSettingsCss).toContain('white-space: nowrap;');
  });

  it('keeps web setup tabs fixed-height and configured API keys in the compact top row', () => {
    const cardBlock = sourceBetween('function aiSettingsCard', 'function aiModeOptions');
    const tabSizingCss = stylesBetween('@media (min-width: 901px) {', '.command-ai-panel .ai-settings-card[data-ai-settings-scope="command"] .ai-security-note');
    const actionCss = stylesBetween(
      '.command-ai-panel .ai-settings-card[data-ai-settings-scope="command"] > .ai-actions.ai-key-actions {',
      '.command-ai-panel .ai-settings-card[data-ai-settings-scope="command"] > .ai-actions button {',
    );

    expect(cardBlock).toContain('desktopConfiguredKeyHeaderVisible = desktopAiSetupHeaderVisible && currentAiKeyActionConfigured();');
    expect(cardBlock).toContain('ai-setup-configured-stack');
    expect(cardBlock).not.toContain('ai-setup-clear-actions');
    expect(cardBlock).not.toContain('const clearButton =');
    expect(cardBlock).not.toContain('ai-key-secondary-action');
    expect(cardBlock).toContain('const inlineAiKeyActionsHtml = `');
    expect(tabSizingCss).toContain('height: 44px;');
    expect(tabSizingCss).toContain('max-height: 44px;');
    expect(tabSizingCss).toContain('flex: 0 1 324px;');
    expect(actionCss).toContain('grid-template-columns: repeat(4, minmax(0, 1fr));');
    expect(actionCss).toContain('grid-column: 1 / span 1;');
  });

  it('keeps subscription connector setup out of the web API-key Local Bridge card', () => {
    const statusHelpers = sourceBetween('function websiteBridgeConnectorStatusMasked', 'function shouldHideAiKeyEntry');
    const localBridgeConnectorBlock = sourceBetween('function localBridgeConnectorSection', 'function bridgeAiConfiguredDisplay');
    const setModeBlock = sourceBetween('function setAiPlannerMode', 'function activeWorkflowMode');
    const clearBlock = sourceBetween('async function runClearAiKey', 'async function runRefreshDeviceAgentStatus');

    expect(statusHelpers).toContain("state.aiSettings.agentEngine !== 'connector'");
    expect(statusHelpers).toContain("state.aiReviewSetupTab === 'api-key'");
    expect(statusHelpers).toContain("status?.engine === 'connector'");
    expect(localBridgeConnectorBlock).toContain('if (websiteApiKeyBridgeProviderMode()) return');
    expect(localBridgeConnectorBlock).toContain("t('Subscription connector')");
    expect(setModeBlock).toContain("state.aiReviewSetupTab = 'api-key';");
    expect(setModeBlock).toContain("state.aiSettings.agentEngine = 'api-key';");
    expect(clearBlock).toContain("state.aiReviewSetupTab = 'api-key';");
    expect(clearBlock).toContain("state.aiSettings.agentEngine = 'api-key';");
  });

  it('keeps the rail Plan Connector fast path compact and functional', () => {
    const panelBlock = sourceBetween('function websitePlanConnectorSetupPanel', 'function commandCenterStoragePanel');
    const actionBlock = sourceBetween("case 'connector-connect':", "case 'open-web-plan-connector':");
    const disconnectBlock = sourceBetween('async function runDisconnectWebsitePlanConnector', 'async function runSelectConnector');
    const routeActivateBlock = sourceBetween('function activateWebsitePlanConnectorSetup', 'function activateAiReviewSetupTab');
    const tabActivateBlock = sourceBetween('function activateAiReviewSetupTab', 'function closeMobileRailSheet');
    const connectorControlBlock = sourceBetween("for (const control of document.querySelectorAll<HTMLSelectElement>('[data-ai-control=\"plan-connector-connector\"]'))", "for (const control of document.querySelectorAll<HTMLSelectElement>('[data-ai-control=\"device-agent-secret-store-mode\"]'))");
    const cssBlock = stylesBetween(
      '.rail-ai-settings .website-plan-connector-panel[data-plan-connector-rail="true"] {',
      '.website-plan-connector-status {',
    );

    expect(panelBlock).toContain("scope === 'rail'");
    expect(panelBlock).toContain('Run your paid plan from Codex, Claude, Gemini, or Antigravity.');
    expect(panelBlock).toContain('Paste this in Terminal to connect and pair your plan.');
    expect(panelBlock).toContain('const disconnectButton = setup.connected');
    expect(panelBlock).not.toContain("state.aiSettings.agentEngine === 'connector' || setup.connected");
    expect(panelBlock).toContain('websiteConnectorSelected ? state.aiStatus : null');
    expect(panelBlock).toContain('rail && !setup.connected');
    expect(panelBlock).toContain('website-plan-connector-refresh-only');
    expect(panelBlock).toContain("rail ? '' : `<ol");
    expect(panelBlock).toContain("rail ? '' : '<p class=\"ai-security-note compact\"");
    expect(panelBlock).toContain('disconnect-web-plan-connector');
    expect(actionBlock).toContain("case 'disconnect-web-plan-connector':");
    expect(routeActivateBlock).toContain("state.aiSettings.agentEngine = 'connector';");
    expect(routeActivateBlock).toContain('Plan Connector route selected.');
    expect(tabActivateBlock).toContain("state.aiReviewSetupTab = tab;");
    expect(tabActivateBlock).toContain('Plan Connector setup opened.');
    expect(tabActivateBlock).not.toContain("state.aiSettings.agentEngine = 'connector';");
    expect(connectorControlBlock).not.toContain("state.aiSettings.agentEngine = 'connector';");
    expect(disconnectBlock).toContain("state.aiReviewSetupTab = 'plan-connector';");
    expect(disconnectBlock).not.toContain("state.aiReviewSetupTab = 'api-key';");
    expect(disconnectBlock).toContain("bridgeRequest<BridgeAiStatus>('/bridge/ai/session-key'");
    expect(disconnectBlock).not.toContain('const stillConnected =');
    expect(disconnectBlock).not.toContain('Plan Connector still connected');
    expect(cssBlock).toContain('data-plan-connector-rail="true"');
  });

  it('gives every web Plan Connector option its own logo', () => {
    const logoTypeBlock = sourceBetween('type BrandLogoId =', 'const BRAND_LOGOS');
    const logosBlock = sourceBetween('const BRAND_LOGOS', 'const KNOWN_TOKEN_LOGOS');
    const optionsBlock = sourceBetween('function planConnectorOptions', 'function planConnectorSelectPicker');
    const brandLogoBlock = sourceBetween('function connectorBrandLogoId', 'function applyPairedRelayPresence');
    const railLogoBlock = sourceBetween('function connectorRailLogoHint', 'function connectorBrandLogoId');

    expect(logoTypeBlock).toContain("'antigravity'");
    expect(logosBlock).toContain('antigravity.svg');
    expect(optionsBlock).toContain('logoId: connectorBrandLogoId(connector)');
    expect(brandLogoBlock).toContain("case 'antigravity':");
    expect(brandLogoBlock).toContain("return 'antigravity';");
    expect(railLogoBlock).toContain("case 'antigravity':");
    expect(mainSource).toContain("const PLAN_CONNECTOR_CHOICES: AiConnector[] = ['codex', 'claude', 'gemini', 'antigravity'];");
  });

  it('keeps the Connect AI safety copy concise without dropping the key boundary', () => {
    const noAiBlock = sourceBetween('function commandAiNoAiCard', 'function commandAiDataDisclosure');
    const mobileBoundaryBlock = sourceBetween('function commandCenterAiPanel', 'function commandAiRouteCards');
    const disclosureBlock = sourceBetween('function commandAiDataDisclosure', 'function commandAiPrincipleCard');
    const cardCss = stylesBetween('.command-ai-data-disclosure {', '.command-ai-data-disclosure strong');

    expect(noAiBlock).toContain('AI prepares drafts; you approve in your wallet. Private keys never leave your wallet.');
    expect(mobileBoundaryBlock).toContain('AI prepares drafts; you approve in your wallet. Private keys never leave your wallet.');
    expect(disclosureBlock).toContain('never your keys, seed phrase, or location');
    expect(mainSource).not.toContain('No AI route can approve, submit, sign, move funds, or change workflow authority.');
    expect(cardCss).toContain('.command-ai-two-col .command-ai-data-disclosure');
    expect(cardCss).toContain('height: 100%;');
    expect(cardCss).toContain('margin-top: 0;');
  });
});
