import { describe, expect, it } from 'vitest';

import {
  connectorActionDisplayParts,
  connectorActionFormById,
  connectorActionFormByActionType,
  connectorActionFormForTemplate,
  connectorActionFormTemplateActionType,
  connectorAiPlannerContext,
  connectorAiUserNotes,
  connectorActionFormsForConnector,
  connectorFormRenderFields,
  connectorCreateConnectors,
  connectorCreateStatus,
  connectorDraftConnectors,
  connectorDraftStatus,
  formTemplateFields,
  isConnectorCapableTemplate,
  normalizeConnectorDraftParameters,
  scopeConnectorDraftParameters,
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

  it('seeds default sub-actions before scoping branch fields', () => {
    const lend = normalizeConnectorDraftParameters(templateById('connector-jupiter-lend'), {
      connectorId: 'jupiter',
      connectorOperationId: 'jupiter:lend-flow',
      assetMint: 'USDC',
      amount: '1',
      memo: 'Earn yield',
    });

    expect(lend).toMatchObject({
      connectorId: 'jupiter',
      connectorOperationId: 'jupiter:lend-flow',
      protocol: 'Jupiter',
      operation: 'Lend',
      connectorActionSource: 'first-class-adapter',
      subAction: 'earn-deposit',
      assetMint: 'USDC',
      amount: '1',
    });
  });

  it('configures Jupiter Lend type selection as a dropdown-backed subaction group', () => {
    const form = connectorActionFormById('jupiter:lend-flow');
    expect(form?.subActions?.label).toBe('Lend type');
    expect(form?.subActions?.display).toBe('select');
  });

  it('groups Jupiter Trigger, DCA, and Perps into user-friendly connector templates', () => {
    const jupiter = PROTOCOL_CONNECTORS.find((connector) => connector.id === 'jupiter')!;
    const forms = connectorActionFormsForConnector(jupiter);

    expect(forms.map((form) => form.id)).not.toContain('jupiter:swap');
    expect(forms.map((form) => form.id)).toEqual(expect.arrayContaining([
      'jupiter:lend-flow',
      'jupiter:trigger-limit-orders',
      'jupiter:recurring-dca',
      'jupiter:perps-status',
    ]));

    const trigger = connectorActionFormById('jupiter:trigger-limit-orders');
    expect(trigger?.operationLabel).toBe('Limit orders');
    expect(trigger?.subActions?.label).toBe('Limit order action');
    expect(trigger?.subActions?.display).toBe('select');
    expect(trigger?.subActions?.options.map((option) => option.label)).toEqual([
      'Set up order vault',
      'Limit / stop order',
      'TP/SL bracket (OCO)',
      'Entry + TP/SL (OTOCO)',
      'Edit order trigger',
      'Cancel order',
      'Withdraw cancelled funds',
    ]);

    const recurring = connectorActionFormById('jupiter:recurring-dca');
    expect(recurring?.operationLabel).toBe('DCA orders');
    expect(recurring?.subActions?.label).toBe('DCA action');
    expect(recurring?.subActions?.options.map((option) => option.label)).toEqual([
      'Create DCA order',
      'Cancel DCA order',
      'Advanced: fund price order',
      'Advanced: withdraw price order',
    ]);

    const perps = connectorActionFormById('jupiter:perps-status');
    expect(perps).toMatchObject({
      operationLabel: 'Perps status (read-only)',
      executionMode: 'read-only',
      actionType: 'read_only',
    });
    expect(templateById('connector-jupiter-perps-status').title).toBe('Jupiter Perps status (read-only)');
  });

  it('infers connector-specific templates before seeding default sub-actions', () => {
    const raydium = normalizeConnectorDraftParameters(templateById('connector-raydium-liquidity'), {
      poolId: 'SOL-USDC-CPMM',
      tokenAAmount: '0.01',
    });
    expect(raydium).toMatchObject({
      connectorId: 'raydium',
      connectorOperationId: 'raydium:liquidity-flow',
      protocol: 'Raydium',
      operation: 'Liquidity',
      connectorActionSource: 'first-class-adapter',
      subAction: 'cpmm-add',
      poolType: 'cpmm',
      poolId: 'SOL-USDC-CPMM',
      tokenAAmount: '0.01',
    });

    const lend = normalizeConnectorDraftParameters(templateById('connector-jupiter-lend'), {
      assetMint: 'So11111111111111111111111111111111111111112',
      amount: '0.01',
    });
    expect(lend).toMatchObject({
      connectorId: 'jupiter',
      connectorOperationId: 'jupiter:lend-flow',
      protocol: 'Jupiter',
      operation: 'Lend',
      connectorActionSource: 'first-class-adapter',
      subAction: 'earn-deposit',
      assetMint: 'So11111111111111111111111111111111111111112',
      amount: '0.01',
    });

    const lulo = normalizeConnectorDraftParameters(templateById('connector-lulo-flow'), {
      mintAddress: 'USDC',
      amount: '1',
    });
    expect(lulo).toMatchObject({
      connectorId: 'lulo',
      connectorOperationId: 'lulo:flow',
      protocol: 'Lulo',
      operation: 'Deposit or withdraw',
      connectorActionSource: 'first-class-adapter',
      subAction: 'deposit-protected',
      depositType: 'protected',
      mintAddress: 'USDC',
      amount: '1',
    });
  });

  it('persists fixed connector sub-action params without rendering them as fields', () => {
    const form = connectorActionFormByActionType('raydium_add_liquidity');
    expect(form).toBeDefined();

    const normalized = normalizeConnectorDraftParameters(templateById('connector-raydium-liquidity'), {
      subAction: 'cpmm-add',
      poolId: 'SOL-USDC-CPMM',
      tokenAAmount: '0.01',
    });
    const renderFieldIds = connectorFormRenderFields(form!, normalized).map((field) => field.id);

    expect(normalized.poolType).toBe('cpmm');
    expect(renderFieldIds).toEqual(['subAction', 'poolId', 'amountSide', 'tokenAAmount', 'tokenBAmount', 'memo']);
    expect(renderFieldIds).not.toContain('poolType');
  });

  it('lets concrete connector templates override stale connector form state', () => {
    const raydium = normalizeConnectorDraftParameters(templateById('connector-raydium-liquidity'), {
      connectorId: 'jupiter',
      connectorOperationId: 'jupiter:lend-flow',
      protocol: 'Jupiter',
      operation: 'Lend',
      poolId: 'SOL-USDC-CPMM',
      amount: '0.01',
    });

    expect(raydium).toMatchObject({
      connectorId: 'raydium',
      connectorOperationId: 'raydium:liquidity-flow',
      protocol: 'Raydium',
      operation: 'Liquidity',
      subAction: 'cpmm-add',
      poolType: 'cpmm',
    });
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

  it('exposes Project 0 forms while keeping MarginFi forms available', () => {
    const project0 = PROTOCOL_CONNECTORS.find((connector) => connector.id === 'project0')!;
    const marginfi = PROTOCOL_CONNECTORS.find((connector) => connector.id === 'marginfi')!;

    expect(connectorActionFormsForConnector(project0).map((form) => form.actionType)).toEqual(expect.arrayContaining([
      'project0_create_account',
      'project0_deposit',
      'project0_withdraw',
      'project0_borrow',
      'project0_repay',
    ]));
    expect(connectorActionFormsForConnector(marginfi).map((form) => form.actionType)).toEqual(expect.arrayContaining([
      'marginfi_deposit',
      'marginfi_withdraw',
      'marginfi_borrow',
      'marginfi_repay',
    ]));
    expect(formTemplateFields(connectorActionFormByActionType('project0_borrow')!).map((field) => field.id)).toEqual(expect.arrayContaining([
      'bankAddress',
      'amount',
      'minHealthRatio',
      'memo',
    ]));
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
        if (connector.id === 'jupiter' && actionKind === 'swap') continue;
        expect(formActionTypes.has(actionKind), `${connector.id} missing form for ${actionKind}`).toBe(true);
        const hasDirectTemplate = templateActionTypes.has(actionKind);
        const hasUnifiedTemplate = [...subActionTemplateIds].some((id) => templateIds.has(id));
        expect(hasDirectTemplate || hasUnifiedTemplate, `${connector.id} missing template for ${actionKind}`).toBe(true);
      }
    }
  });

  it('normalizes Lulo flow selection into fixed adapter params', () => {
    const luloTemplate = templateById('connector-lulo-flow');
    const base = {
      connectorId: 'lulo',
      connectorOperationId: 'lulo:flow',
      protocol: 'lulo',
      operation: 'Deposit or withdraw',
      mintAddress: 'USDC',
      amount: '1',
    };

    const defaultFlow = normalizeConnectorDraftParameters(luloTemplate, base);
    expect(defaultFlow).toMatchObject({
      subAction: 'deposit-protected',
      depositType: 'protected',
    });

    const boost = normalizeConnectorDraftParameters(luloTemplate, {
      ...base,
      subAction: 'deposit-boost',
      subActionLabel: 'Deposit — Protected',
      depositType: 'protected',
    });
    expect(boost.subActionLabel).toBe('Deposit — Boost');
    expect(boost.depositType).toBe('boost');

    const regularWithdraw = normalizeConnectorDraftParameters(luloTemplate, {
      ...base,
      subAction: 'withdraw-regular',
      amount: '',
      percentage: '50',
      withdrawType: 'protected',
    });
    expect(regularWithdraw.withdrawType).toBe('regular');
    expect(regularWithdraw.percentage).toBe('50');
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

    it('uses adapter-native field ids for Wormhole transfer forms', () => {
      const wormholeTransfer = templateById('connector-wormhole-transfer');
      const source = wormholeTransfer.fields.find((field) => field.id === 'sourceMint');
      const destination = wormholeTransfer.fields.find((field) => field.id === 'destinationChain');
      expect(source?.type).toBe('cascading-select');
      expect(source?.cascading?.providerId).toBe('wormhole.token');
      expect(destination?.type).toBe('cascading-select');
      expect(wormholeTransfer.fields.some((field) => field.id === 'destinationAddress')).toBe(true);
      expect(wormholeTransfer.fields.some((field) => field.id === 'recipient')).toBe(false);
    });

    it('uses adapter-native Save reserve values instead of reserve addresses', () => {
      const saveDeposit = templateById('connector-save-deposit');
      const reserve = saveDeposit.fields.find((field) => field.id === 'token');
      expect(reserve?.type).toBe('cascading-select');
      expect(reserve?.cascading?.providerId).toBe('save.reserve');
      expect(saveDeposit.fields.some((field) => field.id === 'reserveAddress')).toBe(false);
    });

    it('uses range presets instead of raw Meteora bin and Orca tick fields', () => {
      const meteora = templateById('connector-meteora-add-liquidity');
      expect(meteora.fields.find((field) => field.id === 'rangePreset')?.type).toBe('select');
      expect(meteora.fields.some((field) => field.id === 'binRange')).toBe(false);

      const orca = templateById('connector-orca-increase-liquidity');
      expect(orca.fields.find((field) => field.id === 'rangePreset')?.type).toBe('select');
      expect(orca.fields.some((field) => field.id === 'lowerTick')).toBe(false);
      expect(orca.fields.some((field) => field.id === 'upperTick')).toBe(false);
    });

    it('preserves Meteora pool token metadata while dropping stale generic fields', () => {
      const normalized = normalizeConnectorDraftParameters(templateById('connector-meteora-add-liquidity'), {
        connectorId: 'meteora',
        connectorOperationId: 'meteora:add-liquidity',
        subAction: 'new-position',
        poolAddress: 'BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y',
        poolAddressLabel: 'SOL-USDC DLMM',
        poolName: 'SOL-USDC',
        tokenXSymbol: 'SOL',
        tokenYSymbol: 'USDC',
        tokenMintX: 'So11111111111111111111111111111111111111112',
        tokenMintY: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        binStep: '25',
        tokenXAmount: '.01',
        tokenYAmount: '1',
        rangePreset: 'balanced',
        strategyType: 'spot',
        amount: 'stale',
      });

      expect(normalized).toMatchObject({
        connectorId: 'meteora',
        connectorOperationId: 'meteora:add-liquidity',
        connectorActionSource: 'first-class-adapter',
        poolAddressLabel: 'SOL-USDC DLMM',
        poolName: 'SOL-USDC',
        tokenXSymbol: 'SOL',
        tokenYSymbol: 'USDC',
        tokenMintX: 'So11111111111111111111111111111111111111112',
        tokenMintY: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        tokenXAmount: '.01',
        tokenYAmount: '1',
      });
      expect(normalized).not.toHaveProperty('amount');
    });

    it('uses a Pyth feed dropdown for price update drafts', () => {
      const pyth = templateById('connector-pyth-post-price-update');
      const feed = pyth.fields.find((field) => field.id === 'priceFeedIds');
      expect(feed?.type).toBe('cascading-select');
      expect(feed?.cascading?.providerId).toBe('pyth.feed');
    });

    it('resolves Pyth position checks to a feed dropdown and drops stale fields', () => {
      const template = templateById('protocol-position-check');
      const pyth = PROTOCOL_CONNECTORS.find((candidate) => candidate.id === 'pyth');
      if (!pyth) throw new Error('Missing Pyth connector');
      const form = connectorActionFormForTemplate(template, pyth);
      const feed = form ? formTemplateFields(form).find((field) => field.id === 'priceFeedIds') : undefined;
      const question = form ? formTemplateFields(form).find((field) => field.id === 'question') : undefined;

      expect(feed?.type).toBe('cascading-select');
      expect(feed?.cascading?.providerId).toBe('pyth.feed');
      expect(question?.type).toBe('select');
      expect(question?.options).toEqual(['price', 'freshness', 'confidence', 'oracle evidence']);
      expect(question?.defaultValue).toBe('price');

      const scoped = scopeConnectorDraftParameters(template, {
        protocol: 'Pyth',
        vaultAddress: 'DriftVault111111111111111111111111111111111',
        priceFeedIds: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
        priceFeedIdsLabel: 'SOL/USD',
        question: 'status',
      });

      expect(scoped).toMatchObject({
        protocol: 'Pyth',
        priceFeedIds: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
        priceFeedIdsLabel: 'SOL/USD',
        question: 'status',
      });
      expect(scoped).not.toHaveProperty('vaultAddress');
      expect(scoped).not.toHaveProperty('position');
      expect(normalizeConnectorDraftParameters(template, { protocol: 'Pyth' }).operation).toBe('Position check');
    });

    it('defaults NFT marketplace bid flows to collection dropdowns', () => {
      const expected: Array<[string, string]> = [
        ['magiceden_bid', 'magiceden.collection'],
        ['tensor_bid', 'tensor.collection'],
      ];

      for (const [actionType, providerId] of expected) {
        const form = connectorActionFormByActionType(actionType);
        if (!form) throw new Error(`Missing form for ${actionType}`);
        expect(form.subActions?.defaultId).toBe('collection');
        const fields = formTemplateFields(form);
        const subAction = fields.find((field) => field.id === 'subAction');
        const collection = fields.find((field) => field.id === 'collectionId');
        expect(subAction?.defaultValue).toBe('collection');
        expect(collection?.type).toBe('cascading-select');
        expect(collection?.cascading?.providerId).toBe(providerId);
        expect(collection?.showWhen).toMatchObject({ subAction: 'collection' });
      }
    });

    it('normalizes NFT marketplace bid target branches and drops stale target values', () => {
      const expected = [
        {
          connectorId: 'magiceden',
          actionType: 'magiceden_bid',
          templateId: 'connector-magiceden-bid',
          operationId: 'magiceden:bid-flow',
        },
        {
          connectorId: 'tensor',
          actionType: 'tensor_bid',
          templateId: 'connector-tensor-bid',
          operationId: 'tensor:bid-flow',
        },
      ] as const;

      for (const { connectorId, actionType, templateId, operationId } of expected) {
        const form = connectorActionFormByActionType(actionType);
        if (!form) throw new Error(`Missing form for ${actionType}`);
        const template = templateById(templateId);

        const collection = normalizeConnectorDraftParameters(template, {
          priceSol: '.01',
          collectionId: 'madlads',
          mintAddress: 'stale-nft-mint',
        });
        expect(collection).toMatchObject({
          connectorId,
          connectorOperationId: operationId,
          subAction: 'collection',
          subActionLabel: 'Collection',
          bidPriceSol: '.01',
          maxEscrowSol: '.01',
          collectionId: 'madlads',
        });
        expect(collection).not.toHaveProperty('priceSol');
        expect(collection).not.toHaveProperty('mintAddress');
        expect(connectorFormRenderFields(form, collection).map((field) => field.id)).toEqual([
          'subAction',
          'collectionId',
          'bidPriceSol',
          'maxEscrowSol',
          'memo',
        ]);

        const nft = normalizeConnectorDraftParameters(template, {
          subAction: 'nft',
          priceSol: '.01',
          mintAddress: 'nft-mint',
          collectionId: 'stale-collection',
        });
        expect(nft).toMatchObject({
          connectorId,
          connectorOperationId: operationId,
          subAction: 'nft',
          subActionLabel: 'Single NFT',
          bidPriceSol: '.01',
          maxEscrowSol: '.01',
          mintAddress: 'nft-mint',
        });
        expect(nft).not.toHaveProperty('priceSol');
        expect(nft).not.toHaveProperty('collectionId');
        expect(connectorFormRenderFields(form, nft).map((field) => field.id)).toEqual([
          'subAction',
          'mintAddress',
          'bidPriceSol',
          'maxEscrowSol',
          'memo',
        ]);
      }
    });

    it('accepts enabled NFT marketplace bid drafts with selected targets', () => {
      const expected = [
        { connectorId: 'magiceden', templateId: 'connector-magiceden-bid' },
        { connectorId: 'tensor', templateId: 'connector-tensor-bid' },
      ] as const;

      for (const { connectorId, templateId } of expected) {
        const connectedDapps = setConnectedDappEnabled(emptyConnectedDapps(), connectorId, true);
        const template = templateById(templateId);
        const env = { connectedDapps, cluster: 'mainnet-beta' };

        const collection = validateConnectorDraftParameters(template, {
          bidPriceSol: '.01',
          collectionId: 'madlads',
        }, env, 'template');
        expect(collection.errors).toEqual({});
        expect(collection.parameters.subAction).toBe('collection');
        expect(collection.parameters.collectionId).toBe('madlads');
        expect(collection.parameters.bidPriceSol).toBe('.01');
        expect(collection.parameters.maxEscrowSol).toBe('.01');

        const nft = validateConnectorDraftParameters(template, {
          subAction: 'nft',
          bidPriceSol: '.01',
          mintAddress: 'nft-mint',
        }, env, 'template');
        expect(nft.errors).toEqual({});
        expect(nft.parameters.subAction).toBe('nft');
        expect(nft.parameters.mintAddress).toBe('nft-mint');
        expect(nft.parameters.bidPriceSol).toBe('.01');
        expect(nft.parameters.maxEscrowSol).toBe('.01');
      }
    });

    it('uses connector dropdowns on protocol position-check forms', () => {
      const expected: Array<[string, string, string]> = [
        ['pyth', 'priceFeedIds', 'pyth.feed'],
        ['drift', 'vaultAddress', 'drift.vault'],
        ['meteora', 'poolAddress', 'meteora.pool'],
        ['raydium', 'poolId', 'raydium.pool'],
        ['orca', 'whirlpoolAddress', 'orca.whirlpool'],
        ['realms', 'realmAddress', 'realms.realm'],
        ['wormhole', 'sourceMint', 'wormhole.token'],
        ['jupiter', 'assetMint', 'jupiter.lend.earn.asset'],
      ];

      for (const [connectorId, fieldId, providerId] of expected) {
        const connector = PROTOCOL_CONNECTORS.find((candidate) => candidate.id === connectorId);
        if (!connector) throw new Error(`Missing connector ${connectorId}`);
        const form = connectorActionFormsForConnector(connector).find((candidate) => candidate.operationId === 'position-check');
        expect(form, `${connectorId} read form`).toBeDefined();
        const field = formTemplateFields(form!).find((candidate) => candidate.id === fieldId);
        expect(field?.type, `${connectorId}.${fieldId}`).toBe('cascading-select');
        expect(field?.cascading?.providerId, `${connectorId}.${fieldId}`).toBe(providerId);
      }
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
      expect(form?.subActions?.defaultId).toBe('collection');
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

    it('formats Project 0 and MarginFi bank deposits with selected bank labels', () => {
      const project0 = connectorActionDisplayParts('project0_deposit', {
        connectorOperationId: 'project0:deposit',
        bankAddress: '4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8',
        bankAddressLabel: 'SOL bank',
        amount: '.01',
      });
      const marginfi = connectorActionDisplayParts('marginfi_deposit', {
        connectorOperationId: 'marginfi:deposit',
        bankAddress: '4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8',
        bankAddressLabel: 'SOL bank',
        amount: '.01',
      });

      expect(project0?.title).toBe('Project 0 deposit - SOL Bank');
      expect(project0?.selectionLabel).toBe('SOL Bank');
      expect(marginfi?.title).toBe('MarginFi deposit - SOL Bank');
      expect(marginfi?.selectionLabel).toBe('SOL Bank');
    });

    it('includes the selected sub-action before the selected pool for unified connector forms', () => {
      const display = connectorActionDisplayParts('raydium_add_liquidity', {
        connectorOperationId: 'raydium:liquidity-flow',
        subAction: 'clmm-open',
        poolId: 'SOL-USDC',
        tokenAAmount: '0.01',
      });

      expect(display?.title).toBe('Raydium liquidity - CLMM Open Position - SOL USDC');
      expect(display?.operationLabel).toBe('Raydium liquidity - CLMM Open Position');
      expect(display?.selectionLabel).toBe('SOL USDC');
    });

    it('formats NFT marketplace collection bids with the selected collection label', () => {
      const display = connectorActionDisplayParts('tensor_bid', {
        connectorOperationId: 'tensor:bid-flow',
        subAction: 'collection',
        collectionId: 'madlads',
        collectionIdLabel: 'Mad Lads',
        bidPriceSol: '.01',
      });

      expect(display?.title).toBe('Tensor bid - Collection - Mad Lads');
      expect(display?.operationLabel).toBe('Tensor bid - Collection');
      expect(display?.selectionLabel).toBe('Mad Lads');
    });
  });
});
