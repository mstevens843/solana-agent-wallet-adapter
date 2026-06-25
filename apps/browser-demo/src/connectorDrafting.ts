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
  display?: 'chips' | 'select';
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

export interface ConnectorActionDisplayParts {
  connectorName: string;
  operationLabel: string;
  selectionLabel: string;
  title: string;
}

// ===========================================================================
// ACTION-FIRST TAXONOMY (single source of truth for the action-first surfaces)
// ---------------------------------------------------------------------------
// Every connector actionType (from PROTOCOL_CONNECTORS[].actionKinds) is mapped
// EXPLICITLY to one user-action category. The category CANNOT be derived from
// the actionType prefix — that's the connector (jupiter_lend_* / jupiter_trigger_*
// / jupiter_recurring_* are all "jupiter"). Sub-actions carry their own actionType,
// so this table also drives sub-action scoping (Jupiter Lend earn=lend vs borrow).
// ===========================================================================
export type ActionCategory =
  | 'swap' | 'send' | 'limit' | 'dca' | 'lend' | 'borrow' | 'lp'
  | 'stake' | 'perps' | 'prediction' | 'nft' | 'governance' | 'bridge' | 'oracle' | 'read' | 'proof';

export const ACTION_TYPE_CATEGORY: Readonly<Record<string, ActionCategory>> = {
  // swap
  swap: 'swap', sanctum_swap_lst: 'swap',
  // limit / TP-SL / triggers
  jupiter_trigger_register_vault: 'limit', jupiter_trigger_single_order: 'limit',
  jupiter_trigger_oco_order: 'limit', jupiter_trigger_otoco_order: 'limit',
  jupiter_trigger_edit_order: 'limit', jupiter_trigger_cancel_order: 'limit',
  jupiter_trigger_withdraw_order_funds: 'limit', phoenix_place_trigger: 'limit',
  // dca / recurring
  jupiter_recurring_create_time_order: 'dca', jupiter_recurring_cancel_order: 'dca',
  jupiter_recurring_deposit_price_order: 'dca', jupiter_recurring_withdraw_price_order: 'dca',
  // lend (supply / earn)
  jupiter_lend_earn_deposit: 'lend', jupiter_lend_earn_withdraw: 'lend',
  jupiter_lend_earn_mint: 'lend', jupiter_lend_earn_redeem: 'lend',
  kamino_deposit: 'lend', kamino_withdraw: 'lend',
  marginfi_deposit: 'lend', marginfi_withdraw: 'lend',
  save_deposit: 'lend', save_withdraw: 'lend',
  project0_create_account: 'lend', project0_deposit: 'lend', project0_withdraw: 'lend',
  drift_vault_deposit: 'lend', drift_vault_request_withdraw: 'lend',
  drift_vault_cancel_withdraw: 'lend', drift_vault_complete_withdraw: 'lend',
  lulo_deposit: 'lend', lulo_withdraw: 'lend', lulo_complete_withdraw: 'lend',
  // borrow
  jupiter_lend_borrow_create_position: 'borrow', jupiter_lend_borrow_deposit_collateral: 'borrow',
  jupiter_lend_borrow_borrow: 'borrow', jupiter_lend_borrow_repay: 'borrow',
  jupiter_lend_borrow_withdraw_collateral: 'borrow',
  marginfi_borrow: 'borrow', marginfi_repay: 'borrow',
  save_borrow: 'borrow', save_repay: 'borrow',
  project0_borrow: 'borrow', project0_repay: 'borrow',
  // liquidity (LP)
  raydium_add_liquidity: 'lp', raydium_remove_liquidity: 'lp', raydium_collect_fees: 'lp',
  raydium_harvest: 'lp', raydium_farm_stake: 'lp', raydium_farm_unstake: 'lp',
  meteora_add_liquidity: 'lp', meteora_remove_liquidity: 'lp', meteora_claim_fees: 'lp',
  meteora_claim_rewards: 'lp', meteora_close_position: 'lp',
  orca_increase_liquidity: 'lp', orca_decrease_liquidity: 'lp',
  orca_collect_fees: 'lp', orca_collect_rewards: 'lp',
  sanctum_add_infinity_liquidity: 'lp', sanctum_remove_infinity_liquidity: 'lp',
  // stake
  jito_stake_sol: 'stake', jito_deposit_stake_account: 'stake', jito_unstake_jitosol: 'stake',
  jito_withdraw_sol: 'stake', jito_claim_deposit_receipt: 'stake',
  marinade_liquid_stake: 'stake', marinade_liquid_unstake: 'stake',
  marinade_delayed_unstake: 'stake', marinade_claim_delayed_unstake: 'stake',
  sanctum_stake_sol_to_lst: 'stake', sanctum_unstake_lst_to_sol: 'stake',
  // perps
  phoenix_open: 'perps', phoenix_close: 'perps', phoenix_modify_collateral: 'perps', phoenix_cancel_order: 'perps',
  // prediction
  jupiter_prediction_create_order: 'prediction', jupiter_prediction_close_position: 'prediction',
  jupiter_prediction_claim_position: 'prediction',
  // nft
  magiceden_bid: 'nft', magiceden_buy: 'nft', magiceden_list: 'nft',
  magiceden_cancel_listing: 'nft', magiceden_cancel_bid: 'nft',
  tensor_bid: 'nft', tensor_buy: 'nft', tensor_list: 'nft',
  tensor_cancel_listing: 'nft', tensor_cancel_bid: 'nft', tensor_sweep: 'nft',
  // governance
  squads_approve_proposal: 'governance', squads_reject_proposal: 'governance',
  squads_cancel_proposal: 'governance', squads_execute_proposal: 'governance',
  squads_create_transfer_proposal: 'governance',
  realms_cast_vote: 'governance', realms_deposit_governance_tokens: 'governance',
  realms_withdraw_governance_tokens: 'governance', realms_relinquish_vote: 'governance',
  // bridge
  wormhole_transfer: 'bridge', wormhole_redeem: 'bridge', wormhole_recover_or_resume: 'bridge',
  // oracle
  pyth_post_price_update: 'oracle',
};

// Connector significance (lower = more prominent within an action group).
export const CONNECTOR_PRIORITY: Readonly<Record<string, number>> = {
  jupiter: 0, kamino: 1, jito: 2, marinade: 3, raydium: 4, orca: 5, meteora: 6,
  drift: 7, marginfi: 8, sanctum: 9, tensor: 10, magiceden: 11, phoenix: 12,
  save: 13, lulo: 14, realms: 15, squads: 16, wormhole: 17, project0: 18, pyth: 19, mayan: 20,
};
export function connectorPriority(connector: ProtocolConnector): number {
  return CONNECTOR_PRIORITY[connector.id] ?? 999;
}

// Ordered action list for the action-first picker (label is t()-wrapped at the render site).
export const ACTION_CATEGORIES: ReadonlyArray<{ id: ActionCategory; label: string; group: 'trade' | 'earn' | 'borrow' | 'pay' | 'more' }> = [
  { id: 'swap', label: 'Swap', group: 'trade' },
  { id: 'limit', label: 'Limit / TP-SL', group: 'trade' },
  { id: 'dca', label: 'DCA', group: 'trade' },
  { id: 'lend', label: 'Lend', group: 'earn' },
  { id: 'stake', label: 'Stake', group: 'earn' },
  { id: 'lp', label: 'Liquidity', group: 'earn' },
  { id: 'borrow', label: 'Borrow', group: 'borrow' },
  { id: 'send', label: 'Send', group: 'pay' },
  { id: 'perps', label: 'Perps', group: 'more' },
  { id: 'prediction', label: 'Prediction', group: 'more' },
  { id: 'nft', label: 'NFT', group: 'more' },
  { id: 'governance', label: 'Governance', group: 'more' },
  { id: 'bridge', label: 'Bridge', group: 'more' },
  { id: 'oracle', label: 'Oracle', group: 'more' },
  { id: 'proof', label: 'Proof', group: 'more' },
  { id: 'read', label: 'Evidence', group: 'more' },
];

export function subActionCategory(option: ConnectorSubAction): ActionCategory | undefined {
  return option.actionType ? ACTION_TYPE_CATEGORY[option.actionType] : undefined;
}
// The categories a form participates in (its actionType ∪ its sub-actions'); read-only → 'read'.
export function formCategories(form: ConnectorActionForm): Set<ActionCategory> {
  if (form.executionMode === 'read-only') return new Set<ActionCategory>(['read']);
  const cats = new Set<ActionCategory>();
  if (form.subActions) {
    for (const option of form.subActions.options) {
      const c = subActionCategory(option);
      if (c) cats.add(c);
    }
  }
  if (form.actionType) {
    const c = ACTION_TYPE_CATEGORY[form.actionType];
    if (c) cats.add(c);
  }
  if (cats.size === 0) cats.add('read');
  return cats;
}
export function formMatchesCategory(form: ConnectorActionForm, category: ActionCategory): boolean {
  return formCategories(form).has(category);
}
// Connectors that expose ≥1 form/sub-action in `category`, ordered by significance.
export function connectorsForCategory(category: ActionCategory, env: ConnectorDraftEnvironment): ProtocolConnector[] {
  void env;
  return PROTOCOL_CONNECTORS
    // Sanctum is hidden from the action lists for now (BYO key); it stays toggleable in Preferences.
    .filter((connector) => connector.id !== 'sanctum')
    .filter((connector) => connectorActionFormsForConnector(connector).some((form) => formMatchesCategory(form, category)))
    .slice()
    .sort((left, right) => connectorPriority(left) - connectorPriority(right));
}

const JUPITER_FORM_TOKEN_MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  PYUSD: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
  MSOL: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3wX3KZK7ytfqcJm7So',
} as const;

const JUPITER_FORM_TOKEN_OPTIONS: string[] = [
  JUPITER_FORM_TOKEN_MINTS.SOL,
  JUPITER_FORM_TOKEN_MINTS.USDC,
  JUPITER_FORM_TOKEN_MINTS.JUP,
  JUPITER_FORM_TOKEN_MINTS.BONK,
  JUPITER_FORM_TOKEN_MINTS.WIF,
  JUPITER_FORM_TOKEN_MINTS.PYUSD,
  JUPITER_FORM_TOKEN_MINTS.MSOL,
];

const JUPITER_FORM_TOKEN_SYMBOL_TO_MINT: Record<string, string> = {
  SOL: JUPITER_FORM_TOKEN_MINTS.SOL,
  WSOL: JUPITER_FORM_TOKEN_MINTS.SOL,
  USDC: JUPITER_FORM_TOKEN_MINTS.USDC,
  JUP: JUPITER_FORM_TOKEN_MINTS.JUP,
  BONK: JUPITER_FORM_TOKEN_MINTS.BONK,
  WIF: JUPITER_FORM_TOKEN_MINTS.WIF,
  PYUSD: JUPITER_FORM_TOKEN_MINTS.PYUSD,
  MSOL: JUPITER_FORM_TOKEN_MINTS.MSOL,
};

const CONNECTOR_DROPDOWN_HIDDEN_ACTION_KINDS = new Set<string>([
  'jupiter:swap',
]);

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
  jupiterLendUnifiedForm(),
  jupiterTriggerUnifiedForm(),
  jupiterRecurringUnifiedForm(),
  jupiterPredictionUnifiedForm(),
  jupiterPerpsStatusForm(),
  ...marginfiForms(),
  ...project0Forms(),
  ...saveForms(),
  ...driftForms(),
  ...phoenixForms(),
  luloUnifiedForm(),
  raydiumLiquidityUnifiedForm(),
  ...marinadeForms(),
  ...jitoForms(),
  ...sanctumForms(),
  ...meteoraForms(),
  ...orcaForms(),
  ...magicedenForms(),
  ...tensorForms(),
  ...squadsForms(),
  ...realmsForms(),
  ...wormholeForms(),
  ...pythForms(),
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

// The display copy below stays English here (this module has no i18n import); `kind` lets the
// render site localize meta/detail/label via t()/tf() with the connector name as a placeholder.
export type ConnectorCreateStatusKind = 'no-flow' | 'wrong-cluster' | 'disabled' | 'first-class' | 'blink';

export function connectorCreateStatus(
  connector: ProtocolConnector,
  env: ConnectorDraftEnvironment,
): {
  selectable: boolean;
  enabled: boolean;
  clusterSupported: boolean;
  kind: ConnectorCreateStatusKind;
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
      kind: 'no-flow',
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
      kind: 'wrong-cluster',
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
      kind: 'disabled',
      label: 'Connector disabled',
      meta: 'Off',
      detail: `${connector.name} is disabled. Enable it in Protocol Connectors before preparing work.`,
    };
  }
  return {
    selectable: true,
    enabled: true,
    clusterSupported: true,
    kind: connector.actionSource === 'first-class-adapter' ? 'first-class' : 'blink',
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
    .filter((actionKind) => !CONNECTOR_DROPDOWN_HIDDEN_ACTION_KINDS.has(`${connector.id}:${actionKind}`))
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

export function connectorActionFormByActionType(actionType: string | undefined): ConnectorActionForm | undefined {
  const kind = actionType?.trim();
  if (!kind) return undefined;
  for (const connector of PROTOCOL_CONNECTORS) {
    for (const form of connectorActionFormsForConnector(connector)) {
      if (form.actionType === kind) return form;
      if (form.subActions) {
        for (const branch of form.subActions.options) {
          if (branch.actionType === kind) return form;
        }
      }
    }
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

function connectorSpecificActionFormForTemplate(
  template: Pick<AgentPlanTemplate, 'id'>,
): ConnectorActionForm | undefined {
  const form = connectorActionFormForTemplate(template);
  return form && !isGenericConnectorActionForm(form) ? form : undefined;
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

export function connectorActionDisplayParts(
  actionKind: string | undefined,
  params: Record<string, unknown>,
): ConnectorActionDisplayParts | undefined {
  const form = connectorActionFormById(stringParam(params, 'connectorOperationId')) ??
    connectorActionFormByActionType(actionKind);
  if (!form) return undefined;
  const connector = getAdapterMeta(form.connectorId);
  const branch = connectorSubActionForDisplay(form, actionKind, params);
  const operationLabel = connectorOperationDisplayLabel(form, connector, branch, actionKind);
  const selectionLabel = connectorPrimarySelectionLabel(form, branch, params);
  return {
    connectorName: connector?.name ?? form.connectorId,
    operationLabel,
    selectionLabel,
    title: selectionLabel ? `${operationLabel} - ${selectionLabel}` : operationLabel,
  };
}

export function resolveConnectorMetaForAction(
  actionKind: string | undefined,
  params: Record<string, unknown> = {},
): { id: string; name: string } | undefined {
  const form =
    connectorActionFormById(stringParam(params, 'connectorOperationId')) ??
    connectorActionFormByActionType(actionKind);
  if (!form) return undefined;
  const connector = getAdapterMeta(form.connectorId);
  return { id: form.connectorId, name: connector?.name ?? form.connectorId };
}

function connectorSubActionForDisplay(
  form: ConnectorActionForm,
  actionKind: string | undefined,
  params: Record<string, unknown>,
): ConnectorSubAction | undefined {
  if (!form.subActions) return undefined;
  const stringParams = stringParamsFromUnknown(params);
  const requested = stringParams[form.subActions.fieldId]?.trim();
  if (requested) {
    const byParam = selectedSubAction(form, stringParams);
    if (byParam) return byParam;
  }
  const byKind = form.subActions.options.find((option) => option.actionType === actionKind);
  if (byKind) return byKind;
  return selectedSubAction(form, stringParams);
}

function connectorOperationDisplayLabel(
  form: ConnectorActionForm,
  connector: ProtocolConnector | undefined,
  branch: ConnectorSubAction | undefined,
  actionKind: string | undefined,
): string {
  const connectorLabel = compactConnectorName(connector?.name ?? form.connectorId);
  const baseParts = branch
    ? [form.operationLabel, branch.label]
    : [form.operationLabel];
  const normalizedBase = baseParts
    .map(connectorTitleSegment)
    .filter(Boolean)
    .join(' - ') ||
    connectorTitleSegment(actionKind ?? form.actionType ?? form.operationId);
  const normalizedConnector = normalizeActionLabel(connectorLabel);
  const normalizedOperation = normalizeActionLabel(normalizedBase);
  if (normalizedOperation.startsWith(normalizedConnector)) return normalizedBase;
  return `${connectorLabel} ${lowercaseFirstWord(normalizedBase)}`.trim();
}

function connectorPrimarySelectionLabel(
  form: ConnectorActionForm,
  branch: ConnectorSubAction | undefined,
  params: Record<string, unknown>,
): string {
  const fields = connectorDisplayFields(form, branch);
  const subActionFieldId = form.subActions?.fieldId;
  const priority = [
    'token',
    'assetMint',
    'reserveAddress',
    'bankAddress',
    'mintAddress',
    'inputMint',
    'outputMint',
    'poolAddress',
    'poolId',
    'whirlpoolAddress',
    'positionAddress',
    'positionMint',
    'vaultAddress',
    'stakeAccount',
    'receiptAccount',
    'ticketAccount',
    'collectionId',
    'listingId',
    'proposalAddress',
    'realmAddress',
    'governingTokenMint',
    'multisigAddress',
    'destinationChain',
    'priceFeedIds',
  ];
  for (const id of priority) {
    const field = fields.find((candidate) => candidate.id === id);
    const value = field ? connectorFieldDisplayValue(field, params) : '';
    if (value) return value;
  }
  for (const field of fields) {
    if (field.id === subActionFieldId || connectorFieldIsLowSignal(field)) continue;
    const value = connectorFieldDisplayValue(field, params);
    if (value) return value;
  }
  return '';
}

function connectorDisplayFields(
  form: ConnectorActionForm,
  branch: ConnectorSubAction | undefined,
): AgentPlanTemplateField[] {
  if (!branch) return form.fields;
  const branchIds = new Set(branch.fields.map((field) => field.id));
  return [...form.fields.filter((field) => !branchIds.has(field.id)), ...branch.fields];
}

function connectorFieldDisplayValue(
  field: AgentPlanTemplateField,
  params: Record<string, unknown>,
): string {
  const raw = stringParam(params, field.id);
  if (!raw) return '';
  const explicitLabel = stringParam(params, `${field.id}Label`);
  if (explicitLabel) return connectorTitleSegment(explicitLabel);
  const compactRaw = connectorDisplayRawValue(raw);
  if (/reserve/i.test(field.label) && compactRaw && !/reserve/i.test(compactRaw)) {
    return `${compactRaw} Reserve`;
  }
  return compactRaw;
}

function connectorFieldIsLowSignal(field: AgentPlanTemplateField): boolean {
  if (field.type !== 'cascading-select' && field.type !== 'select') return true;
  return /^(memo|reason|amount|amountSol|inputAmount|msolAmount|priceSol|bidPriceSol|maxEscrowSol|slippageBps|recipient|poolType|depositType|withdrawMode|voteKind)$/i.test(field.id);
}

function stringParamsFromUnknown(params: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === 'string' ? value.trim() : '';
}

function connectorDisplayRawValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) {
    return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
  }
  if (/^[A-Z0-9]{2,12}$/.test(trimmed)) return trimmed;
  if (/^[a-z]{2,8}$/.test(trimmed)) return trimmed.toUpperCase();
  return connectorTitleSegment(trimmed);
}

function connectorTitleSegment(value: string): string {
  return titleCase(value
    .replace(/[\u2013\u2014]+/g, ' ')
    .replace(/\u2192/g, ' to ')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function compactConnectorName(value: string): string {
  return value.replace(/\s+Finance$/i, '').trim() || value;
}

function lowercaseFirstWord(value: string): string {
  return value.replace(/^\S+/, (match) => match.toLowerCase());
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
  template: Pick<AgentPlanTemplate, 'id' | 'actionType' | 'connectorCapability'> & Partial<Pick<AgentPlanTemplate, 'fields'>>,
  parameters: Record<string, string>,
): Record<string, string> {
  if (!templateCanUseConnectorParameters(template)) {
    return stripConnectorDraftExtras(template as Pick<AgentPlanTemplate, 'fields'>, parameters);
  }
  const templateForm = connectorSpecificActionFormForTemplate(template);
  const explicitForm = connectorActionFormById(parameters.connectorOperationId);
  const explicitFormForTemplate = explicitForm?.templateId === template.id ? explicitForm : undefined;
  const formHint = explicitFormForTemplate ?? templateForm;
  const formConnector = formHint ? getAdapterMeta(formHint.connectorId) : undefined;
  const connector = formConnector ?? selectedConnectorForDraftParameters(parameters);
  if (!connector && !isConnectorCapableTemplate(template)) {
    return template.fields ? stripConnectorDraftExtras({ fields: template.fields }, parameters) : { ...parameters };
  }
  if (!connector) return { ...parameters };
  const form = formHint ?? connectorActionFormForTemplate(template, connector);
  const operation = formHint?.operationLabel ??
    (form?.templateId === template.id && form.executionMode === 'read-only'
      ? form.operationLabel
      : normalizedConnectorOperation(connector, parameters.operation));
  const shouldPersistForm = Boolean(form && (form === explicitFormForTemplate || !isGenericConnectorActionForm(form)));
  const base = {
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
  return scopeConnectorDraftParameters(template, applyConnectorSubActionDefaults(form, normalizeConnectorParameterAliases(form, base)));
}

export function scopeConnectorDraftParameters(
  template: Pick<AgentPlanTemplate, 'id' | 'actionType' | 'connectorCapability'> & Partial<Pick<AgentPlanTemplate, 'fields'>>,
  parameters: Record<string, string>,
): Record<string, string> {
  if (!templateCanUseConnectorParameters(template)) {
    return stripConnectorDraftExtras(template as Pick<AgentPlanTemplate, 'fields'>, parameters);
  }
  const templateForm = connectorSpecificActionFormForTemplate(template);
  const explicitForm = connectorActionFormById(parameters.connectorOperationId);
  const explicitFormForTemplate = explicitForm?.templateId === template.id ? explicitForm : undefined;
  const formHint = explicitFormForTemplate ?? templateForm;
  const connector = (formHint ? getAdapterMeta(formHint.connectorId) : undefined) ??
    selectedConnectorForDraftParameters(parameters);
  const form = formHint ??
    (connector ? connectorActionFormForTemplate(template, connector) : connectorActionFormForTemplate(template));
  const scopedSource = applyConnectorSubActionDefaults(form, normalizeConnectorParameterAliases(form, parameters));
  const fields = form ? formTemplateFields(form) : template.fields ?? [];
  const allowed = new Set<string>([
    'connectorId',
    'connectorActionSource',
    'protocol',
    'operation',
  ]);
  if (form && (form === explicitFormForTemplate || !isGenericConnectorActionForm(form))) {
    allowed.add('connectorOperationId');
  }
  for (const key of connectorScopedMetadataKeys(connector?.id ?? form?.connectorId)) {
    allowed.add(key);
  }
  if (connectorDraftRequiresBlink(template, scopedSource)) {
    allowed.add('blinkUrl');
    allowed.add('actionUrl');
  }
  for (const field of fields) {
    if (!connectorParameterFieldIsVisible(field, scopedSource)) continue;
    allowConnectorFieldParameter(allowed, field.id);
  }
  const branch = form ? selectedSubAction(form, scopedSource) : undefined;
  for (const field of branch?.fields ?? []) {
    if (!connectorParameterFieldIsVisible(field, scopedSource)) continue;
    allowConnectorFieldParameter(allowed, field.id);
  }

  const scoped: Record<string, string> = {};
  for (const [key, value] of Object.entries(scopedSource)) {
    if (allowed.has(key)) scoped[key] = value;
  }
  return scoped;
}

const CONNECTOR_FIELD_META_SUFFIXES = [
  'Label',
  'Symbol',
  'Mint',
  'Decimals',
  'TokenASymbol',
  'TokenBSymbol',
  'TokenAMint',
  'TokenBMint',
  'FeeBps',
  'PoolType',
  'ProgramId',
] as const;

function allowConnectorFieldParameter(allowed: Set<string>, fieldId: string): void {
  allowed.add(fieldId);
  for (const suffix of CONNECTOR_FIELD_META_SUFFIXES) {
    allowed.add(`${fieldId}${suffix}`);
  }
}

function connectorScopedMetadataKeys(connectorId?: ProtocolConnectorId | string): string[] {
  if (connectorId === 'meteora') {
    return [
      'poolName',
      'tokenXSymbol',
      'tokenYSymbol',
      'tokenMintX',
      'tokenMintY',
      'binStep',
    ];
  }
  if (connectorId === 'drift') {
    return [
      'depositSymbol',
      'depositMint',
    ];
  }
  return [];
}

export function stripConnectorDraftExtras(
  template: Pick<AgentPlanTemplate, 'fields'>,
  parameters: Record<string, string>,
): Record<string, string> {
  const fieldIds = new Set(template.fields.map((field) => field.id));
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (fieldIds.has(key) || templateFieldMetadataKey(key, fieldIds)) {
      next[key] = value;
    }
  }
  return next;
}

function templateCanUseConnectorParameters(
  template: Pick<AgentPlanTemplate, 'id' | 'actionType' | 'connectorCapability'> & Partial<Pick<AgentPlanTemplate, 'fields'>>,
): boolean {
  if (isConnectorCapableTemplate(template)) return true;
  if (!template.fields) return true;
  return template.fields.some((field) =>
    field.id === 'protocol' ||
    field.id === 'connectorId' ||
    field.id === 'dapp' ||
    field.id === 'provider' ||
    field.id === 'route',
  );
}

function templateFieldMetadataKey(key: string, fieldIds: Set<string>): boolean {
  for (const suffix of CONNECTOR_FIELD_META_SUFFIXES) {
    if (!key.endsWith(suffix)) continue;
    const fieldId = key.slice(0, -suffix.length);
    if (fieldIds.has(fieldId)) return true;
  }
  return false;
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

function formField(
  id: string,
  label: string,
  required = false,
  options: Pick<AgentPlanTemplateField, 'placeholder' | 'helperText'> = {},
): AgentPlanTemplateField {
  return {
    id,
    label,
    required,
    type: 'text',
    ...(options.placeholder !== undefined ? { placeholder: options.placeholder } : {}),
    ...(options.helperText !== undefined ? { helperText: options.helperText } : {}),
  };
}

function formDateTimeField(
  id: string,
  label: string,
  required = false,
  options: Pick<AgentPlanTemplateField, 'placeholder' | 'helperText'> = {},
): AgentPlanTemplateField {
  return {
    ...formField(id, label, required, options),
    type: 'datetime-local',
  };
}

function jupiterTokenField(
  id: 'inputMint' | 'outputMint' | 'triggerMint' | 'depositMint',
  label: string,
  required = false,
  defaultValue: string = JUPITER_FORM_TOKEN_MINTS.USDC,
): AgentPlanTemplateField {
  return {
    id,
    label,
    required,
    type: 'select',
    options: JUPITER_FORM_TOKEN_OPTIONS,
    defaultValue,
    placeholder: 'Search symbol/name or paste mint',
  };
}

function bidSpendCapField(): AgentPlanTemplateField {
  return formField('maxEscrowSol', 'Spend cap (SOL)', false, {
    placeholder: 'Defaults to bid price',
    helperText: 'Maximum SOL this request may lock for the bid. For one collection bid, leave it equal to the bid price.',
  });
}

function minHealthFactorField(): AgentPlanTemplateField {
  return formField('minHealthFactor', 'Minimum health factor (1.0+)', false, {
    placeholder: 'e.g. 1.10',
    helperText:
      "Block the action if your loan's health factor would fall below this. " +
      '1.0 = at liquidation; 1.10 = 10% buffer above liquidation (recommended).',
  });
}

function minHealthRatioField(): AgentPlanTemplateField {
  return formField('minHealthRatio', 'Minimum health ratio (1.0+)', false, {
    placeholder: 'e.g. 1.10',
    helperText:
      "Block the action if your loan's health ratio would fall below this. " +
      '1.0 = at liquidation; 1.10 = 10% buffer above liquidation (recommended).',
  });
}

function normalizeConnectorParameterAliases(
  form: ConnectorActionForm | undefined,
  parameters: Record<string, string>,
): Record<string, string> {
  const tokenNormalized = normalizeConnectorTokenParameters(form, parameters);
  if (!form) return tokenNormalized;
  parameters = tokenNormalized;
  const actionType = connectorActionFormTemplateActionType(form, parameters);
  if (actionType !== 'magiceden_bid' && actionType !== 'tensor_bid') return parameters;
  const next = { ...parameters };
  const rawBidPriceSol = next.bidPriceSol?.trim() || next.priceSol?.trim() || '';
  const bidPriceSol = rawBidPriceSol ? normalizeSolDecimalDraftValue(rawBidPriceSol) : '';
  if (bidPriceSol) {
    next.bidPriceSol = bidPriceSol;
  }
  const rawMaxEscrowSol = next.maxEscrowSol?.trim() || bidPriceSol;
  const maxEscrowSol = rawMaxEscrowSol ? normalizeSolDecimalDraftValue(rawMaxEscrowSol) : '';
  if (maxEscrowSol) {
    next.maxEscrowSol = maxEscrowSol;
  }
  return next;
}

function normalizeConnectorTokenParameters(
  form: ConnectorActionForm | undefined,
  parameters: Record<string, string>,
): Record<string, string> {
  if (form?.connectorId !== 'jupiter') return parameters;
  const next = { ...parameters };
  for (const fieldId of ['inputMint', 'outputMint', 'triggerMint', 'depositMint'] as const) {
    const explicitMint = next[`${fieldId}Mint`]?.trim();
    if (explicitMint) {
      next[fieldId] = explicitMint;
      continue;
    }
    const symbolMint = JUPITER_FORM_TOKEN_SYMBOL_TO_MINT[next[fieldId]?.trim().toUpperCase() ?? ''];
    if (symbolMint) next[fieldId] = symbolMint;
  }
  return next;
}

function normalizeSolDecimalDraftValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || !/^(?:\d+|\d*\.\d+|\d+\.)$/.test(trimmed)) return trimmed;
  const [wholeRaw = '0', fractionRaw = ''] = trimmed.split('.');
  if (fractionRaw.length > 9) return trimmed;
  const whole = wholeRaw === '' ? '0' : wholeRaw;
  const lamports = BigInt(whole) * 1_000_000_000n + BigInt(fractionRaw.padEnd(9, '0') || '0');
  if (lamports <= 0n) return trimmed;
  const wholeSol = lamports / 1_000_000_000n;
  const fractionLamports = lamports % 1_000_000_000n;
  if (fractionLamports === 0n) return wholeSol.toString();
  return `${wholeSol.toString()}.${fractionLamports.toString().padStart(9, '0').replace(/0+$/, '')}`;
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

function liquidityAmountSideField(): AgentPlanTemplateField {
  return formSelectField('amountSide', 'Amount token', ['tokenA', 'tokenB'], 'tokenA', true);
}

function liquidityTokenAmountField(
  id: 'tokenAAmount' | 'tokenBAmount',
  label: string,
  side: 'tokenA' | 'tokenB',
): AgentPlanTemplateField {
  return {
    ...formField(id, label, true),
    showWhen: { amountSide: side },
  };
}

function liquidityOppositeMaxField(
  id: 'maxTokenAAmount' | 'maxTokenBAmount',
  label: string,
  baseSide: 'tokenA' | 'tokenB',
): AgentPlanTemplateField {
  return {
    ...formField(id, label, true),
    showWhen: { amountSide: baseSide },
    helperText: 'Maximum paired-token spend allowed for this liquidity quote.',
  };
}

function liquidityCustomRangePriceField(
  id: 'lowerPrice' | 'upperPrice',
  label: string,
): AgentPlanTemplateField {
  return {
    ...formField(id, label, true),
    showWhen: { rangePreset: 'custom' },
    helperText: 'Price is token B per token A, for example USDC per SOL in a SOL/USDC pool.',
  };
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

function marinadeForms(): ConnectorActionForm[] {
  // Field IDs MUST match the Marinade adapter input shape (solAmount, msolAmount,
  // ticketAccount). A mismatched `amount` makes the adapter's parseDecimalAmount
  // crash with "Cannot read properties of undefined (reading 'trim')" at approve.
  const ticketField = cascadingField('ticketAccount', 'Unstake ticket', 'marinade.ticket', {
    required: true,
    emptyHint: 'No delayed-unstake tickets found. Paste a ticket account address.',
  });
  return [
    connectorActionForm('marinade', 'liquid-stake', 'Liquid stake', 'connector-marinade-liquid-stake', 'Stake SOL into mSOL via Marinade.', 'first-class-adapter', 'queueable', [
      formField('solAmount', 'SOL amount', true),
      formField('memo', 'Reason'),
    ], false, 'marinade_liquid_stake'),
    connectorActionForm('marinade', 'liquid-unstake', 'Liquid unstake', 'connector-marinade-liquid-unstake', 'Unstake mSOL into SOL immediately (with liquidity fee).', 'first-class-adapter', 'queueable', [
      formField('msolAmount', 'mSOL amount', true),
      formField('memo', 'Reason'),
    ], false, 'marinade_liquid_unstake'),
    connectorActionForm('marinade', 'delayed-unstake', 'Delayed unstake', 'connector-marinade-delayed-unstake', 'Request a delayed unstake (no fee, takes 1–2 epochs).', 'first-class-adapter', 'queueable', [
      formField('msolAmount', 'mSOL amount', true),
      formField('memo', 'Reason'),
    ], false, 'marinade_delayed_unstake'),
    connectorActionForm('marinade', 'claim-delayed-unstake', 'Claim delayed unstake', 'connector-marinade-claim', 'Claim a matured delayed-unstake ticket.', 'first-class-adapter', 'queueable', [
      ticketField,
      formField('memo', 'Reason'),
    ], false, 'marinade_claim_delayed_unstake'),
  ];
}

function jitoForms(): ConnectorActionForm[] {
  // Field IDs MUST match the Jito adapter input shape (solAmount for stake/withdraw,
  // jitosolAmount for unstake). Mismatched ids crash adapter.prepare on .trim().
  const stakeField = cascadingField('stakeAccount', 'Stake account', 'jito.stakeAccount', {
    required: true,
    emptyHint: 'No eligible stake accounts found. Paste a stake account address.',
  });
  const receiptField = cascadingField('receiptAccount', 'Deposit receipt', 'jito.receipt', {
    required: true,
    emptyHint: 'No claimable receipts found. Paste a receipt account address.',
  });
  return [
    connectorActionForm('jito', 'stake-sol', 'Stake SOL', 'connector-jito-stake-sol', 'Stake SOL into JitoSOL via the Jito stake pool.', 'first-class-adapter', 'queueable', [
      formField('solAmount', 'SOL amount', true),
      formField('memo', 'Reason'),
    ], false, 'jito_stake_sol'),
    connectorActionForm('jito', 'deposit-stake-account', 'Deposit stake account', 'connector-jito-deposit-stake-account', 'Deposit a native stake account into the Jito pool (creates a claim receipt).', 'first-class-adapter', 'queueable', [
      stakeField,
      formField('memo', 'Reason'),
    ], false, 'jito_deposit_stake_account'),
    connectorActionForm('jito', 'unstake-jitosol', 'Unstake JitoSOL', 'connector-jito-unstake-jitosol', 'Redeem JitoSOL via the stake pool. Choose the redeem route.', 'first-class-adapter', 'queueable', [
      formField('jitoSolAmount', 'JitoSOL amount', true),
      { id: 'withdrawMode', label: 'Withdraw mode', type: 'select', options: ['stake_account', 'reserve_sol'], defaultValue: 'reserve_sol', required: true },
      formField('memo', 'Reason'),
    ], false, 'jito_unstake_jitosol'),
    connectorActionForm('jito', 'withdraw-sol', 'Withdraw SOL', 'connector-jito-withdraw-sol', 'Withdraw SOL from an inactive Jito stake account.', 'first-class-adapter', 'queueable', [
      stakeField,
      formField('memo', 'Reason'),
    ], false, 'jito_withdraw_sol'),
    connectorActionForm('jito', 'claim-deposit-receipt', 'Claim deposit receipt', 'connector-jito-claim-deposit-receipt', 'Claim a Jito deposit receipt once cooldown completes.', 'first-class-adapter', 'queueable', [
      receiptField,
      formField('memo', 'Reason'),
    ], false, 'jito_claim_deposit_receipt'),
  ];
}

function sanctumLstField(id: string, label: string, providerId: string, required: boolean, dependsOn?: string[]): AgentPlanTemplateField {
  return cascadingField(id, label, providerId, {
    required,
    ...(dependsOn ? { dependsOn } : {}),
    emptyHint: "Couldn't load Sanctum LSTs. Paste an LST mint or symbol.",
  });
}

function sanctumForms(): ConnectorActionForm[] {
  // Field IDs MUST match the Sanctum adapter input shape — the adapter reads
  // `input.inputMint` / `input.outputMint` / `input.lstMint` / `input.solAmount` /
  // `input.lstAmount` / `input.infAmount`. Using mismatched ids (e.g. `inputLstMint`)
  // makes the adapter see undefined and throw "inputMint must be a valid Solana mint
  // address" at approve time.
  return [
    connectorActionForm('sanctum', 'swap-lst', 'Swap LST', 'connector-sanctum-swap-lst', 'Swap one Sanctum-supported LST for another.', 'first-class-adapter', 'queueable', [
      sanctumLstField('inputMint', 'Input LST', 'sanctum.lst', true),
      sanctumLstField('outputMint', 'Output LST', 'sanctum.lst', true),
      formField('amount', 'Amount', true),
      formField('memo', 'Reason'),
    ], false, 'sanctum_swap_lst'),
    connectorActionForm('sanctum', 'stake-sol-to-lst', 'Stake SOL → LST', 'connector-sanctum-stake-sol-to-lst', 'Stake SOL into an LST via Sanctum.', 'first-class-adapter', 'queueable', [
      sanctumLstField('lstMint', 'Target LST', 'sanctum.lst', true),
      formField('solAmount', 'SOL amount', true),
      formField('memo', 'Reason'),
    ], false, 'sanctum_stake_sol_to_lst'),
    connectorActionForm('sanctum', 'unstake-lst-to-sol', 'Unstake LST → SOL', 'connector-sanctum-unstake-lst-to-sol', 'Redeem an LST for SOL via Sanctum.', 'first-class-adapter', 'queueable', [
      sanctumLstField('lstMint', 'LST', 'sanctum.lst', true),
      formField('lstAmount', 'LST amount', true),
      formField('memo', 'Reason'),
    ], false, 'sanctum_unstake_lst_to_sol'),
    connectorActionForm('sanctum', 'add-infinity-liquidity', 'Add Infinity liquidity', 'connector-sanctum-add-infinity', 'Provide liquidity to the Sanctum Infinity pool.', 'first-class-adapter', 'queueable', [
      sanctumLstField('inputMint', 'Input LST / SOL', 'sanctum.lst', true),
      formField('amount', 'Amount', true),
      formField('memo', 'Reason'),
    ], false, 'sanctum_add_infinity_liquidity'),
    connectorActionForm('sanctum', 'remove-infinity-liquidity', 'Remove Infinity liquidity', 'connector-sanctum-remove-infinity', 'Withdraw from the Sanctum Infinity pool.', 'first-class-adapter', 'queueable', [
      sanctumLstField('outputMint', 'Output LST', 'sanctum.lst', true),
      formField('infAmount', 'INF amount', true),
      formField('memo', 'Reason'),
    ], false, 'sanctum_remove_infinity_liquidity'),
  ];
}

function meteoraPoolField(required: boolean): AgentPlanTemplateField {
  return cascadingField('poolAddress', 'DLMM pool', 'meteora.pool', {
    required,
    emptyHint: "Couldn't load Meteora DLMM pools. Paste a pool address.",
  });
}

function meteoraPositionField(required: boolean): AgentPlanTemplateField {
  return cascadingField('positionAddress', 'DLMM position', 'meteora.position', {
    required,
    dependsOn: ['poolAddress'],
    emptyHint: 'No wallet position found in this pool. Choose Open new DLMM position, or paste a position address.',
  });
}

function meteoraForms(): ConnectorActionForm[] {
  return [
    {
      id: 'meteora:add-liquidity',
      connectorId: 'meteora',
      operationId: 'add-liquidity',
      operationLabel: 'Add liquidity',
      templateId: 'connector-meteora-add-liquidity',
      description: 'Add liquidity to a Meteora DLMM pool — top up an owned position or open a new preset range.',
      executionMode: 'first-class-adapter',
      outcome: 'queueable',
      actionType: 'meteora_add_liquidity',
      fields: [formField('memo', 'Reason')],
      subActions: {
        fieldId: 'subAction',
        label: 'Position',
        defaultId: 'existing-position',
        options: [
          {
            id: 'existing-position',
            label: 'Add to existing position',
            description: 'Top up a DLMM position you already own.',
            actionType: 'meteora_add_liquidity',
            fields: [
              meteoraPoolField(true),
              meteoraPositionField(true),
              formField('tokenXAmount', 'Token X amount', true),
              formField('tokenYAmount', 'Token Y amount'),
              formSelectField('rangePreset', 'Range', ['position'], 'position', true),
            ],
          },
          {
            id: 'new-position',
            label: 'Open new position',
            description: 'Open a new preset DLMM range. No lower/upper bin IDs required.',
            actionType: 'meteora_add_liquidity',
            fields: [
              meteoraPoolField(true),
              formField('tokenXAmount', 'Token X amount', true),
              formField('tokenYAmount', 'Token Y amount'),
              formSelectField('rangePreset', 'Range preset', ['balanced', 'narrow', 'wide'], 'balanced', true),
              formSelectField('strategyType', 'Strategy', ['spot', 'bidask', 'curve'], 'spot'),
            ],
          },
        ],
      },
    },
    connectorActionForm('meteora', 'remove-liquidity', 'Remove liquidity', 'connector-meteora-remove-liquidity', 'Remove liquidity from a Meteora DLMM position.', 'first-class-adapter', 'queueable', [
      meteoraPoolField(true),
      meteoraPositionField(true),
      formField('amount', 'Amount'),
      formField('memo', 'Reason'),
    ], false, 'meteora_remove_liquidity'),
    connectorActionForm('meteora', 'claim-fees', 'Claim fees', 'connector-meteora-claim-fees', 'Claim trading fees from a Meteora DLMM position.', 'first-class-adapter', 'queueable', [
      meteoraPoolField(true),
      meteoraPositionField(false),
      formField('memo', 'Reason'),
    ], false, 'meteora_claim_fees'),
    connectorActionForm('meteora', 'claim-rewards', 'Claim rewards', 'connector-meteora-claim-rewards', 'Claim incentive rewards from a Meteora DLMM position.', 'first-class-adapter', 'queueable', [
      meteoraPoolField(true),
      meteoraPositionField(false),
      formField('memo', 'Reason'),
    ], false, 'meteora_claim_rewards'),
    connectorActionForm('meteora', 'close-position', 'Close position', 'connector-meteora-close-position', 'Close a Meteora DLMM position and reclaim rent.', 'first-class-adapter', 'queueable', [
      meteoraPoolField(true),
      meteoraPositionField(true),
      formField('memo', 'Reason'),
    ], false, 'meteora_close_position'),
  ];
}

function orcaWhirlpoolField(required: boolean): AgentPlanTemplateField {
  return cascadingField('whirlpoolAddress', 'Whirlpool', 'orca.whirlpool', {
    required,
    emptyHint: "Couldn't load Orca whirlpools. Paste a whirlpool address.",
  });
}

function orcaPositionField(required: boolean): AgentPlanTemplateField {
  return cascadingField('positionMint', 'Whirlpool position', 'orca.position', {
    required,
    dependsOn: ['whirlpoolAddress'],
    emptyHint: 'No wallet position found in this whirlpool. Choose Open new position, or paste a position mint.',
  });
}

function orcaForms(): ConnectorActionForm[] {
  // Orca liquidity has two flavors: top up an existing position or open a new
  // preset range. The adapter maps presets to tick-aligned bounds at prepare time.
  return [
    {
      id: 'orca:increase-liquidity-flow',
      connectorId: 'orca',
      operationId: 'increase-liquidity',
      operationLabel: 'Increase liquidity',
      templateId: 'connector-orca-increase-liquidity',
      description: 'Add liquidity to an existing Orca whirlpool position you own, or open a new tick-bounded position.',
      executionMode: 'first-class-adapter',
      outcome: 'queueable',
      fields: [formField('memo', 'Reason')],
      subActions: {
        fieldId: 'subAction',
        label: 'Position',
        defaultId: 'existing-position',
        options: [
          {
            id: 'existing-position',
            label: 'Add to existing position',
            description: 'Top up a position you already own — no tick math needed.',
            actionType: 'orca_increase_liquidity',
            fields: [
              orcaWhirlpoolField(true),
              orcaPositionField(true),
              liquidityAmountSideField(),
              liquidityTokenAmountField('tokenAAmount', 'Token A amount', 'tokenA'),
              liquidityOppositeMaxField('maxTokenBAmount', 'Max token B amount', 'tokenA'),
              liquidityTokenAmountField('tokenBAmount', 'Token B amount', 'tokenB'),
              liquidityOppositeMaxField('maxTokenAAmount', 'Max token A amount', 'tokenB'),
            ],
          },
          {
            id: 'new-position',
            label: 'Open new position',
            description: 'Open a brand-new preset range. No tick math required.',
            actionType: 'orca_increase_liquidity',
            fields: [
              orcaWhirlpoolField(true),
              liquidityAmountSideField(),
              liquidityTokenAmountField('tokenAAmount', 'Token A amount', 'tokenA'),
              liquidityOppositeMaxField('maxTokenBAmount', 'Max token B amount', 'tokenA'),
              liquidityTokenAmountField('tokenBAmount', 'Token B amount', 'tokenB'),
              liquidityOppositeMaxField('maxTokenAAmount', 'Max token A amount', 'tokenB'),
              formSelectField('rangePreset', 'Range preset', ['balanced', 'narrow', 'wide'], 'balanced', true),
            ],
          },
        ],
      },
    },
    connectorActionForm('orca', 'decrease-liquidity', 'Decrease liquidity', 'connector-orca-decrease-liquidity', 'Remove liquidity from an Orca whirlpool position.', 'first-class-adapter', 'queueable', [
      orcaWhirlpoolField(true),
      orcaPositionField(true),
      formField('amount', 'Liquidity to remove'),
      formField('memo', 'Reason'),
    ], false, 'orca_decrease_liquidity'),
    connectorActionForm('orca', 'collect-fees', 'Collect fees', 'connector-orca-collect-fees', 'Collect trading fees from an Orca whirlpool position.', 'first-class-adapter', 'queueable', [
      orcaPositionField(true),
      formField('memo', 'Reason'),
    ], false, 'orca_collect_fees'),
    connectorActionForm('orca', 'collect-rewards', 'Collect rewards', 'connector-orca-collect-rewards', 'Collect incentive rewards from an Orca whirlpool position.', 'first-class-adapter', 'queueable', [
      orcaPositionField(true),
      formField('memo', 'Reason'),
    ], false, 'orca_collect_rewards'),
  ];
}

function nftCollectionField(providerId: string, required: boolean): AgentPlanTemplateField {
  return cascadingField('collectionId', 'Collection', providerId, {
    required,
    emptyHint: "Couldn't load collections. Paste a collection id or symbol.",
  });
}

function nftWalletField(providerId: string, required: boolean): AgentPlanTemplateField {
  return cascadingField('mintAddress', 'NFT', providerId, {
    required,
    emptyHint: "Couldn't load your NFTs. Paste an NFT mint address.",
  });
}

function magicedenForms(): ConnectorActionForm[] {
  const collectionListing = cascadingField('listingId', 'Listing', 'magiceden.listing', {
    required: true,
    dependsOn: ['collectionId'],
    emptyHint: 'No listings found for this collection. Paste a listing id.',
  });
  return [
    {
      id: 'magiceden:bid-flow',
      connectorId: 'magiceden',
      operationId: 'bid',
      operationLabel: 'Bid',
      templateId: 'connector-magiceden-bid',
      description: 'Place a bid on a single NFT or an entire collection on Magic Eden.',
      executionMode: 'first-class-adapter',
      outcome: 'queueable',
      fields: [formField('bidPriceSol', 'Bid price (SOL)', true), bidSpendCapField(), formField('memo', 'Reason')],
      subActions: {
        fieldId: 'subAction',
        label: 'Bid target',
        defaultId: 'collection',
        options: [
          { id: 'nft', label: 'Single NFT', description: 'Bid on one specific mint.', actionType: 'magiceden_bid', fields: [nftWalletField('magiceden.wallet.nft', true)] },
          { id: 'collection', label: 'Collection', description: 'Collection-wide bid.', actionType: 'magiceden_bid', fields: [nftCollectionField('magiceden.collection', true)] },
        ],
      },
    },
    connectorActionForm('magiceden', 'buy', 'Buy', 'connector-magiceden-buy', 'Buy a listed NFT on Magic Eden.', 'first-class-adapter', 'queueable', [
      nftWalletField('magiceden.collection', true),
      formField('priceSol', 'Max price (SOL)', true),
      formField('memo', 'Reason'),
    ], false, 'magiceden_buy'),
    connectorActionForm('magiceden', 'list', 'List', 'connector-magiceden-list', 'List one of your NFTs on Magic Eden.', 'first-class-adapter', 'queueable', [
      nftWalletField('magiceden.wallet.nft', true),
      formField('priceSol', 'List price (SOL)', true),
      formField('memo', 'Reason'),
    ], false, 'magiceden_list'),
    connectorActionForm('magiceden', 'cancel-listing', 'Cancel listing', 'connector-magiceden-cancel-listing', 'Cancel an existing Magic Eden listing.', 'first-class-adapter', 'queueable', [
      nftCollectionField('magiceden.collection', true),
      collectionListing,
      formField('memo', 'Reason'),
    ], false, 'magiceden_cancel_listing'),
    connectorActionForm('magiceden', 'cancel-bid', 'Cancel bid', 'connector-magiceden-cancel-bid', 'Cancel an outstanding Magic Eden bid.', 'first-class-adapter', 'queueable', [
      nftCollectionField('magiceden.collection', true),
      formField('bidId', 'Bid id', true),
      formField('memo', 'Reason'),
    ], false, 'magiceden_cancel_bid'),
  ];
}

function tensorForms(): ConnectorActionForm[] {
  const collectionListing = cascadingField('listingId', 'Listing', 'tensor.listing', {
    required: true,
    dependsOn: ['collectionId'],
    emptyHint: 'No listings found for this collection. Paste a listing id.',
  });
  return [
    {
      id: 'tensor:bid-flow',
      connectorId: 'tensor',
      operationId: 'bid',
      operationLabel: 'Bid',
      templateId: 'connector-tensor-bid',
      description: 'Place a bid on a single NFT or an entire collection on Tensor.',
      executionMode: 'first-class-adapter',
      outcome: 'queueable',
      fields: [formField('bidPriceSol', 'Bid price (SOL)', true), bidSpendCapField(), formField('memo', 'Reason')],
      subActions: {
        fieldId: 'subAction',
        label: 'Bid target',
        defaultId: 'collection',
        options: [
          { id: 'nft', label: 'Single NFT', description: 'Bid on one specific mint.', actionType: 'tensor_bid', fields: [nftWalletField('tensor.wallet.nft', true)] },
          { id: 'collection', label: 'Collection', description: 'Collection-wide bid.', actionType: 'tensor_bid', fields: [nftCollectionField('tensor.collection', true)] },
        ],
      },
    },
    connectorActionForm('tensor', 'buy', 'Buy', 'connector-tensor-buy', 'Buy a listed NFT on Tensor.', 'first-class-adapter', 'queueable', [
      nftWalletField('tensor.collection', true),
      formField('priceSol', 'Max price (SOL)', true),
      formField('memo', 'Reason'),
    ], false, 'tensor_buy'),
    connectorActionForm('tensor', 'list', 'List', 'connector-tensor-list', 'List one of your NFTs on Tensor.', 'first-class-adapter', 'queueable', [
      nftWalletField('tensor.wallet.nft', true),
      formField('priceSol', 'List price (SOL)', true),
      formField('memo', 'Reason'),
    ], false, 'tensor_list'),
    connectorActionForm('tensor', 'cancel-listing', 'Cancel listing', 'connector-tensor-cancel-listing', 'Cancel an existing Tensor listing.', 'first-class-adapter', 'queueable', [
      nftCollectionField('tensor.collection', true),
      collectionListing,
      formField('memo', 'Reason'),
    ], false, 'tensor_cancel_listing'),
    connectorActionForm('tensor', 'cancel-bid', 'Cancel bid', 'connector-tensor-cancel-bid', 'Cancel an outstanding Tensor bid.', 'first-class-adapter', 'queueable', [
      nftCollectionField('tensor.collection', true),
      formField('bidId', 'Bid id', true),
      formField('memo', 'Reason'),
    ], false, 'tensor_cancel_bid'),
    connectorActionForm('tensor', 'sweep', 'Sweep', 'connector-tensor-sweep', 'Buy the N cheapest listings in a collection.', 'first-class-adapter', 'queueable', [
      nftCollectionField('tensor.collection', true),
      formField('count', 'Number of NFTs', true),
      formField('maxPriceSol', 'Max price per NFT (SOL)'),
      formField('memo', 'Reason'),
    ], false, 'tensor_sweep'),
  ];
}

function squadsMultisigField(required: boolean): AgentPlanTemplateField {
  return cascadingField('multisigAddress', 'Multisig', 'squads.multisig', {
    required,
    emptyHint: "Couldn't load your Squads multisigs. Paste a multisig address.",
  });
}

function squadsProposalField(required: boolean): AgentPlanTemplateField {
  return cascadingField('proposalAddress', 'Proposal', 'squads.proposal', {
    required,
    dependsOn: ['multisigAddress'],
    emptyHint: 'No proposals found for this multisig. Paste a proposal address.',
  });
}

function squadsForms(): ConnectorActionForm[] {
  return [
    connectorActionForm('squads', 'approve-proposal', 'Approve proposal', 'connector-squads-approve-proposal', 'Approve a Squads proposal.', 'first-class-adapter', 'queueable', [
      squadsMultisigField(true),
      squadsProposalField(true),
      formField('memo', 'Reason'),
    ], false, 'squads_approve_proposal'),
    connectorActionForm('squads', 'reject-proposal', 'Reject proposal', 'connector-squads-reject-proposal', 'Reject a Squads proposal.', 'first-class-adapter', 'queueable', [
      squadsMultisigField(true),
      squadsProposalField(true),
      formField('memo', 'Reason'),
    ], false, 'squads_reject_proposal'),
    connectorActionForm('squads', 'cancel-proposal', 'Cancel proposal', 'connector-squads-cancel-proposal', 'Cancel a Squads proposal you authored.', 'first-class-adapter', 'queueable', [
      squadsMultisigField(true),
      squadsProposalField(true),
      formField('memo', 'Reason'),
    ], false, 'squads_cancel_proposal'),
    connectorActionForm('squads', 'execute-proposal', 'Execute proposal', 'connector-squads-execute-proposal', 'Execute an approved Squads proposal.', 'first-class-adapter', 'queueable', [
      squadsMultisigField(true),
      squadsProposalField(true),
      formField('memo', 'Reason'),
    ], false, 'squads_execute_proposal'),
    connectorActionForm('squads', 'create-transfer-proposal', 'Create transfer proposal', 'connector-squads-create-transfer-proposal', 'Draft a new transfer proposal in a Squads multisig.', 'first-class-adapter', 'queueable', [
      squadsMultisigField(true),
      cascadingField('vaultIndex', 'Vault', 'squads.vault', {
        required: true,
        dependsOn: ['multisigAddress'],
        emptyHint: 'No vaults found. Paste a vault index (0, 1, …) to continue.',
      }),
      formField('recipient', 'Recipient', true),
      formField('amount', 'Amount', true),
      formField('token', 'Token or mint'),
      formField('memo', 'Reason'),
    ], false, 'squads_create_transfer_proposal'),
  ];
}

function realmsRealmField(required: boolean): AgentPlanTemplateField {
  return cascadingField('realmAddress', 'Realm', 'realms.realm', {
    required,
    emptyHint: "Couldn't load your realms. Paste a realm address.",
  });
}

function realmsTokenField(required: boolean): AgentPlanTemplateField {
  return cascadingField('governingTokenMint', 'Governance token', 'realms.token', {
    required,
    dependsOn: ['realmAddress'],
    emptyHint: 'No governance tokens found for this realm.',
  });
}

function realmsProposalField(required: boolean): AgentPlanTemplateField {
  return cascadingField('proposalAddress', 'Proposal', 'realms.proposal', {
    required,
    dependsOn: ['realmAddress'],
    emptyHint: 'No active proposals found in this realm.',
  });
}

function realmsForms(): ConnectorActionForm[] {
  return [
    {
      id: 'realms:cast-vote',
      connectorId: 'realms',
      operationId: 'cast-vote',
      operationLabel: 'Cast vote',
      templateId: 'connector-realms-cast-vote',
      description: 'Cast a vote on a Realms proposal.',
      executionMode: 'first-class-adapter',
      outcome: 'queueable',
      fields: [
        realmsRealmField(true),
        realmsTokenField(true),
        realmsProposalField(true),
        formField('memo', 'Reason'),
      ],
      subActions: {
        fieldId: 'subAction',
        label: 'Vote',
        defaultId: 'approve',
        options: [
          { id: 'approve', label: 'Approve', description: 'Vote to approve the proposal.', actionType: 'realms_cast_vote', fields: [{ id: 'voteKind', label: 'Vote', type: 'select', options: ['approve'], defaultValue: 'approve' }] },
          { id: 'deny', label: 'Deny', description: 'Vote to deny the proposal.', actionType: 'realms_cast_vote', fields: [{ id: 'voteKind', label: 'Vote', type: 'select', options: ['deny'], defaultValue: 'deny' }] },
          { id: 'abstain', label: 'Abstain', description: 'Abstain from this vote.', actionType: 'realms_cast_vote', fields: [{ id: 'voteKind', label: 'Vote', type: 'select', options: ['abstain'], defaultValue: 'abstain' }] },
          { id: 'veto', label: 'Veto', description: 'Cast a veto (council only).', actionType: 'realms_cast_vote', fields: [{ id: 'voteKind', label: 'Vote', type: 'select', options: ['veto'], defaultValue: 'veto' }] },
        ],
      },
    },
    connectorActionForm('realms', 'deposit-governance-tokens', 'Deposit governance tokens', 'connector-realms-deposit', 'Deposit governance tokens into a realm.', 'first-class-adapter', 'queueable', [
      realmsRealmField(true),
      realmsTokenField(true),
      formField('amount', 'Amount', true),
      formField('memo', 'Reason'),
    ], false, 'realms_deposit_governance_tokens'),
    connectorActionForm('realms', 'withdraw-governance-tokens', 'Withdraw governance tokens', 'connector-realms-withdraw', 'Withdraw governance tokens from a realm.', 'first-class-adapter', 'queueable', [
      realmsRealmField(true),
      realmsTokenField(true),
      formField('amount', 'Amount'),
      formField('memo', 'Reason'),
    ], false, 'realms_withdraw_governance_tokens'),
    connectorActionForm('realms', 'relinquish-vote', 'Relinquish vote', 'connector-realms-relinquish-vote', 'Relinquish a vote you previously cast.', 'first-class-adapter', 'queueable', [
      realmsRealmField(true),
      realmsTokenField(true),
      realmsProposalField(true),
      formField('memo', 'Reason'),
    ], false, 'realms_relinquish_vote'),
  ];
}

function wormholeTokenField(required: boolean): AgentPlanTemplateField {
  // Field id MUST match the Wormhole adapter input (`sourceMint`). The provider
  // emits real mint addresses; using `token` here makes the adapter read undefined
  // and reject the approval with "Wormhole sourceMint is required."
  return cascadingField('sourceMint', 'Source token', 'wormhole.token', {
    required,
    emptyHint: "Couldn't load Wormhole token routes. Paste a source mint.",
  });
}

function wormholeDestinationField(required: boolean): AgentPlanTemplateField {
  return cascadingField('destinationChain', 'Destination chain', 'wormhole.destination', {
    required,
    dependsOn: ['sourceMint'],
    emptyHint: 'Choose a source token first.',
  });
}

function wormholeForms(): ConnectorActionForm[] {
  return [
    connectorActionForm('wormhole', 'transfer', 'Transfer', 'connector-wormhole-transfer', 'Bridge tokens via Wormhole to another chain.', 'first-class-adapter', 'queueable', [
      wormholeTokenField(true),
      formField('amount', 'Amount', true),
      wormholeDestinationField(true),
      formField('destinationAddress', 'Destination recipient', true),
      formField('memo', 'Reason'),
    ], false, 'wormhole_transfer'),
    connectorActionForm('wormhole', 'redeem', 'Redeem', 'connector-wormhole-redeem', 'Redeem a pending Wormhole transfer on Solana.', 'first-class-adapter', 'queueable', [
      formField('transferId', 'Transfer id / VAA', true),
      formField('memo', 'Reason'),
    ], false, 'wormhole_redeem'),
    connectorActionForm('wormhole', 'recover-or-resume', 'Recover or resume', 'connector-wormhole-recover-or-resume', 'Recover or resume a stalled Wormhole transfer.', 'first-class-adapter', 'queueable', [
      formField('transferId', 'Transfer id / VAA', true),
      formField('memo', 'Reason'),
    ], false, 'wormhole_recover_or_resume'),
  ];
}

function pythForms(): ConnectorActionForm[] {
  return [
    connectorActionForm('pyth', 'post-price-update', 'Post price update', 'connector-pyth-post-price-update', 'Post a Pyth pull-oracle price update on-chain.', 'first-class-adapter', 'queueable', [
      cascadingField('priceFeedIds', 'Price feeds', 'pyth.feed', {
        required: true,
        emptyHint: 'Type a symbol (e.g. SOL/USD) to search Pyth feeds.',
        placeholder: 'SOL/USD',
      }),
      formField('maxAgeSeconds', 'Max price age (seconds)'),
      formField('memo', 'Reason'),
    ], false, 'pyth_post_price_update'),
  ];
}

function marginfiBankField(required: boolean): AgentPlanTemplateField {
  return cascadingField('bankAddress', 'MarginFi bank', 'marginfi.bank', {
    required,
    emptyHint: "Couldn't load MarginFi banks. Paste a bank address or token symbol.",
  });
}

function marginfiAccountField(): AgentPlanTemplateField {
  return formField('marginfiAccount', 'MarginFi account (optional)', false, {
    placeholder: 'Paste from app.marginfi.com if auto-discovery fails',
    helperText: 'Required only when the SDK cannot auto-discover your account.',
  });
}

function marginfiForms(): ConnectorActionForm[] {
  const amountField = formField('amount', 'Amount', true);
  const healthField = minHealthFactorField();
  return [
    connectorActionForm('marginfi', 'deposit', 'Deposit', 'connector-marginfi-deposit', 'Supply tokens to a MarginFi bank.', 'first-class-adapter', 'queueable', [
      marginfiBankField(true),
      amountField,
      marginfiAccountField(),
      healthField,
      formField('memo', 'Reason'),
    ], false, 'marginfi_deposit'),
    connectorActionForm('marginfi', 'withdraw', 'Withdraw', 'connector-marginfi-withdraw', 'Redeem supplied tokens from a MarginFi bank.', 'first-class-adapter', 'queueable', [
      marginfiBankField(true),
      formField('amount', 'Amount'),
      marginfiAccountField(),
      healthField,
      formField('memo', 'Reason'),
    ], false, 'marginfi_withdraw'),
    connectorActionForm('marginfi', 'borrow', 'Borrow', 'connector-marginfi-borrow', 'Borrow against MarginFi collateral.', 'first-class-adapter', 'queueable', [
      marginfiBankField(true),
      amountField,
      marginfiAccountField(),
      healthField,
      formField('memo', 'Reason'),
    ], false, 'marginfi_borrow'),
    connectorActionForm('marginfi', 'repay', 'Repay', 'connector-marginfi-repay', 'Repay a MarginFi loan.', 'first-class-adapter', 'queueable', [
      marginfiBankField(true),
      formField('amount', 'Amount'),
      marginfiAccountField(),
      healthField,
      formField('memo', 'Reason'),
    ], false, 'marginfi_repay'),
  ];
}

function project0BankField(required: boolean): AgentPlanTemplateField {
  return cascadingField('bankAddress', 'Project 0 bank', 'project0.bank', {
    required,
    emptyHint: "Couldn't load Project 0 banks. Paste a bank address or token symbol.",
  });
}

function project0Forms(): ConnectorActionForm[] {
  const amountField = formField('amount', 'Amount', true);
  const healthField = minHealthRatioField();
  return [
    connectorActionForm('project0', 'create-account', 'Create account', 'connector-project0-create-account', 'Create a Project 0 account for wallet approval.', 'first-class-adapter', 'queueable', [
      formField('accountIndex', 'Account index'),
      formField('memo', 'Reason'),
    ], false, 'project0_create_account'),
    connectorActionForm('project0', 'deposit', 'Deposit', 'connector-project0-deposit', 'Supply tokens to a Project 0 bank.', 'first-class-adapter', 'queueable', [
      project0BankField(true),
      amountField,
      healthField,
      formField('memo', 'Reason'),
    ], false, 'project0_deposit'),
    connectorActionForm('project0', 'withdraw', 'Withdraw', 'connector-project0-withdraw', 'Redeem supplied tokens from a Project 0 bank.', 'first-class-adapter', 'queueable', [
      project0BankField(true),
      formField('amount', 'Amount'),
      healthField,
      formField('memo', 'Reason'),
    ], false, 'project0_withdraw'),
    connectorActionForm('project0', 'borrow', 'Borrow', 'connector-project0-borrow', 'Borrow against Project 0 collateral.', 'first-class-adapter', 'queueable', [
      project0BankField(true),
      amountField,
      healthField,
      formField('memo', 'Reason'),
    ], false, 'project0_borrow'),
    connectorActionForm('project0', 'repay', 'Repay', 'connector-project0-repay', 'Repay Project 0 debt.', 'first-class-adapter', 'queueable', [
      project0BankField(true),
      formField('amount', 'Amount'),
      healthField,
      formField('memo', 'Reason'),
    ], false, 'project0_repay'),
  ];
}

function saveReserveField(required: boolean): AgentPlanTemplateField {
  return cascadingField('token', 'Save reserve', 'save.reserve', {
    required,
    emptyHint: "Couldn't load Save reserves. Paste a token symbol (SOL, USDC, USDT) or reserve mint.",
    placeholder: 'SOL',
  });
}

function saveForms(): ConnectorActionForm[] {
  const healthField = minHealthFactorField();
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

function phoenixSymbolField(required: boolean): AgentPlanTemplateField {
  return cascadingField('symbol', 'Phoenix market', 'phoenix.symbol', {
    required,
    emptyHint: "Couldn't load Phoenix markets. Confirm your Phoenix invite/activation code is configured in Connector API keys.",
  });
}

function phoenixTraderPdaField(): AgentPlanTemplateField {
  return formField('traderPdaIndex', 'Trader PDA index (advanced)', false, {
    placeholder: '0',
    helperText: 'Phoenix subaccount index. Most users leave this blank (defaults to 0).',
  });
}

function phoenixForms(): ConnectorActionForm[] {
  return [
    connectorActionForm('phoenix', 'open', 'Open position', 'phoenix-open',
      'Open a leveraged Phoenix Perpetuals position (market). Optional price limit caps slippage. Policy-gated by max leverage + allowed symbols.',
      'first-class-adapter', 'queueable',
      [
        phoenixSymbolField(true),
        formSelectField('side', 'Side', ['long', 'short'], 'long', true),
        formField('baseSize', 'Base size', true, { placeholder: '0.5' }),
        formField('leverage', 'Leverage', true, {
          placeholder: '3',
          helperText: 'Capped by policy (max ~10x).',
        }),
        formField('priceLimitUsd', 'Price limit USD (optional)', false, {
          placeholder: 'e.g. 145',
          helperText: 'Slippage cap. Leave blank for a pure market order.',
        }),
        phoenixTraderPdaField(),
        formField('memo', 'Reason'),
      ],
      false,
      'phoenix_open'),
    connectorActionForm('phoenix', 'close', 'Close position', 'phoenix-close',
      'Close a Phoenix position (fully or partially). Re-fetches live position size at execute time so partial fills / liquidations are honored.',
      'first-class-adapter', 'queueable',
      [
        phoenixSymbolField(true),
        formField('baseSize', 'Base size to close (optional)', false, {
          placeholder: 'Leave blank to close full position',
        }),
        phoenixTraderPdaField(),
        formField('memo', 'Reason'),
      ],
      false,
      'phoenix_close'),
    connectorActionForm('phoenix', 'modify-collateral', 'Modify collateral', 'phoenix-modify-collateral',
      'Deposit or withdraw USDC collateral from your Phoenix trader account.',
      'first-class-adapter', 'queueable',
      [
        formSelectField('direction', 'Direction', ['deposit', 'withdraw'], 'deposit', true),
        formField('amountUsd', 'Amount (USDC)', true, {
          placeholder: '100',
          helperText: 'USDC amount, up to 6 decimal places.',
        }),
        phoenixTraderPdaField(),
        formField('memo', 'Reason'),
      ],
      false,
      'phoenix_modify_collateral'),
    connectorActionForm('phoenix', 'place-trigger', 'Place stop-loss trigger', 'phoenix-place-trigger',
      "Place a stop-loss trigger on an open Phoenix position. 'less_than' fires when price drops below the trigger; 'greater_than' fires when price rises above.",
      'first-class-adapter', 'queueable',
      [
        phoenixSymbolField(true),
        formSelectField('side', 'Trigger trade side', ['long', 'short'], 'short', true),
        formField('baseSize', 'Base size', true, { placeholder: '0.5' }),
        formField('triggerPriceUsd', 'Trigger price USD', true, {
          placeholder: 'e.g. 120',
          helperText: 'Fires when price crosses this level.',
        }),
        formSelectField('triggerDirection', 'Direction', ['less_than', 'greater_than'], 'less_than', true),
        phoenixTraderPdaField(),
        formField('memo', 'Reason'),
      ],
      false,
      'phoenix_place_trigger'),
    connectorActionForm('phoenix', 'cancel-order', 'Cancel open order', 'phoenix-cancel-order',
      'Cancel a Phoenix limit order by orderId + priceTicks. Find both values via Position Snapshot → openOrders.',
      'first-class-adapter', 'queueable',
      [
        phoenixSymbolField(true),
        formField('orderId', 'Order ID', true, {
          helperText: 'From Position Snapshot → openOrders[].orderId.',
        }),
        formField('priceTicks', 'Price ticks', true, {
          helperText: 'From Position Snapshot → openOrders[].priceTicks (Phoenix tick units, not USD).',
        }),
        phoenixTraderPdaField(),
        formField('memo', 'Reason'),
      ],
      false,
      'phoenix_cancel_order'),
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
      display: 'select',
      options: [
        {
          id: 'cpmm-add',
          label: 'CPMM — add liquidity',
          description: 'Constant-product full-range deposit.',
          actionType: 'raydium_add_liquidity',
          fields: [
            raydiumPoolField('raydium.cpmm.pool', true),
            { id: 'poolType', label: 'Pool type', type: 'select', options: ['cpmm'], defaultValue: 'cpmm' },
            liquidityAmountSideField(),
            liquidityTokenAmountField('tokenAAmount', 'Token A amount', 'tokenA'),
            liquidityTokenAmountField('tokenBAmount', 'Token B amount', 'tokenB'),
          ],
        },
        {
          id: 'clmm-open',
          label: 'CLMM — open position',
          description: 'Open a concentrated-liquidity position with a price range.',
          actionType: 'raydium_add_liquidity',
          fields: [
            raydiumPoolField('raydium.clmm.pool', true),
            { id: 'poolType', label: 'Pool type', type: 'select', options: ['clmm'], defaultValue: 'clmm' },
            liquidityAmountSideField(),
            liquidityTokenAmountField('tokenAAmount', 'Token A amount', 'tokenA'),
            liquidityOppositeMaxField('maxTokenBAmount', 'Max token B amount', 'tokenA'),
            liquidityTokenAmountField('tokenBAmount', 'Token B amount', 'tokenB'),
            liquidityOppositeMaxField('maxTokenAAmount', 'Max token A amount', 'tokenB'),
            formSelectField('rangePreset', 'Price range', ['balanced', 'narrow', 'wide', 'custom'], 'balanced', true),
            liquidityCustomRangePriceField('lowerPrice', 'Custom lower price'),
            liquidityCustomRangePriceField('upperPrice', 'Custom upper price'),
          ],
        },
        {
          id: 'clmm-increase',
          label: 'CLMM — add to position',
          description: 'Increase an existing concentrated-liquidity position.',
          actionType: 'raydium_add_liquidity',
          fields: [
            raydiumPoolField('raydium.clmm.pool', true),
            { id: 'poolType', label: 'Pool type', type: 'select', options: ['clmm'], defaultValue: 'clmm' },
            cascadingField('positionMint', 'Existing position', 'raydium.position', {
              required: true,
              dependsOn: ['poolId'],
              emptyHint: 'No CLMM positions found in this pool. Choose CLMM — open position to create one.',
            }),
            liquidityAmountSideField(),
            liquidityTokenAmountField('tokenAAmount', 'Token A amount', 'tokenA'),
            liquidityOppositeMaxField('maxTokenBAmount', 'Max token B amount', 'tokenA'),
            liquidityTokenAmountField('tokenBAmount', 'Token B amount', 'tokenB'),
            liquidityOppositeMaxField('maxTokenAAmount', 'Max token A amount', 'tokenB'),
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
      display: 'select',
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
          fields: [borrowVault, borrowPosition, formField('borrowAmount', 'Borrow amount', true), minHealthRatioField()],
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
          fields: [borrowVault, borrowPosition, formField('amount', 'Withdraw amount', true), minHealthRatioField()],
        },
      ],
    },
  };
}

function jupiterTriggerUnifiedForm(): ConnectorActionForm {
  const memo = formField('memo', 'Reason');
  const inputMint = jupiterTokenField('inputMint', 'Spend token', true, JUPITER_FORM_TOKEN_MINTS.SOL);
  const outputMint = jupiterTokenField('outputMint', 'Receive token', true, JUPITER_FORM_TOKEN_MINTS.USDC);
  const triggerMint = jupiterTokenField('triggerMint', 'Watch price of', true, JUPITER_FORM_TOKEN_MINTS.SOL);
  const amount = formField('amount', 'Amount to spend', true);
  const expiresAt = formDateTimeField('expiresAt', 'Expires at', true);
  const slippageBps = formField('slippageBps', 'Max slippage', false, { placeholder: '0.5%' });
  const takeProfitPrice = formField('takeProfitPriceUsd', 'Take-profit price', true);
  const stopLossPrice = formField('stopLossPriceUsd', 'Stop-loss price', true);
  return {
    id: 'jupiter:trigger-limit-orders',
    connectorId: 'jupiter',
    operationId: 'trigger-limit-orders',
    operationLabel: 'Limit orders',
    templateId: 'connector-jupiter-trigger-limit-orders',
    description: 'Create or manage Jupiter Trigger limit orders, including TP/SL brackets. Funds sit in the Jupiter Trigger vault and future fills run through Jupiter automation.',
    executionMode: 'first-class-adapter',
    outcome: 'queueable',
    fields: [memo],
    subActions: {
      fieldId: 'subAction',
      label: 'Limit order action',
      defaultId: 'single-limit-stop',
      display: 'select',
      options: [
        {
          id: 'register-vault',
          label: 'Set up order vault',
          description: 'Register the Jupiter Trigger vault required before creating limit orders.',
          actionType: 'jupiter_trigger_register_vault',
          fields: [formField('payer', 'Payer override')],
        },
        {
          id: 'single-limit-stop',
          label: 'Limit / stop order',
          description: 'Swap when a token crosses one USD price threshold. Output is not guaranteed at trigger time.',
          actionType: 'jupiter_trigger_single_order',
          fields: [
            inputMint,
            outputMint,
            amount,
            triggerMint,
            formSelectField('triggerCondition', 'Trigger when price is', ['above', 'below'], 'above', true),
            formField('triggerPriceUsd', 'Trigger price USD', true),
            slippageBps,
            expiresAt,
          ],
        },
        {
          id: 'oco-tpsl',
          label: 'TP/SL bracket (OCO)',
          description: 'Take-profit and stop-loss pair where one fill cancels the other.',
          actionType: 'jupiter_trigger_oco_order',
          fields: [
            inputMint,
            outputMint,
            amount,
            triggerMint,
            formSelectField('side', 'Position side', ['sell', 'buy'], 'sell'),
            takeProfitPrice,
            stopLossPrice,
            formField('takeProfitSlippageBps', 'Take-profit max slippage', false, { placeholder: '0.5%' }),
            formField('stopLossSlippageBps', 'Stop-loss max slippage', false, { placeholder: '0.5%' }),
            expiresAt,
          ],
        },
        {
          id: 'otoco-entry-tpsl',
          label: 'Entry + TP/SL (OTOCO)',
          description: 'Entry trigger first, then automatically activates a TP/SL OCO bracket.',
          actionType: 'jupiter_trigger_otoco_order',
          fields: [
            inputMint,
            outputMint,
            amount,
            triggerMint,
            formSelectField('entryCondition', 'Entry when price is', ['above', 'below'], 'above', true),
            formField('entryPriceUsd', 'Entry price USD', true),
            takeProfitPrice,
            stopLossPrice,
            slippageBps,
            formField('takeProfitSlippageBps', 'Take-profit max slippage', false, { placeholder: '0.5%' }),
            formField('stopLossSlippageBps', 'Stop-loss max slippage', false, { placeholder: '0.5%' }),
            expiresAt,
          ],
        },
        {
          id: 'edit-trigger',
          label: 'Edit order trigger',
          description: 'Change an existing Trigger order price, slippage, or expiry.',
          actionType: 'jupiter_trigger_edit_order',
          fields: [
            formField('orderId', 'Order id', true),
            formSelectField('orderType', 'Order type', ['single', 'oco', 'otoco'], 'single'),
            formField('newTriggerPriceUsd', 'New trigger price USD'),
            formField('newSlippageBps', 'New max slippage', false, { placeholder: '0.5%' }),
            formDateTimeField('newExpiresAt', 'New expiry'),
            formField('reason', 'Reason'),
          ],
        },
        {
          id: 'cancel-order',
          label: 'Cancel order',
          description: 'Cancel an open or pending Trigger order. Withdraw funds separately if needed.',
          actionType: 'jupiter_trigger_cancel_order',
          fields: [formField('orderId', 'Order id', true), formField('reason', 'Reason')],
        },
        {
          id: 'withdraw-order-funds',
          label: 'Withdraw cancelled funds',
          description: 'Move cancelled or expired Trigger order funds from the vault back to the wallet.',
          actionType: 'jupiter_trigger_withdraw_order_funds',
          fields: [formField('orderId', 'Order id', true), formField('reason', 'Reason')],
        },
      ],
    },
  };
}

function jupiterRecurringUnifiedForm(): ConnectorActionForm {
  const memo = formField('memo', 'Reason');
  const inputMint = jupiterTokenField('inputMint', 'Spend token', true, JUPITER_FORM_TOKEN_MINTS.USDC);
  const outputMint = jupiterTokenField('outputMint', 'Buy token', true, JUPITER_FORM_TOKEN_MINTS.SOL);
  const automationAccepted = formSelectField('automationWarningAccepted', 'Jupiter automation acknowledged', ['true'], 'true');
  const deprecationAccepted = formSelectField('priceOrderDeprecationAccepted', 'Deprecated price-order warning acknowledged', ['true'], 'true');
  return {
    id: 'jupiter:recurring-dca',
    connectorId: 'jupiter',
    operationId: 'recurring-dca',
    operationLabel: 'DCA orders',
    templateId: 'connector-jupiter-recurring-dca',
    description: 'Create or manage Jupiter Recurring DCA orders. After setup approval, future fills run through Jupiter automation rather than Agentic approval per cycle.',
    executionMode: 'first-class-adapter',
    outcome: 'queueable',
    fields: [memo],
    subActions: {
      fieldId: 'subAction',
      label: 'DCA action',
      defaultId: 'create-time-dca',
      display: 'select',
      options: [
        {
          id: 'create-time-dca',
          label: 'Create DCA order',
          description: 'Set up a time-based Jupiter Recurring order for repeated token swaps.',
          actionType: 'jupiter_recurring_create_time_order',
          fields: [
            formSelectField('dcaDirection', 'Direction', ['buy', 'sell'], 'buy', true),
            inputMint,
            outputMint,
            formField('totalAmount', 'Total spend', true),
            formField('numberOfOrders', 'How many buys', true),
            formField('intervalSeconds', 'Every', true),
            formDateTimeField('startAt', 'Start at'),
            formField('minPrice', 'Minimum price'),
            formField('maxPrice', 'Maximum price'),
            automationAccepted,
          ],
        },
        {
          id: 'cancel-dca',
          label: 'Cancel DCA order',
          description: 'Cancel a time-based Jupiter Recurring order and reclaim remaining funds.',
          actionType: 'jupiter_recurring_cancel_order',
          fields: [formField('orderId', 'Order id', true), formField('reason', 'Reason')],
        },
        {
          id: 'deposit-deprecated-price-order',
          label: 'Advanced: fund price order',
          description: 'Deposit into a deprecated price-based Recurring order only when you already know the order id.',
          actionType: 'jupiter_recurring_deposit_price_order',
          fields: [
            formField('orderId', 'Order id', true),
            formField('amount', 'Amount'),
            formField('amountRaw', 'Raw amount'),
            formSelectField('inputOrOutput', 'Amount side', ['In', 'Out'], 'In'),
            deprecationAccepted,
          ],
        },
        {
          id: 'withdraw-deprecated-price-order',
          label: 'Advanced: withdraw price order',
          description: 'Withdraw from a deprecated price-based Recurring order only when you already know the order id.',
          actionType: 'jupiter_recurring_withdraw_price_order',
          fields: [
            formField('orderId', 'Order id', true),
            formField('amount', 'Amount'),
            formField('amountRaw', 'Raw amount'),
            formSelectField('inputOrOutput', 'Amount side', ['In', 'Out'], 'In'),
            deprecationAccepted,
          ],
        },
      ],
    },
  };
}

function jupiterPredictionUnifiedForm(): ConnectorActionForm {
  const memo = formField('memo', 'Reason');
  const depositMint = jupiterTokenField('depositMint', 'Deposit token', true, JUPITER_FORM_TOKEN_MINTS.USDC);
  const betaAccepted = formSelectField('predictionBetaAcknowledged', 'Prediction beta acknowledged', ['true'], 'true');
  return {
    id: 'jupiter:prediction',
    connectorId: 'jupiter',
    operationId: 'prediction',
    operationLabel: 'Prediction markets',
    templateId: 'connector-jupiter-prediction',
    description: 'Trade Jupiter Prediction markets (beta). Buy/sell YES/NO contracts, close, or claim. Markets come from external providers; US/SK access is restricted and writes require a non-US egress.',
    executionMode: 'first-class-adapter',
    outcome: 'queueable',
    fields: [memo],
    subActions: {
      fieldId: 'subAction',
      label: 'Prediction action',
      defaultId: 'create-order',
      display: 'select',
      options: [
        {
          id: 'create-order',
          label: 'Open position',
          description: 'Buy or sell YES/NO contracts on a prediction market.',
          actionType: 'jupiter_prediction_create_order',
          fields: [
            formField('marketId', 'Market id', true),
            formSelectField('isBuy', 'Side', ['buy', 'sell'], 'buy', true),
            formSelectField('isYes', 'Outcome', ['yes', 'no'], 'yes', true),
            formField('depositAmount', 'Amount (USD)', true),
            depositMint,
            betaAccepted,
          ],
        },
        {
          id: 'close-position',
          label: 'Close position',
          description: 'Sell all contracts in an existing prediction position.',
          actionType: 'jupiter_prediction_close_position',
          fields: [
            formField('positionPubkey', 'Position address', true),
            formField('minSellPriceSlippageBps', 'Max slippage (bps)'),
          ],
        },
        {
          id: 'claim-position',
          label: 'Claim payout',
          description: 'Claim winnings from a settled prediction position ($1 per winning contract).',
          actionType: 'jupiter_prediction_claim_position',
          fields: [formField('positionPubkey', 'Position address', true)],
        },
      ],
    },
  };
}

function jupiterPerpsStatusForm(): ConnectorActionForm {
  return connectorActionForm(
    'jupiter',
    'perps-status',
    'Perps status (read-only)',
    'connector-jupiter-perps-status',
    'Check Jupiter Perps API readiness, docs, and risk warnings. Read-only; no Perps trades are prepared.',
    'read-only',
    'audit',
    [
      formSelectField('question', 'Perps check', ['status'], 'status'),
      formField('memo', 'Research note'),
    ],
    false,
    'read_only',
  );
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

function applyConnectorSubActionDefaults(
  form: ConnectorActionForm | undefined,
  parameters: Record<string, string>,
): Record<string, string> {
  if (!form?.subActions) return parameters;
  const branch = selectedSubAction(form, parameters);
  if (!branch) return parameters;
  const next = { ...parameters };
  const fieldId = form.subActions.fieldId;
  if (!next[fieldId]?.trim()) next[fieldId] = branch.id;
  next[`${fieldId}Label`] = branch.label;
  for (const field of branch.fields) {
    const defaultValue = connectorSubActionFieldDefault(field);
    if (defaultValue === undefined) continue;
    if (connectorFixedSubActionField(field) || !next[field.id]?.trim()) {
      next[field.id] = defaultValue;
    }
  }
  applySingleSidedLiquidityAmountDefaults(branch, next);
  return next;
}

function applySingleSidedLiquidityAmountDefaults(
  branch: ConnectorSubAction,
  parameters: Record<string, string>,
): void {
  const branchIds = new Set(branch.fields.map((field) => field.id));
  if (!branchIds.has('amountSide') || !branchIds.has('tokenAAmount') || !branchIds.has('tokenBAmount')) return;
  const side = parameters.amountSide === 'tokenB' ? 'tokenB' : 'tokenA';
  const selectedAmount = side === 'tokenB' ? 'tokenBAmount' : 'tokenAAmount';
  const oppositeAmount = side === 'tokenB' ? 'tokenAAmount' : 'tokenBAmount';
  const selectedMax = side === 'tokenB' ? 'maxTokenAAmount' : 'maxTokenBAmount';
  const oppositeMax = side === 'tokenB' ? 'maxTokenBAmount' : 'maxTokenAAmount';
  if (parameters.amount?.trim() && !parameters.tokenAAmount?.trim() && !parameters.tokenBAmount?.trim()) {
    parameters[selectedAmount] = parameters.amount.trim();
  }
  delete parameters[oppositeAmount];
  if (!branchIds.has(selectedMax)) delete parameters[selectedMax];
  delete parameters[oppositeMax];
}

function connectorFixedSubActionField(field: AgentPlanTemplateField): boolean {
  return field.type === 'select' && (field.options?.length ?? 0) === 1;
}

function connectorSubActionFieldDefault(field: AgentPlanTemplateField): string | undefined {
  if (field.defaultValue !== undefined) return field.defaultValue;
  if (connectorFixedSubActionField(field)) return field.options?.[0];
  return undefined;
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

export function connectorFormRenderFields(
  form: ConnectorActionForm,
  parameters: Record<string, string> = {},
): AgentPlanTemplateField[] {
  const fields = connectorVisibleFormFields(form, parameters);
  return fields
    .map((field, index) => ({ field, index }))
    .sort((left, right) => {
      const leftRank = connectorRenderFieldRank(left.field);
      const rightRank = connectorRenderFieldRank(right.field);
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.index - right.index;
    })
    .map((entry) => entry.field);
}

function connectorVisibleFormFields(
  form: ConnectorActionForm,
  parameters: Record<string, string>,
): AgentPlanTemplateField[] {
  if (!form.subActions) return form.fields;
  const fields: AgentPlanTemplateField[] = [];
  const selectField = subActionSelectField(form);
  if (selectField) fields.push(selectField);
  const baseIds = new Set(form.fields.map((field) => field.id));
  const branch = selectedSubAction(form, parameters);
  for (const field of branch?.fields ?? []) {
    if (baseIds.has(field.id) || connectorFixedSubActionField(field)) continue;
    fields.push(field);
  }
  fields.push(...form.fields);
  return fields;
}

function connectorRenderFieldRank(field: AgentPlanTemplateField): number {
  if (field.id === 'subAction') return 0;
  if (connectorMemoField(field)) return 90;
  if (connectorPrimarySelectorField(field)) return 10;
  if (connectorDependentSelectorField(field)) return 20;
  if (field.type === 'cascading-select' && (field.cascading?.dependsOn?.length ?? 0) === 0) return 10;
  if (field.type === 'cascading-select') return 20;
  if (connectorAmountField(field)) return 30;
  if (connectorRecipientField(field)) return 40;
  if (connectorConstraintField(field)) return 50;
  return 60;
}

function connectorPrimarySelectorField(field: AgentPlanTemplateField): boolean {
  return /^(protocol|operation|realmAddress|multisigAddress|vaultId|vaultAddress|poolAddress|poolId|whirlpoolAddress|reserveAddress|bankAddress|token|assetMint|mintAddress|sourceMint|inputMint|outputMint|lstMint|priceFeedIds|collectionId|stakeAccount|receiptAccount|ticketAccount)$/i.test(field.id);
}

function connectorDependentSelectorField(field: AgentPlanTemplateField): boolean {
  return /^(positionId|positionAddress|positionMint|governingTokenMint|proposalAddress|destinationChain|listingId|withdrawalId|bidId|vaultIndex)$/i.test(field.id);
}

function connectorMemoField(field: AgentPlanTemplateField): boolean {
  return /^(memo|reason|instructions|note|notes)$/i.test(field.id);
}

function connectorAmountField(field: AgentPlanTemplateField): boolean {
  const id = field.id.toLowerCase();
  return id.includes('amount') ||
    id === 'shares' ||
    id === 'percentage' ||
    id === 'pricesol' ||
    id === 'bidpricesol' ||
    id === 'maxpricesol' ||
    id === 'maxescrowsol' ||
    id === 'count';
}

function connectorRecipientField(field: AgentPlanTemplateField): boolean {
  return /^(recipient|destinationAddress|destinationRecipient)$/i.test(field.id);
}

function connectorConstraintField(field: AgentPlanTemplateField): boolean {
  return /^(slippageBps|minHealthFactor|minHealthRatio|rangePreset|strategyType|withdrawMode|lowerPrice|upperPrice|lowerTick|upperTick|maxAgeSeconds|question)$/i.test(field.id);
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
  const subActionFieldId = form.subActions.fieldId;
  const branchFields: AgentPlanTemplateField[] = [];
  for (const branch of form.subActions.options) {
    for (const field of branch.fields) {
      if (baseIds.has(field.id)) continue;
      if (connectorFixedSubActionField(field)) continue;
      branchFields.push({
        ...field,
        showWhen: {
          ...(field.showWhen ?? {}),
          [subActionFieldId]: branch.id,
        },
      });
    }
  }
  return [
    ...(selectField ? [selectField] : []),
    ...branchFields,
    ...form.fields,
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
    add(minHealthRatioField());
  } else if (actionKind.startsWith('jupiter_trigger_')) {
    if (has('cancel', 'edit', 'withdraw')) add(formField('orderId', 'Order id', true));
    if (has('single_order', 'oco_order', 'otoco_order')) {
      add(jupiterTokenField('inputMint', 'Spend token', true, JUPITER_FORM_TOKEN_MINTS.SOL));
      add(jupiterTokenField('outputMint', 'Receive token', true, JUPITER_FORM_TOKEN_MINTS.USDC));
      add(formField('amount', 'Amount to spend', true));
      add(formField('takingAmount', 'Minimum output amount'));
      add(formField('triggerPriceUsd', 'Trigger price'));
      add(formField('slippageBps', 'Max slippage', false, { placeholder: '0.5%' }));
    }
    if (has('register_vault')) add(formField('payer', 'Payer override'));
    if (has('edit')) add(formField('newTriggerPriceUsd', 'New trigger price'));
  } else if (actionKind.startsWith('jupiter_recurring_')) {
    if (has('cancel', 'deposit_price_order', 'withdraw_price_order')) add(formField('orderId', 'Order id', true));
    if (has('create_time_order')) {
      add(formSelectField('dcaDirection', 'Direction', ['buy', 'sell'], 'buy', true));
      add(jupiterTokenField('inputMint', 'Spend token', true, JUPITER_FORM_TOKEN_MINTS.USDC));
      add(jupiterTokenField('outputMint', 'Buy token', true, JUPITER_FORM_TOKEN_MINTS.SOL));
      add(formField('totalAmount', 'Total spend', true));
      add(formField('intervalSeconds', 'Every', true));
      add(formField('numberOfOrders', 'How many buys'));
    }
  } else if (actionKind.startsWith('raydium_')) {
    add(formField('poolId', 'Pool id', true));
    add(formSelectField('poolType', 'Pool type', ['cpmm', 'clmm', 'farm'], 'cpmm'));
    if (has('liquidity', 'fees')) add(formField('positionMint', 'Position mint'));
    if (has('add_liquidity')) {
      add(liquidityAmountSideField());
      add(liquidityTokenAmountField('tokenAAmount', 'Token A amount', 'tokenA'));
      add(liquidityOppositeMaxField('maxTokenBAmount', 'Max token B amount', 'tokenA'));
      add(liquidityTokenAmountField('tokenBAmount', 'Token B amount', 'tokenB'));
      add(liquidityOppositeMaxField('maxTokenAAmount', 'Max token A amount', 'tokenB'));
      add(formSelectField('rangePreset', 'Price range', ['balanced', 'narrow', 'wide', 'custom'], 'balanced'));
      add(liquidityCustomRangePriceField('lowerPrice', 'Custom lower price'));
      add(liquidityCustomRangePriceField('upperPrice', 'Custom upper price'));
    } else if (has('remove_liquidity', 'farm_stake', 'farm_unstake')) {
      add(formField('amount', 'Amount'));
    }
  } else if (actionKind.startsWith('orca_')) {
    add(formField('whirlpoolAddress', 'Whirlpool address', true));
    add(formField('positionMint', 'Position mint'));
    if (has('increase_liquidity')) {
      add(liquidityAmountSideField());
      add(liquidityTokenAmountField('tokenAAmount', 'Token A amount', 'tokenA'));
      add(liquidityOppositeMaxField('maxTokenBAmount', 'Max token B amount', 'tokenA'));
      add(liquidityTokenAmountField('tokenBAmount', 'Token B amount', 'tokenB'));
      add(liquidityOppositeMaxField('maxTokenAAmount', 'Max token A amount', 'tokenB'));
      add(formSelectField('rangePreset', 'Range preset', ['balanced', 'narrow', 'wide'], 'balanced'));
    } else if (has('liquidity')) {
      add(formField('amount', 'Liquidity amount'));
    }
  } else if (actionKind.startsWith('meteora_')) {
    add(formField('poolAddress', 'DLMM pool address', true));
    add(formField('positionAddress', 'Position address'));
    if (has('add_liquidity')) {
      add(formField('tokenXAmount', 'Token X amount'));
      add(formSelectField('rangePreset', 'Range preset', ['balanced', 'narrow', 'wide'], 'balanced'));
    } else if (has('liquidity')) {
      add(formField('amount', 'Amount'));
    }
  } else if (actionKind.startsWith('marginfi_')) {
    add(formField('bankAddress', 'Bank address', true));
    add(formField('amount', 'Amount', !has('withdraw', 'repay')));
    add(minHealthFactorField());
  } else if (actionKind.startsWith('project0_')) {
    if (has('create_account')) {
      add(formField('accountIndex', 'Account index'));
    } else {
      add(formField('bankAddress', 'Bank address', true));
      add(formField('amount', 'Amount', !has('withdraw', 'repay')));
      add(formField('project0Account', 'Project 0 account'));
      add(minHealthRatioField());
    }
  } else if (actionKind.startsWith('save_')) {
    add(formField('token', 'Reserve token or mint', true));
    add(formField('amount', 'Amount', !has('withdraw', 'repay')));
    add(minHealthFactorField());
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
      add(wormholeTokenField(true));
      add(formField('amount', 'Amount', true));
      add(wormholeDestinationField(true));
      add(formField('destinationAddress', 'Destination recipient', true));
    } else {
      add(formField('transferId', 'Transfer id / VAA', true));
    }
  } else if (actionKind.startsWith('pyth_')) {
    add(cascadingField('priceFeedIds', 'Price feeds', 'pyth.feed', {
      required: true,
      emptyHint: 'Type a symbol (e.g. SOL/USD) to search Pyth feeds.',
      placeholder: 'SOL/USD',
    }));
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
    connectorReadFields(connector),
    false,
    'read_only',
  );
}

function connectorReadFields(connector: ProtocolConnector): AgentPlanTemplateField[] {
  const base = [formField('protocol', 'Protocol', true)];
  const tail = [
    formSelectField('question', 'Question', ['status', 'balances', 'rewards', 'risk', 'markets'], 'status'),
    formField('memo', 'Instructions'),
  ];
  const pythTail = [
    formSelectField('question', 'Question', ['price', 'freshness', 'confidence', 'oracle evidence'], 'price'),
    formField('memo', 'Instructions'),
  ];
  switch (connector.id) {
    case 'pyth':
      return [
        ...base,
        cascadingField('priceFeedIds', 'Price feed', 'pyth.feed', {
          emptyHint: 'Type a symbol (e.g. SOL/USD) to search Pyth feeds.',
          placeholder: 'SOL/USD',
        }),
        ...pythTail,
      ];
    case 'drift':
      return [
        ...base,
        driftVaultField(false),
        ...tail,
      ];
    case 'meteora':
      return [
        ...base,
        meteoraPoolField(false),
        meteoraPositionField(false),
        ...tail,
      ];
    case 'raydium':
      return [
        ...base,
        raydiumPoolField('raydium.pool', false),
        cascadingField('positionMint', 'Raydium position', 'raydium.position', {
          dependsOn: ['poolId'],
          emptyHint: 'No Raydium positions found in this pool.',
        }),
        ...tail,
      ];
    case 'orca':
      return [
        ...base,
        orcaWhirlpoolField(false),
        orcaPositionField(false),
        ...tail,
      ];
    case 'realms':
      return [
        ...base,
        realmsRealmField(false),
        realmsTokenField(false),
        realmsProposalField(false),
        ...tail,
      ];
    case 'wormhole':
      return [
        ...base,
        wormholeTokenField(false),
        wormholeDestinationField(false),
        ...tail,
      ];
    case 'jupiter':
      return [
        ...base,
        cascadingField('assetMint', 'Jupiter Lend asset', 'jupiter.lend.earn.asset', {
          emptyHint: "Couldn't load Jupiter Lend earn pools.",
        }),
        ...tail,
      ];
    case 'kamino':
      return [
        ...base,
        kaminoReserveField(false),
        ...tail,
      ];
    case 'marginfi':
      return [
        ...base,
        marginfiBankField(false),
        ...tail,
      ];
    case 'save':
      return [
        ...base,
        saveReserveField(false),
        ...tail,
      ];
    case 'lulo':
      return [
        ...base,
        luloMintField(false),
        ...tail,
      ];
    case 'sanctum':
      return [
        ...base,
        sanctumLstField('lstMint', 'Sanctum LST', 'sanctum.lst', false),
        ...tail,
      ];
    default:
      return [
        ...base,
        formField('position', 'Position / market'),
        ...tail,
      ];
  }
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

function connectorParameterFieldIsVisible(
  field: AgentPlanTemplateField,
  parameters: Record<string, string>,
): boolean {
  if (!field.showWhen) return true;
  for (const [key, value] of Object.entries(field.showWhen)) {
    const actual = parameters[key]?.trim() ?? '';
    const expected = Array.isArray(value) ? value : [value];
    if (!expected.includes(actual)) return false;
  }
  return true;
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
      amount: validation.parameters.amount || validation.parameters.bidPriceSol || validation.parameters.priceSol || '',
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
