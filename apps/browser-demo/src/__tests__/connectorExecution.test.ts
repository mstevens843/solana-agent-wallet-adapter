import { describe, expect, it, vi } from 'vitest';

import {
  BROWSER_PROOF_ONLY_KINDS,
  CONNECTOR_APPROVAL_ACTION_TYPES,
  classifyConnectorReceipt,
  connectorExecutionUnsupportedMessage,
  connectorPrepareEndpointAvailable,
  connectorPrepareRouteChain,
  executeBrowserConnectorAction,
  isConnectorApprovalKind,
  isProofOnlyApprovalKind,
  type ConnectorActionExecutionTarget,
  type ConnectorExecutionDeps,
  type ConnectorExecutionToastContext,
  type PreparedTransactionResponse,
} from '../connectorExecution.js';

describe('connectorExecution helpers', () => {
  describe('CONNECTOR_APPROVAL_ACTION_TYPES', () => {
    it('contains representative kinds from every connector family', () => {
      // Lending
      expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('kamino_deposit')).toBe(true);
      expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('kamino_withdraw')).toBe(true);
      expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('marginfi_deposit')).toBe(true);
      expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('save_deposit')).toBe(true);
      expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('lulo_deposit')).toBe(true);
      // LST / staking
      expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('marinade_liquid_stake')).toBe(true);
      expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('jito_stake_sol')).toBe(true);
      expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('sanctum_stake_sol_to_lst')).toBe(true);
      // DEX / LP
      expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('meteora_add_liquidity')).toBe(true);
      expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('orca_increase_liquidity')).toBe(true);
      expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('raydium_add_liquidity')).toBe(true);
      // NFT marketplaces (sub-action covered by params, not kind)
      expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('magiceden_bid')).toBe(true);
      expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('tensor_bid')).toBe(true);
      // Governance / multisig
      expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('squads_create_transfer_proposal')).toBe(true);
      expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('realms_cast_vote')).toBe(true);
      // Bridges / oracles
      expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('wormhole_transfer')).toBe(true);
      expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('pyth_post_price_update')).toBe(true);
    });

    it('excludes generic browser-native kinds and the bare swap kind', () => {
      expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('transfer_sol')).toBe(false);
      expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('transfer_spl')).toBe(false);
      expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('custom_transaction')).toBe(false);
      expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('manual_review')).toBe(false);
      expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('read_only')).toBe(false);
      expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('swap')).toBe(false);
    });
  });

  describe('BROWSER_PROOF_ONLY_KINDS', () => {
    it('only contains audit-only / non-execution kinds', () => {
      expect(BROWSER_PROOF_ONLY_KINDS.has('manual_review')).toBe(true);
      expect(BROWSER_PROOF_ONLY_KINDS.has('read_only')).toBe(true);
      expect(BROWSER_PROOF_ONLY_KINDS.has('custom')).toBe(true);
    });

    it('never overlaps with connector kinds (no kind is both)', () => {
      for (const kind of BROWSER_PROOF_ONLY_KINDS) {
        expect(CONNECTOR_APPROVAL_ACTION_TYPES.has(kind)).toBe(false);
      }
    });

    it('does not include real-execution kinds', () => {
      expect(BROWSER_PROOF_ONLY_KINDS.has('transfer_sol')).toBe(false);
      expect(BROWSER_PROOF_ONLY_KINDS.has('swap')).toBe(false);
      expect(BROWSER_PROOF_ONLY_KINDS.has('kamino_deposit')).toBe(false);
    });
  });

  describe('isConnectorApprovalKind', () => {
    it('returns true for connector action kinds', () => {
      expect(isConnectorApprovalKind({ kind: 'kamino_deposit' })).toBe(true);
      expect(isConnectorApprovalKind({ kind: 'magiceden_bid' })).toBe(true);
      expect(isConnectorApprovalKind({ kind: 'jito_unstake_jitosol' })).toBe(true);
    });

    it('returns false for browser-native kinds', () => {
      expect(isConnectorApprovalKind({ kind: 'transfer_sol' })).toBe(false);
      expect(isConnectorApprovalKind({ kind: 'transfer_spl' })).toBe(false);
      expect(isConnectorApprovalKind({ kind: 'swap' })).toBe(false);
      expect(isConnectorApprovalKind({ kind: 'manual_review' })).toBe(false);
    });

    it('returns false for unknown kinds', () => {
      expect(isConnectorApprovalKind({ kind: 'not_a_real_kind' })).toBe(false);
      expect(isConnectorApprovalKind({ kind: '' })).toBe(false);
    });
  });

  describe('isProofOnlyApprovalKind', () => {
    it('returns true only for explicit audit-only kinds', () => {
      expect(isProofOnlyApprovalKind({ kind: 'manual_review' })).toBe(true);
      expect(isProofOnlyApprovalKind({ kind: 'read_only' })).toBe(true);
      expect(isProofOnlyApprovalKind({ kind: 'kamino_deposit' })).toBe(false);
      expect(isProofOnlyApprovalKind({ kind: 'transfer_sol' })).toBe(false);
    });
  });

  describe('connectorExecutionUnsupportedMessage', () => {
    it('humanizes the kind and explains the wallet capability constraint', () => {
      const message = connectorExecutionUnsupportedMessage({ kind: 'kamino_deposit' });
      expect(message).toContain('kamino deposit');
      expect(message.toLowerCase()).toContain('transaction signing');
      expect(message).not.toMatch(/kamino_deposit/);
    });

    it('works for sub-action-bearing kinds like magiceden_bid', () => {
      const message = connectorExecutionUnsupportedMessage({ kind: 'magiceden_bid' });
      expect(message).toContain('magiceden bid');
    });
  });

  describe('connectorPrepareEndpointAvailable', () => {
    it('is true when the local bridge is active', () => {
      expect(connectorPrepareEndpointAvailable({ bridgeActive: true, cloudSessionMatchesWallet: false })).toBe(true);
    });

    it('is true when the cloud session matches the connected wallet', () => {
      expect(connectorPrepareEndpointAvailable({ bridgeActive: false, cloudSessionMatchesWallet: true })).toBe(true);
    });

    it('is false in pure browser-workflow mode (no bridge, no cloud)', () => {
      expect(connectorPrepareEndpointAvailable({ bridgeActive: false, cloudSessionMatchesWallet: false })).toBe(false);
    });
  });

  describe('connectorPrepareRouteChain — Approve never depends on sign-in', () => {
    // The Approve button must never be bound to AI Bridge, Agentic Cloud, or any session.
    // The wallet signs locally either way; the prepare endpoint just produces unsigned tx
    // bytes. The chain orders routes from most-private (local bridge) to most-available
    // (public cloud) and the dispatcher falls through to the next route on error.
    const target = (overrides: Partial<ConnectorActionExecutionTarget> = {}): ConnectorActionExecutionTarget => ({
      id: 'browser-action_abc123',
      kind: 'kamino_deposit',
      cluster: 'mainnet-beta',
      walletAddress: 'Wallet111',
      workflowSource: 'browser',
      ...overrides,
    });

    it('browser-workflow + bridge active: prefer local bridge stateless, fall back to cloud stateless', () => {
      const chain = connectorPrepareRouteChain(target({ workflowSource: 'browser' }), { bridgeActive: true, cloudSessionMatchesWallet: false });
      expect(chain.map((route) => route.kind)).toEqual(['bridge-stateless', 'cloud-stateless']);
    });

    it('browser-workflow + bridge active + cloud signed-in: cloud session is irrelevant; bridge still goes first', () => {
      const chain = connectorPrepareRouteChain(target({ workflowSource: 'browser' }), { bridgeActive: true, cloudSessionMatchesWallet: true });
      expect(chain.map((route) => route.kind)).toEqual(['bridge-stateless', 'cloud-stateless']);
    });

    it('browser-workflow + no bridge: public cloud stateless is the only stop — no sign-in required', () => {
      const chain = connectorPrepareRouteChain(target({ workflowSource: 'browser' }), { bridgeActive: false, cloudSessionMatchesWallet: false });
      expect(chain.map((route) => route.kind)).toEqual(['cloud-stateless']);
    });

    it('local-bridge action + bridge active: try the stored-action endpoint first, then bridge stateless, then cloud stateless', () => {
      const chain = connectorPrepareRouteChain(target({ workflowSource: 'local-bridge' }), { bridgeActive: true, cloudSessionMatchesWallet: false });
      expect(chain.map((route) => route.kind)).toEqual(['bridge', 'bridge-stateless', 'cloud-stateless']);
    });

    it('local-bridge action + bridge offline: cloud stateless rebuilds tx from kind+params (no cloud sign-in needed)', () => {
      const chain = connectorPrepareRouteChain(target({ workflowSource: 'local-bridge' }), { bridgeActive: false, cloudSessionMatchesWallet: false });
      expect(chain.map((route) => route.kind)).toEqual(['cloud-stateless']);
    });

    it('cloud-stored action + cloud session matches: stored-approval endpoint first, public fallback if it errors', () => {
      const chain = connectorPrepareRouteChain(target({ workflowSource: 'cloud' }), { bridgeActive: false, cloudSessionMatchesWallet: true });
      expect(chain.map((route) => route.kind)).toEqual(['cloud-approval', 'cloud-stateless']);
    });

    it('cloud-stored action + cloud session missing: public stateless still rebuilds the tx (no sign-in required)', () => {
      const chain = connectorPrepareRouteChain(target({ workflowSource: 'cloud' }), { bridgeActive: false, cloudSessionMatchesWallet: false });
      expect(chain.map((route) => route.kind)).toEqual(['cloud-stateless']);
    });
  });

  describe('classifyConnectorReceipt — Done tab honesty', () => {
    it('marks receipts with a txid as transaction_submitted', () => {
      expect(classifyConnectorReceipt({ kind: 'kamino_deposit', txid: '5xYz...' })).toBe('transaction_submitted');
      expect(classifyConnectorReceipt({ kind: 'transfer_sol', txid: 'abc', proofSignature: 'sig' })).toBe('transaction_submitted');
    });

    it('marks proof-only audit kinds with only a proofSignature as decision_proof_only', () => {
      expect(classifyConnectorReceipt({ kind: 'manual_review', proofSignature: 'sig' })).toBe('decision_proof_only');
      expect(classifyConnectorReceipt({ kind: 'read_only', proofSignature: 'sig' })).toBe('decision_proof_only');
    });

    it('flags connector receipts that have only a proof (no txid) as unsubmitted_connector — the legacy bug surface', () => {
      // This is the exact shape the legacy "Sign approval proof" path produced for a Kamino deposit:
      // a proofSignature only, no txid. We want the Done tab to call that out instead of pretending it succeeded.
      expect(classifyConnectorReceipt({ kind: 'kamino_deposit', proofSignature: 'sig' })).toBe('unsubmitted_connector');
      expect(classifyConnectorReceipt({ kind: 'magiceden_bid', proofSignature: 'sig' })).toBe('unsubmitted_connector');
      expect(classifyConnectorReceipt({ kind: 'squads_approve_proposal', proofSignature: 'sig' })).toBe('unsubmitted_connector');
    });

    it('returns unknown when neither signal is present', () => {
      expect(classifyConnectorReceipt({ kind: 'kamino_deposit' })).toBe('unknown');
      expect(classifyConnectorReceipt({ kind: 'transfer_sol', txid: '', proofSignature: '' })).toBe('unknown');
    });
  });
});

describe('connectorExecution — recurring occurrences', () => {
  // Recurring schedules with actionKind 'connector' (e.g., recurring Kamino deposit) generate
  // PreparedAction occurrences when due. For the cloud and local-bridge paths the occurrence is
  // produced server-side with the real connector kind (e.g., 'kamino_deposit') and will hit the
  // Phase D1 safety stop the same way a one-time approval does.
  //
  // The browser-workflow path in `browserOccurrenceFromRecurring` (apps/browser-demo/src/main.ts)
  // currently hardcodes occurrence.kind to 'swap'/'transfer_sol'/'transfer_spl' based on the
  // payment shape and does NOT branch on actionKind === 'connector'. That is a separate, pre-
  // existing gap (browser-workflow recurring connector schedules fall through to a transfer kind
  // and silently execute as a transfer). This test documents the expected behavior once that
  // browser builder is fixed: a connector-kinded occurrence MUST be recognized by isConnector-
  // ApprovalKind so D1 / future-D2 dispatch handles it correctly.
  it('recognizes recurring occurrences whose kind is a connector action type', () => {
    expect(isConnectorApprovalKind({ kind: 'kamino_deposit' })).toBe(true);
    expect(isConnectorApprovalKind({ kind: 'marginfi_deposit' })).toBe(true);
  });

  it('does NOT misclassify swap/transfer recurring occurrences as connector actions', () => {
    expect(isConnectorApprovalKind({ kind: 'swap' })).toBe(false);
    expect(isConnectorApprovalKind({ kind: 'transfer_sol' })).toBe(false);
    expect(isConnectorApprovalKind({ kind: 'transfer_spl' })).toBe(false);
  });
});

describe('executeBrowserConnectorAction — Phase D2 dispatcher', () => {
  function makeAction(overrides: Partial<ConnectorActionExecutionTarget> = {}): ConnectorActionExecutionTarget {
    return {
      id: 'browser-action_abc123',
      kind: 'kamino_deposit',
      cluster: 'mainnet-beta',
      walletAddress: 'Wallet111',
      workflowSource: 'local-bridge',
      ...overrides,
    };
  }

  function makeToastContext(): ConnectorExecutionToastContext {
    return { toastId: 1, cluster: 'mainnet-beta', actionId: 'browser-action_abc123' };
  }

  function makeDeps(
    response: Partial<PreparedTransactionResponse> = {},
    overrides: Partial<ConnectorExecutionDeps<ConnectorActionExecutionTarget>> = {},
  ): ConnectorExecutionDeps<ConnectorActionExecutionTarget> {
    const payload: PreparedTransactionResponse = {
      transactionBase64: 'AAAA-base64-fixture',
      summary: 'Deposit 0.01 SOL into Kamino',
      cluster: 'mainnet-beta',
      ...response,
    };
    return {
      cloudRequest: vi.fn(async () => payload as never),
      bridgeRequest: vi.fn(async () => payload as never),
      signAndBroadcast: vi.fn(async () => 'tx-signature-1'),
      resolveStatus: vi.fn(async () => 'confirmed'),
      capabilitiesSupportSignTransaction: vi.fn(() => true),
      explorerUrl: vi.fn((txid, cluster) => `https://solscan.io/tx/${txid}?cluster=${cluster}`),
      availability: { bridgeActive: true, cloudSessionMatchesWallet: false },
      ...overrides,
    };
  }

  it('POSTs to /bridge/prepared-actions/:id/prepare-transaction when the action is local-bridge sourced and the bridge is active', async () => {
    const deps = makeDeps({}, { availability: { bridgeActive: true, cloudSessionMatchesWallet: false } });
    const action = makeAction({ workflowSource: 'local-bridge' });
    await executeBrowserConnectorAction(action, makeToastContext(), deps);
    expect(deps.bridgeRequest).toHaveBeenCalledWith(
      `/bridge/prepared-actions/${encodeURIComponent(action.id)}/prepare-transaction`,
      { method: 'POST' },
    );
    expect(deps.cloudRequest).not.toHaveBeenCalled();
  });

  it('POSTs to /api/approvals/:id/prepare-transaction when the action is cloud sourced and cloud session matches', async () => {
    const deps = makeDeps({}, { availability: { bridgeActive: false, cloudSessionMatchesWallet: true } });
    const action = makeAction({ workflowSource: 'cloud' });
    await executeBrowserConnectorAction(action, makeToastContext(), deps);
    expect(deps.cloudRequest).toHaveBeenCalledWith(
      `/api/approvals/${encodeURIComponent(action.id)}/prepare-transaction`,
      { method: 'POST' },
    );
    expect(deps.bridgeRequest).not.toHaveBeenCalled();
  });

  it('signs the returned base64 transaction (not a proof message string)', async () => {
    const deps = makeDeps({ transactionBase64: 'BBBB-real-tx' });
    const action = makeAction();
    await executeBrowserConnectorAction(action, makeToastContext(), deps);
    expect(deps.signAndBroadcast).toHaveBeenCalledWith(
      action,
      'BBBB-real-tx',
      'Deposit 0.01 SOL into Kamino',
      expect.objectContaining({ toastId: 1 }),
    );
  });

  it('returns the txid from signAndBroadcast plus a resolved status and explorer URL', async () => {
    const deps = makeDeps();
    const result = await executeBrowserConnectorAction(makeAction(), makeToastContext(), deps);
    expect(result.txid).toBe('tx-signature-1');
    expect(result.txStatus).toBe('confirmed');
    expect(result.explorerUrl).toContain('tx-signature-1');
    expect(result.explorerUrl).toContain('mainnet-beta');
    expect(deps.resolveStatus).toHaveBeenCalledWith('mainnet-beta', 'tx-signature-1', expect.any(Object));
  });

  it('falls back to the public stateless cloud route when neither bridge nor cloud session is available', async () => {
    const deps = makeDeps({}, { availability: { bridgeActive: false, cloudSessionMatchesWallet: false } });
    const action = makeAction({
      workflowSource: 'browser',
      params: { token: 'SOL', amount: '0.01' },
    });
    await executeBrowserConnectorAction(action, makeToastContext(), deps);
    expect(deps.bridgeRequest).not.toHaveBeenCalled();
    expect(deps.cloudRequest).toHaveBeenCalledWith(
      '/api/connector/prepare-transaction',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"kind":"kamino_deposit"'),
      }),
    );
    const call = (deps.cloudRequest as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call).toBeDefined();
    const init = call?.[1] as { body?: string } | undefined;
    expect(typeof init?.body).toBe('string');
    const body = JSON.parse(init!.body!);
    expect(body).toEqual({
      kind: 'kamino_deposit',
      params: { token: 'SOL', amount: '0.01' },
      walletAddress: 'Wallet111',
      cluster: 'mainnet-beta',
    });
  });

  it('refuses to dispatch a non-connector kind (defensive check)', async () => {
    const deps = makeDeps();
    const action = makeAction({ kind: 'transfer_sol' });
    await expect(executeBrowserConnectorAction(action, makeToastContext(), deps))
      .rejects.toThrow(/non-connector kind/);
    expect(deps.bridgeRequest).not.toHaveBeenCalled();
  });

  it('throws when the wallet cannot sign transactions', async () => {
    const deps = makeDeps({}, { capabilitiesSupportSignTransaction: () => false });
    await expect(executeBrowserConnectorAction(makeAction(), makeToastContext(), deps))
      .rejects.toThrow(/cannot sign connector transactions/);
    expect(deps.bridgeRequest).not.toHaveBeenCalled();
  });

  it('throws when the prepare-transaction response is missing transactionBase64', async () => {
    const deps = makeDeps({ transactionBase64: undefined as unknown as string });
    await expect(executeBrowserConnectorAction(makeAction(), makeToastContext(), deps))
      .rejects.toThrow(/transactionBase64/);
    expect(deps.signAndBroadcast).not.toHaveBeenCalled();
  });

  it('routes browser-source actions to the local bridge stateless endpoint when the bridge is active', async () => {
    // Browser-source actions live only in the user's localStorage. The bridge cannot
    // look them up by ID — but it CAN prepare the tx statelessly from raw kind+params.
    // Prefer the local bridge so Approve-and-send never reaches across to the cloud
    // when a local bridge is online (and never requires a cloud sign-in). Approve and
    // send must work whether or not the user is signed into Agentic Cloud.
    const deps = makeDeps({}, { availability: { bridgeActive: true, cloudSessionMatchesWallet: true } });
    const action = makeAction({
      workflowSource: 'browser',
      params: { token: 'SOL', amount: '0.01' },
    });
    await executeBrowserConnectorAction(action, makeToastContext(), deps);
    expect(deps.cloudRequest).not.toHaveBeenCalled();
    expect(deps.bridgeRequest).toHaveBeenCalledWith(
      '/bridge/connector/prepare-transaction',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"kind":"kamino_deposit"'),
      }),
    );
    const call = (deps.bridgeRequest as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = call?.[1] as { body?: string } | undefined;
    expect(typeof init?.body).toBe('string');
    expect(JSON.parse(init!.body!)).toEqual({
      kind: 'kamino_deposit',
      params: { token: 'SOL', amount: '0.01' },
      walletAddress: 'Wallet111',
      cluster: 'mainnet-beta',
    });
  });

  it('falls back to the public cloud stateless endpoint when the local bridge stateless route errors', async () => {
    // If the local bridge accepts the call but errors (e.g., adapter mismatch on this
    // build), Approve-and-send must still succeed via the public cloud endpoint. The
    // wallet still signs locally; the prepare endpoints only build unsigned tx bytes.
    const deps = makeDeps(
      {},
      {
        availability: { bridgeActive: true, cloudSessionMatchesWallet: false },
        bridgeRequest: vi.fn(async () => {
          throw new Error('bridge stateless preparer failed');
        }),
      },
    );
    const action = makeAction({
      workflowSource: 'browser',
      params: { token: 'SOL', amount: '0.01' },
    });
    await executeBrowserConnectorAction(action, makeToastContext(), deps);
    expect(deps.bridgeRequest).toHaveBeenCalledWith(
      '/bridge/connector/prepare-transaction',
      expect.any(Object),
    );
    expect(deps.cloudRequest).toHaveBeenCalledWith(
      '/api/connector/prepare-transaction',
      expect.any(Object),
    );
  });

  it('uses the stateless cloud route for AI-drafted (workflowSource undefined) actions when there is no bridge', async () => {
    const deps = makeDeps({}, { availability: { bridgeActive: false, cloudSessionMatchesWallet: false } });
    const action = makeAction({
      workflowSource: undefined as unknown as string,
      params: { token: 'USDC', amount: '5' },
    });
    await executeBrowserConnectorAction(action, makeToastContext(), deps);
    expect(deps.cloudRequest).toHaveBeenCalledWith(
      '/api/connector/prepare-transaction',
      expect.any(Object),
    );
  });
});

describe('classifyConnectorReceipt — proofSignature+txid coexistence', () => {
  // A connector approval can be denied (proofSignature only) or approved+executed (txid only).
  // If a receipt somehow ends up with BOTH (e.g., legacy entries that got upgraded), the txid
  // wins for the user-facing outcome — the wallet did, in fact, submit a transaction.
  it('treats txid as authoritative when both proofSignature and txid are present', () => {
    expect(classifyConnectorReceipt({
      kind: 'kamino_deposit',
      txid: 'real-tx',
      proofSignature: 'leftover-proof',
    })).toBe('transaction_submitted');
  });

  it('still marks a connector receipt with only a proof as unsubmitted_connector', () => {
    expect(classifyConnectorReceipt({ kind: 'kamino_deposit', proofSignature: 'proof' }))
      .toBe('unsubmitted_connector');
  });
});
