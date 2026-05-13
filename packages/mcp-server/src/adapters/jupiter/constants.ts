import { PublicKey } from '@solana/web3.js';

import type { Cluster } from '@solana-agent-wallet-adapter/core';

export const JUPITER_ADAPTER_ID = 'jupiter' as const;
export const JUPITER_NAME = 'Jupiter';
export const JUPITER_WEBSITE = 'https://jup.ag';
export const JUPITER_DESCRIPTION =
  'Jupiter first-class connector. Swap is wallet-approved through Swap API v2. Lend Earn and Borrow expose first-class reads and prepare-only Earn/Borrow actions; the wallet still signs every Lend action.';

export const JUPITER_SUPPORTED_CLUSTERS: Cluster[] = ['mainnet-beta'];

export const JUPITER_LEND_EARN_PROGRAM_ID = new PublicKey('jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9');
export const JUPITER_LEND_LIQUIDITY_PROGRAM_ID = new PublicKey('jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC');
export const JUPITER_LEND_REWARDS_RATE_MODEL_PROGRAM_ID = new PublicKey(
  'jup7TthsMgcR9Y3L277b8Eo9uboVSmu1utkuXHNUKar',
);
export const JUPITER_LEND_ORACLE_PROGRAM_ID = new PublicKey('jupnw4B6Eqs7ft6rxpzYLJZYSnrpRgPcr589n5Kv4oc');
export const JUPITER_LEND_BORROW_PROGRAM_ID = new PublicKey('jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi');
export const JUPITER_LEND_FLASHLOAN_PROGRAM_ID = new PublicKey('jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS');

export const JUPITER_LEND_PROGRAM_IDS = [
  JUPITER_LEND_EARN_PROGRAM_ID,
  JUPITER_LEND_LIQUIDITY_PROGRAM_ID,
  JUPITER_LEND_REWARDS_RATE_MODEL_PROGRAM_ID,
  JUPITER_LEND_ORACLE_PROGRAM_ID,
  JUPITER_LEND_BORROW_PROGRAM_ID,
];

export const DEFAULT_JUPITER_MIN_BORROW_HEALTH_RATIO = 1.25;
export const DEFAULT_JUPITER_MAX_BORROW_LTV_BPS = 8500;

export type JupiterLendOperation =
  | 'earn_deposit'
  | 'earn_withdraw'
  | 'earn_mint'
  | 'earn_redeem'
  | 'borrow_create_position'
  | 'borrow_deposit_collateral'
  | 'borrow_borrow'
  | 'borrow_repay'
  | 'borrow_withdraw_collateral';

export type JupiterLendEarnOperation = Extract<
  JupiterLendOperation,
  'earn_deposit' | 'earn_withdraw' | 'earn_mint' | 'earn_redeem'
>;

export type JupiterLendBorrowOperation = Exclude<JupiterLendOperation, JupiterLendEarnOperation>;

export const JUPITER_LEND_EARN_OPERATIONS: JupiterLendEarnOperation[] = [
  'earn_deposit',
  'earn_withdraw',
  'earn_mint',
  'earn_redeem',
];

export const JUPITER_LEND_BORROW_OPERATIONS: JupiterLendBorrowOperation[] = [
  'borrow_create_position',
  'borrow_deposit_collateral',
  'borrow_borrow',
  'borrow_repay',
  'borrow_withdraw_collateral',
];
