import { describe, expect, it } from 'vitest';

import { CONNECTOR_ATOMS } from '@solana-agent-wallet-adapter/workflow';

import { getConnector } from '../connectorRegistry.js';

// The connector-action atoms live in `workflow` and CANNOT import connectorRegistry.ts
// (that would invert the dependency graph). This guard catches drift between the two:
// every atom must point at a connector that still exists, and every fact-bearing atom's
// capability must still be a declared read capability that connectorReadFacts accepts.
describe('connector atom ↔ registry drift guard', () => {
  it('every atom targets a registered connector', () => {
    for (const atom of CONNECTOR_ATOMS) {
      expect(getConnector(atom.connectorId), `connector "${atom.connectorId}" missing from registry`).toBeDefined();
    }
  });

  it('every fact-bearing atom uses a declared read capability', () => {
    for (const atom of CONNECTOR_ATOMS) {
      if (!atom.factSpec) continue;
      const connector = getConnector(atom.connectorId);
      expect(connector).toBeDefined();
      expect(
        connector!.readCapabilities.includes(atom.factSpec.capability),
        `${atom.connectorId}/${atom.action} capability "${atom.factSpec.capability}" not in readCapabilities [${connector!.readCapabilities.join(', ')}]`,
      ).toBe(true);
    }
  });

  it("every fact-bearing atom's documented readTool exists on the connector", () => {
    for (const atom of CONNECTOR_ATOMS) {
      if (!atom.factSpec) continue;
      const connector = getConnector(atom.connectorId)!;
      expect(
        connector.readTools.includes(atom.factSpec.readTool),
        `${atom.connectorId}/${atom.action} readTool "${atom.factSpec.readTool}" not registered on the connector`,
      ).toBe(true);
    }
  });
});
