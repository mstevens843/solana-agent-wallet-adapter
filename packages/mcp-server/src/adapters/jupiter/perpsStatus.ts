import type { AgentWalletConfig } from '../../config.js';
import { getJupiterPerpsPolicy } from '../../config.js';

export const JUPITER_PERPS_DOCS = {
  overview: 'https://developers.jup.ag/docs/perps',
  positionAccount: 'https://developers.jup.ag/docs/perps/position-account',
  positionRequestAccount: 'https://developers.jup.ag/docs/perps/positionrequest-account',
  poolAccount: 'https://developers.jup.ag/docs/perps/pool-account',
  custodyAccount: 'https://developers.jup.ag/docs/perps/custody-account',
} as const;

export const JUPITER_PERPS_WARNINGS = {
  leverage: 'Jupiter Perps are leveraged derivatives; positions can be liquidated and collateral can be lost.',
  liquidation: 'Liquidation can cause complete loss of posted collateral.',
  workInProgress: 'Official Jupiter Perps API is marked work in progress; account decoding for pools, custodies, and positions is not enabled.',
} as const;

export const JUPITER_PERPS_WRITE_DENY_REASON =
  'Jupiter Perps writes (open, close, increase, decrease, collateral changes, JLP writes, leverage recommendations) are denied. A separate leverage-risk policy must land before any Perps writes are exposed.';

export type JupiterPerpsApiStatus = 'work_in_progress' | 'stable' | 'unavailable';

export interface JupiterPerpsStatusInput {
  includeDocsCheck?: boolean;
}

export interface JupiterPerpsStatusSnapshot {
  apiStatus: JupiterPerpsApiStatus;
  officialDocsStatus: 'work_in_progress';
  docs: typeof JUPITER_PERPS_DOCS;
  writeSupport: 'denied';
  writeDenyReason: string;
  warnings: string[];
  perpsConfig: {
    enabled: boolean;
    readOnly: boolean;
    perpsBaseUrlConfigured: boolean;
  };
  docsCheck: {
    requested: boolean;
    performed: boolean;
    note: string;
  };
}

export function buildPerpsStatus(
  config: AgentWalletConfig,
  input: JupiterPerpsStatusInput = {},
): JupiterPerpsStatusSnapshot {
  const policy = getJupiterPerpsPolicy(config);
  const perpsBaseUrlConfigured = Boolean(config.jupiter.perpsBaseUrl);
  const requestedDocsCheck = input.includeDocsCheck !== false;
  return {
    apiStatus: 'work_in_progress',
    officialDocsStatus: 'work_in_progress',
    docs: JUPITER_PERPS_DOCS,
    writeSupport: 'denied',
    writeDenyReason: JUPITER_PERPS_WRITE_DENY_REASON,
    warnings: [
      JUPITER_PERPS_WARNINGS.leverage,
      JUPITER_PERPS_WARNINGS.liquidation,
      JUPITER_PERPS_WARNINGS.workInProgress,
    ],
    perpsConfig: {
      enabled: policy.enabled,
      readOnly: policy.readOnly,
      perpsBaseUrlConfigured,
    },
    docsCheck: {
      requested: requestedDocsCheck,
      performed: false,
      note: 'Live docs status polling is reserved for a future revision; this read returns the official work-in-progress status from upstream docs without a network call.',
    },
  };
}
