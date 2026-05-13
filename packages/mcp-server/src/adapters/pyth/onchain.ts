import type { DAppAdapterContext } from '../types.js';
import { AdapterError } from '../types.js';

import { getPythClient, describePythReceiverUnavailableReason } from './client.js';
import {
  PYTH_ADAPTER_ID,
  normalizePriceFeedId,
  withFeedIdPrefix,
} from './constants.js';
import { resolveFeedId, clientHost } from './feeds.js';

export interface PythOnchainSnapshot {
  priceFeedId: string;
  priceFeedIdHex: string;
  priceAccount?: string;
  exists: 'yes' | 'no' | 'unknown';
  evidenceSource: 'on_chain' | 'sdk_missing' | 'hermes_fallback';
  reason?: string;
  ownerProgram?: string;
  rentEpoch?: number;
  lamports?: number;
  accountDataBase64?: string;
  hermesUrlHost: string;
  asOfIso: string;
}

export interface GetPythOnchainAccountInput {
  priceFeedId?: string;
  symbol?: string;
  includeRawAccount?: boolean;
}

export async function getOnchainPriceAccountSnapshot(
  input: GetPythOnchainAccountInput,
  ctx: DAppAdapterContext,
): Promise<PythOnchainSnapshot> {
  if (!input.priceFeedId?.trim() && !input.symbol?.trim()) {
    throw new AdapterError(
      PYTH_ADAPTER_ID,
      'invalid_request',
      'Provide priceFeedId or symbol to read an on-chain Pyth price account.',
    );
  }
  const metadata = await resolveFeedId(
    {
      ...(input.priceFeedId !== undefined ? { priceFeedId: input.priceFeedId } : {}),
      ...(input.symbol !== undefined ? { symbol: input.symbol } : {}),
    },
    ctx,
  );
  const priceFeedId = normalizePriceFeedId(metadata.priceFeedId);
  const hermesUrlHost = clientHost(getPythClient().hermesUrl);
  const asOfIso = new Date().toISOString();
  const sdkReason = describePythReceiverUnavailableReason();
  if (sdkReason) {
    return {
      priceFeedId,
      priceFeedIdHex: withFeedIdPrefix(priceFeedId),
      exists: 'unknown',
      evidenceSource: 'sdk_missing',
      reason: sdkReason,
      hermesUrlHost,
      asOfIso,
    };
  }
  let priceAccount: string | undefined;
  try {
    priceAccount = await derivePriceAccount(priceFeedId);
  } catch (err) {
    return {
      priceFeedId,
      priceFeedIdHex: withFeedIdPrefix(priceFeedId),
      exists: 'unknown',
      evidenceSource: 'sdk_missing',
      reason:
        err instanceof Error
          ? `Could not derive Pyth price-update PDA: ${err.message}`
          : 'Could not derive Pyth price-update PDA.',
      hermesUrlHost,
      asOfIso,
    };
  }
  const account = await safeGetAccountInfo(ctx, priceAccount);
  if (!account) {
    return {
      priceFeedId,
      priceFeedIdHex: withFeedIdPrefix(priceFeedId),
      priceAccount,
      exists: 'no',
      evidenceSource: 'on_chain',
      reason:
        'No price update account exists for this feed yet. Use solana_prepare_pyth_post_price_update to publish one before consuming on-chain.',
      hermesUrlHost,
      asOfIso,
    };
  }
  const snapshot: PythOnchainSnapshot = {
    priceFeedId,
    priceFeedIdHex: withFeedIdPrefix(priceFeedId),
    priceAccount,
    exists: 'yes',
    evidenceSource: 'on_chain',
    hermesUrlHost,
    asOfIso,
    ownerProgram: account.ownerProgram,
    lamports: account.lamports,
  };
  if (typeof account.rentEpoch === 'number') snapshot.rentEpoch = account.rentEpoch;
  if (input.includeRawAccount && account.dataBase64) {
    snapshot.accountDataBase64 = account.dataBase64;
  }
  return snapshot;
}

interface RawAccountInfo {
  ownerProgram: string;
  lamports: number;
  rentEpoch?: number;
  dataBase64?: string;
}

async function safeGetAccountInfo(
  ctx: DAppAdapterContext,
  priceAccount: string,
): Promise<RawAccountInfo | null> {
  const connection = ctx.connection as unknown as {
    getAccountInfo?: (pubkey: unknown, commitment?: string) => Promise<{
      owner: { toBase58(): string };
      lamports: number;
      rentEpoch?: number;
      data?: Uint8Array | Buffer;
    } | null>;
    getParsedAccountInfo?: (pubkey: unknown, commitment?: string) => Promise<{
      value: {
        owner: { toBase58(): string };
        lamports: number;
        rentEpoch?: number;
        data: Buffer | { data?: string };
      } | null;
    }>;
  };

  const PublicKey = await loadPublicKey();
  const pubkey = new PublicKey(priceAccount);
  if (typeof connection.getAccountInfo === 'function') {
    const info = await connection.getAccountInfo(pubkey, 'confirmed');
    if (!info) return null;
    const result: RawAccountInfo = {
      ownerProgram: info.owner.toBase58(),
      lamports: info.lamports,
    };
    if (typeof info.rentEpoch === 'number') result.rentEpoch = info.rentEpoch;
    if (info.data) {
      const buffer = info.data instanceof Buffer ? info.data : Buffer.from(info.data);
      result.dataBase64 = buffer.toString('base64');
    }
    return result;
  }
  if (typeof connection.getParsedAccountInfo === 'function') {
    const info = await connection.getParsedAccountInfo(pubkey, 'confirmed');
    const value = info.value;
    if (!value) return null;
    const result: RawAccountInfo = {
      ownerProgram: value.owner.toBase58(),
      lamports: value.lamports,
    };
    if (typeof value.rentEpoch === 'number') result.rentEpoch = value.rentEpoch;
    if (value.data instanceof Buffer) {
      result.dataBase64 = value.data.toString('base64');
    }
    return result;
  }
  return null;
}

async function derivePriceAccount(priceFeedId: string): Promise<string> {
  const [{ pythSolanaReceiverIdl, getPriceFeedAccountForProgram, DEFAULT_RECEIVER_PROGRAM_ID }, web3] = await Promise.all([
    importReceiverDeriver(),
    import('@solana/web3.js'),
  ]);
  void pythSolanaReceiverIdl;
  const { PublicKey } = web3;
  const programId = DEFAULT_RECEIVER_PROGRAM_ID as InstanceType<typeof PublicKey>;
  const buffer = hexToBuffer(priceFeedId);
  const pda = getPriceFeedAccountForProgram(0, buffer, programId) as InstanceType<typeof PublicKey>;
  return pda.toBase58();
}

async function importReceiverDeriver(): Promise<{
  pythSolanaReceiverIdl: unknown;
  getPriceFeedAccountForProgram: (
    shardId: number,
    priceFeedId: Buffer,
    receiverProgramId: unknown,
  ) => unknown;
  DEFAULT_RECEIVER_PROGRAM_ID: unknown;
}> {
  const mod = (await import('@pythnetwork/pyth-solana-receiver')) as unknown as Record<string, unknown>;
  const deriver = (mod.getPriceFeedAccountForProgram ?? mod.getPriceUpdateAccountForProgram) as
    | ((shardId: number, priceFeedId: Buffer, receiverProgramId: unknown) => unknown)
    | undefined;
  if (typeof deriver !== 'function') {
    throw new Error('Pyth receiver SDK is missing getPriceFeedAccountForProgram.');
  }
  const DEFAULT_RECEIVER_PROGRAM_ID = mod.DEFAULT_RECEIVER_PROGRAM_ID ?? mod.PYTH_PUSH_ORACLE_PROGRAM_ID;
  if (!DEFAULT_RECEIVER_PROGRAM_ID) {
    throw new Error('Pyth receiver SDK is missing DEFAULT_RECEIVER_PROGRAM_ID.');
  }
  return {
    pythSolanaReceiverIdl: mod.pythSolanaReceiverIdl,
    getPriceFeedAccountForProgram: deriver,
    DEFAULT_RECEIVER_PROGRAM_ID,
  };
}

async function loadPublicKey(): Promise<typeof import('@solana/web3.js').PublicKey> {
  const { PublicKey } = await import('@solana/web3.js');
  return PublicKey;
}

function hexToBuffer(value: string): Buffer {
  const normalized = normalizePriceFeedId(value);
  if (normalized.length === 0 || normalized.length % 2 !== 0) {
    throw new Error(`Invalid hex price feed id: ${value}`);
  }
  return Buffer.from(normalized, 'hex');
}
