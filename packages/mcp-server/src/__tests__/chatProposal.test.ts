import { describe, expect, it } from 'vitest';

import { validateChatProposedAction } from '../aiPlanner.js';

// A valid base58 Solana address shape (the wrapped-SOL mint) — used only to
// satisfy the recipient base58 check; the validator only checks format.
const VALID_ADDRESS = 'So11111111111111111111111111111111111111112';

describe('validateChatProposedAction', () => {
  it('accepts a well-formed swap proposal and forces requiresApproval', () => {
    const { proposal, error } = validateChatProposedAction({
      kind: 'swap',
      summary: 'Swap 1 SOL to USDC',
      params: { amount: '1', inputToken: 'SOL', outputToken: 'USDC' },
    });
    expect(error).toBeUndefined();
    expect(proposal?.kind).toBe('swap');
    expect(proposal?.requiresApproval).toBe(true);
  });

  it('rejects a swap whose input and output tokens are identical', () => {
    const { proposal, error } = validateChatProposedAction({
      kind: 'swap',
      summary: 'Swap 1 SOL to SOL',
      params: { amount: '1', inputToken: 'SOL', outputToken: 'SOL' },
    });
    expect(proposal).toBeUndefined();
    expect(error).toMatch(/different/i);
  });

  it('accepts a transfer_sol with a base58 recipient', () => {
    const { proposal, error } = validateChatProposedAction({
      kind: 'transfer_sol',
      summary: 'Send 1 SOL',
      params: { recipient: VALID_ADDRESS, amountSol: '1' },
    });
    expect(error).toBeUndefined();
    expect(proposal?.params.recipient).toBe(VALID_ADDRESS);
  });

  it('rejects an unsupported kind', () => {
    const { proposal, error } = validateChatProposedAction({
      kind: 'stake',
      summary: 'Stake SOL',
      params: {},
    });
    expect(proposal).toBeUndefined();
    expect(error).toMatch(/transfer_sol|swap/);
  });

  it('rejects a missing summary', () => {
    const { error } = validateChatProposedAction({ kind: 'swap', summary: '', params: { amount: '1' } });
    expect(error).toMatch(/summary/i);
  });

  it('rejects a transfer with a non-base58 recipient', () => {
    const { proposal, error } = validateChatProposedAction({
      kind: 'transfer_sol',
      summary: 'Send to bob',
      params: { recipient: 'bob', amountSol: '1' },
    });
    expect(proposal).toBeUndefined();
    expect(error).toMatch(/base58|exact address/i);
  });

  it('rejects a recipient resolved from chat text alone', () => {
    const { proposal, error } = validateChatProposedAction({
      kind: 'transfer_sol',
      summary: 'Send 1 SOL',
      params: { recipient: VALID_ADDRESS, amountSol: '1' },
      resolution: { recipientSource: 'chat_text_alone' },
    });
    expect(proposal).toBeUndefined();
    expect(error).toMatch(/explicit user input/i);
  });

  it('rejects a transfer with no amount', () => {
    const { error } = validateChatProposedAction({
      kind: 'transfer_sol',
      summary: 'Send SOL',
      params: { recipient: VALID_ADDRESS },
    });
    expect(error).toMatch(/amount/i);
  });

  it('rejects a swap with no amount', () => {
    const { error } = validateChatProposedAction({
      kind: 'swap',
      summary: 'Swap',
      params: { inputToken: 'SOL', outputToken: 'USDC' },
    });
    expect(error).toMatch(/amount/i);
  });

  it('accepts a sign_proof with a statement', () => {
    const { proposal, error } = validateChatProposedAction({
      kind: 'sign_proof',
      summary: 'Proof of Q3 review',
      params: { statement: 'I reviewed the Q3 budget on 2026-06-21.' },
    });
    expect(error).toBeUndefined();
    expect(proposal?.kind).toBe('sign_proof');
    expect(proposal?.requiresApproval).toBe(true);
  });

  it('accepts a sign_proof via the message alias', () => {
    const { proposal } = validateChatProposedAction({
      kind: 'sign_proof',
      summary: 'Attestation',
      params: { message: 'I attest to X.' },
    });
    expect(proposal?.kind).toBe('sign_proof');
  });

  it('rejects a sign_proof with no statement', () => {
    const { proposal, error } = validateChatProposedAction({
      kind: 'sign_proof',
      summary: 'Empty proof',
      params: {},
    });
    expect(proposal).toBeUndefined();
    expect(error).toMatch(/statement/i);
  });
});
