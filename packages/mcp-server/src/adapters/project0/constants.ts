import { PublicKey } from '@solana/web3.js';

import type { Cluster } from '@solana-agent-wallet-adapter/core';

export const PROJECT0_ADAPTER_ID = 'project0' as const;
export const PROJECT0_NAME = 'Project 0';
export const PROJECT0_WEBSITE = 'https://app.0.xyz';
export const PROJECT0_DOCS = 'https://docs.0.xyz';
export const PROJECT0_API_BASE_URL = 'https://ai.0.xyz';
export const PROJECT0_DESCRIPTION =
  'Read Project 0 banks, strategies, wallet holdings, and P0 account health; prepare P0 account, deposit, withdraw, borrow, and repay actions for wallet approval.';

export const PROJECT0_SUPPORTED_CLUSTERS: Cluster[] = ['mainnet-beta'];
export const PROJECT0_PROGRAM_ID = new PublicKey('MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA');
export const DEFAULT_PROJECT0_MIN_HEALTH_RATIO = 1.1;

// Opt-in env: when truthy ("1", "true", "yes", "on"), the Project 0 adapter
// rebuilds the cached SDK client per prepare/execute call instead of reusing
// a process-lifetime cached instance. Use this to rule out cache staleness
// when the SDK throws account-decode errors mid-session.
export const PROJECT0_FRESH_CLIENT_PER_PREPARE_ENV = 'PROJECT0_FRESH_CLIENT_PER_PREPARE';
