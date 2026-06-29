import type { ConnectorFactArgs } from './types.js';

export const CONNECTOR_FACT_STRING_ARG_KEYS = [
  'amount',
  'inputToken',
  'outputToken',
  'token',
  'bankAddress',
  'bankMint',
  'marginfiAccount',
  'project0Account',
  'collectionId',
  'collectionSymbol',
  'mintAddress',
  'assetId',
  'lstMint',
  'inputMint',
  'outputMint',
  'realmAddress',
  'governanceAddress',
  'proposalAddress',
  'multisigAddress',
  'vaultAddress',
] as const;

export const CONNECTOR_FACT_NUMBER_ARG_KEYS = ['limit', 'vaultIndex', 'transactionIndex', 'subAccountId'] as const;
export const CONNECTOR_FACT_BOOLEAN_ARG_KEYS = ['includeListings', 'includeBids', 'listedOnly'] as const;

export function connectorFactArgsFromInput(
  input: Record<string, unknown>,
  walletAddress = '',
  mint = '',
  query = '',
): ConnectorFactArgs {
  const args: Record<string, unknown> = {
    ...(walletAddress ? { walletAddress } : {}),
    ...(mint ? { mint } : {}),
    ...(query ? { query } : {}),
  };

  for (const key of CONNECTOR_FACT_STRING_ARG_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) args[key] = value.trim();
  }

  for (const key of CONNECTOR_FACT_NUMBER_ARG_KEYS) {
    const value = input[key];
    const parsed = typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
    if (Number.isFinite(parsed)) args[key] = parsed;
  }

  for (const key of CONNECTOR_FACT_BOOLEAN_ARG_KEYS) {
    const value = input[key];
    if (typeof value === 'boolean') args[key] = value;
  }

  return args as ConnectorFactArgs;
}
