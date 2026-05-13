import type { Connection } from '@solana/web3.js';

import { getJitoClient, type JitoQuote, type JitoQuoteInput, type JitoStakePoolSnapshot } from './client.js';

export function getJitoStakePoolSnapshot(
  connection: Connection,
  input: { includeValidators?: boolean } = {},
): Promise<JitoStakePoolSnapshot> {
  return getJitoClient().getStakePoolSnapshot(connection, input);
}

export function quoteJito(connection: Connection, input: JitoQuoteInput): Promise<JitoQuote> {
  return getJitoClient().quote(connection, input);
}
