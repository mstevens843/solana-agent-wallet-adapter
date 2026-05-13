import type { Connection } from '@solana/web3.js';

import { AdapterError } from '../types.js';

import {
  getRealmsClient,
  type ProposalInstructionDecoded,
  type ProposalListEntry,
  type ProposalListInput,
  type ProposalSnapshot,
  type ProposalSnapshotOptions,
} from './client.js';
import { REALMS_ADAPTER_ID } from './constants.js';
import { decodeInstructions } from './instructions.js';
import { requireAddress } from './realms.js';

export interface DecoratedProposalSnapshot extends ProposalSnapshot {
  decodedInstructions: ProposalInstructionDecoded[];
}

export async function getProposalList(
  connection: Connection,
  input: ProposalListInput,
): Promise<ProposalListEntry[]> {
  const realmAddress = requireAddress(input.realmAddress, 'realmAddress');
  const governanceAddress = input.governanceAddress
    ? requireAddress(input.governanceAddress, 'governanceAddress')
    : undefined;
  if (!Number.isFinite(input.limit) || input.limit <= 0) {
    throw new AdapterError(
      REALMS_ADAPTER_ID,
      'invalid_request',
      'limit must be a positive integer.',
    );
  }
  return getRealmsClient().getProposalList(connection, {
    realmAddress,
    ...(governanceAddress !== undefined && { governanceAddress }),
    state: input.state,
    limit: input.limit,
  });
}

export async function getProposalSnapshot(
  connection: Connection,
  proposalAddress: string,
  options: ProposalSnapshotOptions = {},
): Promise<DecoratedProposalSnapshot> {
  const normalized = requireAddress(proposalAddress, 'proposalAddress');
  const snapshot = await getRealmsClient().getProposalSnapshot(connection, normalized, options);
  return {
    ...snapshot,
    decodedInstructions: decodeInstructions(snapshot.rawInstructions),
  };
}
