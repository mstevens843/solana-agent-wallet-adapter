import { PublicKey } from '@solana/web3.js';

import { AdapterError, type DAppAdapterContext } from '../types.js';
import { PHOENIX_ADAPTER_ID, PHOENIX_TRADER_PDA_INDEX_DEFAULT } from './constants.js';
import {
  resolvePhoenixClient,
  withPhoenixErrors,
  type PhoenixPosition,
  type PhoenixTraderStateSnapshot,
} from './client.js';

export interface GetPhoenixPositionSnapshotInput {
  walletAddress?: string;
  symbol?: string;
  traderPdaIndex?: number;
}

export interface PhoenixPositionSnapshotResult {
  walletAddress: string;
  symbol: string;
  position?: PhoenixPosition;
  warnings?: string[];
  asOf: string;
}

export interface GetPhoenixWalletPositionsInput {
  walletAddress?: string;
  traderPdaIndex?: number;
}

export interface PhoenixWalletPositionsResult extends PhoenixTraderStateSnapshot {}

async function resolveWallet(ctx: DAppAdapterContext, override?: string): Promise<string> {
  const candidate = override?.trim() || (await ctx.backend.getAddress());
  try {
    new PublicKey(candidate);
  } catch {
    throw new AdapterError(PHOENIX_ADAPTER_ID, 'invalid_request', `walletAddress is not a valid Solana public key.`);
  }
  return candidate;
}

export async function getPositionSnapshot(
  ctx: DAppAdapterContext,
  input: GetPhoenixPositionSnapshotInput,
): Promise<PhoenixPositionSnapshotResult> {
  const walletAddress = await resolveWallet(ctx, input.walletAddress);
  const symbol = (input.symbol ?? '').trim();
  if (!symbol) {
    throw new AdapterError(PHOENIX_ADAPTER_ID, 'invalid_request', 'symbol is required to read a Phoenix position snapshot.');
  }
  const client = resolvePhoenixClient(ctx);
  await withPhoenixErrors('activateIfNeeded', () => client.activateIfNeeded(walletAddress));
  const snapshot = await withPhoenixErrors('fetchTraderState', () =>
    client.fetchTraderState({
      authority: walletAddress,
      traderPdaIndex: input.traderPdaIndex ?? PHOENIX_TRADER_PDA_INDEX_DEFAULT,
    }),
  );
  const normalizedSymbol = symbol.toUpperCase();
  const position = snapshot.positions.find((row) => row.symbol.toUpperCase() === normalizedSymbol);
  return {
    walletAddress,
    symbol: normalizedSymbol,
    ...(position !== undefined && { position }),
    asOf: snapshot.asOf ?? new Date().toISOString(),
    ...(snapshot.warnings !== undefined && { warnings: snapshot.warnings }),
  };
}

export async function getWalletPositions(
  ctx: DAppAdapterContext,
  input: GetPhoenixWalletPositionsInput,
): Promise<PhoenixWalletPositionsResult> {
  const walletAddress = await resolveWallet(ctx, input.walletAddress);
  const client = resolvePhoenixClient(ctx);
  await withPhoenixErrors('activateIfNeeded', () => client.activateIfNeeded(walletAddress));
  return withPhoenixErrors('fetchTraderState', () =>
    client.fetchTraderState({
      authority: walletAddress,
      traderPdaIndex: input.traderPdaIndex ?? PHOENIX_TRADER_PDA_INDEX_DEFAULT,
    }),
  );
}
