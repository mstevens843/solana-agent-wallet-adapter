import { describe, expect, it } from 'vitest';

import {
  connectorFormRenderFields,
  effectiveFormFields,
  formTemplateFields,
  selectedSubAction,
  subActionSelectField,
  connectorActionFormTemplateActionType,
  connectorActionFormByActionType,
  type ConnectorActionForm,
  type ConnectorSubAction,
} from '../connectorDrafting.js';

function makeForm(subActions?: ConnectorActionForm['subActions']): ConnectorActionForm {
  return {
    id: 'jupiter:lend-flow',
    connectorId: 'jupiter',
    operationId: 'lend',
    operationLabel: 'Lend',
    templateId: 'connector-jupiter-lend',
    description: 'Jupiter Lend unified entry',
    executionMode: 'first-class-adapter',
    outcome: 'queueable',
    fields: [
      { id: 'memo', label: 'Reason', type: 'text' },
    ],
    ...(subActions ? { subActions } : {}),
    actionType: 'jupiter_lend',
  };
}

const earn: ConnectorSubAction = {
  id: 'earn-deposit',
  label: 'Earn (single-asset pool)',
  description: 'Deposit into a Jupiter Lend earn pool.',
  actionType: 'jupiter_lend_earn_deposit',
  fields: [
    { id: 'assetMint', label: 'Earn asset', type: 'text', required: true },
    { id: 'amount', label: 'Amount', type: 'text', required: true },
  ],
};

const borrow: ConnectorSubAction = {
  id: 'borrow-deposit',
  label: 'Borrow (collateral)',
  description: 'Deposit collateral into a Jupiter Lend borrow vault.',
  actionType: 'jupiter_lend_borrow_deposit_collateral',
  fields: [
    { id: 'vaultId', label: 'Borrow vault', type: 'text', required: true },
    { id: 'collateralAmount', label: 'Collateral amount', type: 'text', required: true },
  ],
};

describe('connector sub-actions', () => {
  it('returns base fields when form has no subActions', () => {
    const form = makeForm();
    expect(effectiveFormFields(form)).toEqual(form.fields);
    expect(selectedSubAction(form)).toBeUndefined();
    expect(subActionSelectField(form)).toBeUndefined();
  });

  it('uses the first option by default when no params are supplied', () => {
    const form = makeForm({ fieldId: 'subAction', label: 'Lend type', options: [earn, borrow] });
    const branch = selectedSubAction(form);
    expect(branch?.id).toBe('earn-deposit');
  });

  it('honors defaultId when present', () => {
    const form = makeForm({ fieldId: 'subAction', label: 'Lend type', options: [earn, borrow], defaultId: 'borrow-deposit' });
    const branch = selectedSubAction(form);
    expect(branch?.id).toBe('borrow-deposit');
  });

  it('selects the requested branch by id', () => {
    const form = makeForm({ fieldId: 'subAction', label: 'Lend type', options: [earn, borrow] });
    const branch = selectedSubAction(form, { subAction: 'borrow-deposit' });
    expect(branch?.id).toBe('borrow-deposit');
  });

  it('concatenates base + selected branch fields without duplicates', () => {
    const form = makeForm({ fieldId: 'subAction', label: 'Lend type', options: [earn, borrow] });
    const merged = effectiveFormFields(form, { subAction: 'borrow-deposit' });
    expect(merged.map((field) => field.id)).toEqual(['memo', 'vaultId', 'collateralAmount']);
  });

  it('resolves actionType from the selected branch', () => {
    const form = makeForm({ fieldId: 'subAction', label: 'Lend type', options: [earn, borrow] });
    expect(connectorActionFormTemplateActionType(form, { subAction: 'earn-deposit' })).toBe('jupiter_lend_earn_deposit');
    expect(connectorActionFormTemplateActionType(form, { subAction: 'borrow-deposit' })).toBe('jupiter_lend_borrow_deposit_collateral');
  });

  it('falls back to form actionType when no branch is selected', () => {
    const form = makeForm();
    expect(connectorActionFormTemplateActionType(form)).toBe('jupiter_lend');
  });

  it('builds template fields with a sub-action select and showWhen annotations', () => {
    const form = makeForm({ fieldId: 'subAction', label: 'Lend type', options: [earn, borrow] });
    const fields = formTemplateFields(form);
    const ids = fields.map((field) => field.id);
    expect(ids).toEqual(['subAction', 'assetMint', 'amount', 'vaultId', 'collateralAmount', 'memo']);
    const subActionField = fields.find((field) => field.id === 'subAction');
    expect(subActionField?.type).toBe('select');
    expect(subActionField?.options).toEqual(['earn-deposit', 'borrow-deposit']);
    const assetMintField = fields.find((field) => field.id === 'assetMint');
    expect(assetMintField?.showWhen).toEqual({ subAction: 'earn-deposit' });
    const vaultField = fields.find((field) => field.id === 'vaultId');
    expect(vaultField?.showWhen).toEqual({ subAction: 'borrow-deposit' });
  });

  it('renders only the active branch in canonical connector form order', () => {
    const form = makeForm({ fieldId: 'subAction', label: 'Lend type', options: [earn, borrow] });
    const fields = connectorFormRenderFields(form, { subAction: 'borrow-deposit' });
    expect(fields.map((field) => field.id)).toEqual(['subAction', 'vaultId', 'collateralAmount', 'memo']);
  });

  it('does not duplicate branch fields whose id collides with base fields', () => {
    const conflicting: ConnectorSubAction = {
      id: 'conflict',
      label: 'Conflict',
      description: 'Branch reusing the base memo field id.',
      actionType: 'conflict_action',
      fields: [
        { id: 'memo', label: 'Override memo', type: 'text' },
        { id: 'extra', label: 'Extra', type: 'text' },
      ],
    };
    const form = makeForm({ fieldId: 'subAction', label: 'Mode', options: [conflicting] });
    const fields = formTemplateFields(form);
    expect(fields.map((field) => field.id)).toEqual(['subAction', 'extra', 'memo']);
    const extra = fields.find((field) => field.id === 'extra');
    expect(extra?.showWhen).toEqual({ subAction: 'conflict' });
  });

  it('keeps repeated branch fields branch-scoped and hides fixed sub-action params', () => {
    const form = connectorActionFormByActionType('lulo_deposit');
    expect(form).toBeDefined();
    const fields = formTemplateFields(form!);
    expect(fields.some((field) => field.id === 'depositType')).toBe(false);
    expect(fields.some((field) => field.id === 'withdrawType')).toBe(false);

    const depositAmount = fields.find((field) => field.id === 'amount' && field.showWhen?.subAction === 'deposit-protected');
    const withdrawAmount = fields.find((field) => field.id === 'amount' && field.showWhen?.subAction === 'withdraw-protected');
    expect(depositAmount?.required).toBe(true);
    expect(withdrawAmount?.required).toBeFalsy();
  });

  it('keeps fixed sub-action params out of visible render fields', () => {
    const raydium = connectorActionFormByActionType('raydium_add_liquidity');
    const realms = connectorActionFormByActionType('realms_cast_vote');
    expect(raydium).toBeDefined();
    expect(realms).toBeDefined();

    const raydiumFields = connectorFormRenderFields(raydium!, { subAction: 'cpmm-add' }).map((field) => field.id);
    const realmsFields = connectorFormRenderFields(realms!, { subAction: 'approve' }).map((field) => field.id);

    expect(raydiumFields).toEqual(['subAction', 'poolId', 'amountSide', 'tokenAAmount', 'tokenBAmount', 'memo']);
    expect(raydiumFields).not.toContain('poolType');
    expect(realmsFields).toEqual(['subAction', 'realmAddress', 'governingTokenMint', 'proposalAddress', 'memo']);
    expect(realmsFields).not.toContain('voteKind');
  });

  it('keeps pool or position selectors before amounts and reason across liquidity forms', () => {
    const orca = connectorActionFormByActionType('orca_increase_liquidity');
    const raydium = connectorActionFormByActionType('raydium_add_liquidity');
    expect(orca).toBeDefined();
    expect(raydium).toBeDefined();

    expect(connectorFormRenderFields(orca!, { subAction: 'existing-position' }).map((field) => field.id)).toEqual([
      'subAction',
      'whirlpoolAddress',
      'positionMint',
      'amountSide',
      'tokenAAmount',
      'tokenBAmount',
      'memo',
    ]);
    expect(connectorFormRenderFields(raydium!, { subAction: 'clmm-increase' }).map((field) => field.id)).toEqual([
      'subAction',
      'poolId',
      'positionMint',
      'amountSide',
      'tokenAAmount',
      'tokenBAmount',
      'memo',
    ]);
  });
});
