import { describe, expect, it } from 'vitest';

import {
  connectorActionDisplayParts,
  connectorActionFormByActionType,
  connectorActionFormTemplateActionType,
  connectorAiPlannerContext,
  connectorAiUserNotes,
  connectorActionFormsForConnector,
  connectorCreateConnectors,
  connectorCreateStatus,
  connectorDraftConnectors,
  connectorDraftStatus,
  isConnectorCapableTemplate,
  normalizeConnectorDraftParameters,
  selectedConnectorForDraftParameters,
  validateConnectorDraftParameters,
} from '../connectorDrafting.js';
import {
  PROTOCOL_CONNECTORS,
  emptyConnectedDapps,
  setConnectedDappEnabled,
} from '../connectedDapps.js';
import { AGENT_PLAN_TEMPLATES, templateById } from '../planner.js';

describe('connector drafting helpers', () => {
  const template = templateById('protocol-blink-action');

  it('marks the protocol connector action template as connector-capable', () => {
    expect(isConnectorCapableTemplate(template)).toBe(true);
    expect(isConnectorCapableTemplate(templateById('swap'))).toBe(false);
  });

  it('orders enabled Blink-capable connectors before disabled connectors', () => {
    const connectedDapps = setConnectedDappEnabled(emptyConnectedDapps(), 'meteora', true);
    const connectors = connectorDraftConnectors({
      connectedDapps,
      cluster: 'mainnet-beta',
    });

    expect(connectors[0]?.id).toBe('meteora');
    expect(connectorDraftStatus(connectors[0]!, { connectedDapps, cluster: 'mainnet-beta' }).selectable).toBe(true);
    expect(connectors.find((connector) => connector.id === 'orca')).toBeDefined();
  });

  it('normalizes selected connector parameters to canonical connector identity', () => {
    const parameters = normalizeConnectorDraftParameters(template, {
      protocol: 'meteora dlmm',
      operation: 'claim fees',
      blinkUrl: 'https://example.com/action',
    });

    expect(parameters).toMatchObject({
      connectorId: 'meteora',
      protocol: 'Meteora',
      operation: 'Claim fees',
      connectorActionSource: 'blink',
    });
    expect(selectedConnectorForDraftParameters(parameters)?.id).toBe('meteora');
  });

  it('drops stale generic amount and token fields from SOL staking connector forms', () => {
    const marinade = normalizeConnectorDraftParameters(templateById('connector-marinade-liquid-stake'), {
      connectorId: 'marinade',
      connectorOperationId: 'marinade:liquid-stake',
      token: 'USDC',
      inputToken: 'SOL',
      outputToken: 'USDC',
      amount: '9',
      solAmount: '0.01',
      memo: 'Stake into mSOL',
    });

    expect(marinade).toMatchObject({
      connectorId: 'marinade',
      protocol: 'Marinade',
      operation: 'Liquid stake',
      connectorActionSource: 'first-class-adapter',
      solAmount: '0.01',
      memo: 'Stake into mSOL',
    });
    expect(marinade).not.toHaveProperty('token');
    expect(marinade).not.toHaveProperty('inputToken');
    expect(marinade).not.toHaveProperty('outputToken');
    expect(marinade).not.toHaveProperty('amount');

    const jito = normalizeConnectorDraftParameters(templateById('connector-jito-stake-sol'), {
      connectorId: 'jito',
      connectorOperationId: 'jito:stake-sol',
      token: 'USDC',
      inputToken: 'SOL',
      outputToken: 'USDC',
      amount: '9',
      solAmount: '0.01',
      memo: 'Stake into JitoSOL',
    });

    expect(jito).toMatchObject({
      connectorId: 'jito',
      protocol: 'Jito',
      operation: 'Stake SOL',
      connectorActionSource: 'first-class-adapter',
      solAmount: '0.01',
      memo: 'Stake into JitoSOL',
    });
    expect(jito).not.toHaveProperty('token');
    expect(jito).not.toHaveProperty('inputToken');
    expect(jito).not.toHaveProperty('outputToken');
    expect(jito).not.toHaveProperty('amount');
  });

  it('exposes first-class connector forms without requiring Blink URLs', () => {
    const connectedDapps = setConnectedDappEnabled(emptyConnectedDapps(), 'kamino', true);
    const connectors = connectorCreateConnectors({
      connectedDapps,
      cluster: 'mainnet-beta',
    });
    const kamino = connectors.find((connector) => connector.id === 'kamino')!;
    const forms = connectorActionFormsForConnector(kamino);

    expect(connectorCreateStatus(kamino, { connectedDapps, cluster: 'mainnet-beta' }).selectable).toBe(true);
    expect(forms.map((form) => form.id)).toEqual(expect.arrayContaining([
      'kamino:deposit',
      'kamino:withdraw',
      'kamino:earnings-proof',
    ]));

    const result = validateConnectorDraftParameters(templateById('kamino-deposit'), {
      connectorId: 'kamino',
      connectorOperationId: 'kamino:deposit',
      token: 'SOL',
      amount: '0.1',
    }, {
      connectedDapps,
      cluster: 'mainnet-beta',
    }, 'template');

    expect(result.errors).toEqual({});
    expect(result.parameters).toMatchObject({
      connectorId: 'kamino',
      protocol: 'Kamino Finance',
      operation: 'Deposit',
      connectorActionSource: 'first-class-adapter',
    });
  });

  it('creates connector forms and plan templates for every registered first-class action kind', () => {
    const templateActionTypes = new Set(AGENT_PLAN_TEMPLATES.map((candidate) => candidate.actionType));
    const templateIds = new Set(AGENT_PLAN_TEMPLATES.map((candidate) => candidate.id));

    for (const connector of PROTOCOL_CONNECTORS.filter((candidate) => candidate.actionKinds.length > 0)) {
      const forms = connectorActionFormsForConnector(connector);
      const formActionTypes = new Set<string>();
      const subActionTemplateIds = new Set<string>();
      for (const form of forms) {
        const baseActionType = connectorActionFormTemplateActionType(form);
        if (baseActionType) formActionTypes.add(baseActionType);
        if (form.subActions) {
          for (const branch of form.subActions.options) {
            if (branch.actionType) {
              formActionTypes.add(branch.actionType);
              subActionTemplateIds.add(form.templateId);
            }
          }
        }
      }

      for (const actionKind of connector.actionKinds) {
        expect(formActionTypes.has(actionKind), `${connector.id} missing form for ${actionKind}`).toBe(true);
        const hasDirectTemplate = templateActionTypes.has(actionKind);
        const hasUnifiedTemplate = [...subActionTemplateIds].some((id) => templateIds.has(id));
        expect(hasDirectTemplate || hasUnifiedTemplate, `${connector.id} missing template for ${actionKind}`).toBe(true);
      }
    }
  });

  it('blocks non-AI executable drafts for disabled connectors', () => {
    const result = validateConnectorDraftParameters(template, {
      protocol: 'Meteora',
      operation: 'Claim fees',
      blinkUrl: 'https://example.com/action',
    }, {
      connectedDapps: emptyConnectedDapps(),
      cluster: 'mainnet-beta',
    }, 'template');

    expect(result.errors.protocol).toMatch(/not enabled/);
  });

  it('requires a valid Blink URL for non-AI connector template drafts', () => {
    const connectedDapps = setConnectedDappEnabled(emptyConnectedDapps(), 'meteora', true);
    const missingUrl = validateConnectorDraftParameters(template, {
      protocol: 'Meteora',
      operation: 'Claim fees',
    }, {
      connectedDapps,
      cluster: 'mainnet-beta',
    }, 'template');

    expect(missingUrl.errors.blinkUrl).toMatch(/requires a Blink\/Solana Action URL/);

    const invalidUrl = validateConnectorDraftParameters(template, {
      protocol: 'Meteora',
      operation: 'Claim fees',
      blinkUrl: 'http://example.com/action',
    }, {
      connectedDapps,
      cluster: 'mainnet-beta',
    }, 'template');

    expect(invalidUrl.errors.blinkUrl).toMatch(/https/);
  });

  it('lets AI drafts carry missing connector facts instead of switching connector', () => {
    const connectedDapps = setConnectedDappEnabled(emptyConnectedDapps(), 'meteora', true);
    const result = validateConnectorDraftParameters(template, {
      protocol: 'Meteora',
      operation: 'Claim fees',
    }, {
      connectedDapps,
      cluster: 'mainnet-beta',
    }, 'ai');

    expect(result.errors).toEqual({});
    expect(result.missingFacts).toContain('Blink/Solana Action URL');

    const context = connectorAiPlannerContext(template, result.parameters, {
      connectedDapps,
      cluster: 'mainnet-beta',
    });

    expect(context).toHaveLength(1);
    expect(context[0]).toMatchObject({
      selected: true,
      selectedOnly: true,
      id: 'meteora',
      selectedOperation: 'Claim fees',
      missingFacts: expect.arrayContaining(['Blink/Solana Action URL']),
    });
    expect(String(context[0]?.strictInstruction)).toContain('Do not switch protocols');
  });

  it('injects selected-only connector steering into AI user notes', () => {
    const notes = connectorAiUserNotes(template, {
      connectorId: 'meteora',
      protocol: 'Meteora',
      operation: 'Claim fees',
    }, 'claim if it matches my position');

    expect(notes).toContain('Selected protocol connector: Meteora (meteora).');
    expect(notes).toContain('Use this connector only');
    expect(notes).toContain('claim if it matches my position');
  });

  describe('cascading-select wins when legacy template ids collide', () => {
    it('exposes the cascading-select reserve field on the Kamino deposit template', () => {
      const kaminoDeposit = templateById('kamino-deposit');
      const tokenField = kaminoDeposit.fields.find((field) => field.id === 'token');
      expect(tokenField?.type).toBe('cascading-select');
      expect(tokenField?.cascading?.providerId).toBe('kamino.reserve');
    });

    it('preserves base template metadata when merging generated fields', () => {
      const kaminoDeposit = templateById('kamino-deposit');
      expect(kaminoDeposit.title).toBe('Kamino deposit');
      expect(kaminoDeposit.actionType).toBe('kamino_deposit');
      expect(kaminoDeposit.risk).toBe('medium');
    });

    it('surfaces cascading vault dropdown for Drift vault deposit', () => {
      const driftDeposit = templateById('drift-vault-deposit');
      const vaultField = driftDeposit.fields.find((field) => field.id === 'vaultAddress');
      expect(vaultField?.type).toBe('cascading-select');
      expect(vaultField?.cascading?.providerId).toBe('drift.vault');
    });

    it('surfaces cascading reserve dropdown for Kamino withdraw', () => {
      const kaminoWithdraw = templateById('kamino-withdraw');
      const tokenField = kaminoWithdraw.fields.find((field) => field.id === 'token');
      expect(tokenField?.type).toBe('cascading-select');
    });

    it('does not strip the swap template token-picker selectField defaults', () => {
      const swap = templateById('swap');
      const inputToken = swap.fields.find((field) => field.id === 'inputToken');
      const outputToken = swap.fields.find((field) => field.id === 'outputToken');
      const amount = swap.fields.find((field) => field.id === 'amount');
      expect(inputToken?.type).toBe('select');
      expect(inputToken?.defaultValue).toBe('SOL');
      expect(inputToken?.options).toEqual(expect.arrayContaining(['SOL', 'USDC']));
      expect(outputToken?.type).toBe('select');
      expect(outputToken?.defaultValue).toBe('USDC');
      expect(amount?.defaultValue).toBe('0.01');
    });

    it('keeps base-only fields like Drift initializeDepositorIfMissing after merge', () => {
      const driftDeposit = templateById('drift-vault-deposit');
      const initField = driftDeposit.fields.find((field) => field.id === 'initializeDepositorIfMissing');
      expect(initField?.type).toBe('select');
      const amount = driftDeposit.fields.find((field) => field.id === 'amount');
      expect(amount?.defaultValue).toBe('25');
    });
  });

  describe('connectorActionFormByActionType', () => {
    it('resolves the Kamino deposit form from its action type', () => {
      const form = connectorActionFormByActionType('kamino_deposit');
      expect(form?.connectorId).toBe('kamino');
      expect(form?.operationLabel).toBe('Deposit');
      const reserveField = form?.fields.find((field) => field.id === 'token');
      expect(reserveField?.type).toBe('cascading-select');
    });

    it('returns the Magic Eden bid form when given a sub-action action type', () => {
      const form = connectorActionFormByActionType('magiceden_bid');
      expect(form?.subActions?.options.map((option) => option.id)).toContain('collection');
    });

    it('returns undefined for an unknown action type', () => {
      expect(connectorActionFormByActionType('not_a_real_action')).toBeUndefined();
      expect(connectorActionFormByActionType('')).toBeUndefined();
      expect(connectorActionFormByActionType(undefined)).toBeUndefined();
    });
  });

  describe('connectorActionDisplayParts', () => {
    it('formats the connector operation and selected reserve as the inbox title', () => {
      const display = connectorActionDisplayParts('kamino_deposit', {
        connectorOperationId: 'kamino:deposit',
        token: 'SOL',
        amount: '0.01',
      });

      expect(display?.title).toBe('Kamino deposit - SOL Reserve');
      expect(display?.operationLabel).toBe('Kamino deposit');
      expect(display?.selectionLabel).toBe('SOL Reserve');
    });

    it('prefers explicit dropdown labels when a connector value is an address', () => {
      const display = connectorActionDisplayParts('kamino_deposit', {
        connectorOperationId: 'kamino:deposit',
        token: 'So11111111111111111111111111111111111111112',
        tokenLabel: 'SOL reserve',
        amount: '0.01',
      });

      expect(display?.title).toBe('Kamino deposit - SOL Reserve');
    });

    it('includes the selected sub-action before the selected pool for unified connector forms', () => {
      const display = connectorActionDisplayParts('raydium_add_liquidity', {
        connectorOperationId: 'raydium:liquidity-flow',
        subAction: 'clmm-add',
        poolId: 'SOL-USDC',
        amount: '0.01',
      });

      expect(display?.title).toBe('Raydium liquidity - CLMM Add Liquidity - SOL USDC');
      expect(display?.operationLabel).toBe('Raydium liquidity - CLMM Add Liquidity');
      expect(display?.selectionLabel).toBe('SOL USDC');
    });
  });
});
