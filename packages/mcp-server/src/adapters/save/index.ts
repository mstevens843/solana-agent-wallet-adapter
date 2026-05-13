import {
  SAVE_ADAPTER_ID,
  SAVE_DESCRIPTION,
  SAVE_MAIN_MARKET,
  SAVE_NAME,
  SAVE_SUPPORTED_CLUSTERS,
  SAVE_WEBSITE,
  SOLEND_PROGRAM_ID,
  resolveKnownReserve,
} from './constants.js';
import { AdapterError } from '../types.js';
import { parseDecimalAmount } from '../../amounts.js';
import { getMarketSnapshot } from './markets.js';
import { getObligation } from './obligations.js';
import { getReserveSnapshot, listReserveSnapshots } from './reserves.js';
import { saveDepositAction, type SaveDepositInput } from './deposit.js';
import { saveWithdrawAction, type SaveWithdrawInput } from './withdraw.js';
import { saveBorrowAction, type SaveBorrowInput } from './borrow.js';
import { saveRepayAction, type SaveRepayInput } from './repay.js';
import {
  previewHealth,
  resolveMinHealthFactor,
  type HealthDeltaKind,
  type HealthPreview,
} from './health.js';
import type { DAppAdapter, AdapterRead } from '../types.js';

const reserveSnapshotRead: AdapterRead<{ token?: string; reserveMint?: string; marketAddress?: string }, unknown> = {
  id: 'reserve_snapshot',
  async read(input, ctx) {
    const token = input.token ?? input.reserveMint ?? 'USDC';
    return getReserveSnapshot(ctx.connection, token, input.marketAddress);
  },
};

const listReservesRead: AdapterRead<{ marketAddress?: string }, unknown> = {
  id: 'list_reserves',
  async read(input, ctx) {
    return listReserveSnapshots(ctx.connection, input.marketAddress);
  },
};

const marketSnapshotRead: AdapterRead<{ marketAddress?: string }, unknown> = {
  id: 'market_snapshot',
  async read(input, ctx) {
    return getMarketSnapshot(ctx.connection, input.marketAddress);
  },
};

const walletObligationRead: AdapterRead<{ walletAddress?: string; marketAddress?: string }, unknown> = {
  id: 'wallet_obligation',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    const obligation = await getObligation(ctx.connection, walletAddress, input.marketAddress);
    return {
      walletAddress,
      cluster: ctx.config.cluster,
      obligation,
    };
  },
};

interface SaveHealthPreviewInput {
  operation: HealthDeltaKind;
  amount: string;
  token?: string;
  reserveMint?: string;
  marketAddress?: string;
  walletAddress?: string;
  minHealthFactor?: number;
}

interface SaveHealthPreviewResult {
  operation: HealthDeltaKind;
  walletAddress: string;
  reserveSymbol: string;
  reserveMint: string;
  amount: string;
  amountRaw: string;
  minHealthFactor: number;
  preview: HealthPreview;
  blocked: boolean;
}

const healthPreviewRead: AdapterRead<SaveHealthPreviewInput, SaveHealthPreviewResult> = {
  id: 'health_preview',
  async read(input, ctx) {
    const tokenIdentifier = (input.token ?? input.reserveMint ?? 'USDC').trim();
    const known = resolveKnownReserve(tokenIdentifier);
    const reserveMint = known?.mint ?? input.reserveMint?.trim();
    const reserveSymbolHint = known?.symbol ?? tokenIdentifier;
    if (!reserveMint) {
      throw new AdapterError(
        SAVE_ADAPTER_ID,
        'unknown_reserve',
        `Unknown Save reserve "${tokenIdentifier}". Pass token: SOL, USDC, USDT, or reserveMint as a mint address.`,
      );
    }
    const decimals = known?.decimals;
    if (typeof decimals !== 'number') {
      throw new AdapterError(
        SAVE_ADAPTER_ID,
        'unknown_reserve',
        `Save reserve "${tokenIdentifier}" is not in the known list; add decimals first.`,
      );
    }
    const marketAddress = input.marketAddress?.trim() || SAVE_MAIN_MARKET.toBase58();
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    const amountRaw = parseDecimalAmount(input.amount, decimals, `${reserveSymbolHint} ${input.operation} amount`);

    const snapshot = await getReserveSnapshot(ctx.connection, reserveMint, marketAddress);
    const obligation = await getObligation(ctx.connection, walletAddress, marketAddress);
    const preview = previewHealth(obligation, {
      kind: input.operation,
      reserveMint: snapshot.reserveMint,
      amountRaw,
      decimals: snapshot.decimals,
      reserveSnapshot: snapshot,
    });
    const minHealthFactor = resolveMinHealthFactor(input.minHealthFactor);
    const requiresGate = input.operation === 'borrow' || input.operation === 'withdraw';
    const blocked = preview.breaches.length > 0
      || (requiresGate && preview.projectedHealthFactor < minHealthFactor);
    return {
      operation: input.operation,
      walletAddress,
      reserveSymbol: snapshot.reserveSymbol,
      reserveMint: snapshot.reserveMint,
      amount: input.amount,
      amountRaw: amountRaw.toString(),
      minHealthFactor,
      preview,
      blocked,
    };
  },
};

export const saveAdapter: DAppAdapter = {
  id: SAVE_ADAPTER_ID,
  name: SAVE_NAME,
  website: SAVE_WEBSITE,
  description: SAVE_DESCRIPTION,
  supportedClusters: SAVE_SUPPORTED_CLUSTERS,
  programIds: [SOLEND_PROGRAM_ID],
  actions: {
    deposit: saveDepositAction,
    withdraw: saveWithdrawAction,
    borrow: saveBorrowAction,
    repay: saveRepayAction,
  },
  reads: {
    reserve_snapshot: reserveSnapshotRead,
    list_reserves: listReservesRead,
    market_snapshot: marketSnapshotRead,
    wallet_obligation: walletObligationRead,
    health_preview: healthPreviewRead,
  },
};

export type { SaveHealthPreviewInput, SaveHealthPreviewResult };

export type { SaveDepositInput, SaveWithdrawInput, SaveBorrowInput, SaveRepayInput };
export {
  SAVE_ADAPTER_ID,
  SAVE_NAME,
  SAVE_WEBSITE,
  SAVE_DESCRIPTION,
  SAVE_SUPPORTED_CLUSTERS,
  SAVE_MAIN_MARKET,
  SOLEND_PROGRAM_ID,
};
