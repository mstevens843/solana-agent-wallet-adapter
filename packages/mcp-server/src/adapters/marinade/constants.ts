import { PublicKey } from '@solana/web3.js';

export const MARINADE_ADAPTER_ID = 'marinade' as const;
export const MARINADE_NAME = 'Marinade';
export const MARINADE_WEBSITE = 'https://marinade.finance';

export const MARINADE_DESCRIPTION =
  'Stake SOL into mSOL, prepare instant mSOL exits through Jupiter, manage delayed unstake orders, and inspect Marinade staking positions.';

export const MSOL_MINT = 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So';
export const MSOL_DECIMALS = 9;
export const SOL_DECIMALS = 9;

export const MARINADE_PROGRAM_ID = 'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD';
export const MARINADE_STATE_ADDRESS = '8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC';
export const STAKE_PROGRAM_ID = 'Stake11111111111111111111111111111111111111';

export const MSOL_MINT_PUBLIC_KEY = new PublicKey(MSOL_MINT);
export const MARINADE_PROGRAM_PUBLIC_KEY = new PublicKey(MARINADE_PROGRAM_ID);
export const MARINADE_STATE_PUBLIC_KEY = new PublicKey(MARINADE_STATE_ADDRESS);
export const STAKE_PROGRAM_PUBLIC_KEY = new PublicKey(STAKE_PROGRAM_ID);

export const MARINADE_DEFAULT_SLIPPAGE_BPS = 100;
export const MARINADE_MIN_SOL_LAMPORTS = 1_000_000n;
export const MARINADE_MIN_MSOL_LAMPORTS = 1_000_000n;

export const MARINADE_APPROVAL_BOUNDARY =
  'Prepare-only Marinade action. The wallet must explicitly sign the generated transaction at execution time.';

export function shortAddress(address: string): string {
  if (address.length <= 12) {
    return address;
  }
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}
