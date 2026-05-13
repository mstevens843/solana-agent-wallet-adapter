import type { AgentPlanTemplate, AgentPlanTemplateField } from './planner.js';
import {
  PROTOCOL_CONNECTORS,
  connectorHasCapability,
  findProtocolConnectorByInput,
  getAdapterMeta,
  isClusterSupported,
  isDappEnabled,
  protocolConnectorPlannerContext,
  type ConnectedDappsState,
  type ProtocolConnector,
  type ProtocolConnectorId,
} from './connectedDapps.js';
import { normalizeBlinkUrl } from './protocolActions.js';

export type ConnectorDraftMode = 'template' | 'ai';
export type ConnectorActionExecutionMode = 'first-class-adapter' | 'blink' | 'read-only';

export interface ConnectorSubAction {
  id: string;
  label: string;
  description: string;
  actionType: string;
  fields: AgentPlanTemplateField[];
}

export interface ConnectorSubActionGroup {
  fieldId: string;
  label: string;
  options: ConnectorSubAction[];
  defaultId?: string;
}

export interface ConnectorActionForm {
  id: string;
  connectorId: ProtocolConnectorId;
  operationId: string;
  operationLabel: string;
  templateId: string;
  description: string;
  actionType?: string;
  executionMode: ConnectorActionExecutionMode;
  outcome: 'queueable' | 'audit';
  requiresBlinkUrl?: boolean;
  fields: AgentPlanTemplateField[];
  subActions?: ConnectorSubActionGroup;
}

export interface ConnectorDraftEnvironment {
  connectedDapps: ConnectedDappsState;
  cluster: string;
  dialectClientKeyConfigured?: boolean;
}

export interface ConnectorDraftValidationResult {
  connector?: ProtocolConnector;
  parameters: Record<string, string>;
  errors: Record<string, string>;
  missingFacts: string[];
}

const CONNECTOR_ACTION_FORMS: ConnectorActionForm[] = [
  connectorActionForm('kamino', 'deposit', 'Deposit', 'kamino-deposit', 'Supply tokens to a Kamino Lend reserve.', 'first-class-adapter', 'queueable', [
    kaminoReserveField(true),
    formField('amount', 'Amount', true),
    formField('memo', 'Reason'),
  ], false, 'kamino_deposit'),
  connectorActionForm('kamino', 'withdraw', 'Withdraw', 'kamino-withdraw', 'Redeem supplied tokens from Kamino Lend.', 'first-class-adapter', 'queueable', [
    kaminoReserveField(true),
    formField('amount', 'Amount'),
    formField('memo', 'Reason'),
  ], false, 'kamino_withdraw'),
  connectorActionForm('kamino', 'earnings-proof', 'Earnings proof', 'kamino-earnings-proof', 'Build a signable Kamino earnings receipt.', 'read-only', 'audit', [
    kaminoReserveField(false),
    formField('memo', 'Reason'),
  ]),
  connectorActionForm('jupiter', 'swap', 'Prepare swap', 'swap', 'Prepare a Jupiter swap review with explicit tokens, amount, and slippage.', 'first-class-adapter', 'queueable', [
    formField('inputToken', 'Input token', true),
    formField('outputToken', 'Output token', true),
    formField('amount', 'Token amount', true),
    formField('slippageBps', 'Max slippage'),
  ], false, 'swap'),
  jupiterLendUnifiedForm(),
  ...marginfiForms(),
  ...saveForms(),
  ...driftForms(),
  luloUnifiedForm(),
  raydiumLiquidityUnifiedForm(),
];

export function isConnectorCapableTemplate(
  template: Pick<AgentPlanTemplate, 'id' | 'actionType' | 'connectorCapability'>,
): boolean {
  return template.id === 'protocol-blink-action' ||
    template.actionType === 'blink_action' ||
    Boolean(template.connectorCapability);
}

export function connectorCreateConnectors(
  env: ConnectorDraftEnvironment,
): ProtocolConnector[] {
  return PROTOCOL_CONNECTORS
    .filter((connector) => connectorActionFormsForConnector(connector).length > 0)
    .slice()
    .sort((left, right) => {
      const leftRank = connectorCreateRank(left, env);
      const rightRank = connectorCreateRank(right, env);
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.name.localeCompare(right.name);
    });
}

export function connectorCreateStatus(
  connector: ProtocolConnector,
  env: ConnectorDraftEnvironment,
): {
  selectable: boolean;
  enabled: boolean;
  clusterSupported: boolean;
  label: string;
  detail: string;
  meta: string;
} {
  const clusterSupported = isClusterSupported(connector, env.cluster);
  const enabled = isDappEnabled(connector.id, env.connectedDapps, env.cluster);
  const forms = connectorActionFormsForConnector(connector);
  if (forms.length === 0) {
    return {
      selectable: false,
      enabled: false,
      clusterSupported,
      label: 'Unavailable',
      meta: 'No Create flow',
      detail: `${connector.name} does not expose a Create flow yet.`,
    };
  }
  if (!clusterSupported) {
    return {
      selectable: false,
      enabled: false,
      clusterSupported,
      label: 'Wrong cluster',
      meta: 'Unavailable',
      detail: `${connector.name} is available on ${connector.supportedClusters.join(', ')} only.`,
    };
  }
  if (!enabled) {
    return {
      selectable: false,
      enabled: false,
      clusterSupported,
      label: 'Connector disabled',
      meta: 'Off',
      detail: `${connector.name} is disabled. Enable it in Protocol Connectors before preparing work.`,
    };
  }
  return {
    selectable: true,
    enabled: true,
    clusterSupported: true,
    label: connector.actionSource === 'first-class-adapter' ? 'First-class adapter' : 'Blink-backed',
    meta: connector.actionSource === 'first-class-adapter' ? 'First-class' : 'Blink connector',
    detail: connector.actionSource === 'first-class-adapter'
      ? 'First-class adapter. Agentic can prepare connector-backed work; wallet still signs after review.'
      : 'Blink-backed. Requires an action URL. Wallet signs only after review.',
  };
}

export function connectorActionFormsForConnector(
  connector: ProtocolConnector,
): ConnectorActionForm[] {
  const explicitForms = CONNECTOR_ACTION_FORMS.filter((form) => form.connectorId === connector.id);
  const explicitActionTypes = new Set<string>();
  for (const form of explicitForms) {
    if (form.actionType) explicitActionTypes.add(form.actionType);
    if (form.subActions) {
      for (const branch of form.subActions.options) {
        if (branch.actionType) explicitActionTypes.add(branch.actionType);
      }
    }
  }
  const generatedForms = connector.actionKinds
    .filter((actionKind) => !explicitActionTypes.has(actionKind))
    .map((actionKind) => generatedConnectorActionForm(connector, actionKind));
  const generic: ConnectorActionForm[] = [];
  if (
    connectorHasCapability(connector, 'read_positions') ||
    connectorHasCapability(connector, 'read_rewards') ||
    connectorHasCapability(connector, 'read_markets')
  ) {
    generic.push(genericReadForm(connector));
  }
  if (connectorHasCapability(connector, 'blink_actions')) {
    generic.push(genericBlinkForm(connector));
  }
  return [...explicitForms, ...generatedForms, ...generic];
}

export function connectorActionFormById(id: string | undefined): ConnectorActionForm | undefined {
  const formId = id?.trim();
  if (!formId) return undefined;
  for (const connector of PROTOCOL_CONNECTORS) {
    const form = connectorActionFormsForConnector(connector).find((candidate) => candidate.id === formId);
    if (form) return form;
  }
  return undefined;
}

export function connectorActionFormForTemplate(
  template: Pick<AgentPlanTemplate, 'id'>,
  connector?: ProtocolConnector,
): ConnectorActionForm | undefined {
  if (connector) {
    return connectorActionFormsForConnector(connector).find((form) => form.templateId === template.id);
  }
  return PROTOCOL_CONNECTORS
    .flatMap((candidate) => connectorActionFormsForConnector(candidate))
    .find((form) => form.templateId === template.id);
}

export function selectedConnectorActionForm(
  parameters: Record<string, string>,
): ConnectorActionForm | undefined {
  const explicit = connectorActionFormById(parameters.connectorOperationId);
  if (explicit) return explicit;
  const connector = selectedConnectorForDraftParameters(parameters);
  if (!connector) return undefined;
  const normalizedOperation = normalizeActionLabel(parameters.operation ?? '');
  return connectorActionFormsForConnector(connector).find((form) =>
    normalizeActionLabel(form.operationLabel) === normalizedOperation ||
    normalizeActionLabel(form.operationId) === normalizedOperation ||
    form.templateId === parameters.templateId,
  );
}

export function selectedConnectorForDraftParameters(
  parameters: Record<string, string>,
): ProtocolConnector | undefined {
  const protocol = parameters.protocol?.trim();
  const byProtocol = protocolConnectorById(protocol) ?? findProtocolConnectorByInput(protocol);
  if (byProtocol) return byProtocol;
  const byConnectorId = protocolConnectorById(parameters.connectorId?.trim());
  if (byConnectorId) return byConnectorId;
  return findProtocolConnectorByInput(
    parameters.dapp || parameters.provider || parameters.route,
  );
}

export function connectorDraftConnectors(
  env: ConnectorDraftEnvironment,
): ProtocolConnector[] {
  return PROTOCOL_CONNECTORS
    .filter((connector) => connectorHasCapability(connector, 'blink_actions'))
    .slice()
    .sort((left, right) => {
      const leftRank = connectorDraftRank(left, env);
      const rightRank = connectorDraftRank(right, env);
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.name.localeCompare(right.name);
    });
}

export function connectorDraftStatus(
  connector: ProtocolConnector,
  env: ConnectorDraftEnvironment,
): {
  selectable: boolean;
  enabled: boolean;
  clusterSupported: boolean;
  label: string;
  detail: string;
  meta: string;
} {
  const clusterSupported = isClusterSupported(connector, env.cluster);
  const enabled = isDappEnabled(connector.id, env.connectedDapps, env.cluster);
  const hasBlink = connectorHasCapability(connector, 'blink_actions');
  if (!hasBlink) {
    return {
      selectable: false,
      enabled: false,
      clusterSupported,
      label: 'Unavailable',
      meta: 'Unsupported',
      detail: `${connector.name} does not expose Blink actions in this connector catalog.`,
    };
  }
  if (!clusterSupported) {
    return {
      selectable: false,
      enabled: false,
      clusterSupported,
      label: 'Wrong cluster',
      meta: 'Unavailable',
      detail: `${connector.name} is available on ${connector.supportedClusters.join(', ')} only.`,
    };
  }
  if (!enabled) {
    return {
      selectable: false,
      enabled: false,
      clusterSupported,
      label: 'Connector disabled',
      meta: 'Off',
      detail: `${connector.name} is disabled. Enable it in Protocol Connectors before preparing executable work.`,
    };
  }
  return {
    selectable: true,
    enabled: true,
    clusterSupported,
    label: connector.actionSource === 'first-class-adapter' ? 'First-class adapter' : 'Blink-backed',
    meta: connector.actionSource === 'first-class-adapter' ? 'First-class' : 'Blink connector',
    detail: connector.actionSource === 'first-class-adapter'
      ? 'First-class adapter. Agentic can prepare connector-backed work; wallet still signs after review.'
      : 'Blink-backed. Requires an action URL. Wallet signs only after review.',
  };
}

export function normalizeConnectorDraftParameters(
  template: Pick<AgentPlanTemplate, 'id' | 'actionType' | 'connectorCapability'>,
  parameters: Record<string, string>,
): Record<string, string> {
  const connector = selectedConnectorForDraftParameters(parameters);
  if (!connector && !isConnectorCapableTemplate(template)) return { ...parameters };
  if (!connector) return { ...parameters };
  const explicitForm = connectorActionFormById(parameters.connectorOperationId);
  const form = explicitForm ?? connectorActionFormForTemplate(template, connector);
  const operation = explicitForm?.operationLabel ?? normalizedConnectorOperation(connector, parameters.operation);
  const shouldPersistForm = Boolean(explicitForm || (form && !isGenericConnectorActionForm(form)));
  return {
    ...parameters,
    connectorId: connector.id,
    protocol: connector.name,
    operation,
    ...(shouldPersistForm && form ? { connectorOperationId: form.id } : {}),
    connectorActionSource: form?.executionMode === 'blink'
      ? 'blink'
      : form?.executionMode === 'read-only'
        ? 'read-only'
        : connector.actionSource ?? 'blink',
  };
}

export function stripConnectorDraftExtras(
  template: Pick<AgentPlanTemplate, 'fields'>,
  parameters: Record<string, string>,
): Record<string, string> {
  const next = { ...parameters };
  const fieldIds = new Set(template.fields.map((field) => field.id));
  for (const key of ['connectorId', 'connectorActionSource', 'dapp', 'provider', 'actionUrl']) {
    if (!fieldIds.has(key)) delete next[key];
  }
  for (const key of ['protocol', 'operation', 'blinkUrl', 'position']) {
    if (!fieldIds.has(key)) delete next[key];
  }
  return next;
}

export function validateConnectorDraftParameters(
  template: Pick<AgentPlanTemplate, 'id' | 'actionType' | 'connectorCapability'>,
  parameters: Record<string, string>,
  env: ConnectorDraftEnvironment,
  mode: ConnectorDraftMode,
): ConnectorDraftValidationResult {
  const normalized = normalizeConnectorDraftParameters(template, parameters);
  const connector = selectedConnectorForDraftParameters(normalized);
  const connectorAware = isConnectorCapableTemplate(template) || Boolean(connector);
  if (!connectorAware) {
    return { parameters: normalized, errors: {}, missingFacts: [] };
  }

  const errors: Record<string, string> = {};
  const missingFacts: string[] = [];
  if (!connector) {
    errors.protocol = 'Choose one enabled Protocol Connector before preparing connector-backed work.';
    missingFacts.push('protocol connector');
    return { parameters: normalized, errors, missingFacts };
  }

  const requiresBlink = connectorDraftRequiresBlink(template, normalized);
  if (requiresBlink && !connectorHasCapability(connector, 'blink_actions')) {
    errors.protocol = `${connector.name} does not expose Blink actions in this connector catalog.`;
  } else if (!isClusterSupported(connector, env.cluster)) {
    errors.protocol = `${connector.name} is only available on ${connector.supportedClusters.join(', ')}; current cluster is ${env.cluster}.`;
  } else if (!isDappEnabled(connector.id, env.connectedDapps, env.cluster)) {
    errors.protocol = `${connector.name} is not enabled. Enable it in Protocol Connectors before sending.`;
  }

  const url = normalized.blinkUrl?.trim() || normalized.actionUrl?.trim() || '';
  if (requiresBlink && !url) {
    missingFacts.push('Blink/Solana Action URL');
    if (mode === 'template') {
      errors.blinkUrl = `${connector.name} requires a Blink/Solana Action URL for executable work.`;
    }
  } else if (url) {
    try {
      normalized.blinkUrl = normalizeBlinkUrl(url);
    } catch (err) {
      errors.blinkUrl = err instanceof Error ? err.message : 'Blink/Solana Action URL is invalid.';
    }
  }

  if (!normalized.operation?.trim()) missingFacts.push('operation');
  return { connector, parameters: normalized, errors, missingFacts };
}

function connectorActionForm(
  connectorId: ProtocolConnectorId,
  operationId: string,
  operationLabel: string,
  templateId: string,
  description: string,
  executionMode: ConnectorActionExecutionMode,
  outcome: ConnectorActionForm['outcome'],
  fields: AgentPlanTemplateField[],
  requiresBlinkUrl = false,
  actionType?: string,
): ConnectorActionForm {
  return {
    id: `${connectorId}:${operationId}`,
    connectorId,
    operationId,
    operationLabel,
    templateId,
    description,
    ...(actionType ? { actionType } : {}),
    executionMode,
    outcome,
    requiresBlinkUrl,
    fields,
  };
}

function formField(id: string, label: string, required = false): AgentPlanTemplateField {
  return { id, label, required, type: 'text' };
}

function formSelectField(
  id: string,
  label: string,
  options: string[],
  defaultValue: string,
  required = false,
): AgentPlanTemplateField {
  return { id, label, options, defaultValue, required, type: 'select' };
}

function cascadingField(
  id: string,
  label: string,
  providerId: string,
  options: {
    required?: boolean;
    dependsOn?: string[];
    allowManualFallback?: boolean;
    emptyHint?: string;
    placeholder?: string;
  } = {},
): AgentPlanTemplateField {
  return {
    id,
    label,
    type: 'cascading-select',
    ...(options.required !== undefined ? { required: options.required } : {}),
    ...(options.placeholder !== undefined ? { placeholder: options.placeholder } : {}),
    cascading: {
      dependsOn: options.dependsOn ?? [],
      providerId,
      allowManualFallback: options.allowManualFallback ?? true,
      ...(options.emptyHint !== undefined ? { emptyHint: options.emptyHint } : {}),
    },
  };
}

function kaminoReserveField(required: boolean): AgentPlanTemplateField {
  return cascadingField('token', 'Kamino reserve', 'kamino.reserve', {
    required,
    allowManualFallback: true,
    emptyHint: "Couldn't load Kamino reserves. Paste a reserve symbol (USDC, SOL, JitoSOL) or mint address.",
    placeholder: 'USDC',
  });
}

function marginfiBankField(required: boolean): AgentPlanTemplateField {
  return cascadingField('bankAddress', 'MarginFi bank', 'marginfi.bank', {
    required,
    emptyHint: "Couldn't load MarginFi banks. Paste a bank address or token symbol.",
  });
}

function marginfiForms(): ConnectorActionForm[] {
  const amountField = formField('amount', 'Amount', true);
  const healthField = formField('minHealthFactor', 'Minimum health factor');
  return [
    connectorActionForm('marginfi', 'deposit', 'Deposit', 'connector-marginfi-deposit', 'Supply tokens to a MarginFi bank.', 'first-class-adapter', 'queueable', [
      marginfiBankField(true),
      amountField,
      healthField,
      formField('memo', 'Reason'),
    ], false, 'marginfi_deposit'),
    connectorActionForm('marginfi', 'withdraw', 'Withdraw', 'connector-marginfi-withdraw', 'Redeem supplied tokens from a MarginFi bank.', 'first-class-adapter', 'queueable', [
      marginfiBankField(true),
      formField('amount', 'Amount'),
      healthField,
      formField('memo', 'Reason'),
    ], false, 'marginfi_withdraw'),
    connectorActionForm('marginfi', 'borrow', 'Borrow', 'connector-marginfi-borrow', 'Borrow against MarginFi collateral.', 'first-class-adapter', 'queueable', [
      marginfiBankField(true),
      amountField,
      healthField,
      formField('memo', 'Reason'),
    ], false, 'marginfi_borrow'),
    connectorActionForm('marginfi', 'repay', 'Repay', 'connector-marginfi-repay', 'Repay a MarginFi loan.', 'first-class-adapter', 'queueable', [
      marginfiBankField(true),
      formField('amount', 'Amount'),
      healthField,
      formField('memo', 'Reason'),
    ], false, 'marginfi_repay'),
  ];
}

function saveReserveField(required: boolean): AgentPlanTemplateField {
  return cascadingField('reserveAddress', 'Save reserve', 'save.reserve', {
    required,
    emptyHint: "Couldn't load Save reserves. Paste a reserve address or token symbol.",
  });
}

function saveForms(): ConnectorActionForm[] {
  const healthField = formField('minHealthFactor', 'Minimum health factor');
  return [
    connectorActionForm('save', 'deposit', 'Deposit', 'connector-save-deposit', 'Supply tokens to a Save reserve.', 'first-class-adapter', 'queueable', [
      saveReserveField(true),
      formField('amount', 'Amount', true),
      healthField,
      formField('memo', 'Reason'),
    ], false, 'save_deposit'),
    connectorActionForm('save', 'withdraw', 'Withdraw', 'connector-save-withdraw', 'Redeem supplied tokens from a Save reserve.', 'first-class-adapter', 'queueable', [
      saveReserveField(true),
      formField('amount', 'Amount'),
      healthField,
      formField('memo', 'Reason'),
    ], false, 'save_withdraw'),
    connectorActionForm('save', 'borrow', 'Borrow', 'connector-save-borrow', 'Borrow against Save collateral.', 'first-class-adapter', 'queueable', [
      saveReserveField(true),
      formField('amount', 'Amount', true),
      healthField,
      formField('memo', 'Reason'),
    ], false, 'save_borrow'),
    connectorActionForm('save', 'repay', 'Repay', 'connector-save-repay', 'Repay a Save loan.', 'first-class-adapter', 'queueable', [
      saveReserveField(true),
      formField('amount', 'Amount'),
      healthField,
      formField('memo', 'Reason'),
    ], false, 'save_repay'),
  ];
}

function driftVaultField(required: boolean): AgentPlanTemplateField {
  return cascadingField('vaultAddress', 'Drift vault', 'drift.vault', {
    required,
    emptyHint: "Couldn't load Drift vaults. Paste a vault address.",
  });
}

function driftForms(): ConnectorActionForm[] {
  return [
    connectorActionForm('drift', 'vault-deposit', 'Vault deposit', 'drift-vault-deposit', 'Deposit into a Drift strategy vault.', 'first-class-adapter', 'queueable', [
      driftVaultField(true),
      formField('amount', 'Amount', true),
      formField('mint', 'Deposit mint'),
      formField('memo', 'Reason'),
    ], false, 'drift_vault_deposit'),
    connectorActionForm('drift', 'request-withdraw', 'Request withdraw', 'drift-vault-request-withdraw', 'Request a Drift vault withdrawal.', 'first-class-adapter', 'queueable', [
      driftVaultField(true),
      formField('withdrawUnit', 'Withdraw unit'),
      formField('amount', 'Token amount'),
      formField('shares', 'Share amount'),
      formField('memo', 'Reason'),
    ], false, 'drift_vault_request_withdraw'),
    connectorActionForm('drift', 'cancel-withdraw', 'Cancel withdraw', 'drift-vault-cancel-withdraw', 'Cancel a pending Drift vault withdrawal request.', 'first-class-adapter', 'queueable', [
      driftVaultField(true),
      formField('memo', 'Reason'),
    ], false, 'drift_vault_cancel_withdraw'),
    connectorActionForm('drift', 'complete-withdraw', 'Complete withdraw', 'drift-vault-complete-withdraw', 'Complete a Drift vault withdrawal after the redeem period.', 'first-class-adapter', 'queueable', [
      driftVaultField(true),
      formField('memo', 'Reason'),
    ], false, 'drift_vault_complete_withdraw'),
  ];
}

function luloMintField(required: boolean): AgentPlanTemplateField {
  return cascadingField('mintAddress', 'Lulo mint', 'lulo.mint', {
    required,
    emptyHint: "Couldn't load Lulo mints. Paste a mint address or token symbol.",
  });
}

function luloUnifiedForm(): ConnectorActionForm {
  const mintField = luloMintField(true);
  return {
    id: 'lulo:flow',
    connectorId: 'lulo',
    operationId: 'flow',
    operationLabel: 'Deposit or withdraw',
    templateId: 'connector-lulo-flow',
    description: 'Deposit, withdraw, or complete Lulo flows across protected, boost, or regular tiers.',
    executionMode: 'first-class-adapter',
    outcome: 'queueable',
    fields: [formField('memo', 'Reason')],
    subActions: {
      fieldId: 'subAction',
      label: 'Lulo flow',
      defaultId: 'deposit-protected',
      options: [
        {
          id: 'deposit-protected',
          label: 'Deposit — Protected',
          description: 'Insured deposit tier.',
          actionType: 'lulo_deposit',
          fields: [mintField, formField('amount', 'Amount', true), { id: 'depositType', label: 'Tier', type: 'select', options: ['protected'], defaultValue: 'protected' }],
        },
        {
          id: 'deposit-boost',
          label: 'Deposit — Boost',
          description: 'Higher-yield boost tier.',
          actionType: 'lulo_deposit',
          fields: [mintField, formField('amount', 'Amount', true), { id: 'depositType', label: 'Tier', type: 'select', options: ['boost'], defaultValue: 'boost' }],
        },
        {
          id: 'deposit-regular',
          label: 'Deposit — Regular',
          description: 'Standard deposit tier.',
          actionType: 'lulo_deposit',
          fields: [mintField, formField('amount', 'Amount', true), { id: 'depositType', label: 'Tier', type: 'select', options: ['regular'], defaultValue: 'regular' }],
        },
        {
          id: 'withdraw-protected',
          label: 'Withdraw — Protected',
          description: 'Withdraw from the protected tier.',
          actionType: 'lulo_withdraw',
          fields: [mintField, formField('amount', 'Amount'), { id: 'withdrawType', label: 'Tier', type: 'select', options: ['protected'], defaultValue: 'protected' }, formField('percentage', 'Percentage')],
        },
        {
          id: 'withdraw-regular',
          label: 'Withdraw — Regular',
          description: 'Withdraw from the regular tier (two-phase).',
          actionType: 'lulo_withdraw',
          fields: [mintField, formField('amount', 'Amount'), { id: 'withdrawType', label: 'Tier', type: 'select', options: ['regular'], defaultValue: 'regular' }, formField('percentage', 'Percentage')],
        },
        {
          id: 'complete-withdraw',
          label: 'Complete withdraw',
          description: 'Finalize a previously initiated regular withdrawal.',
          actionType: 'lulo_complete_withdraw',
          fields: [mintField, formField('withdrawalId', 'Withdrawal id', true)],
        },
      ],
    },
  };
}

function raydiumPoolField(providerId: string, required: boolean): AgentPlanTemplateField {
  return cascadingField('poolId', 'Raydium pool', providerId, {
    required,
    emptyHint: "Couldn't load Raydium pools. Paste a pool id.",
  });
}

function raydiumLiquidityUnifiedForm(): ConnectorActionForm {
  return {
    id: 'raydium:liquidity-flow',
    connectorId: 'raydium',
    operationId: 'liquidity',
    operationLabel: 'Liquidity',
    templateId: 'connector-raydium-liquidity',
    description: 'Add or remove Raydium liquidity. CPMM pools take full-range deposits; CLMM pools require a price range and produce a position NFT.',
    executionMode: 'first-class-adapter',
    outcome: 'queueable',
    fields: [formField('memo', 'Reason')],
    subActions: {
      fieldId: 'subAction',
      label: 'Pool type',
      defaultId: 'cpmm-add',
      options: [
        {
          id: 'cpmm-add',
          label: 'CPMM — add liquidity',
          description: 'Constant-product full-range deposit.',
          actionType: 'raydium_add_liquidity',
          fields: [
            raydiumPoolField('raydium.cpmm.pool', true),
            { id: 'poolType', label: 'Pool type', type: 'select', options: ['cpmm'], defaultValue: 'cpmm' },
            formField('amount', 'Amount', true),
          ],
        },
        {
          id: 'clmm-add',
          label: 'CLMM — add liquidity',
          description: 'Concentrated-liquidity range deposit.',
          actionType: 'raydium_add_liquidity',
          fields: [
            raydiumPoolField('raydium.clmm.pool', true),
            { id: 'poolType', label: 'Pool type', type: 'select', options: ['clmm'], defaultValue: 'clmm' },
            cascadingField('positionMint', 'Existing position', 'raydium.position', {
              dependsOn: ['poolId'],
              emptyHint: 'No CLMM positions found in this pool. Leave blank to open a new one.',
            }),
            formField('lowerPrice', 'Lower price'),
            formField('upperPrice', 'Upper price'),
            formField('amount', 'Amount'),
          ],
        },
        {
          id: 'cpmm-remove',
          label: 'CPMM — remove liquidity',
          description: 'Withdraw from a constant-product pool.',
          actionType: 'raydium_remove_liquidity',
          fields: [
            raydiumPoolField('raydium.cpmm.pool', true),
            { id: 'poolType', label: 'Pool type', type: 'select', options: ['cpmm'], defaultValue: 'cpmm' },
            formField('amount', 'Amount'),
          ],
        },
        {
          id: 'clmm-remove',
          label: 'CLMM — remove liquidity',
          description: 'Close or shrink a concentrated-liquidity position.',
          actionType: 'raydium_remove_liquidity',
          fields: [
            raydiumPoolField('raydium.clmm.pool', true),
            { id: 'poolType', label: 'Pool type', type: 'select', options: ['clmm'], defaultValue: 'clmm' },
            cascadingField('positionMint', 'CLMM position', 'raydium.position', {
              required: true,
              dependsOn: ['poolId'],
              emptyHint: 'No CLMM positions found in this pool yet.',
            }),
            formField('amount', 'Amount'),
          ],
        },
        {
          id: 'collect-fees',
          label: 'CLMM — collect fees',
          description: 'Harvest CLMM fees accrued by a position.',
          actionType: 'raydium_collect_fees',
          fields: [
            raydiumPoolField('raydium.clmm.pool', true),
            { id: 'poolType', label: 'Pool type', type: 'select', options: ['clmm'], defaultValue: 'clmm' },
            cascadingField('positionMint', 'CLMM position', 'raydium.position', {
              required: true,
              dependsOn: ['poolId'],
              emptyHint: 'No CLMM positions found in this pool yet.',
            }),
          ],
        },
      ],
    },
  };
}

function jupiterLendUnifiedForm(): ConnectorActionForm {
  const memo = formField('memo', 'Reason');
  const earnAsset = cascadingField('assetMint', 'Earn asset', 'jupiter.lend.earn.asset', {
    required: true,
    emptyHint: "Couldn't load Jupiter Lend earn pools. Paste an asset mint to continue.",
  });
  const borrowVault = cascadingField('vaultId', 'Borrow vault', 'jupiter.lend.borrow.vault', {
    required: true,
    emptyHint: "Couldn't load Jupiter Lend borrow vaults. Paste a vault id to continue.",
  });
  const borrowPosition = cascadingField('positionId', 'Borrow position', 'jupiter.lend.borrow.position', {
    dependsOn: ['vaultId'],
    emptyHint: 'No positions found in this vault yet. Leave blank to create a new one.',
  });
  return {
    id: 'jupiter:lend-flow',
    connectorId: 'jupiter',
    operationId: 'lend',
    operationLabel: 'Lend',
    templateId: 'connector-jupiter-lend',
    description: 'Earn yield in a Jupiter Lend pool or borrow against collateral.',
    executionMode: 'first-class-adapter',
    outcome: 'queueable',
    fields: [memo],
    subActions: {
      fieldId: 'subAction',
      label: 'Lend type',
      defaultId: 'earn-deposit',
      options: [
        {
          id: 'earn-deposit',
          label: 'Earn — deposit',
          description: 'Supply tokens to a Jupiter Lend earn pool.',
          actionType: 'jupiter_lend_earn_deposit',
          fields: [earnAsset, formField('amount', 'Amount', true)],
        },
        {
          id: 'earn-withdraw',
          label: 'Earn — withdraw',
          description: 'Redeem deposited tokens from a Jupiter Lend earn pool.',
          actionType: 'jupiter_lend_earn_withdraw',
          fields: [earnAsset, formField('amount', 'Amount'), formField('shares', 'Shares')],
        },
        {
          id: 'earn-mint',
          label: 'Earn — mint shares',
          description: 'Mint earn pool shares directly.',
          actionType: 'jupiter_lend_earn_mint',
          fields: [earnAsset, formField('amount', 'Amount', true)],
        },
        {
          id: 'earn-redeem',
          label: 'Earn — redeem shares',
          description: 'Redeem earn pool shares for the underlying asset.',
          actionType: 'jupiter_lend_earn_redeem',
          fields: [earnAsset, formField('shares', 'Shares', true)],
        },
        {
          id: 'borrow-create',
          label: 'Borrow — create position',
          description: 'Open a new collateralized borrow position.',
          actionType: 'jupiter_lend_borrow_create_position',
          fields: [borrowVault],
        },
        {
          id: 'borrow-deposit-collateral',
          label: 'Borrow — deposit collateral',
          description: 'Add collateral to an existing borrow position.',
          actionType: 'jupiter_lend_borrow_deposit_collateral',
          fields: [borrowVault, borrowPosition, formField('collateralAmount', 'Collateral amount', true)],
        },
        {
          id: 'borrow-borrow',
          label: 'Borrow — draw',
          description: 'Borrow against the position’s collateral.',
          actionType: 'jupiter_lend_borrow_borrow',
          fields: [borrowVault, borrowPosition, formField('borrowAmount', 'Borrow amount', true), formField('minHealthRatio', 'Minimum health ratio')],
        },
        {
          id: 'borrow-repay',
          label: 'Borrow — repay',
          description: 'Repay outstanding debt on the position.',
          actionType: 'jupiter_lend_borrow_repay',
          fields: [borrowVault, borrowPosition, formField('amount', 'Repay amount', true)],
        },
        {
          id: 'borrow-withdraw-collateral',
          label: 'Borrow — withdraw collateral',
          description: 'Withdraw collateral once health permits.',
          actionType: 'jupiter_lend_borrow_withdraw_collateral',
          fields: [borrowVault, borrowPosition, formField('amount', 'Withdraw amount', true), formField('minHealthRatio', 'Minimum health ratio')],
        },
      ],
    },
  };
}

function generatedConnectorActionForm(connector: ProtocolConnector, actionKind: string): ConnectorActionForm {
  const operationId = connectorOperationIdFromActionKind(connector, actionKind);
  const operationLabel = connectorOperationLabelFromActionKind(connector, actionKind);
  return connectorActionForm(
    connector.id,
    operationId,
    operationLabel,
    connectorActionTemplateId(actionKind),
    `${operationLabel} through ${connector.name}. Prepares wallet approval work only; the wallet owner still reviews and signs separately.`,
    connector.actionSource === 'blink' ? 'blink' : 'first-class-adapter',
    'queueable',
    connectorActionFields(actionKind),
    false,
    actionKind,
  );
}

export function connectorActionTemplateId(actionKind: string): string {
  return `connector-${actionKind.trim().toLowerCase().replace(/_/g, '-')}`;
}

export function selectedSubAction(
  form: ConnectorActionForm,
  parameters?: Record<string, string>,
): ConnectorSubAction | undefined {
  if (!form.subActions) return undefined;
  const requested = parameters?.[form.subActions.fieldId]?.trim();
  if (requested) {
    const match = form.subActions.options.find((option) => option.id === requested);
    if (match) return match;
  }
  const defaultId = form.subActions.defaultId ?? form.subActions.options[0]?.id;
  return form.subActions.options.find((option) => option.id === defaultId) ?? form.subActions.options[0];
}

export function effectiveFormFields(
  form: ConnectorActionForm,
  parameters?: Record<string, string>,
): AgentPlanTemplateField[] {
  const branch = selectedSubAction(form, parameters);
  if (!branch) return form.fields;
  const branchIds = new Set(branch.fields.map((field) => field.id));
  return [...form.fields.filter((field) => !branchIds.has(field.id)), ...branch.fields];
}

export function subActionSelectField(form: ConnectorActionForm): AgentPlanTemplateField | undefined {
  if (!form.subActions) return undefined;
  const defaultId = form.subActions.defaultId ?? form.subActions.options[0]?.id ?? '';
  return {
    id: form.subActions.fieldId,
    label: form.subActions.label,
    type: 'select',
    required: true,
    options: form.subActions.options.map((option) => option.id),
    defaultValue: defaultId,
  };
}

export function formTemplateFields(form: ConnectorActionForm): AgentPlanTemplateField[] {
  if (!form.subActions) return form.fields;
  const selectField = subActionSelectField(form);
  const baseIds = new Set(form.fields.map((field) => field.id));
  const branchFields: AgentPlanTemplateField[] = [];
  for (const branch of form.subActions.options) {
    for (const field of branch.fields) {
      if (baseIds.has(field.id)) continue;
      if (branchFields.some((candidate) => candidate.id === field.id)) continue;
      branchFields.push({
        ...field,
        showWhen: {
          ...(field.showWhen ?? {}),
          [form.subActions.fieldId]: branch.id,
        },
      });
    }
  }
  return [
    ...form.fields,
    ...(selectField ? [selectField] : []),
    ...branchFields,
  ];
}

export function connectorActionFormTemplateActionType(
  form: ConnectorActionForm,
  parameters?: Record<string, string>,
): string {
  const branch = selectedSubAction(form, parameters);
  if (branch?.actionType) return branch.actionType;
  if (form.actionType) return form.actionType;
  if (form.executionMode === 'read-only') return 'read_only';
  if (form.executionMode === 'blink') return 'blink_action';
  return form.templateId;
}

function connectorOperationIdFromActionKind(connector: ProtocolConnector, actionKind: string): string {
  const prefix = `${connector.id}_`;
  const withoutConnector = actionKind.startsWith(prefix) ? actionKind.slice(prefix.length) : actionKind;
  return withoutConnector.replace(/_/g, '-');
}

function connectorOperationLabelFromActionKind(connector: ProtocolConnector, actionKind: string): string {
  const normalizedKind = normalizeActionLabel(actionKind);
  const direct = connector.supportedActions.find((action) => normalizeActionLabel(action) === normalizedKind);
  if (direct) return direct;
  const operationId = connectorOperationIdFromActionKind(connector, actionKind);
  const operationText = normalizeActionLabel(operationId);
  const fromSupported = connector.supportedActions.find((action) => {
    const normalized = normalizeActionLabel(action);
    return normalized === operationText || operationText.includes(normalized) || normalized.includes(operationText);
  });
  return fromSupported ?? titleCase(operationId.replace(/-/g, ' '));
}

function connectorActionFields(actionKind: string): AgentPlanTemplateField[] {
  const fields: AgentPlanTemplateField[] = [];
  const add = (fieldDef: AgentPlanTemplateField): void => {
    if (fields.some((candidate) => candidate.id === fieldDef.id)) return;
    fields.push(fieldDef);
  };
  const has = (...parts: string[]) => parts.some((part) => actionKind.includes(part));

  if (actionKind.startsWith('jupiter_lend_earn_')) {
    add(formField('assetMint', 'Asset mint or symbol', true));
    if (has('deposit', 'mint')) add(formField('amount', 'Amount', true));
    if (has('withdraw', 'redeem')) {
      add(formField('amount', 'Amount'));
      add(formField('shares', 'Shares'));
    }
  } else if (actionKind.startsWith('jupiter_lend_borrow_')) {
    add(formField('vaultId', 'Vault id', true));
    if (has('position', 'repay', 'withdraw')) add(formField('positionId', 'Position id'));
    if (has('deposit_collateral')) add(formField('collateralAmount', 'Collateral amount', true));
    if (actionKind.endsWith('_borrow')) add(formField('borrowAmount', 'Borrow amount', true));
    if (has('repay')) add(formField('amount', 'Repay amount', true));
    if (has('withdraw_collateral')) add(formField('amount', 'Withdraw amount', true));
    add(formField('minHealthRatio', 'Minimum health ratio'));
  } else if (actionKind.startsWith('jupiter_trigger_')) {
    if (has('cancel', 'edit', 'withdraw')) add(formField('orderId', 'Order id', true));
    if (has('single_order', 'oco_order', 'otoco_order')) {
      add(formField('inputMint', 'Input mint or symbol', true));
      add(formField('outputMint', 'Output mint or symbol', true));
      add(formField('makingAmount', 'Input amount', true));
      add(formField('takingAmount', 'Minimum output amount'));
      add(formField('triggerPriceUsd', 'Trigger price USD'));
      add(formField('slippageBps', 'Max slippage bps'));
    }
    if (has('register_vault')) add(formField('payer', 'Payer override'));
    if (has('edit')) add(formField('newTriggerPriceUsd', 'New trigger price USD'));
  } else if (actionKind.startsWith('jupiter_recurring_')) {
    if (has('cancel', 'deposit_price_order', 'withdraw_price_order')) add(formField('orderId', 'Order id', true));
    if (has('create_time_order')) {
      add(formField('inputMint', 'Input mint or symbol', true));
      add(formField('outputMint', 'Output mint or symbol', true));
      add(formField('amount', 'Order amount', true));
      add(formField('intervalSeconds', 'Interval seconds', true));
      add(formField('numberOfOrders', 'Number of orders'));
    }
  } else if (actionKind.startsWith('raydium_')) {
    add(formField('poolId', 'Pool id', true));
    add(formSelectField('poolType', 'Pool type', ['cpmm', 'clmm', 'farm'], 'cpmm'));
    if (has('liquidity', 'fees')) add(formField('positionMint', 'Position mint'));
    if (has('add_liquidity', 'remove_liquidity', 'farm_stake', 'farm_unstake')) add(formField('amount', 'Amount'));
  } else if (actionKind.startsWith('orca_')) {
    add(formField('whirlpoolAddress', 'Whirlpool address', true));
    add(formField('positionMint', 'Position mint'));
    if (has('liquidity')) add(formField('amount', 'Liquidity amount'));
  } else if (actionKind.startsWith('meteora_')) {
    add(formField('poolAddress', 'DLMM pool address', true));
    add(formField('positionAddress', 'Position address'));
    if (has('liquidity')) {
      add(formField('amount', 'Amount'));
      add(formField('binRange', 'Bin range'));
    }
  } else if (actionKind.startsWith('marginfi_')) {
    add(formField('bankAddress', 'Bank address', true));
    add(formField('amount', 'Amount', !has('withdraw', 'repay')));
    add(formField('minHealthFactor', 'Minimum health factor'));
  } else if (actionKind.startsWith('save_')) {
    add(formField('reserveAddress', 'Reserve address', true));
    add(formField('amount', 'Amount', !has('withdraw', 'repay')));
    add(formField('minHealthFactor', 'Minimum health factor'));
  } else if (actionKind.startsWith('lulo_')) {
    add(formField('mintAddress', 'Mint address', true));
    if (has('deposit')) {
      add(formSelectField('depositType', 'Deposit type', ['protected', 'regular', 'boost'], 'protected'));
      add(formField('amount', 'Amount', true));
    }
    if (has('withdraw')) {
      add(formSelectField('withdrawType', 'Withdraw type', ['protected', 'regular', 'boost'], 'protected'));
      add(formField('amount', 'Amount'));
      add(formField('percentage', 'Percentage'));
    }
    if (has('complete')) add(formField('withdrawalId', 'Withdrawal id', true));
  } else if (actionKind.startsWith('jito_')) {
    if (has('stake_sol')) add(formField('amount', 'SOL amount', true));
    if (has('stake_account')) add(formField('stakeAccount', 'Stake account', true));
    if (has('receipt')) add(formField('receiptAccount', 'Deposit receipt account', true));
    if (has('unstake')) add(formField('amount', 'JitoSOL amount', true));
    if (has('withdraw')) add(formField('stakeAccount', 'Inactive stake account', true));
  } else if (actionKind.startsWith('marinade_')) {
    if (has('stake', 'unstake')) add(formField('amount', 'Amount', true));
    if (has('claim')) add(formField('ticketAccount', 'Unstake ticket account', true));
    if (has('delayed_unstake')) add(formField('msolAmount', 'mSOL amount', true));
  } else if (actionKind.startsWith('sanctum_')) {
    if (has('swap')) {
      add(formField('inputLstMint', 'Input LST mint or symbol', true));
      add(formField('outputLstMint', 'Output LST mint or symbol', true));
    } else {
      add(formField('lstMint', 'LST mint or symbol', true));
    }
    add(formField('amount', 'Amount', has('swap', 'stake', 'unstake', 'liquidity')));
  } else if (actionKind.startsWith('magiceden_') || actionKind.startsWith('tensor_')) {
    if (has('sweep')) add(formField('collectionSymbol', 'Collection symbol', true));
    if (!has('sweep')) add(formField('mintAddress', 'NFT mint address'));
    if (has('buy', 'bid', 'list', 'sweep')) add(formField('priceSol', 'Price / max price SOL', has('buy', 'bid', 'list', 'sweep')));
    if (has('cancel_listing')) add(formField('listingId', 'Listing id'));
    if (has('cancel_bid')) add(formField('bidId', 'Bid id'));
  } else if (actionKind.startsWith('realms_')) {
    if (has('vote')) {
      add(formField('proposalAddress', 'Proposal address', true));
      add(formSelectField('voteKind', 'Vote', ['approve', 'deny', 'abstain', 'veto'], 'abstain', true));
    } else {
      add(formField('realmAddress', 'Realm address', true));
      add(formField('governingTokenMint', 'Governance token mint', true));
      add(formField('amount', 'Amount'));
    }
  } else if (actionKind.startsWith('squads_')) {
    add(formField('multisigAddress', 'Multisig address', true));
    if (has('proposal')) add(formField('proposalAddress', 'Proposal address', has('approve', 'reject', 'cancel', 'execute')));
    if (has('transfer')) {
      add(formField('vaultIndex', 'Vault index', true));
      add(formField('recipient', 'Recipient address', true));
      add(formField('amount', 'Amount', true));
      add(formField('token', 'Token or mint'));
    }
  } else if (actionKind.startsWith('wormhole_')) {
    if (has('transfer')) {
      add(formField('token', 'Token or mint', true));
      add(formField('amount', 'Amount', true));
      add(formField('destinationChain', 'Destination chain', true));
      add(formField('recipient', 'Destination recipient', true));
    } else {
      add(formField('transferId', 'Transfer id / VAA', true));
    }
  } else if (actionKind.startsWith('pyth_')) {
    add(formField('priceFeedIds', 'Price feed ids', true));
    add(formField('maxAgeSeconds', 'Max price age seconds'));
  }

  if (fields.length === 0) {
    add(formField('position', 'Position / market'));
    add(formField('amount', 'Amount / cap'));
  }
  add(formField('memo', 'Reason'));
  return fields;
}

function genericReadForm(connector: ProtocolConnector): ConnectorActionForm {
  return connectorActionForm(
    connector.id,
    'position-check',
    'Position check',
    'protocol-position-check',
    'Read connector facts before proposing anything executable.',
    'read-only',
    'audit',
    [
      formField('protocol', 'Protocol', true),
      formField('position', 'Position / market'),
      formField('question', 'Question'),
      formField('memo', 'Instructions'),
    ],
    false,
    'read_only',
  );
}

function genericBlinkForm(connector: ProtocolConnector): ConnectorActionForm {
  return connectorActionForm(
    connector.id,
    'blink-action',
    'Blink URL action',
    'protocol-blink-action',
    'Prepare a connector-backed Blink or Solana Action URL.',
    'blink',
    'queueable',
    [
      formField('protocol', 'Protocol', true),
      formField('operation', 'Operation', true),
      formField('blinkUrl', 'Blink / Action URL', true),
      formField('position', 'Position / market'),
      formField('amount', 'Amount / cap'),
      formField('memo', 'Agent instructions'),
    ],
    true,
    'blink_action',
  );
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (match) => match.toUpperCase());
}

function connectorCreateRank(connector: ProtocolConnector, env: ConnectorDraftEnvironment): number {
  const status = connectorCreateStatus(connector, env);
  if (status.selectable) return 0;
  if (status.clusterSupported) return 1;
  return 2;
}

function connectorDraftRequiresBlink(
  template: Pick<AgentPlanTemplate, 'id' | 'actionType' | 'connectorCapability'>,
  parameters: Record<string, string>,
): boolean {
  const form = selectedConnectorActionForm(parameters) ?? connectorActionFormById(parameters.connectorOperationId);
  return Boolean(
    form?.requiresBlinkUrl ||
    form?.executionMode === 'blink' ||
    template.id === 'protocol-blink-action' ||
    template.actionType === 'blink_action' ||
    template.connectorCapability === 'blink_actions',
  );
}

function isGenericConnectorActionForm(form: ConnectorActionForm): boolean {
  return form.operationId === 'position-check' || form.operationId === 'blink-action';
}

export function connectorAiPlannerContext(
  template: Pick<AgentPlanTemplate, 'id' | 'actionType' | 'connectorCapability'>,
  parameters: Record<string, string>,
  env: ConnectorDraftEnvironment,
): Array<Record<string, unknown>> {
  const selected = selectedConnectorForDraftParameters(parameters);
  if (!isConnectorCapableTemplate(template) && !selected) {
    return protocolConnectorPlannerContext(env.connectedDapps, env.cluster, {
      dialectClientKeyConfigured: Boolean(env.dialectClientKeyConfigured),
      includeDisabled: true,
    });
  }
  if (!selected) return [];
  const validation = validateConnectorDraftParameters(template, parameters, env, 'ai');
  const base = protocolConnectorPlannerContext(env.connectedDapps, env.cluster, {
    dialectClientKeyConfigured: Boolean(env.dialectClientKeyConfigured),
    includeDisabled: true,
  }).find((entry) => entry.id === selected.id) ?? {};
  return [{
    ...base,
    selected: true,
    selectedOnly: true,
    id: selected.id,
    name: selected.name,
    selectedOperation: validation.parameters.operation || '',
    selectedActionSource: selected.actionSource ?? 'blink',
    suppliedFields: {
      blinkUrl: validation.parameters.blinkUrl || validation.parameters.actionUrl || '',
      position: validation.parameters.position || '',
      amount: validation.parameters.amount || '',
      memo: validation.parameters.memo || '',
    },
    missingFacts: validation.missingFacts,
    strictInstruction:
      'Use the selected protocol connector only. Do not switch protocols. If required connector facts are missing, ask for the missing facts instead of inventing execution. Do not claim the action is signed, submitted, approved, or safe. The wallet owner must approve separately.',
  }];
}

export function connectorAiUserNotes(
  template: Pick<AgentPlanTemplate, 'id' | 'actionType' | 'connectorCapability'>,
  parameters: Record<string, string>,
  userNotes: string,
): string {
  const connector = selectedConnectorForDraftParameters(parameters);
  if (!isConnectorCapableTemplate(template) && !connector) return userNotes;
  if (!connector) return userNotes;
  const steering = [
    `Selected protocol connector: ${connector.name} (${connector.id}).`,
    `Selected operation: ${parameters.operation || 'not supplied'}.`,
    'Use this connector only; do not switch protocols.',
    'If the Blink/Solana Action URL, position, amount, or other required fact is missing, ask for that fact instead of inventing execution.',
    'Wallet approval remains separate.',
  ].join(' ');
  return [steering, userNotes.trim()].filter(Boolean).join('\n\n');
}

function connectorDraftRank(connector: ProtocolConnector, env: ConnectorDraftEnvironment): number {
  const status = connectorDraftStatus(connector, env);
  if (status.selectable) return 0;
  if (status.clusterSupported) return 1;
  return 2;
}

function normalizedConnectorOperation(connector: ProtocolConnector, value: string | undefined): string {
  const requested = value?.trim() ?? '';
  if (!requested) return connector.supportedActions[0] ?? '';
  const normalized = normalizeActionLabel(requested);
  return connector.supportedActions.find((action) => normalizeActionLabel(action) === normalized) ??
    requested;
}

function protocolConnectorById(value: string | undefined): ProtocolConnector | undefined {
  const id = value?.trim() ?? '';
  if (!id) return undefined;
  return getAdapterMeta(id as ProtocolConnectorId);
}

function normalizeActionLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
