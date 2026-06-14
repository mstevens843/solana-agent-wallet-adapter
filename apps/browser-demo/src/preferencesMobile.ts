export type PreferenceViewId = 'workspace' | 'ai' | 'access' | 'rules' | 'tokens';

export const MOBILE_PREFERENCES_VIEW_ORDER: readonly PreferenceViewId[] = [
  'access',
  'rules',
  'ai',
  'tokens',
  'workspace',
];

export function mobilePreferencesDefaultView(
  persistedView: PreferenceViewId | undefined,
  mobileNativeShell: boolean,
): PreferenceViewId {
  return persistedView ?? (mobileNativeShell ? 'access' : 'workspace');
}

export type FailureRetryGroupId = 'wallet_setup' | 'network_rpc' | 'transaction_quote';

export interface FailureRetryGroup {
  id: FailureRetryGroupId;
  title: string;
  detail: string;
  kinds: readonly string[];
}

export const FAILURE_RETRY_GROUPS: readonly FailureRetryGroup[] = [
  {
    id: 'wallet_setup',
    title: 'Wallet & setup',
    detail: 'Signer availability, missing config, and local setup failures.',
    kinds: ['wallet_rejected', 'wallet_unavailable', 'config_missing'],
  },
  {
    id: 'network_rpc',
    title: 'Network / RPC',
    detail: 'Temporary network, RPC, blockhash, and rate-limit failures.',
    kinds: ['rpc_timeout', 'rpc_rejected', 'network_unreachable', 'expired_blockhash', 'rate_limited'],
  },
  {
    id: 'transaction_quote',
    title: 'Transaction / quote',
    detail: 'Quote, simulation, balance, malformed transaction, and ambiguous send results.',
    kinds: [
      'onchain_failed',
      'slippage_or_quote_failed',
      'simulation_failed',
      'insufficient_funds',
      'invalid_transaction',
      'unknown_maybe_submitted',
    ],
  },
];

export function groupedFailureRetryKinds(kinds: readonly string[]): FailureRetryGroup[] {
  const known = new Set(kinds);
  const assigned = new Set<string>();
  const groups = FAILURE_RETRY_GROUPS
    .map((group) => {
      const groupKinds = group.kinds.filter((kind) => known.has(kind));
      for (const kind of groupKinds) assigned.add(kind);
      return { ...group, kinds: groupKinds };
    })
    .filter((group) => group.kinds.length > 0);
  const unassigned = kinds.filter((kind) => !assigned.has(kind));
  if (unassigned.length > 0) {
    groups.push({
      id: 'transaction_quote',
      title: 'Transaction / quote',
      detail: 'Other failure kinds.',
      kinds: unassigned,
    });
  }
  return groups;
}
