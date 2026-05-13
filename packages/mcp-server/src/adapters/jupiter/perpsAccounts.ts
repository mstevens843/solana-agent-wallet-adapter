import { PublicKey } from '@solana/web3.js';

import { ProtocolError } from '@solana-agent-wallet-adapter/core';

const PERPS_ACCOUNT_UNSUPPORTED_REASON =
  'Jupiter Perps account decoding requires a stable official API or SDK. Decoding via unofficial Anchor IDL is not safe for money-moving evidence. See https://developers.jup.ag/docs/perps.';

export interface JupiterPerpsPoolSnapshotInput {
  poolAddress: string;
  includeCustodies?: boolean;
}

export interface JupiterPerpsCustodySnapshotInput {
  custodyAddress: string;
}

export interface JupiterPerpsPositionSnapshotInput {
  walletAddress?: string;
  positionAddress?: string;
  market?: string;
}

export function getPoolSnapshot(input: JupiterPerpsPoolSnapshotInput): never {
  const poolAddress = (input.poolAddress ?? '').trim();
  if (!poolAddress) {
    throw new ProtocolError('invalid_request', 'poolAddress is required to read a Jupiter Perps pool snapshot.');
  }
  assertPublicKey(poolAddress, 'poolAddress');
  throw new ProtocolError('unsupported_method', PERPS_ACCOUNT_UNSUPPORTED_REASON);
}

export function getCustodySnapshot(input: JupiterPerpsCustodySnapshotInput): never {
  const custodyAddress = (input.custodyAddress ?? '').trim();
  if (!custodyAddress) {
    throw new ProtocolError('invalid_request', 'custodyAddress is required to read a Jupiter Perps custody snapshot.');
  }
  assertPublicKey(custodyAddress, 'custodyAddress');
  throw new ProtocolError('unsupported_method', PERPS_ACCOUNT_UNSUPPORTED_REASON);
}

export function getPositionSnapshot(input: JupiterPerpsPositionSnapshotInput): never {
  if (input.walletAddress) assertPublicKey(input.walletAddress.trim(), 'walletAddress');
  if (input.positionAddress) assertPublicKey(input.positionAddress.trim(), 'positionAddress');
  throw new ProtocolError('unsupported_method', PERPS_ACCOUNT_UNSUPPORTED_REASON);
}

function assertPublicKey(value: string, field: string): void {
  try {
    new PublicKey(value);
  } catch {
    throw new ProtocolError('invalid_request', `${field} is not a valid Solana public key.`);
  }
}
