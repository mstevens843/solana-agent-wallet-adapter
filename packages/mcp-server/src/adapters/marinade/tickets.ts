import type { Connection } from '@solana/web3.js';

import { getMarinadeClient, type MarinadeUnstakeTicket } from './client.js';

export async function readMarinadeUnstakeTickets(
  connection: Connection,
  walletAddress: string,
  input: { claimableOnly?: boolean } = {},
): Promise<MarinadeUnstakeTicket[]> {
  const tickets = await getMarinadeClient().getUnstakeTickets(connection, walletAddress);
  if (input.claimableOnly) {
    return tickets.filter((ticket) => ticket.status === 'claimable');
  }
  return tickets;
}
