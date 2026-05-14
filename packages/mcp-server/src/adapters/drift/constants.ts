import { PublicKey } from '@solana/web3.js';

import type { Cluster } from '@solana-agent-wallet-adapter/core';

export const DRIFT_ADAPTER_ID = 'drift' as const;
export const DRIFT_NAME = 'Drift Vaults';
export const DRIFT_WEBSITE = 'https://app.drift.trade';
export const DRIFT_DESCRIPTION =
  'Deposit into Drift strategy vaults and manage the withdraw lifecycle (request, cancel, complete) with plain-English presign review. V1 does not expose perp trading, spot margin, leverage, Swift orders, or delegated accounts.';

export const DRIFT_SUPPORTED_CLUSTERS: Cluster[] = ['mainnet-beta'];

// Drift Vaults program used by the current public strategy-vault catalog, including SOL Super Staking.
export const DRIFT_VAULTS_PROGRAM_ID = new PublicKey('vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR');

// Drift's program address docs list this newer vaults deployment. Keep both ids accepted so the
// adapter can work with catalog vaults still owned by the legacy program and newly deployed vaults.
export const DRIFT_VAULTS_CURRENT_PROGRAM_ID = new PublicKey('JCNCMFXo5M5qwUPg2Utu1u6YWp3MbygxqBsBeXXJfrw');
export const DRIFT_VAULTS_PROGRAM_IDS = [
  DRIFT_VAULTS_PROGRAM_ID,
  DRIFT_VAULTS_CURRENT_PROGRAM_ID,
] as const;

// Drift protocol program on mainnet. Read-only user/account snapshots route through this program.
export const DRIFT_PROGRAM_ID = new PublicKey('dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH');

export type DriftWithdrawUnit = 'token' | 'shares';
