import type { GlobalOptions } from '../shared/types.js';
import { input, select, confirm, header, badge, multilineInput } from '../tui/index.js';
import { requiredUserInputsForAction, getConnector, humanizeActionKind } from './connectorMeta.js';
import { validatePositiveDecimal } from './validators.js';
import { tryResourcePick } from './resourcePicker.js';

export interface ConnectorActionDraft {
  connectorId: string;
  actionKind: string;
  params: Record<string, unknown>;
  summary: string;
  reason?: string;
  note?: string;
}

const NUMBER_INTEGER_HINTS = new Set([
  'slippageBps',
  'maxFeeBps',
  'priorityFee',
  'percentage',
  'leverage',
  'quantity',
  'maxItems',
  'vaultId',
  'positionId',
  'maxLtvBps',
  'minBinId',
  'maxBinId',
  'liquidityBps',
  'lowerTick',
  'upperTick',
  'accountIndex',
  'traderPdaIndex',
  'vaultIndex',
  'maxAgeSeconds',
  'computeUnitPriceMicroLamports',
  'numberOfOrders',
  'intervalSeconds',
  'choiceIndex',
  'transactionIndex',
]);

export async function promptConnectorForm(
  connectorId: string,
  actionKind: string,
  options?: GlobalOptions,
): Promise<ConnectorActionDraft> {
  const spec = getConnector(connectorId);
  if (!spec) throw new Error(`Unknown connector: ${connectorId}`);

  const label = humanizeActionKind(actionKind, connectorId);
  console.log(header(`${spec.name} → ${label}`));

  const inputs = requiredUserInputsForAction(connectorId, actionKind);
  if (inputs.length === 0) {
    console.log(badge('No required inputs in spec - you can add custom params below.', 'muted'));
  }

  const params: Record<string, unknown> = {};
  // Required first, then optional — readability for the user.
  const ordered = [...inputs].sort((a, b) => Number(b.required) - Number(a.required));

  for (const field of ordered) {
    const value = await promptField(field, connectorId, options);
    if (value !== undefined) params[field.name] = value;
  }

  // Custom param escape hatch — for spec gaps and advanced flags.
  const wantsExtra = await confirm({
    message: 'Add another custom parameter (advanced)?',
    default: false,
  });
  if (wantsExtra) {
    await collectExtraParams(params);
  }

  // Universal Reason + Notes (web parity — every action form ends with these).
  const reason = await input({
    message: 'Reason (optional)',
    default: '',
  });
  const note = await multilineInput({
    message: 'Notes for review record (optional)',
    default: '',
  });

  const draft: ConnectorActionDraft = {
    connectorId,
    actionKind,
    params,
    summary: `${spec.name} → ${label}`,
  };
  if (reason.trim()) draft.reason = reason.trim();
  if (note.trim())   draft.note   = note.trim();
  return draft;
}

async function promptField(
  field: { name: string; kind: string; required: boolean; prompt: string; options?: string[] },
  connectorId: string,
  options?: GlobalOptions,
): Promise<unknown> {
  const label = `${field.prompt}${field.required ? '' : ' (optional)'}`;

  if (field.kind === 'select' && field.options && field.options.length > 0) {
    if (!field.required) {
      const skip = await confirm({ message: `Provide ${field.name}?`, default: false });
      if (!skip) return undefined;
    }
    return select<string>({
      message: label,
      choices: field.options.map((opt) => ({ name: opt, value: opt })),
    });
  }

  if (field.kind === 'boolean' || field.kind === 'toggle') {
    return confirm({ message: label, default: false });
  }

  if (field.kind === 'number') {
    const raw = await input({
      message: label,
      validate: (v) => {
        const trimmed = v.trim();
        if (!trimmed) return field.required ? 'Required field.' : true;
        const isInteger = NUMBER_INTEGER_HINTS.has(field.name);
        if (isInteger) {
          if (!/^-?\d+$/.test(trimmed)) return 'Must be an integer.';
          return true;
        }
        return validatePositiveDecimal(trimmed);
      },
    });
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    if (NUMBER_INTEGER_HINTS.has(field.name)) {
      return Number(trimmed);
    }
    // Decimals stay as strings (token amount precision).
    return trimmed;
  }

  // Default: text. First try a resource picker — if one is registered for
  // this (connector, field) pair, fetch the catalog and let the user pick.
  // Falls back to plain input when nothing is registered or the fetch is empty.
  if (options) {
    const picked = await tryResourcePick({
      options,
      connectorId,
      fieldName: field.name,
      label,
      required: field.required,
    });
    if (picked !== null) return picked || undefined;
  }
  const raw = await input({
    message: label,
    validate: (v) => {
      if (!v.trim() && field.required) return 'Required field.';
      return true;
    },
  });
  const trimmed = raw.trim();
  return trimmed || undefined;
}

async function collectExtraParams(params: Record<string, unknown>): Promise<void> {
  while (true) {
    const key = await input({
      message: 'Parameter name (blank to finish)',
    });
    if (!key.trim()) return;
    const value = await input({
      message: `Value for ${key.trim()}`,
    });
    params[key.trim()] = coerce(value.trim());
    const more = await confirm({ message: 'Add another?', default: false });
    if (!more) return;
  }
}

function coerce(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  return value;
}
