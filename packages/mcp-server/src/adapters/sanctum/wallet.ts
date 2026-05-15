import { PublicKey } from '@solana/web3.js';

import { formatRawAmount } from '../../amounts.js';
import type { DAppAdapterContext } from '../types.js';
import { resolveSanctumClient, type SanctumLstMetadata } from './client.js';
import { SANCTUM_INF_MINT, WSOL_MINT } from './constants.js';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

export interface SanctumWalletPosition {
  mint: string;
  symbol: string;
  account: string;
  amountRaw: string;
  amountUi: string;
  decimals: number;
  isInf: boolean;
  isLst: boolean;
}

export interface SanctumWalletPositionsSnapshot {
  walletAddress: string;
  rows: SanctumWalletPosition[];
  totals: {
    positions: number;
    lstPositions: number;
    infPositions: number;
  };
  asOfIso: string;
  source: 'wallet-token-accounts';
}

export async function getSanctumWalletPositions(
  input: { walletAddress?: string; includeSmallBalances?: boolean },
  ctx: DAppAdapterContext,
): Promise<SanctumWalletPositionsSnapshot> {
  const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
  const owner = new PublicKey(walletAddress);
  const metadata = await resolveSanctumClient(ctx).getLsts({ includeDisabled: false });
  const byMint = new Map<string, SanctumLstMetadata>();
  for (const row of metadata.rows) byMint.set(row.mint, row);
  byMint.set(SANCTUM_INF_MINT, {
    mint: SANCTUM_INF_MINT,
    symbol: 'INF',
    decimals: 9,
    enabled: true,
  });

  const accounts = [
    ...await readParsedTokenAccounts(ctx, owner, TOKEN_PROGRAM_ID),
    ...await readParsedTokenAccounts(ctx, owner, TOKEN_2022_PROGRAM_ID),
  ];
  const rows: SanctumWalletPosition[] = [];
  for (const account of accounts) {
    const meta = byMint.get(account.mint);
    if (!meta) continue;
    const raw = BigInt(account.amountRaw || '0');
    if (raw === 0n && input.includeSmallBalances !== true) continue;
    const decimals = account.decimals ?? meta.decimals ?? 9;
    rows.push({
      mint: account.mint,
      symbol: meta.symbol,
      account: account.account,
      amountRaw: raw.toString(),
      amountUi: account.uiAmountString ?? formatRawAmount(raw, decimals),
      decimals,
      isInf: account.mint === SANCTUM_INF_MINT,
      isLst: account.mint !== WSOL_MINT && account.mint !== SANCTUM_INF_MINT,
    });
  }
  return {
    walletAddress,
    rows,
    totals: {
      positions: rows.length,
      lstPositions: rows.filter((row) => row.isLst).length,
      infPositions: rows.filter((row) => row.isInf).length,
    },
    asOfIso: new Date().toISOString(),
    source: 'wallet-token-accounts',
  };
}

async function readParsedTokenAccounts(
  ctx: DAppAdapterContext,
  owner: PublicKey,
  programId: PublicKey,
): Promise<Array<{
  account: string;
  mint: string;
  amountRaw: string;
  uiAmountString?: string;
  decimals?: number;
}>> {
  const result = await ctx.connection
    .getParsedTokenAccountsByOwner(owner, { programId }, 'confirmed')
    .catch(() => ({ value: [] }));
  return result.value.flatMap((entry) => {
    const parsed = entry.account.data.parsed as {
      info?: {
        mint?: string;
        tokenAmount?: {
          amount?: string;
          uiAmountString?: string;
          decimals?: number;
        };
      };
    };
    const mint = parsed.info?.mint;
    const amountRaw = parsed.info?.tokenAmount?.amount;
    if (!mint || amountRaw === undefined) return [];
    return [{
      account: entry.pubkey.toBase58(),
      mint,
      amountRaw,
      ...(parsed.info?.tokenAmount?.uiAmountString !== undefined && {
        uiAmountString: parsed.info.tokenAmount.uiAmountString,
      }),
      ...(parsed.info?.tokenAmount?.decimals !== undefined && {
        decimals: parsed.info.tokenAmount.decimals,
      }),
    }];
  });
}
