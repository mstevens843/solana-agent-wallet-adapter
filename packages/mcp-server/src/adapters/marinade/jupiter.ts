import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { jupiterFetchJson } from '../jupiter/index.js';
import { WSOL_MINT, type AgentWalletConfig } from '../../config.js';
import {
  MARINADE_ADAPTER_ID,
  MARINADE_DEFAULT_SLIPPAGE_BPS,
  MSOL_MINT,
  SOL_DECIMALS,
} from './constants.js';
import type { MarinadeQuote } from './client.js';

export interface MarinadeJupiterOrder {
  requestId?: string;
  transactionBase64: string;
  inputMint: string;
  outputMint: string;
  inputAmountRaw: string;
  outputAmountRaw?: string;
  minOutputAmountRaw?: string;
  priceImpactPct?: string;
  slippageBps: number;
  order: Record<string, unknown>;
}

export interface MarinadeJupiterExecuteResult {
  signature?: string;
  txid?: string;
  status?: string;
  raw: Record<string, unknown>;
}

export async function fetchMarinadeInstantUnstakeOrder(input: {
  config: AgentWalletConfig;
  taker: string;
  msolAmountRaw: bigint;
  slippageBps?: number;
}): Promise<MarinadeJupiterOrder> {
  const order = await jupiterFetchJson(input.config, 'swap', '/order', {
    searchParams: {
      inputMint: MSOL_MINT,
      outputMint: WSOL_MINT,
      amount: input.msolAmountRaw.toString(),
      taker: input.taker,
      slippageBps: input.slippageBps ?? MARINADE_DEFAULT_SLIPPAGE_BPS,
      swapMode: 'ExactIn',
    },
  });
  const transactionBase64 = readString(order, 'transaction');
  if (!transactionBase64) {
    throw new ProtocolError('wallet_unreachable', 'Jupiter order response did not include a transaction.');
  }
  return {
    requestId: readString(order, 'requestId'),
    transactionBase64,
    inputMint: readString(order, 'inputMint') ?? MSOL_MINT,
    outputMint: readString(order, 'outputMint') ?? WSOL_MINT,
    inputAmountRaw: readString(order, 'inAmount') ?? input.msolAmountRaw.toString(),
    outputAmountRaw: readString(order, 'outAmount'),
    minOutputAmountRaw: readString(order, 'otherAmountThreshold'),
    priceImpactPct: readString(order, 'priceImpactPct'),
    slippageBps: input.slippageBps ?? MARINADE_DEFAULT_SLIPPAGE_BPS,
    order,
  };
}

export async function executeMarinadeJupiterOrder(input: {
  config: AgentWalletConfig;
  signedTransaction: string;
  requestId?: string;
}): Promise<MarinadeJupiterExecuteResult> {
  if (!input.requestId) {
    throw new ProtocolError('invalid_request', 'Jupiter order did not include requestId.');
  }
  const raw = await jupiterFetchJson(input.config, 'swap', '/execute', {
    method: 'POST',
    body: {
      signedTransaction: input.signedTransaction,
      requestId: input.requestId,
    },
  });
  return {
    signature: readString(raw, 'signature'),
    txid: readString(raw, 'txid'),
    status: readString(raw, 'status'),
    raw,
  };
}

export function quoteFromJupiterOrder(order: MarinadeJupiterOrder): MarinadeQuote {
  return {
    connectorId: MARINADE_ADAPTER_ID,
    operation: 'liquid_unstake',
    inputAmount: lamportsToAmount(order.inputAmountRaw),
    inputAmountRaw: order.inputAmountRaw,
    outputAmount: order.outputAmountRaw ? lamportsToAmount(order.outputAmountRaw) : undefined,
    outputAmountRaw: order.outputAmountRaw,
    minOutputAmount: order.minOutputAmountRaw ? lamportsToAmount(order.minOutputAmountRaw) : undefined,
    minOutputAmountRaw: order.minOutputAmountRaw,
    route: 'jupiter',
    price: order.priceImpactPct,
    raw: {
      requestId: order.requestId,
      inputMint: order.inputMint,
      outputMint: order.outputMint,
      slippageBps: order.slippageBps,
    },
  };
}

export function assertJupiterMinOutput(order: MarinadeJupiterOrder, minOutputAmountRaw?: bigint): void {
  if (minOutputAmountRaw === undefined) {
    return;
  }
  const raw = order.minOutputAmountRaw ?? order.outputAmountRaw;
  if (!raw) {
    throw new ProtocolError('invalid_request', 'Jupiter order did not include an output amount to validate.');
  }
  if (BigInt(raw) < minOutputAmountRaw) {
    throw new ProtocolError(
      'invalid_request',
      `Jupiter route minimum output ${raw} is below requested minimum ${minOutputAmountRaw.toString()}.`,
    );
  }
}

export function txidFromJupiterExecution(result: MarinadeJupiterExecuteResult): string {
  const txid = result.signature ?? result.txid;
  if (!txid) {
    throw new ProtocolError('wallet_unreachable', 'Jupiter execute response did not include a transaction signature.');
  }
  return txid;
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const result = value[key];
  return typeof result === 'string' && result.length > 0 ? result : undefined;
}

function lamportsToAmount(raw: string): string {
  const value = BigInt(raw);
  const divisor = 10n ** BigInt(SOL_DECIMALS);
  const whole = value / divisor;
  const fraction = value % divisor;
  if (fraction === 0n) {
    return whole.toString();
  }
  return `${whole.toString()}.${fraction.toString().padStart(SOL_DECIMALS, '0').replace(/0+$/, '')}`;
}
