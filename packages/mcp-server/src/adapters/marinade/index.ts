import { PublicKey } from '@solana/web3.js';
import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { parseDecimalAmount } from '../../amounts.js';
import { WSOL_MINT } from '../../config.js';
import type { AdapterRead, DAppAdapter, DAppAdapterContext } from '../types.js';
import { AdapterError } from '../types.js';
import {
  getMarinadeClient,
  type MarinadeOperation,
  type MarinadeQuote,
  type MarinadeStakeAccount,
  type MarinadeStateSnapshot,
  type MarinadeUnstakeTicket,
  type MarinadeWalletPositionsResult,
} from './client.js';
import {
  marinadeClaimDelayedUnstakeAction,
  marinadeDelayedUnstakeAction,
  marinadeLiquidStakeAction,
  marinadeLiquidUnstakeAction,
} from './actions.js';
import {
  MARINADE_ADAPTER_ID,
  MARINADE_DESCRIPTION,
  MARINADE_NAME,
  MARINADE_PROGRAM_ID,
  MARINADE_PROGRAM_PUBLIC_KEY,
  MARINADE_WEBSITE,
  MSOL_DECIMALS,
  MSOL_MINT,
  SOL_DECIMALS,
} from './constants.js';
import {
  assertJupiterMinOutput,
  fetchMarinadeInstantUnstakeOrder,
  quoteFromJupiterOrder,
} from './jupiter.js';
import { readMarinadeStateSnapshot } from './state.js';
import { readMarinadeUnstakeTickets } from './tickets.js';
import { readMarinadeWalletPositions, readMarinadeWalletStakeAccounts } from './wallet.js';

export type {
  MarinadeClaimDelayedUnstakeInput,
  MarinadeDelayedUnstakeInput,
  MarinadeLiquidStakeInput,
  MarinadeLiquidUnstakeInput,
} from './actions.js';
export type {
  MarinadeBuiltTransaction,
  MarinadeClient,
  MarinadeClientFactory,
  MarinadeOperation,
  MarinadeQuote,
  MarinadeStakeAccount,
  MarinadeStateSnapshot,
  MarinadeUnstakeTicket,
  MarinadeWalletPositionsResult,
} from './client.js';
export {
  baseMarinadeStateSnapshot,
  describeMarinadeUnavailableReason,
  getMarinadeClient,
  setMarinadeClientFactory,
} from './client.js';

export interface MarinadeWalletInput {
  walletAddress?: string;
}

export interface MarinadeTicketsInput extends MarinadeWalletInput {
  claimableOnly?: boolean;
}

export interface MarinadeQuoteReadInput {
  operation: MarinadeOperation;
  walletAddress?: string;
  solAmount?: string;
  msolAmount?: string;
  minSolAmount?: string;
  minMsolAmount?: string;
  ticketAccount?: string;
  slippageBps?: number;
}

const stateSnapshotRead: AdapterRead<unknown, MarinadeStateSnapshot> = {
  id: 'state_snapshot',
  async read(_input, ctx): Promise<MarinadeStateSnapshot> {
    return readMarinadeStateSnapshot(ctx.connection);
  },
};

const walletPositionsRead: AdapterRead<MarinadeWalletInput, MarinadeWalletPositionsResult> = {
  id: 'wallet_positions',
  async read(input, ctx): Promise<MarinadeWalletPositionsResult> {
    const walletAddress = await walletForRead(input, ctx);
    return readMarinadeWalletPositions(ctx.connection, walletAddress);
  },
};

const walletStakeAccountsRead: AdapterRead<MarinadeWalletInput, MarinadeStakeAccount[]> = {
  id: 'wallet_stake_accounts',
  async read(input, ctx): Promise<MarinadeStakeAccount[]> {
    const walletAddress = await walletForRead(input, ctx);
    return readMarinadeWalletStakeAccounts(ctx.connection, walletAddress);
  },
};

const unstakeTicketsRead: AdapterRead<MarinadeTicketsInput, MarinadeUnstakeTicket[]> = {
  id: 'unstake_tickets',
  async read(input, ctx): Promise<MarinadeUnstakeTicket[]> {
    const walletAddress = await walletForRead(input, ctx);
    return readMarinadeUnstakeTickets(ctx.connection, walletAddress, {
      claimableOnly: input?.claimableOnly === true,
    });
  },
};

const quoteRead: AdapterRead<MarinadeQuoteReadInput, MarinadeQuote> = {
  id: 'quote',
  async read(input, ctx): Promise<MarinadeQuote> {
    return readMarinadeQuote(input, ctx);
  },
};

export const marinadeAdapter: DAppAdapter = {
  id: MARINADE_ADAPTER_ID,
  name: MARINADE_NAME,
  website: MARINADE_WEBSITE,
  description: MARINADE_DESCRIPTION,
  supportedClusters: ['mainnet-beta'],
  programIds: [MARINADE_PROGRAM_PUBLIC_KEY],
  actions: {
    liquid_stake: marinadeLiquidStakeAction,
    liquid_unstake: marinadeLiquidUnstakeAction,
    delayed_unstake: marinadeDelayedUnstakeAction,
    claim_delayed_unstake: marinadeClaimDelayedUnstakeAction,
  },
  reads: {
    state_snapshot: stateSnapshotRead,
    wallet_positions: walletPositionsRead,
    wallet_stake_accounts: walletStakeAccountsRead,
    unstake_tickets: unstakeTicketsRead,
    quote: quoteRead,
  },
};

async function readMarinadeQuote(
  input: MarinadeQuoteReadInput,
  ctx: DAppAdapterContext,
): Promise<MarinadeQuote> {
  const walletAddress = input.walletAddress ?? await ctx.backend.getAddress();
  switch (input.operation) {
    case 'liquid_stake': {
      const amountRaw = parseRequiredAmount(input.solAmount, SOL_DECIMALS, 'solAmount');
      const minRaw = input.minMsolAmount
        ? parseDecimalAmount(input.minMsolAmount, MSOL_DECIMALS, 'minMsolAmount')
        : undefined;
      return getMarinadeClient().getQuote(ctx.connection, {
        operation: 'liquid_stake',
        walletAddress,
        inputAmountRaw: amountRaw,
        minOutputAmountRaw: minRaw,
        config: ctx.config,
      });
    }
    case 'liquid_unstake': {
      const amountRaw = parseRequiredAmount(input.msolAmount, MSOL_DECIMALS, 'msolAmount');
      const minRaw = input.minSolAmount
        ? parseDecimalAmount(input.minSolAmount, SOL_DECIMALS, 'minSolAmount')
        : undefined;
      const order = await fetchMarinadeInstantUnstakeOrder({
        config: ctx.config,
        taker: walletAddress,
        msolAmountRaw: amountRaw,
        slippageBps: input.slippageBps,
      });
      assertJupiterMinOutput(order, minRaw);
      return quoteFromJupiterOrder(order);
    }
    case 'delayed_unstake': {
      const amountRaw = parseRequiredAmount(input.msolAmount, MSOL_DECIMALS, 'msolAmount');
      const minRaw = input.minSolAmount
        ? parseDecimalAmount(input.minSolAmount, SOL_DECIMALS, 'minSolAmount')
        : undefined;
      return getMarinadeClient().getQuote(ctx.connection, {
        operation: 'delayed_unstake',
        walletAddress,
        inputAmountRaw: amountRaw,
        minOutputAmountRaw: minRaw,
        config: ctx.config,
      });
    }
    case 'claim_delayed_unstake': {
      const ticketAccount = normalizePublicKey(input.ticketAccount, 'ticketAccount');
      const tickets = await getMarinadeClient().getUnstakeTickets(ctx.connection, walletAddress);
      const ticket = tickets.find((entry) => entry.ticketAccount === ticketAccount);
      if (!ticket) {
        throw new AdapterError(MARINADE_ADAPTER_ID, 'ticket_not_found', `Marinade unstake ticket ${ticketAccount} was not found.`);
      }
      if (ticket.status !== 'claimable') {
        throw new AdapterError(
          MARINADE_ADAPTER_ID,
          'ticket_not_claimable',
          ticket.reason ?? `Marinade unstake ticket ${ticketAccount} is not claimable yet.`,
        );
      }
      return {
        connectorId: MARINADE_ADAPTER_ID,
        operation: 'claim_delayed_unstake',
        inputAmount: '0',
        inputAmountRaw: '0',
        outputAmount: ticket.solAmount,
        outputAmountRaw: ticket.lamports,
        route: 'marinade',
        raw: {
          ticketAccount,
          programId: MARINADE_PROGRAM_ID,
          outputMint: WSOL_MINT,
        },
      };
    }
  }
}

async function walletForRead(input: MarinadeWalletInput | undefined, ctx: DAppAdapterContext): Promise<string> {
  return input?.walletAddress ?? ctx.backend.getAddress();
}

function parseRequiredAmount(value: string | undefined, decimals: number, label: string): bigint {
  if (value === undefined) {
    throw new ProtocolError('invalid_request', `${label} is required.`);
  }
  return parseDecimalAmount(value, decimals, label);
}

function normalizePublicKey(value: string | undefined, label: string): string {
  if (value === undefined) {
    throw new ProtocolError('invalid_request', `${label} is required.`);
  }
  try {
    return new PublicKey(value.trim()).toBase58();
  } catch {
    throw new AdapterError(MARINADE_ADAPTER_ID, 'invalid_request', `${label} must be a valid Solana public key.`);
  }
}
