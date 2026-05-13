import { describe, expect, it } from 'vitest';

import {
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
  emptyConnectedDapps,
  setConnectedDappEnabled,
} from '../connectedDapps.js';
import { templateById } from '../planner.js';

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
});
