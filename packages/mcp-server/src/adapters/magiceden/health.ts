import { AdapterError } from '../types.js';

import { getMagicedenClient, type MagicedenApiHealthSnapshot } from './client.js';
import { MAGICEDEN_ADAPTER_ID, MAGICEDEN_API_TRANSITION_WARNING } from './constants.js';

export async function getApiHealthSnapshot(input: {
  includeTradingEndpoints?: boolean;
}): Promise<MagicedenApiHealthSnapshot> {
  const includeTradingEndpoints = input.includeTradingEndpoints !== false;
  const snapshot = await getMagicedenClient().getApiHealth({ includeTradingEndpoints });
  const warnings = snapshot.warnings.includes(MAGICEDEN_API_TRANSITION_WARNING)
    ? snapshot.warnings
    : [...snapshot.warnings, MAGICEDEN_API_TRANSITION_WARNING];
  return { ...snapshot, warnings };
}

export function requireTradingOperational(snapshot: MagicedenApiHealthSnapshot): void {
  if (snapshot.tradingOperational) return;
  const detail = snapshot.degradedReasons.length > 0 ? ` (${snapshot.degradedReasons.join('; ')})` : '';
  throw new AdapterError(
    MAGICEDEN_ADAPTER_ID,
    'health_degraded',
    `Magic Eden trading endpoints are not operational; refusing to prepare write actions${detail}.`,
  );
}
