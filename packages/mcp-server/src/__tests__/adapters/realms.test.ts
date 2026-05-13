import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  REALMS_ADAPTER_ID,
  REALMS_SUPPORTED_CLUSTERS,
  realmsAdapter,
} from '../../adapters/realms/index.js';
import {
  resetRealmsClientFactory,
  setRealmsClientFactory,
  type ProposalListEntry,
  type ProposalSnapshot,
  type RealmSnapshot,
  type RealmsBuildCastVoteResult,
  type RealmsBuildDepositResult,
  type RealmsBuildRelinquishVoteResult,
  type RealmsBuildWithdrawResult,
  type RealmsClient,
  type VoteRecordSnapshot,
  type WalletGovernanceSnapshot,
} from '../../adapters/realms/client.js';
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
const REALM = '4Ge5Lz4eyEYpoxxRGfg4S2zPgQH7vXxQjU9JL2KkH8sd';
const GOVERNANCE = '8mfu8eJWj9Q6ATe5g78ZBz2Y7VfkFa3JpDz3CkPe3ZCK';
const PROPOSAL = '7N6h2RhBJZS2qE5HxPexSY8Qg4Q4f4wPjCWj4mE4uXqZ';
const COMMUNITY_MINT = 'CmtY1qF3Wj5L8q8tAjXJZqV5xPYxFKKf9R8t6XU3xN8K';
const COUNCIL_MINT = 'CcLn7gB6JJ4dRXG1bzdh2qDpA1WVbR6P8YqEYRJp9HfY';
const VOTE_RECORD = 'VRRu2WqVxFwUtKkUtVBNW8sGE1Z3jVRsETKZeS6Y6w7H';

class FakeBackend {
  async getAddress(): Promise<string> {
    return WALLET;
  }
  async capabilities(): Promise<{ address: string }> {
    return { address: WALLET };
  }
}

interface FakeRealmsState {
  realmSnapshot: RealmSnapshot;
  proposalSnapshot: ProposalSnapshot;
  proposalList: ProposalListEntry[];
  walletGovernance: WalletGovernanceSnapshot[];
  voteRecord: VoteRecordSnapshot | null;
  castVoteCalls: Array<{
    walletAddress: string;
    proposalAddress: string;
    governingTokenMint: string;
    voteKind: string;
    choiceIndex?: number;
  }>;
  relinquishCalls: Array<{ walletAddress: string; proposalAddress: string }>;
  depositCalls: Array<{ walletAddress: string; realmAddress: string; amountRaw: bigint }>;
  withdrawCalls: Array<{
    walletAddress: string;
    realmAddress: string;
    governingTokenMint: string;
    amountRaw?: bigint;
    withdrawAll: boolean;
  }>;
}

function buildFakeRealms(state: FakeRealmsState): RealmsClient {
  return {
    async getRealmSnapshot() {
      return state.realmSnapshot;
    },
    async getGovernanceSnapshot() {
      return {
        governanceAddress: GOVERNANCE,
        realmAddress: REALM,
        governedAccount: 'GovernedAcct1111111111111111111111111111111',
        voteThresholdType: 'YesVotePercentage',
        voteThresholdPct: 60,
        votingBaseSec: 60 * 60 * 24 * 3,
        votingCoolOffSec: 60 * 60 * 24,
        proposals: [],
        asOfSlot: 280_000_000,
      };
    },
    async getProposalList() {
      return state.proposalList;
    },
    async getProposalSnapshot() {
      return state.proposalSnapshot;
    },
    async getVoteRecord() {
      return state.voteRecord;
    },
    async getWalletGovernance() {
      return state.walletGovernance;
    },
    async buildCastVoteTransaction(_connection, input): Promise<RealmsBuildCastVoteResult> {
      state.castVoteCalls.push(input);
      return {
        transactionBase64: 'BASE64_CAST_VOTE_PLACEHOLDER',
        proposalAddress: state.proposalSnapshot.proposalAddress,
        realmAddress: state.proposalSnapshot.realmAddress,
        governanceAddress: state.proposalSnapshot.governanceAddress,
        governingTokenMint: input.governingTokenMint,
        voteKind: input.voteKind,
        ...(input.choiceIndex !== undefined && { choiceIndex: input.choiceIndex }),
        proposalName: state.proposalSnapshot.name,
        postWalletWeight: state.walletGovernance[0]?.tokenOwnerRecord.governingTokenDepositAmount ?? '0',
      };
    },
    async buildRelinquishVoteTransaction(_connection, input): Promise<RealmsBuildRelinquishVoteResult> {
      state.relinquishCalls.push(input);
      return {
        transactionBase64: 'BASE64_RELINQUISH_PLACEHOLDER',
        proposalAddress: state.proposalSnapshot.proposalAddress,
        realmAddress: state.proposalSnapshot.realmAddress,
        governanceAddress: state.proposalSnapshot.governanceAddress,
        governingTokenMint: input.governingTokenMint,
        proposalName: state.proposalSnapshot.name,
        isFinalized: state.proposalSnapshot.state !== 'voting',
      };
    },
    async buildDepositGovernanceTokensTransaction(_connection, input): Promise<RealmsBuildDepositResult> {
      state.depositCalls.push(input);
      return {
        transactionBase64: 'BASE64_DEPOSIT_PLACEHOLDER',
        realmAddress: state.realmSnapshot.realmAddress,
        realmName: state.realmSnapshot.name,
        governingTokenMint: input.governingTokenMint,
        amountRaw: input.amountRaw.toString(),
        amountUi: (Number(input.amountRaw) / 10 ** state.realmSnapshot.communityMintDecimals).toString(),
        mintDecimals: state.realmSnapshot.communityMintDecimals,
      };
    },
    async buildWithdrawGovernanceTokensTransaction(_connection, input): Promise<RealmsBuildWithdrawResult> {
      state.withdrawCalls.push(input);
      return {
        transactionBase64: 'BASE64_WITHDRAW_PLACEHOLDER',
        realmAddress: state.realmSnapshot.realmAddress,
        realmName: state.realmSnapshot.name,
        governingTokenMint: input.governingTokenMint,
        amountRaw: (input.amountRaw ?? 0n).toString(),
        amountUi: input.amountRaw
          ? (Number(input.amountRaw) / 10 ** state.realmSnapshot.communityMintDecimals).toString()
          : '0',
        mintDecimals: state.realmSnapshot.communityMintDecimals,
        withdrawAll: input.withdrawAll,
      };
    },
  };
}

function fakeRealmSnapshot(overrides: Partial<RealmSnapshot> = {}): RealmSnapshot {
  return {
    realmAddress: REALM,
    realmConfigAddress: 'RealmCfg1111111111111111111111111111111111',
    name: 'Demo DAO',
    communityMint: COMMUNITY_MINT,
    communityMintDecimals: 6,
    councilMint: COUNCIL_MINT,
    councilMintDecimals: 0,
    governances: [],
    pluginsDetected: false,
    pluginNames: [],
    asOfSlot: 280_000_000,
    ...overrides,
  };
}

function fakeProposalSnapshot(overrides: Partial<ProposalSnapshot> = {}): ProposalSnapshot {
  return {
    proposalAddress: PROPOSAL,
    realmAddress: REALM,
    governanceAddress: GOVERNANCE,
    governingTokenMint: COMMUNITY_MINT,
    name: 'Treasury Allocation Q1',
    state: 'voting',
    voteType: 'single_choice',
    choices: [{ index: 0, label: 'Approve', weight: '0', tipped: false }],
    voteTally: { yes: '500', no: '100', abstain: '0', veto: '0' },
    votingAt: Math.floor(Date.now() / 1000) - 60 * 60,
    votingExpiresAt: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
    inCoolOff: false,
    rawInstructions: [],
    pluginsDetected: false,
    pluginNames: [],
    asOfSlot: 280_000_000,
    ...overrides,
  };
}

function fakeWalletGovernance(
  overrides: Partial<WalletGovernanceSnapshot> = {},
): WalletGovernanceSnapshot {
  return {
    walletAddress: WALLET,
    realmAddress: REALM,
    realmName: 'Demo DAO',
    governingTokenMint: COMMUNITY_MINT,
    mintRole: 'community',
    tokenOwnerRecord: {
      recordAddress: 'TorAddr111111111111111111111111111111111111',
      governingTokenDepositAmount: '1000000',
      outstandingProposalCount: 0,
      unrelinquishedVotesCount: 0,
    },
    votingPower: { raw: '1000000', pluginAffected: false },
    pluginsDetected: false,
    pluginNames: [],
    asOfSlot: 280_000_000,
    ...overrides,
  };
}

function fakeVoteRecord(overrides: Partial<VoteRecordSnapshot> = {}): VoteRecordSnapshot {
  return {
    recordAddress: VOTE_RECORD,
    proposalAddress: PROPOSAL,
    walletAddress: WALLET,
    governingTokenMint: COMMUNITY_MINT,
    voteKind: 'approve',
    weight: '1000000',
    isRelinquished: false,
    asOfSlot: 280_000_000,
    ...overrides,
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
    signAndBroadcast: opts.signed ?? (async () => 'TxidPlaceholderForRealmsTests111111111111'),
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
  resetRealmsClientFactory();
});

function requireRealmsAction(
  id:
    | 'cast_vote'
    | 'relinquish_vote'
    | 'deposit_governance_tokens'
    | 'withdraw_governance_tokens',
) {
  const action = realmsAdapter.actions[id];
  if (!action) throw new Error(`Realms adapter is missing action ${id}.`);
  return action;
}

function freshState(overrides?: Partial<FakeRealmsState>): FakeRealmsState {
  return {
    realmSnapshot: fakeRealmSnapshot(),
    proposalSnapshot: fakeProposalSnapshot(),
    proposalList: [],
    walletGovernance: [fakeWalletGovernance()],
    voteRecord: null,
    castVoteCalls: [],
    relinquishCalls: [],
    depositCalls: [],
    withdrawCalls: [],
    ...overrides,
  };
}

describe('Realms adapter shape', () => {
  it('registers with expected id, mainnet gating, four actions, six reads', () => {
    expect(realmsAdapter.id).toBe(REALMS_ADAPTER_ID);
    expect(realmsAdapter.supportedClusters).toEqual(REALMS_SUPPORTED_CLUSTERS);
    expect(Object.keys(realmsAdapter.actions).sort()).toEqual([
      'cast_vote',
      'deposit_governance_tokens',
      'relinquish_vote',
      'withdraw_governance_tokens',
    ]);
    expect(Object.keys(realmsAdapter.reads).sort()).toEqual([
      'governance_snapshot',
      'proposal_list',
      'proposal_snapshot',
      'realm_snapshot',
      'vote_record',
      'wallet_governance',
    ]);
  });

  it('is discoverable via the adapter registry', () => {
    expect(requireAdapter('realms').id).toBe('realms');
    expect(adapterForActionKind('realms_cast_vote')?.id).toBe('realms');
    expect(actionForKind('realms_relinquish_vote')?.action.id).toBe('relinquish_vote');
    expect(actionForKind('realms_deposit_governance_tokens')?.action.id).toBe(
      'deposit_governance_tokens',
    );
    expect(actionForKind('realms_withdraw_governance_tokens')?.action.id).toBe(
      'withdraw_governance_tokens',
    );
  });

  it('throws AdapterError on cluster mismatch via assertSupportedCluster', () => {
    expect(() => assertSupportedCluster(realmsAdapter, 'devnet')).toThrowError(AdapterError);
    expect(() => assertSupportedCluster(realmsAdapter, 'mainnet-beta')).not.toThrow();
  });
});

describe('Realms adapter SDK unavailable', () => {
  it('throws a clear error when no factory is wired and a prepare runs', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireRealmsAction('cast_vote').prepare({ proposalAddress: PROPOSAL, vote: 'approve' }, ctx),
    ).rejects.toThrowError(/Realms adapter is not configured/);
  });
});

describe('Realms cast vote prepare', () => {
  let state: FakeRealmsState;

  beforeEach(() => {
    state = freshState();
    setRealmsClientFactory(() => buildFakeRealms(state));
  });

  it('prepare enriches params and stores realms_cast_vote action', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const result = await requireRealmsAction('cast_vote').prepare(
      { proposalAddress: PROPOSAL, vote: 'approve' },
      ctx,
    );
    expect(result.addInput.kind).toBe('realms_cast_vote');
    expect(result.addInput.params).toMatchObject({
      adapter: 'realms',
      proposalAddress: PROPOSAL,
      realmAddress: REALM,
      governanceAddress: GOVERNANCE,
      governingTokenMint: COMMUNITY_MINT,
      voteKind: 'approve',
      proposalStateAtPrepare: 'voting',
      pluginsDetectedAtPrepare: false,
      voteRecordExistedAtPrepare: false,
      walletWeightAtPrepare: '1000000',
      refreshAtExecution: true,
    });
  });

  it('rejects when proposal is not in voting state', async () => {
    state.proposalSnapshot = fakeProposalSnapshot({ state: 'completed' });
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireRealmsAction('cast_vote').prepare({ proposalAddress: PROPOSAL, vote: 'approve' }, ctx),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('rejects when wallet has zero voting power', async () => {
    state.walletGovernance = [
      fakeWalletGovernance({
        tokenOwnerRecord: {
          recordAddress: 'TorAddr111111111111111111111111111111111111',
          governingTokenDepositAmount: '0',
          outstandingProposalCount: 0,
          unrelinquishedVotesCount: 0,
        },
      }),
    ];
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireRealmsAction('cast_vote').prepare({ proposalAddress: PROPOSAL, vote: 'approve' }, ctx),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('hard-refuses when realm uses a voting power plugin', async () => {
    state.proposalSnapshot = fakeProposalSnapshot({
      pluginsDetected: true,
      pluginNames: ['voter-stake-registry'],
    });
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireRealmsAction('cast_vote').prepare({ proposalAddress: PROPOSAL, vote: 'approve' }, ctx),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('rejects approve during cool-off; accepts deny / abstain', async () => {
    state.proposalSnapshot = fakeProposalSnapshot({
      inCoolOff: true,
      coolOffEndsAt: Math.floor(Date.now() / 1000) + 60 * 60,
    });
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireRealmsAction('cast_vote').prepare({ proposalAddress: PROPOSAL, vote: 'approve' }, ctx),
    ).rejects.toBeInstanceOf(AdapterError);
    const ctx2 = makeContext({ store: inMemoryStore() });
    const result = await requireRealmsAction('cast_vote').prepare(
      { proposalAddress: PROPOSAL, vote: 'deny' },
      ctx2,
    );
    expect(result.addInput.params).toMatchObject({ voteKind: 'deny', inCoolOffAtPrepare: true });
  });

  it('rejects choiceIndex on single-choice proposals', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireRealmsAction('cast_vote').prepare(
        { proposalAddress: PROPOSAL, vote: 'approve', choiceIndex: 1 },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('requires choiceIndex on multi-choice proposals', async () => {
    state.proposalSnapshot = fakeProposalSnapshot({
      voteType: 'multi_choice',
      choices: [
        { index: 0, label: 'A', weight: '0', tipped: false },
        { index: 1, label: 'B', weight: '0', tipped: false },
      ],
    });
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireRealmsAction('cast_vote').prepare({ proposalAddress: PROPOSAL, vote: 'approve' }, ctx),
    ).rejects.toBeInstanceOf(AdapterError);
    const result = await requireRealmsAction('cast_vote').prepare(
      { proposalAddress: PROPOSAL, vote: 'approve', choiceIndex: 1 },
      makeContext({ store: inMemoryStore() }),
    );
    expect(result.addInput.params).toMatchObject({ voteType: 'multi_choice', choiceIndex: 1 });
  });

  it('derives governingTokenMint from the proposal, not from input', async () => {
    state.proposalSnapshot = fakeProposalSnapshot({ governingTokenMint: COUNCIL_MINT });
    state.walletGovernance = [
      fakeWalletGovernance({
        governingTokenMint: COUNCIL_MINT,
        mintRole: 'council',
        tokenOwnerRecord: {
          recordAddress: 'TorCouncilAddr1111111111111111111111111111',
          governingTokenDepositAmount: '5',
          outstandingProposalCount: 0,
          unrelinquishedVotesCount: 0,
        },
      }),
    ];
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const result = await requireRealmsAction('cast_vote').prepare(
      { proposalAddress: PROPOSAL, vote: 'approve' },
      ctx,
    );
    expect(result.addInput.params).toMatchObject({ governingTokenMint: COUNCIL_MINT });
  });

  it('rejects existing non-relinquished vote record', async () => {
    state.voteRecord = fakeVoteRecord();
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireRealmsAction('cast_vote').prepare({ proposalAddress: PROPOSAL, vote: 'approve' }, ctx),
    ).rejects.toBeInstanceOf(AdapterError);
  });
});

describe('Realms cast vote execute', () => {
  let state: FakeRealmsState;

  beforeEach(() => {
    state = freshState();
    setRealmsClientFactory(() => buildFakeRealms(state));
  });

  it('execute calls signAndBroadcast with the rebuilt transaction', async () => {
    const store = inMemoryStore();
    const signedCalls: Array<{ summary: string; transactionBase64: string }> = [];
    const ctx = makeContext({
      store,
      signed: async (transactionBase64, summary) => {
        signedCalls.push({ transactionBase64, summary });
        return 'broadcasted-realms-vote';
      },
    });
    const prepared = await requireRealmsAction('cast_vote').prepare(
      { proposalAddress: PROPOSAL, vote: 'approve' },
      ctx,
    );
    const action = await store.addAction(prepared.addInput);
    const result = await requireRealmsAction('cast_vote').execute(action, ctx);
    expect(result.txid).toBe('broadcasted-realms-vote');
    expect(signedCalls[0]?.transactionBase64).toBe('BASE64_CAST_VOTE_PLACEHOLDER');
    expect(state.castVoteCalls).toHaveLength(1);
    expect(state.castVoteCalls[0]?.voteKind).toBe('approve');
  });

  it('execute refuses when proposal state changed between prepare and execute', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const prepared = await requireRealmsAction('cast_vote').prepare(
      { proposalAddress: PROPOSAL, vote: 'approve' },
      ctx,
    );
    const action = await store.addAction(prepared.addInput);
    state.proposalSnapshot = fakeProposalSnapshot({ state: 'completed' });
    await expect(requireRealmsAction('cast_vote').execute(action, ctx)).rejects.toThrowError(
      /not 'voting'|invalid_request/,
    );
  });
});

describe('Realms relinquish vote', () => {
  let state: FakeRealmsState;

  beforeEach(() => {
    state = freshState({ voteRecord: fakeVoteRecord() });
    setRealmsClientFactory(() => buildFakeRealms(state));
  });

  it('prepare succeeds when an unrelinquished vote record exists', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const result = await requireRealmsAction('relinquish_vote').prepare(
      { proposalAddress: PROPOSAL },
      ctx,
    );
    expect(result.addInput.kind).toBe('realms_relinquish_vote');
    expect(result.addInput.params).toMatchObject({
      proposalAddress: PROPOSAL,
      voteKindAtPrepare: 'approve',
      voteRecordAddress: VOTE_RECORD,
      isFinalizedAtPrepare: false,
    });
  });

  it('prepare rejects when no vote record exists', async () => {
    state.voteRecord = null;
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireRealmsAction('relinquish_vote').prepare({ proposalAddress: PROPOSAL }, ctx),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('prepare rejects when the existing record is already relinquished', async () => {
    state.voteRecord = fakeVoteRecord({ isRelinquished: true });
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireRealmsAction('relinquish_vote').prepare({ proposalAddress: PROPOSAL }, ctx),
    ).rejects.toBeInstanceOf(AdapterError);
  });
});

describe('Realms deposit governance tokens', () => {
  let state: FakeRealmsState;

  beforeEach(() => {
    state = freshState();
    setRealmsClientFactory(() => buildFakeRealms(state));
  });

  it('prepare succeeds for community mint', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const result = await requireRealmsAction('deposit_governance_tokens').prepare(
      { realmAddress: REALM, governingTokenMint: COMMUNITY_MINT, amount: '5' },
      ctx,
    );
    expect(result.addInput.kind).toBe('realms_deposit_governance_tokens');
    expect(result.addInput.params).toMatchObject({
      realmAddress: REALM,
      governingTokenMint: COMMUNITY_MINT,
      governingTokenMintRole: 'community',
      amount: '5',
      amountRaw: (5_000_000n).toString(),
      mintDecimals: 6,
    });
  });

  it('prepare rejects when mint is neither community nor council', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const stranger = 'StrangerMintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    await expect(
      requireRealmsAction('deposit_governance_tokens').prepare(
        { realmAddress: REALM, governingTokenMint: stranger, amount: '1' },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });
});

describe('Realms withdraw governance tokens', () => {
  let state: FakeRealmsState;

  beforeEach(() => {
    state = freshState();
    setRealmsClientFactory(() => buildFakeRealms(state));
  });

  it('prepare rejects when outstandingProposalCount > 0', async () => {
    state.walletGovernance = [
      fakeWalletGovernance({
        tokenOwnerRecord: {
          recordAddress: 'TorAddr111111111111111111111111111111111111',
          governingTokenDepositAmount: '1000000',
          outstandingProposalCount: 1,
          unrelinquishedVotesCount: 0,
        },
      }),
    ];
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireRealmsAction('withdraw_governance_tokens').prepare(
        { realmAddress: REALM, governingTokenMint: COMMUNITY_MINT, amount: '1' },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('prepare rejects when unrelinquishedVotesCount > 0', async () => {
    state.walletGovernance = [
      fakeWalletGovernance({
        tokenOwnerRecord: {
          recordAddress: 'TorAddr111111111111111111111111111111111111',
          governingTokenDepositAmount: '1000000',
          outstandingProposalCount: 0,
          unrelinquishedVotesCount: 2,
        },
      }),
    ];
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireRealmsAction('withdraw_governance_tokens').prepare(
        { realmAddress: REALM, governingTokenMint: COMMUNITY_MINT, amount: '1' },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('prepare rejects when governance delegate is set to a third party', async () => {
    state.walletGovernance = [
      fakeWalletGovernance({
        tokenOwnerRecord: {
          recordAddress: 'TorAddr111111111111111111111111111111111111',
          governingTokenDepositAmount: '1000000',
          outstandingProposalCount: 0,
          unrelinquishedVotesCount: 0,
          governanceDelegate: 'DelegateXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        },
      }),
    ];
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireRealmsAction('withdraw_governance_tokens').prepare(
        { realmAddress: REALM, governingTokenMint: COMMUNITY_MINT, amount: '1' },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('withdrawAll captures the deposited balance at prepare time', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const result = await requireRealmsAction('withdraw_governance_tokens').prepare(
      { realmAddress: REALM, governingTokenMint: COMMUNITY_MINT, withdrawAll: true },
      ctx,
    );
    expect(result.addInput.params).toMatchObject({
      withdrawAll: true,
      amountRaw: '1000000',
      depositedAtPrepare: '1000000',
    });
  });

  it('prepare rejects when amount exceeds deposited balance', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireRealmsAction('withdraw_governance_tokens').prepare(
        { realmAddress: REALM, governingTokenMint: COMMUNITY_MINT, amount: '999' },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });
});
