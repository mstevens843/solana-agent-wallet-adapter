import type { Connection } from '@solana/web3.js';
import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import type { AgentWalletConfig } from '../../config.js';
import {
  MARINADE_ADAPTER_ID,
  MARINADE_PROGRAM_ID,
  MARINADE_STATE_ADDRESS,
  MSOL_MINT,
} from './constants.js';

export type MarinadeOperation =
  | 'liquid_stake'
  | 'liquid_unstake'
  | 'delayed_unstake'
  | 'claim_delayed_unstake';

export interface MarinadeValidatorSummary {
  voteAccount?: string;
  validatorIdentity?: string;
  name?: string;
  activeStakeSol?: string;
  score?: number;
}

export interface MarinadeStateSnapshot {
  connectorId: typeof MARINADE_ADAPTER_ID;
  stateAddress: string;
  programId: string;
  msolMint: string;
  asOfSlot?: number;
  msolPrice?: string;
  totalVirtualStakedSol?: string;
  circulatingMsol?: string;
  availableReserveSol?: string;
  delayedUnstakeCoolingDownSeconds?: number;
  rewardFeeBps?: number;
  liquidityTargetSol?: string;
  validators?: MarinadeValidatorSummary[];
  warnings?: string[];
  raw?: Record<string, unknown>;
}

export interface MarinadeStakeAccount {
  stakeAccount: string;
  lamports: string;
  solAmount: string;
  state: 'active' | 'activating' | 'deactivating' | 'inactive' | 'unknown';
  delegated?: boolean;
  validatorVoteAccount?: string;
  activationEpoch?: string;
  deactivationEpoch?: string;
  rentExemptReserve?: string;
}

export interface MarinadeUnstakeTicket {
  ticketAccount: string;
  beneficiary?: string;
  lamports?: string;
  solAmount?: string;
  msolAmount?: string;
  createdEpoch?: string;
  claimableAt?: string;
  claimableSlot?: number;
  status: 'claimable' | 'pending' | 'expired' | 'unknown';
  reason?: string;
}

export interface MarinadeWalletPositionsResult {
  connectorId: typeof MARINADE_ADAPTER_ID;
  walletAddress: string;
  asOfSlot?: number;
  msolMint: string;
  msolBalanceRaw: string;
  msolBalance: string;
  estimatedSolValue?: string;
  nativeStakeAccounts: MarinadeStakeAccount[];
  unstakeTickets: MarinadeUnstakeTicket[];
  warnings?: string[];
}

export interface MarinadeQuote {
  connectorId: typeof MARINADE_ADAPTER_ID;
  operation: MarinadeOperation;
  inputAmount: string;
  inputAmountRaw: string;
  outputAmount?: string;
  outputAmountRaw?: string;
  minOutputAmount?: string;
  minOutputAmountRaw?: string;
  feeBps?: number;
  price?: string;
  route?: 'marinade' | 'jupiter';
  warnings?: string[];
  raw?: Record<string, unknown>;
}

export interface MarinadeBuildTransactionInput {
  walletAddress: string;
  amountRaw?: bigint;
  minOutputAmountRaw?: bigint;
  ticketAccount?: string;
  slippageBps?: number;
  config: AgentWalletConfig;
}

export interface MarinadeBuiltTransaction {
  transactionBase64: string;
  programIds: string[];
  quote?: MarinadeQuote;
  preview?: Record<string, unknown>;
}

export interface MarinadeQuoteInput {
  walletAddress?: string;
  operation: MarinadeOperation;
  inputAmountRaw: bigint;
  minOutputAmountRaw?: bigint;
  slippageBps?: number;
  config: AgentWalletConfig;
}

export interface MarinadeClient {
  getStateSnapshot(connection: Connection): Promise<MarinadeStateSnapshot>;
  getWalletPositions(connection: Connection, walletAddress: string): Promise<MarinadeWalletPositionsResult>;
  getStakeAccounts(connection: Connection, walletAddress: string): Promise<MarinadeStakeAccount[]>;
  getUnstakeTickets(connection: Connection, walletAddress: string): Promise<MarinadeUnstakeTicket[]>;
  getQuote(connection: Connection, input: MarinadeQuoteInput): Promise<MarinadeQuote>;
  buildLiquidStakeTransaction(
    connection: Connection,
    input: MarinadeBuildTransactionInput,
  ): Promise<MarinadeBuiltTransaction>;
  buildDelayedUnstakeTransaction(
    connection: Connection,
    input: MarinadeBuildTransactionInput,
  ): Promise<MarinadeBuiltTransaction>;
  buildClaimDelayedUnstakeTransaction(
    connection: Connection,
    input: MarinadeBuildTransactionInput,
  ): Promise<MarinadeBuiltTransaction>;
}

export type MarinadeClientFactory = () => MarinadeClient;

const SDK_PACKAGE_NAME = '@marinade.finance/marinade-ts-sdk';

class MarinadeUnavailableClient implements MarinadeClient {
  constructor(private readonly reason: string) {}

  getReason(): string {
    return this.reason;
  }

  async getStateSnapshot(): Promise<MarinadeStateSnapshot> {
    throw this.error();
  }

  async getWalletPositions(): Promise<MarinadeWalletPositionsResult> {
    throw this.error();
  }

  async getStakeAccounts(): Promise<MarinadeStakeAccount[]> {
    throw this.error();
  }

  async getUnstakeTickets(): Promise<MarinadeUnstakeTicket[]> {
    throw this.error();
  }

  async getQuote(): Promise<MarinadeQuote> {
    throw this.error();
  }

  async buildLiquidStakeTransaction(): Promise<MarinadeBuiltTransaction> {
    throw this.error();
  }

  async buildDelayedUnstakeTransaction(): Promise<MarinadeBuiltTransaction> {
    throw this.error();
  }

  async buildClaimDelayedUnstakeTransaction(): Promise<MarinadeBuiltTransaction> {
    throw this.error();
  }

  private error(): ProtocolError {
    return new ProtocolError('unsupported_method', this.reason);
  }
}

let clientFactory: MarinadeClientFactory = () =>
  new MarinadeUnavailableClient(
    `Marinade connector requires a runtime Marinade SDK client. Install ${SDK_PACKAGE_NAME} or inject a MarinadeClient with setMarinadeClientFactory().`,
  );

export function setMarinadeClientFactory(factory?: MarinadeClientFactory): void {
  clientFactory =
    factory ??
    (() =>
      new MarinadeUnavailableClient(
        `Marinade connector requires a runtime Marinade SDK client. Install ${SDK_PACKAGE_NAME} or inject a MarinadeClient with setMarinadeClientFactory().`,
      ));
}

export function getMarinadeClient(): MarinadeClient {
  return clientFactory();
}

export function describeMarinadeUnavailableReason(): string | undefined {
  const client = getMarinadeClient();
  if (client instanceof MarinadeUnavailableClient) {
    return client.getReason();
  }
  return undefined;
}

export function baseMarinadeStateSnapshot(overrides: Partial<MarinadeStateSnapshot> = {}): MarinadeStateSnapshot {
  return {
    connectorId: MARINADE_ADAPTER_ID,
    stateAddress: MARINADE_STATE_ADDRESS,
    programId: MARINADE_PROGRAM_ID,
    msolMint: MSOL_MINT,
    ...overrides,
  };
}
