import { createHash } from 'node:crypto';

import type { Connection } from '@solana/web3.js';

import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { AdapterError } from '../types.js';

import {
  getSquadsMultisigClient,
  type SquadsInstructionPreview,
  type SquadsProposalListEntry,
  type SquadsProposalSnapshot,
} from './client.js';
import {
  SQUADS_ADAPTER_ID,
  SQUADS_APPROVAL_LIMITS,
  SQUADS_PROGRAM_ID,
  type SquadsInstructionKind,
  type SquadsInstructionRiskTier,
  type SquadsProposalStatus,
  type SquadsVoteOperation,
} from './constants.js';
import { requireMultisigAddress, type ResolvedMemberPermissions } from './multisigs.js';

export interface ProposalDescriptor {
  proposalAddress?: string;
  transactionIndex?: number;
}

export function requireProposalDescriptor(input: ProposalDescriptor): ProposalDescriptor {
  const hasAddress = typeof input.proposalAddress === 'string' && input.proposalAddress.trim().length > 0;
  const hasIndex = input.transactionIndex !== undefined && Number.isFinite(input.transactionIndex);
  if (!hasAddress && !hasIndex) {
    throw new AdapterError(
      SQUADS_ADAPTER_ID,
      'invalid_request',
      'Provide proposalAddress or transactionIndex.',
    );
  }
  if (hasIndex) {
    const normalized = Number(input.transactionIndex);
    if (!Number.isInteger(normalized) || normalized < 0) {
      throw new AdapterError(
        SQUADS_ADAPTER_ID,
        'invalid_proposal',
        'transactionIndex must be a non-negative integer.',
      );
    }
  }
  return {
    ...(hasAddress && { proposalAddress: input.proposalAddress!.trim() }),
    ...(hasIndex && { transactionIndex: Number(input.transactionIndex) }),
  };
}

export async function getProposalSnapshot(
  connection: Connection,
  multisigAddress: string,
  opts: ProposalDescriptor & { includeInstructions?: boolean },
): Promise<SquadsProposalSnapshot> {
  const normalizedMultisig = requireMultisigAddress(multisigAddress);
  const descriptor = requireProposalDescriptor(opts);
  return getSquadsMultisigClient().getProposalSnapshot(connection, normalizedMultisig, {
    ...descriptor,
    ...(opts.includeInstructions !== undefined && { includeInstructions: opts.includeInstructions }),
  });
}

export async function listProposals(
  connection: Connection,
  multisigAddress: string,
  opts: { status?: SquadsProposalStatus | 'all'; limit?: number } = {},
): Promise<SquadsProposalListEntry[]> {
  const normalizedMultisig = requireMultisigAddress(multisigAddress);
  const limit = Math.min(
    SQUADS_APPROVAL_LIMITS.proposalListMax,
    Math.max(1, opts.limit ?? SQUADS_APPROVAL_LIMITS.proposalListDefault),
  );
  return getSquadsMultisigClient().listProposals(connection, normalizedMultisig, {
    status: opts.status ?? 'active',
    limit,
  });
}

export function assertProposalState(
  snapshot: SquadsProposalSnapshot,
  allowed: SquadsProposalStatus[],
  operation: SquadsVoteOperation | 'execute',
): void {
  if (allowed.includes(snapshot.status)) return;
  throw new AdapterError(
    SQUADS_ADAPTER_ID,
    'proposal_state',
    `Cannot ${operation} a Squads proposal that is ${snapshot.status}; required status is one of ${allowed.join(', ')}.`,
  );
}

export function assertCanVote(
  permissions: ResolvedMemberPermissions,
  operation: SquadsVoteOperation,
  proposalStatus: SquadsProposalStatus,
): void {
  if (!permissions.member) {
    throw new AdapterError(
      SQUADS_ADAPTER_ID,
      'not_a_member',
      `Connected wallet is not a member of this Squads multisig; cannot ${operation} the proposal.`,
    );
  }
  if (!permissions.canVote) {
    throw new AdapterError(
      SQUADS_ADAPTER_ID,
      'no_vote_permission',
      `Connected wallet does not have vote permission on this Squads multisig; cannot ${operation}.`,
    );
  }
  if (operation === 'cancel' && proposalStatus !== 'approved') {
    throw new AdapterError(
      SQUADS_ADAPTER_ID,
      'cancel_requires_approved',
      'Squads cancel is only available once a proposal has been approved.',
    );
  }
}

export function assertCanExecute(
  permissions: ResolvedMemberPermissions,
  snapshot: SquadsProposalSnapshot,
  nowMs: number,
): void {
  if (!permissions.member) {
    throw new AdapterError(
      SQUADS_ADAPTER_ID,
      'not_a_member',
      'Connected wallet is not a member of this Squads multisig; cannot execute the proposal.',
    );
  }
  if (!permissions.canExecute) {
    throw new AdapterError(
      SQUADS_ADAPTER_ID,
      'no_execute_permission',
      'Connected wallet does not have execute permission on this Squads multisig.',
    );
  }
  if (snapshot.status !== 'approved') {
    throw new AdapterError(
      SQUADS_ADAPTER_ID,
      'proposal_state',
      `Cannot execute a Squads proposal that is ${snapshot.status}; required status is approved.`,
    );
  }
  if (snapshot.approvalCount < snapshot.threshold) {
    throw new AdapterError(
      SQUADS_ADAPTER_ID,
      'threshold_not_met',
      `Squads proposal has ${snapshot.approvalCount} approvals; threshold is ${snapshot.threshold}.`,
    );
  }
  if (snapshot.lockoutExpiresAt !== undefined && snapshot.lockoutExpiresAt > nowMs) {
    const eta = new Date(snapshot.lockoutExpiresAt).toISOString();
    throw new AdapterError(
      SQUADS_ADAPTER_ID,
      'time_lock_not_elapsed',
      `Squads time-lock has not elapsed yet (executable at ${eta}).`,
    );
  }
}

export function assertExecuteStateUnchanged(
  prepared: { approvalCount: number; status: SquadsProposalStatus; executableAt?: number },
  refreshed: SquadsProposalSnapshot,
): void {
  if (refreshed.status !== prepared.status) {
    throw new ProtocolError(
      'invalid_request',
      `Squads proposal status changed from ${prepared.status} to ${refreshed.status} between prepare and execute. Re-prepare before signing.`,
    );
  }
  if (refreshed.approvalCount < prepared.approvalCount) {
    throw new ProtocolError(
      'invalid_request',
      `Squads proposal lost approvals between prepare (${prepared.approvalCount}) and execute (${refreshed.approvalCount}). Re-prepare before signing.`,
    );
  }
  if (
    prepared.executableAt !== undefined &&
    refreshed.executableAt !== undefined &&
    refreshed.executableAt !== prepared.executableAt
  ) {
    throw new ProtocolError(
      'invalid_request',
      'Squads proposal executableAt changed between prepare and execute. Re-prepare before signing.',
    );
  }
}

// --- Instruction decoder ----------------------------------------------------

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const MEMO_PROGRAM_V1_ID = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';
const MEMO_PROGRAM_V2_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';

interface RawInstructionInput {
  programId: string;
  data: Uint8Array | Buffer | string;
  accounts: string[];
}

export function decodeInstructionPreview(rawInstructions: RawInstructionInput[]): SquadsInstructionPreview[] {
  return rawInstructions.map((raw, index) => decodeOne(raw, index));
}

function decodeOne(raw: RawInstructionInput, index: number): SquadsInstructionPreview {
  const data = normalizeData(raw.data);
  const programId = raw.programId;
  if (programId === SYSTEM_PROGRAM_ID) return decodeSystem(raw, data, index);
  if (programId === TOKEN_PROGRAM_ID || programId === TOKEN_2022_PROGRAM_ID) return decodeToken(raw, data, programId, index);
  if (programId === MEMO_PROGRAM_V1_ID || programId === MEMO_PROGRAM_V2_ID) return decodeMemo(raw, data, programId, index);
  if (programId === COMPUTE_BUDGET_PROGRAM_ID) return decodeComputeBudget(raw, data, index);
  if (programId === SQUADS_PROGRAM_ID.toBase58()) return decodeSquads(raw, data, index);
  return unknownInstruction(raw, data, index);
}

function decodeSystem(raw: RawInstructionInput, data: Uint8Array, index: number): SquadsInstructionPreview {
  const opcode = readUInt32LE(data, 0);
  if (opcode === 2) {
    // SystemInstruction::Transfer { lamports }
    const lamports = readBigUInt64LE(data, 4);
    return {
      index,
      kind: 'sol_transfer',
      programId: raw.programId,
      riskTier: 'transfer',
      summary: `Transfer ${formatLamports(lamports)} SOL to ${shortAddr(raw.accounts[1])}`,
      detail: {
        from: raw.accounts[0] ?? null,
        to: raw.accounts[1] ?? null,
        lamports: lamports.toString(),
      },
    };
  }
  if (opcode === 11) {
    // SystemInstruction::TransferWithSeed
    return {
      index,
      kind: 'sol_transfer_with_seed',
      programId: raw.programId,
      riskTier: 'transfer',
      summary: 'SOL transferWithSeed',
      detail: { accounts: raw.accounts },
    };
  }
  if (opcode === 0) {
    return {
      index,
      kind: 'system_create_account',
      programId: raw.programId,
      riskTier: 'governance',
      summary: 'Create system account',
      detail: { accounts: raw.accounts },
    };
  }
  if (opcode === 1) {
    return {
      index,
      kind: 'system_assign',
      programId: raw.programId,
      riskTier: 'governance',
      summary: 'Assign system account owner',
      detail: { accounts: raw.accounts },
    };
  }
  return unknownInstruction(raw, data, index);
}

function decodeToken(
  raw: RawInstructionInput,
  data: Uint8Array,
  programId: string,
  index: number,
): SquadsInstructionPreview {
  if (data.length === 0) return unknownInstruction(raw, data, index);
  const tag = data[0]!;
  if (tag === 3) {
    // Transfer { amount }
    const amount = readBigUInt64LE(data, 1);
    return {
      index,
      kind: 'spl_transfer',
      programId,
      riskTier: 'transfer',
      summary: `SPL transfer ${amount.toString()} to ${shortAddr(raw.accounts[1])}`,
      detail: { source: raw.accounts[0] ?? null, destination: raw.accounts[1] ?? null, amountRaw: amount.toString() },
    };
  }
  if (tag === 12) {
    // TransferChecked { amount, decimals }
    const amount = readBigUInt64LE(data, 1);
    const decimals = data[9] ?? 0;
    return {
      index,
      kind: 'spl_transfer_checked',
      programId,
      riskTier: 'transfer',
      summary: `SPL transferChecked ${amount.toString()} (decimals ${decimals})`,
      detail: {
        source: raw.accounts[0] ?? null,
        mint: raw.accounts[1] ?? null,
        destination: raw.accounts[2] ?? null,
        amountRaw: amount.toString(),
        decimals,
      },
    };
  }
  if (tag === 9) {
    return {
      index,
      kind: 'spl_close_account',
      programId,
      riskTier: 'transfer',
      summary: 'Close SPL token account',
      detail: { account: raw.accounts[0] ?? null, destination: raw.accounts[1] ?? null },
    };
  }
  if (tag === 17) {
    return {
      index,
      kind: 'spl_sync_native',
      programId,
      riskTier: 'transfer',
      summary: 'Sync native SOL token account',
      detail: { account: raw.accounts[0] ?? null },
    };
  }
  if (tag === 4) {
    return {
      index,
      kind: 'spl_approve',
      programId,
      riskTier: 'governance',
      summary: 'Approve SPL delegate',
      warning: 'Approving an SPL delegate grants spending authority to another account.',
      detail: { account: raw.accounts[0] ?? null, delegate: raw.accounts[1] ?? null },
    };
  }
  if (tag === 5) {
    return {
      index,
      kind: 'spl_revoke',
      programId,
      riskTier: 'transfer',
      summary: 'Revoke SPL delegate',
      detail: { account: raw.accounts[0] ?? null },
    };
  }
  if (tag === 8) {
    const amount = readBigUInt64LE(data, 1);
    return {
      index,
      kind: 'spl_burn',
      programId,
      riskTier: 'governance',
      summary: `Burn ${amount.toString()} SPL tokens`,
      warning: 'Burning tokens is irreversible.',
      detail: { account: raw.accounts[0] ?? null, amountRaw: amount.toString() },
    };
  }
  return unknownInstruction(raw, data, index);
}

function decodeMemo(
  raw: RawInstructionInput,
  data: Uint8Array,
  programId: string,
  index: number,
): SquadsInstructionPreview {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
  return {
    index,
    kind: 'memo',
    programId,
    riskTier: 'governance',
    summary: text ? `Memo: ${truncate(text, 96)}` : 'Memo',
    detail: { text },
  };
}

function decodeComputeBudget(raw: RawInstructionInput, data: Uint8Array, index: number): SquadsInstructionPreview {
  if (data.length === 0) return unknownInstruction(raw, data, index);
  const tag = data[0]!;
  if (tag === 2) {
    const units = readUInt32LE(data, 1);
    return {
      index,
      kind: 'compute_budget_set_limit',
      programId: raw.programId,
      riskTier: 'compute',
      summary: `Set compute unit limit to ${units}`,
      detail: { units },
    };
  }
  if (tag === 3) {
    const microLamports = readBigUInt64LE(data, 1);
    return {
      index,
      kind: 'compute_budget_set_price',
      programId: raw.programId,
      riskTier: 'compute',
      summary: `Set compute unit price to ${microLamports.toString()} micro-lamports`,
      detail: { microLamports: microLamports.toString() },
    };
  }
  return unknownInstruction(raw, data, index);
}

function decodeSquads(raw: RawInstructionInput, data: Uint8Array, index: number): SquadsInstructionPreview {
  if (data.length < 8) return unknownInstruction(raw, data, index);
  // Anchor discriminator is the first 8 bytes; we identify by a stable hash prefix.
  // For V1 we do not need to fully decode args; we just label the instruction kind so
  // the wallet review surface can highlight admin/governance changes.
  const discriminator = Array.from(data.slice(0, 8))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const entry = SQUADS_DISCRIMINATOR_TABLE.get(discriminator);
  if (!entry) {
    return {
      index,
      kind: 'unknown',
      programId: raw.programId,
      riskTier: 'unknown',
      summary: 'Unknown Squads instruction',
      warning: 'This Squads instruction discriminator is not in the V1 decoder table.',
      detail: { discriminator, accounts: raw.accounts },
    };
  }
  return {
    index,
    kind: entry.kind,
    programId: raw.programId,
    riskTier: entry.riskTier,
    summary: entry.summary,
    ...(entry.warning && { warning: entry.warning }),
    detail: { discriminator, accounts: raw.accounts },
  };
}

function unknownInstruction(raw: RawInstructionInput, data: Uint8Array, index: number): SquadsInstructionPreview {
  return {
    index,
    kind: 'unknown',
    programId: raw.programId,
    riskTier: 'unknown',
    summary: `Unknown instruction (${raw.programId.slice(0, 4)}…)`,
    warning: 'Instruction could not be decoded. Review carefully before approving.',
    detail: { dataLength: data.length, accounts: raw.accounts },
  };
}

interface SquadsDiscriminatorEntry {
  kind: SquadsInstructionKind;
  riskTier: SquadsInstructionRiskTier;
  summary: string;
  warning?: string;
}

// Anchor instruction discriminators are sha256("global:<method>")[0..8]. We compute them at
// module load from the canonical @sqds/multisig v4 IDL method names so the decoder reflects the
// actual on-chain encoding. If a future SDK version renames or adds methods, the entry falls
// through to the `unknown` path with a warning rather than failing silently.
function anchorDiscriminator(method: string): string {
  return createHash('sha256').update(`global:${method}`).digest('hex').slice(0, 16);
}

const SQUADS_DISCRIMINATOR_TABLE = new Map<string, SquadsDiscriminatorEntry>([
  [anchorDiscriminator('vault_transaction_create'), { kind: 'squads_vault_transaction_create', riskTier: 'transfer', summary: 'Squads vault transaction create' }],
  [anchorDiscriminator('config_transaction_create'), { kind: 'squads_config_transaction_create', riskTier: 'admin', summary: 'Squads config transaction create', warning: 'This proposal modifies multisig configuration (members, threshold, or time-lock).' }],
  [anchorDiscriminator('proposal_create'), { kind: 'squads_proposal_create', riskTier: 'governance', summary: 'Squads proposal create' }],
  [anchorDiscriminator('proposal_approve'), { kind: 'squads_proposal_approve', riskTier: 'governance', summary: 'Squads proposal approve' }],
  [anchorDiscriminator('proposal_reject'), { kind: 'squads_proposal_reject', riskTier: 'governance', summary: 'Squads proposal reject' }],
  [anchorDiscriminator('proposal_cancel'), { kind: 'squads_proposal_cancel', riskTier: 'governance', summary: 'Squads proposal cancel' }],
  [anchorDiscriminator('vault_transaction_execute'), { kind: 'squads_vault_transaction_execute', riskTier: 'transfer', summary: 'Squads vault transaction execute', warning: 'Execution moves treasury funds.' }],
  [anchorDiscriminator('config_transaction_execute'), { kind: 'squads_config_transaction_execute', riskTier: 'admin', summary: 'Squads config transaction execute', warning: 'Execution changes multisig configuration.' }],
  [anchorDiscriminator('multisig_add_member'), { kind: 'squads_add_member', riskTier: 'admin', summary: 'Squads add member', warning: 'This proposal adds a member to the multisig.' }],
  [anchorDiscriminator('multisig_remove_member'), { kind: 'squads_remove_member', riskTier: 'admin', summary: 'Squads remove member', warning: 'This proposal removes a member from the multisig.' }],
  [anchorDiscriminator('multisig_change_threshold'), { kind: 'squads_change_threshold', riskTier: 'admin', summary: 'Squads change threshold', warning: 'This proposal changes the multisig threshold.' }],
  [anchorDiscriminator('multisig_set_time_lock'), { kind: 'squads_set_time_lock', riskTier: 'admin', summary: 'Squads set time-lock', warning: 'This proposal changes the multisig time-lock.' }],
  [anchorDiscriminator('multisig_set_config_authority'), { kind: 'squads_set_config_authority', riskTier: 'admin', summary: 'Squads set config authority', warning: 'This proposal transfers configuration authority.' }],
]);

export function collectInstructionWarnings(preview: SquadsInstructionPreview[]): string[] {
  const warnings: string[] = [];
  let hasUnknown = false;
  let touchesAdmin = false;
  let movesFunds = false;
  for (const entry of preview) {
    if (entry.warning) warnings.push(entry.warning);
    if (entry.kind === 'unknown') hasUnknown = true;
    if (entry.riskTier === 'admin') touchesAdmin = true;
    if (entry.riskTier === 'transfer') movesFunds = true;
  }
  if (hasUnknown) warnings.push('Proposal contains instructions that could not be decoded.');
  if (touchesAdmin) warnings.push('Proposal modifies multisig administration.');
  if (movesFunds) warnings.push('Execution moves treasury funds.');
  return Array.from(new Set(warnings));
}

// --- byte helpers -----------------------------------------------------------

function normalizeData(input: Uint8Array | Buffer | string): Uint8Array {
  if (typeof input === 'string') {
    if (/^[0-9a-f]+$/i.test(input)) {
      const bytes = new Uint8Array(input.length / 2);
      for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = parseInt(input.slice(i * 2, i * 2 + 2), 16);
      }
      return bytes;
    }
    // Base64 fallback.
    if (typeof Buffer !== 'undefined') {
      return new Uint8Array(Buffer.from(input, 'base64'));
    }
    return new Uint8Array();
  }
  if (input instanceof Uint8Array) return input;
  return new Uint8Array(input as ArrayBufferLike);
}

function readUInt32LE(data: Uint8Array, offset: number): number {
  if (data.length < offset + 4) return 0;
  return (
    data[offset]! |
    (data[offset + 1]! << 8) |
    (data[offset + 2]! << 16) |
    (data[offset + 3]! << 24)
  ) >>> 0;
}

function readBigUInt64LE(data: Uint8Array, offset: number): bigint {
  if (data.length < offset + 8) return 0n;
  let value = 0n;
  for (let i = 0; i < 8; i += 1) {
    value |= BigInt(data[offset + i]!) << BigInt(i * 8);
  }
  return value;
}

function formatLamports(lamports: bigint): string {
  const integer = lamports / 1_000_000_000n;
  const fraction = lamports % 1_000_000_000n;
  if (fraction === 0n) return integer.toString();
  const fractionStr = fraction.toString().padStart(9, '0').replace(/0+$/, '');
  return `${integer.toString()}.${fractionStr}`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function shortAddr(value: string | undefined): string {
  if (!value) return '?';
  if (value.length <= 12) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
