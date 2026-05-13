import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import type { ConnectorFact, ConnectorFactTone } from '../../connectorFacts.js';
import type { JupiterPerpsStatusSnapshot } from './perpsStatus.js';

export function factsFromJupiterPerpsStatus(
  snapshot: JupiterPerpsStatusSnapshot,
  checkedAt = new Date().toISOString(),
): ConnectorFact[] {
  const statusTone: ConnectorFactTone =
    snapshot.apiStatus === 'stable' ? 'good' : snapshot.apiStatus === 'work_in_progress' ? 'warn' : 'fail';
  return [
    {
      connectorId: 'jupiter',
      label: 'Perps API status',
      value: humanizeStatus(snapshot.apiStatus),
      tone: statusTone,
      source: 'connector',
      checkedAt,
      detail: {
        officialDocsStatus: snapshot.officialDocsStatus,
        perpsConfig: snapshot.perpsConfig,
      },
    },
    {
      connectorId: 'jupiter',
      label: 'Write support',
      value: 'Denied — read-only research',
      tone: 'warn',
      source: 'connector',
      checkedAt,
      detail: { reason: snapshot.writeDenyReason },
    },
    {
      connectorId: 'jupiter',
      label: 'Official docs',
      value: 'developers.jup.ag/docs/perps',
      tone: 'neutral',
      source: 'connector',
      checkedAt,
      detail: { ...snapshot.docs },
    },
  ];
}

export function factsFromJupiterPerpsPoolSnapshot(): never {
  throw new ProtocolError('unsupported_method', 'Jupiter Perps pool snapshot facts are reserved for a future revision once the official API stabilizes.');
}

export function factsFromJupiterPerpsCustodySnapshot(): never {
  throw new ProtocolError('unsupported_method', 'Jupiter Perps custody snapshot facts are reserved for a future revision once the official API stabilizes.');
}

export function factsFromJupiterPerpsPositionSnapshot(): never {
  throw new ProtocolError('unsupported_method', 'Jupiter Perps position snapshot facts are reserved for a future revision once the official API stabilizes.');
}

function humanizeStatus(status: JupiterPerpsStatusSnapshot['apiStatus']): string {
  switch (status) {
    case 'stable':
      return 'Stable';
    case 'work_in_progress':
      return 'Work in progress';
    case 'unavailable':
      return 'Unavailable';
  }
}
