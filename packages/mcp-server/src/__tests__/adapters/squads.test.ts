import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SQUADS_ADAPTER_ID,
  SQUADS_SUPPORTED_CLUSTERS,
  squadsAdapter,
} from '../../adapters/squads/index.js';
import {
  resetSquadsMultisigClientFactory,
  setSquadsMultisigClientFactory,
  type SquadsBuildCreateTransferProposalResult,
  type SquadsBuildExecuteResult,
  type SquadsBuildVoteResult,
  type SquadsInstructionPreview,
  type SquadsMemberSnapshot,
  type SquadsMultisigClient,
  type SquadsMultisigSnapshot,
  type SquadsProposalSnapshot,
  type SquadsVaultSnapshot,
  type SquadsWalletAuthority,
} from '../../adapters/squads/client.js';
import { decodeInstructionPreview } from '../../adapters/squads/proposals.js';
import {
  AdapterError,
  actionForKind,
  adapterForActionKind,
  assertSupportedCluster,
  requireAdapter,
} from '../../adapters/index.js';
import type { AgentWalletConfig } from '../../config.js';
import type { DAppAdapterContext } from '../../adapters/types.js';
import type {
  AddPreparedActionInput,
  PreparedAction,
  PreparedActionStore,
} from '../../preparedActions.js';

const WALLET = 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV';
const MEMBER_B = '6BiPpcoBL55kpfwbBmpBVxd2c4uo32V1xFwYbpFiZjGm';
const MULTISIG = 'SQwHbW2NoYKxKQt7uDtPyAUUUBpVZ8K6S8KQU3qKjsa';
const VAULT = '7Sxz6w2bcF7w12VS9Mr8RoiVgsKn4tMqQA2Bgr9pKKgM';
const PROPOSAL = '4P9PrcKK6c8TpkP1cQGUw3Tj4HKZxV7uYn8t5sw5Lh9P';
const TRANSACTION = '2NSEY1QY8FwJX3Bj2QGcoqJZL7s8FQF6mzaaXuVj4qa3';
const RECIPIENT = 'CB7NjDDDgM6L9w7rPLfYr8eDQ4dPmqNcF7w4d6BRkZkX';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

class FakeBackend {
  async getAddress(): Promise<string> {
    return WALLET;
  }
  async capabilities(): Promise<{ address: string }> {
    return { address: WALLET };
  }
}

interface FakeSquadsState {
  multisigSnapshot: SquadsMultisigSnapshot;
  vaultSnapshot: SquadsVaultSnapshot;
  proposalSnapshot: SquadsProposalSnapshot;
  walletAuthority: SquadsWalletAuthority;
  createCalls: Array<Record<string, unknown>>;
  voteCalls: Array<Record<string, unknown>>;
  executeCalls: Array<Record<string, unknown>>;
}

function buildFakeSquads(state: FakeSquadsState): SquadsMultisigClient {
  return {
    async getWalletAuthority() {
      return state.walletAuthority;
    },
    async getMultisigSnapshot() {
      return state.multisigSnapshot;
    },
    async getVaultSnapshot() {
      return state.vaultSnapshot;
    },
    async getProposalSnapshot() {
      return state.proposalSnapshot;
    },
    async listProposals() {
      return [
        {
          transactionIndex: state.proposalSnapshot.transactionIndex,
          proposalAddress: state.proposalSnapshot.proposalAddress,
          status: state.proposalSnapshot.status,
          approvalCount: state.proposalSnapshot.approvalCount,
          rejectionCount: state.proposalSnapshot.rejectionCount,
          threshold: state.proposalSnapshot.threshold,
        },
      ];
    },
    async buildCreateTransferProposalTransaction(_connection, input): Promise<SquadsBuildCreateTransferProposalResult> {
      state.createCalls.push({ ...input });
      return {
        transactionBase64: 'BASE64_CREATE_TRANSFER_PROPOSAL',
        multisigAddress: input.multisigAddress,
        vaultIndex: input.vaultIndex,
        vaultAddress: state.vaultSnapshot.vaultAddress,
        recipient: input.recipient,
        mintAddress: input.mintAddress,
        amountRaw: input.amountRaw.toString(),
        amountUi: (Number(input.amountRaw) / 10 ** input.decimals).toString(),
        decimals: input.decimals,
        transactionIndex: input.transactionIndex,
        proposalAddress: PROPOSAL,
        transactionAddress: TRANSACTION,
        instructionPreview: state.proposalSnapshot.instructionPreview,
      };
    },
    async buildVoteTransaction(_connection, input): Promise<SquadsBuildVoteResult> {
      state.voteCalls.push({ ...input });
      return {
        transactionBase64: `BASE64_VOTE_${input.operation.toUpperCase()}`,
        multisigAddress: input.multisigAddress,
        transactionIndex: input.transactionIndex,
        proposalAddress: input.proposalAddress,
        operation: input.operation,
      };
    },
    async buildExecuteTransaction(_connection, input): Promise<SquadsBuildExecuteResult> {
      state.executeCalls.push({ ...input });
      return {
        transactionBase64: 'BASE64_EXECUTE_PROPOSAL',
        multisigAddress: input.multisigAddress,
        transactionIndex: input.transactionIndex,
        proposalAddress: input.proposalAddress,
        transactionAddress: TRANSACTION,
        instructionPreview: state.proposalSnapshot.instructionPreview,
      };
    },
  };
}

function fakeMember(overrides: Partial<SquadsMemberSnapshot> = {}): SquadsMemberSnapshot {
  return {
    publicKey: WALLET,
    canInitiate: true,
    canVote: true,
    canExecute: true,
    ...overrides,
  };
}

function fakeMultisigSnapshot(overrides: Partial<SquadsMultisigSnapshot> = {}): SquadsMultisigSnapshot {
  return {
    multisigAddress: MULTISIG,
    createKey: '4cwNqGZQwYDppKxFa9ZJDhKLKfA4qf2DLM6cVwjGcKbV',
    configAuthority: MULTISIG,
    threshold: 2,
    timeLockSec: 0,
    transactionIndex: 5,
    staleTransactionIndex: 0,
    members: [fakeMember(), fakeMember({ publicKey: MEMBER_B })],
    vaultCount: 1,
    asOfSlot: 280_000_000,
    ...overrides,
  };
}

function fakeVaultSnapshot(overrides: Partial<SquadsVaultSnapshot> = {}): SquadsVaultSnapshot {
  return {
    multisigAddress: MULTISIG,
    vaultIndex: 0,
    vaultAddress: VAULT,
    lamports: '2500000000',
    solUi: '2.5',
    tokenAccounts: [
      {
        mint: USDC_MINT,
        symbol: 'USDC',
        decimals: 6,
        amountRaw: '1000000000',
        amountUi: '1000',
        tokenAccountAddress: '8r2zMpKAUgKaPzgapKDhUu25cFv2XmYz4M6m7QPzkyZk',
      },
    ],
    asOfSlot: 280_000_000,
    ...overrides,
  };
}

function fakeInstructionPreview(): SquadsInstructionPreview[] {
  return [
    {
      index: 0,
      kind: 'sol_transfer',
      programId: '11111111111111111111111111111111',
      riskTier: 'transfer',
      summary: `Transfer 0.5 SOL to ${RECIPIENT.slice(0, 4)}…`,
      detail: { from: VAULT, to: RECIPIENT, lamports: '500000000' },
    },
  ];
}

function fakeProposalSnapshot(overrides: Partial<SquadsProposalSnapshot> = {}): SquadsProposalSnapshot {
  return {
    multisigAddress: MULTISIG,
    transactionIndex: 5,
    proposalAddress: PROPOSAL,
    transactionAddress: TRANSACTION,
    status: 'active',
    approvals: [WALLET],
    rejections: [],
    cancellations: [],
    approvalCount: 1,
    rejectionCount: 0,
    threshold: 2,
    approvalsRequired: 1,
    staleAtIndex: 0,
    timeLockSec: 0,
    instructionCount: 1,
    instructionPreview: fakeInstructionPreview(),
    warnings: [],
    asOfSlot: 280_000_000,
    ...overrides,
  };
}

function fakeWalletAuthority(): SquadsWalletAuthority {
  return {
    walletAddress: WALLET,
    multisigs: [
      {
        multisigAddress: MULTISIG,
        role: 'all',
        threshold: 2,
        memberCount: 2,
        activeProposalCount: 1,
      },
    ],
  };
}

function fakeConfig(cluster: 'mainnet-beta' | 'devnet' = 'mainnet-beta'): AgentWalletConfig {
  return {
    cluster,
    rpcUrl: 'https://api.fake',
    mainnet: {
      enabled: true,
      maxSolTransfer: '10',
      maxSwapInput: '10',
      maxSlippageBps: 100,
      allowArbitraryTransactions: false,
    },
    tokens: [],
    jupiter: { baseUrl: 'https://fake', apiKeyEnv: 'JUP_API_KEY' },
    recurring: {},
  } as unknown as AgentWalletConfig;
}

function makeContext(opts: {
  store: PreparedActionStore;
  cluster?: 'mainnet-beta' | 'devnet';
  signed?: (transactionBase64: string, summary: string) => Promise<string>;
}): DAppAdapterContext {
  return {
    backend: new FakeBackend() as unknown as DAppAdapterContext['backend'],
    config: fakeConfig(opts.cluster ?? 'mainnet-beta'),
    connection: {} as DAppAdapterContext['connection'],
    signAndBroadcast: opts.signed ?? (async () => 'TxidPlaceholderForSquadsTests11111111111111'),
    signTransaction: async () => "signed-base64-placeholder",
    signMessage: async () => "signature-base64-placeholder",
    store: opts.store,
  };
}

function inMemoryStore(): PreparedActionStore {
  const actions: PreparedAction[] = [];
  return {
    async addAction(input: AddPreparedActionInput): Promise<PreparedAction> {
      const now = new Date().toISOString();
      const action: PreparedAction = {
        id: `pa_${actions.length + 1}`,
        kind: input.kind,
        status: input.status ?? 'ready',
        walletAddress: input.walletAddress,
        cluster: input.cluster,
        summary: input.summary,
        params: input.params,
        dueAt: input.dueAt ?? now,
        createdAt: now,
        updatedAt: now,
      };
      actions.push(action);
      return action;
    },
    async listActions() {
      return [...actions];
    },
    async getAction(id) {
      return actions.find((entry) => entry.id === id) ?? null;
    },
    async updateAction(id, patch) {
      const index = actions.findIndex((entry) => entry.id === id);
      const current = actions[index];
      if (!current) throw new Error(`Unknown ${id}`);
      actions[index] = { ...current, ...patch, updatedAt: new Date().toISOString() };
      return actions[index]!;
    },
    async deleteAction(id) {
      const before = actions.length;
      const next = actions.filter((entry) => entry.id !== id);
      actions.length = 0;
      actions.push(...next);
      return next.length !== before;
    },
    async archiveAction(id) {
      const current = await this.getAction(id);
      if (!current) throw new Error('missing');
      return current;
    },
    async addRecurringPayment() {
      throw new Error('not implemented for tests');
    },
    async listRecurringPayments() {
      return [];
    },
    async listRecurringPaymentViews() {
      return [];
    },
    async updateRecurringPayment() {
      throw new Error('not implemented for tests');
    },
    async deleteRecurringPayment() {
      return false;
    },
    async materializeDueRecurring() {
      return [];
    },
    async listReceipts() {
      return [];
    },
  };
}

afterEach(() => {
  resetSquadsMultisigClientFactory();
});

function requireSquadsAction(
  id:
    | 'create_transfer_proposal'
    | 'approve_proposal'
    | 'reject_proposal'
    | 'cancel_proposal'
    | 'execute_proposal',
) {
  const action = squadsAdapter.actions[id];
  if (!action) throw new Error(`Squads adapter is missing action ${id}.`);
  return action;
}

describe('Squads adapter shape', () => {
  it('registers with expected id, mainnet gating, and five actions', () => {
    expect(squadsAdapter.id).toBe(SQUADS_ADAPTER_ID);
    expect(squadsAdapter.supportedClusters).toEqual(SQUADS_SUPPORTED_CLUSTERS);
    expect(Object.keys(squadsAdapter.actions).sort()).toEqual([
      'approve_proposal',
      'cancel_proposal',
      'create_transfer_proposal',
      'execute_proposal',
      'reject_proposal',
    ]);
    expect(Object.keys(squadsAdapter.reads).sort()).toEqual([
      'multisig_snapshot',
      'proposal_list',
      'proposal_snapshot',
      'vault_snapshot',
      'wallet_authority',
    ]);
  });

  it('is discoverable via the adapter registry', () => {
    expect(requireAdapter('squads').id).toBe('squads');
    expect(adapterForActionKind('squads_create_transfer_proposal')?.id).toBe('squads');
    expect(actionForKind('squads_approve_proposal')?.action.id).toBe('approve_proposal');
    expect(actionForKind('squads_reject_proposal')?.action.id).toBe('reject_proposal');
    expect(actionForKind('squads_cancel_proposal')?.action.id).toBe('cancel_proposal');
    expect(actionForKind('squads_execute_proposal')?.action.id).toBe('execute_proposal');
  });

  it('throws AdapterError on cluster mismatch via assertSupportedCluster', () => {
    expect(() => assertSupportedCluster(squadsAdapter, 'devnet')).toThrowError(AdapterError);
    expect(() => assertSupportedCluster(squadsAdapter, 'mainnet-beta')).not.toThrow();
  });
});

describe('Squads adapter SDK unavailable', () => {
  it('throws a clear error if no factory is wired and a prepare runs', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireSquadsAction('create_transfer_proposal').prepare(
        {
          multisigAddress: MULTISIG,
          recipient: RECIPIENT,
          amount: '1',
          vaultIndex: 0,
          title: 'Transfer',
        },
        ctx,
      ),
    ).rejects.toThrowError(/Squads adapter is not configured/);
  });

  it('throws a clear error if no factory is wired and a read runs', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const read = squadsAdapter.reads.multisig_snapshot;
    expect(read).toBeDefined();
    await expect(read!.read({ multisigAddress: MULTISIG }, ctx)).rejects.toThrowError(
      /Squads adapter is not configured/,
    );
  });
});

describe('Squads read tools', () => {
  let fakeState: FakeSquadsState;

  beforeEach(() => {
    fakeState = {
      multisigSnapshot: fakeMultisigSnapshot(),
      vaultSnapshot: fakeVaultSnapshot(),
      proposalSnapshot: fakeProposalSnapshot(),
      walletAuthority: fakeWalletAuthority(),
      createCalls: [],
      voteCalls: [],
      executeCalls: [],
    };
    setSquadsMultisigClientFactory(() => buildFakeSquads(fakeState));
  });

  it('wallet_authority returns no-role cleanly for a wallet not on any multisig', async () => {
    fakeState.walletAuthority = { walletAddress: WALLET, multisigs: [] };
    const ctx = makeContext({ store: inMemoryStore() });
    const result = (await squadsAdapter.reads.wallet_authority!.read({}, ctx)) as Record<
      string,
      unknown
    >;
    expect(result.walletAddress).toBe(WALLET);
    expect((result.facts as { multisigCount: number }).multisigCount).toBe(0);
  });

  it('multisig_snapshot normalizes threshold, members, time-lock, and wallet role', async () => {
    const ctx = makeContext({ store: inMemoryStore() });
    const result = (await squadsAdapter.reads.multisig_snapshot!.read(
      { multisigAddress: MULTISIG },
      ctx,
    )) as Record<string, unknown>;
    expect((result.facts as { threshold: number }).threshold).toBe(2);
    expect((result.facts as { memberCount: number }).memberCount).toBe(2);
    expect(result.walletRole).toBe('all');
  });
});

describe('Squads create transfer proposal', () => {
  let fakeState: FakeSquadsState;

  beforeEach(() => {
    fakeState = {
      multisigSnapshot: fakeMultisigSnapshot(),
      vaultSnapshot: fakeVaultSnapshot(),
      proposalSnapshot: fakeProposalSnapshot(),
      walletAuthority: fakeWalletAuthority(),
      createCalls: [],
      voteCalls: [],
      executeCalls: [],
    };
    setSquadsMultisigClientFactory(() => buildFakeSquads(fakeState));
  });

  it('prepare stores squads_create_transfer_proposal with vault facts and threshold snapshot', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const result = await requireSquadsAction('create_transfer_proposal').prepare(
      {
        multisigAddress: MULTISIG,
        recipient: RECIPIENT,
        amount: '100',
        mintAddress: USDC_MINT,
        vaultIndex: 0,
        title: 'Pay vendor',
      },
      ctx,
    );
    expect(result.addInput.kind).toBe('squads_create_transfer_proposal');
    expect(result.addInput.summary).toContain('Propose Squads transfer of 100');
    expect(result.addInput.params).toMatchObject({
      adapter: 'squads',
      operation: 'create_transfer_proposal',
      multisigAddress: MULTISIG,
      vaultIndex: 0,
      vaultAddress: VAULT,
      recipient: RECIPIENT,
      mintAddress: USDC_MINT,
      decimals: 6,
      amount: '100',
      amountRaw: '100000000',
      proposedTransactionIndex: 6,
      refreshAtExecution: true,
    });
  });

  it('rejects when wallet has no proposer permission', async () => {
    fakeState.multisigSnapshot = fakeMultisigSnapshot({
      members: [fakeMember({ canInitiate: false }), fakeMember({ publicKey: MEMBER_B })],
    });
    const ctx = makeContext({ store: inMemoryStore() });
    await expect(
      requireSquadsAction('create_transfer_proposal').prepare(
        {
          multisigAddress: MULTISIG,
          recipient: RECIPIENT,
          amount: '1',
          vaultIndex: 0,
          title: 'Pay',
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('rejects when wallet is not a member at all', async () => {
    fakeState.multisigSnapshot = fakeMultisigSnapshot({
      members: [fakeMember({ publicKey: MEMBER_B })],
    });
    const ctx = makeContext({ store: inMemoryStore() });
    await expect(
      requireSquadsAction('create_transfer_proposal').prepare(
        {
          multisigAddress: MULTISIG,
          recipient: RECIPIENT,
          amount: '1',
          vaultIndex: 0,
          title: 'Pay',
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('rejects when vault balance is insufficient (SOL)', async () => {
    fakeState.vaultSnapshot = fakeVaultSnapshot({ lamports: '500000000', solUi: '0.5' });
    const ctx = makeContext({ store: inMemoryStore() });
    await expect(
      requireSquadsAction('create_transfer_proposal').prepare(
        {
          multisigAddress: MULTISIG,
          recipient: RECIPIENT,
          amount: '5',
          vaultIndex: 0,
          title: 'Pay',
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('rejects when vault has no token account for the mint', async () => {
    fakeState.vaultSnapshot = fakeVaultSnapshot({ tokenAccounts: [] });
    const ctx = makeContext({ store: inMemoryStore() });
    await expect(
      requireSquadsAction('create_transfer_proposal').prepare(
        {
          multisigAddress: MULTISIG,
          recipient: RECIPIENT,
          amount: '1',
          mintAddress: USDC_MINT,
          vaultIndex: 0,
          title: 'Pay',
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('rejects on invalid recipient pubkey', async () => {
    const ctx = makeContext({ store: inMemoryStore() });
    await expect(
      requireSquadsAction('create_transfer_proposal').prepare(
        {
          multisigAddress: MULTISIG,
          recipient: 'not-base58',
          amount: '1',
          vaultIndex: 0,
          title: 'Pay',
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('rejects on unsupported cluster via assertSupportedCluster', () => {
    expect(() => assertSupportedCluster(squadsAdapter, 'devnet')).toThrowError(AdapterError);
  });

  it('execute calls signAndBroadcast with the built transaction and returns a txid', async () => {
    const store = inMemoryStore();
    const signedCalls: Array<{ summary: string; transactionBase64: string }> = [];
    const ctx = makeContext({
      store,
      signed: async (transactionBase64, summary) => {
        signedCalls.push({ transactionBase64, summary });
        return 'broadcasted-squads-create';
      },
    });
    const prepared = await requireSquadsAction('create_transfer_proposal').prepare(
      {
        multisigAddress: MULTISIG,
        recipient: RECIPIENT,
        amount: '100',
        mintAddress: USDC_MINT,
        vaultIndex: 0,
        title: 'Pay vendor',
      },
      ctx,
    );
    const action = await store.addAction(prepared.addInput);
    const result = await requireSquadsAction('create_transfer_proposal').execute(action, ctx);
    expect(result.txid).toBe('broadcasted-squads-create');
    expect(signedCalls[0]?.transactionBase64).toBe('BASE64_CREATE_TRANSFER_PROPOSAL');
    expect(fakeState.createCalls).toHaveLength(1);
  });
});

describe('Squads vote actions (approve / reject / cancel)', () => {
  let fakeState: FakeSquadsState;

  beforeEach(() => {
    fakeState = {
      multisigSnapshot: fakeMultisigSnapshot(),
      vaultSnapshot: fakeVaultSnapshot(),
      proposalSnapshot: fakeProposalSnapshot(),
      walletAuthority: fakeWalletAuthority(),
      createCalls: [],
      voteCalls: [],
      executeCalls: [],
    };
    setSquadsMultisigClientFactory(() => buildFakeSquads(fakeState));
  });

  it('approve stores squads_approve_proposal with proposal snapshot', async () => {
    const ctx = makeContext({ store: inMemoryStore() });
    const result = await requireSquadsAction('approve_proposal').prepare(
      { multisigAddress: MULTISIG, proposalAddress: PROPOSAL },
      ctx,
    );
    expect(result.addInput.kind).toBe('squads_approve_proposal');
    expect(result.addInput.params).toMatchObject({
      operation: 'approve',
      proposalStatus: 'active',
      threshold: 2,
      approvalCount: 1,
      refreshAtExecution: true,
    });
  });

  it('approve rejects when wallet has no vote permission', async () => {
    fakeState.multisigSnapshot = fakeMultisigSnapshot({
      members: [fakeMember({ canVote: false }), fakeMember({ publicKey: MEMBER_B })],
    });
    const ctx = makeContext({ store: inMemoryStore() });
    await expect(
      requireSquadsAction('approve_proposal').prepare(
        { multisigAddress: MULTISIG, proposalAddress: PROPOSAL },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('approve rejects when proposal is not active', async () => {
    fakeState.proposalSnapshot = fakeProposalSnapshot({ status: 'approved' });
    const ctx = makeContext({ store: inMemoryStore() });
    await expect(
      requireSquadsAction('approve_proposal').prepare(
        { multisigAddress: MULTISIG, proposalAddress: PROPOSAL },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('reject stores squads_reject_proposal in active state', async () => {
    const ctx = makeContext({ store: inMemoryStore() });
    const result = await requireSquadsAction('reject_proposal').prepare(
      { multisigAddress: MULTISIG, proposalAddress: PROPOSAL, reason: 'wrong recipient' },
      ctx,
    );
    expect(result.addInput.kind).toBe('squads_reject_proposal');
    expect(result.addInput.params).toMatchObject({ operation: 'reject', reason: 'wrong recipient' });
  });

  it('cancel requires the proposal to be approved', async () => {
    const ctx = makeContext({ store: inMemoryStore() });
    await expect(
      requireSquadsAction('cancel_proposal').prepare(
        { multisigAddress: MULTISIG, proposalAddress: PROPOSAL },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('cancel succeeds when proposal status is approved', async () => {
    fakeState.proposalSnapshot = fakeProposalSnapshot({ status: 'approved', approvalCount: 2 });
    const ctx = makeContext({ store: inMemoryStore() });
    const result = await requireSquadsAction('cancel_proposal').prepare(
      { multisigAddress: MULTISIG, proposalAddress: PROPOSAL },
      ctx,
    );
    expect(result.addInput.kind).toBe('squads_cancel_proposal');
  });
});

describe('Squads execute proposal', () => {
  let fakeState: FakeSquadsState;

  beforeEach(() => {
    fakeState = {
      multisigSnapshot: fakeMultisigSnapshot(),
      vaultSnapshot: fakeVaultSnapshot(),
      proposalSnapshot: fakeProposalSnapshot({ status: 'approved', approvalCount: 2 }),
      walletAuthority: fakeWalletAuthority(),
      createCalls: [],
      voteCalls: [],
      executeCalls: [],
    };
    setSquadsMultisigClientFactory(() => buildFakeSquads(fakeState));
  });

  it('prepare stores squads_execute_proposal when threshold met and time-lock elapsed', async () => {
    const ctx = makeContext({ store: inMemoryStore() });
    const result = await requireSquadsAction('execute_proposal').prepare(
      { multisigAddress: MULTISIG, proposalAddress: PROPOSAL },
      ctx,
    );
    expect(result.addInput.kind).toBe('squads_execute_proposal');
    expect(result.addInput.summary).toBe('Execute Squads proposal #5');
    expect(result.addInput.params).toMatchObject({
      operation: 'execute',
      threshold: 2,
      approvalCount: 2,
      proposalStatus: 'approved',
      refreshAtExecution: true,
    });
  });

  it('rejects when wallet has no execute permission', async () => {
    fakeState.multisigSnapshot = fakeMultisigSnapshot({
      members: [fakeMember({ canExecute: false }), fakeMember({ publicKey: MEMBER_B })],
    });
    const ctx = makeContext({ store: inMemoryStore() });
    await expect(
      requireSquadsAction('execute_proposal').prepare(
        { multisigAddress: MULTISIG, proposalAddress: PROPOSAL },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('rejects when proposal status is not approved', async () => {
    fakeState.proposalSnapshot = fakeProposalSnapshot({ status: 'active' });
    const ctx = makeContext({ store: inMemoryStore() });
    await expect(
      requireSquadsAction('execute_proposal').prepare(
        { multisigAddress: MULTISIG, proposalAddress: PROPOSAL },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('rejects when threshold is not met', async () => {
    fakeState.proposalSnapshot = fakeProposalSnapshot({ status: 'approved', approvalCount: 1 });
    const ctx = makeContext({ store: inMemoryStore() });
    await expect(
      requireSquadsAction('execute_proposal').prepare(
        { multisigAddress: MULTISIG, proposalAddress: PROPOSAL },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('rejects when time-lock has not elapsed', async () => {
    fakeState.proposalSnapshot = fakeProposalSnapshot({
      status: 'approved',
      approvalCount: 2,
      lockoutExpiresAt: Date.now() + 60_000,
      executableAt: Date.now() + 60_000,
    });
    const ctx = makeContext({ store: inMemoryStore() });
    await expect(
      requireSquadsAction('execute_proposal').prepare(
        { multisigAddress: MULTISIG, proposalAddress: PROPOSAL },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('execute path rejects when proposal state changed between prepare and execute', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const prepared = await requireSquadsAction('execute_proposal').prepare(
      { multisigAddress: MULTISIG, proposalAddress: PROPOSAL },
      ctx,
    );
    const action = await store.addAction(prepared.addInput);
    fakeState.proposalSnapshot = fakeProposalSnapshot({ status: 'cancelled', approvalCount: 2 });
    await expect(
      requireSquadsAction('execute_proposal').execute(action, ctx),
    ).rejects.toThrowError(/Cannot execute|status changed|invalid_request/);
  });

  it('execute calls signAndBroadcast with the built transaction and returns a txid', async () => {
    const store = inMemoryStore();
    const signedCalls: Array<{ summary: string; transactionBase64: string }> = [];
    const ctx = makeContext({
      store,
      signed: async (transactionBase64, summary) => {
        signedCalls.push({ transactionBase64, summary });
        return 'broadcasted-squads-execute';
      },
    });
    const prepared = await requireSquadsAction('execute_proposal').prepare(
      { multisigAddress: MULTISIG, proposalAddress: PROPOSAL },
      ctx,
    );
    const action = await store.addAction(prepared.addInput);
    const result = await requireSquadsAction('execute_proposal').execute(action, ctx);
    expect(result.txid).toBe('broadcasted-squads-execute');
    expect(signedCalls[0]?.transactionBase64).toBe('BASE64_EXECUTE_PROPOSAL');
    expect(signedCalls[0]?.summary).toContain('Execute Squads proposal');
    expect(fakeState.executeCalls).toHaveLength(1);
  });
});

describe('Squads instruction decoder', () => {
  it('decodes a SOL transfer', () => {
    const data = new Uint8Array(12);
    // SystemInstruction::Transfer opcode = 2
    data[0] = 0x02;
    // lamports = 500_000_000 LE 64
    const lamports = 500_000_000n;
    for (let i = 0; i < 8; i += 1) data[4 + i] = Number((lamports >> BigInt(i * 8)) & 0xffn);
    const decoded = decodeInstructionPreview([
      { programId: '11111111111111111111111111111111', data, accounts: [VAULT, RECIPIENT] },
    ]);
    expect(decoded[0]?.kind).toBe('sol_transfer');
    expect(decoded[0]?.riskTier).toBe('transfer');
    expect((decoded[0]?.detail as { lamports: string }).lamports).toBe('500000000');
  });

  it('decodes an SPL transferChecked', () => {
    const data = new Uint8Array(10);
    data[0] = 12; // TransferChecked
    const amount = 100_000_000n;
    for (let i = 0; i < 8; i += 1) data[1 + i] = Number((amount >> BigInt(i * 8)) & 0xffn);
    data[9] = 6; // decimals
    const decoded = decodeInstructionPreview([
      {
        programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        data,
        accounts: [VAULT, USDC_MINT, RECIPIENT, WALLET],
      },
    ]);
    expect(decoded[0]?.kind).toBe('spl_transfer_checked');
    expect(decoded[0]?.riskTier).toBe('transfer');
    expect((decoded[0]?.detail as { decimals: number }).decimals).toBe(6);
  });

  it('decodes a memo program payload as text', () => {
    const memoText = 'invoice-42';
    const data = new TextEncoder().encode(memoText);
    const decoded = decodeInstructionPreview([
      { programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', data, accounts: [WALLET] },
    ]);
    expect(decoded[0]?.kind).toBe('memo');
    expect((decoded[0]?.detail as { text: string }).text).toBe(memoText);
  });

  it('returns kind: unknown with a warning for an undecodable instruction', () => {
    const decoded = decodeInstructionPreview([
      {
        programId: 'UnknownProgram11111111111111111111111111111',
        data: new Uint8Array([0xab, 0xcd, 0xef]),
        accounts: [],
      },
    ]);
    expect(decoded[0]?.kind).toBe('unknown');
    expect(decoded[0]?.riskTier).toBe('unknown');
    expect(decoded[0]?.warning).toBeDefined();
  });
});
