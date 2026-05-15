import { PublicKey } from '@solana/web3.js';

import type { Cluster } from '@solana-agent-wallet-adapter/core';

export const MARGINFI_ADAPTER_ID = 'marginfi' as const;
export const MARGINFI_NAME = 'MarginFi';
export const MARGINFI_WEBSITE = 'https://app.marginfi.com';
export const MARGINFI_DESCRIPTION =
  'Read MarginFi banks and accounts, preview account health, and prepare lending actions for wallet approval.';

export const MARGINFI_SUPPORTED_CLUSTERS: Cluster[] = ['mainnet-beta'];
export const MARGINFI_PROGRAM_ID = new PublicKey('MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA');
export const DEFAULT_MARGINFI_MIN_HEALTH_RATIO = 1.1;

// Opt-in env: when truthy ("1", "true", "yes", "on"), the MarginFi adapter
// rebuilds the cached SDK client per prepare/execute call instead of reusing
// a process-lifetime cached instance. Use this to rule out cache staleness
// when the SDK throws account-decode errors mid-session.
export const MARGINFI_FRESH_CLIENT_PER_PREPARE_ENV = 'MARGINFI_FRESH_CLIENT_PER_PREPARE';

