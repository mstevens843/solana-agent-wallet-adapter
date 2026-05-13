import {
  getOrcaClient,
  type OrcaPosition,
  type OrcaWalletPositionsResult,
} from './client.js';
import {
  ensurePositionMatchesWhirlpool,
  optionalPublicKey,
  parsePublicKey,
} from './validation.js';
import type { DAppAdapterContext } from '../types.js';

export async function getWalletPositions(
  ctx: DAppAdapterContext,
  input: { walletAddress?: string; whirlpoolAddress?: string },
): Promise<OrcaWalletPositionsResult> {
  const walletAddress = input.walletAddress?.trim()
    ? parsePublicKey(input.walletAddress, 'walletAddress')
    : parsePublicKey(await ctx.backend.getAddress(), 'walletAddress');
  const whirlpoolAddress = optionalPublicKey(input.whirlpoolAddress, 'whirlpoolAddress');
  return getOrcaClient().getWalletPositions(ctx.connection, walletAddress, whirlpoolAddress);
}

export async function getPositionDetail(
  ctx: DAppAdapterContext,
  input: { positionMint: string; whirlpoolAddress?: string },
): Promise<OrcaPosition> {
  const positionMint = parsePublicKey(input.positionMint, 'positionMint');
  const whirlpoolAddress = optionalPublicKey(input.whirlpoolAddress, 'whirlpoolAddress');
  const position = await getOrcaClient().getPositionDetail(ctx.connection, positionMint, whirlpoolAddress);
  ensurePositionMatchesWhirlpool(position, whirlpoolAddress);
  return position;
}

export function summarizePositions(positions: OrcaPosition[]): {
  positions: number;
  inRange: number;
  outOfRange: number;
} {
  let inRange = 0;
  let outOfRange = 0;
  for (const position of positions) {
    if (position.inRange === true) inRange += 1;
    if (position.inRange === false) outOfRange += 1;
  }
  return {
    positions: positions.length,
    inRange,
    outOfRange,
  };
}
