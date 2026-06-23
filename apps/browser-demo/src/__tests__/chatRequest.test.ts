import { describe, expect, it } from 'vitest';

import { buildWalletBalanceSnapshot } from '../walletBalanceSummary.js';
import {
  buildAgentChatRequest,
  chatMentionsOwnWallet,
  chatMentionsWalletBalance,
} from '../chatRequest.js';

describe('chat request helper', () => {
  const walletAddress = '4FtqUdd9dhX6oX7hcc4ufXK7BMf85y3s4dqWMMAgent';

  it('keeps wallet identity out of the chat request root', () => {
    const request = buildAgentChatRequest({
      messages: [
        { role: 'user', content: 'What should I check before swapping?' },
      ],
    }, {
      address: walletAddress,
      cluster: 'devnet',
      uiLanguage: 'en',
    });

    expect(request.walletAddress).toBeUndefined();
    expect(request.cluster).toBe('devnet');
    expect(request.context?.browserWallet).toMatchObject({
      connected: true,
      source: 'browser_wallet',
      address: walletAddress,
      cluster: 'devnet',
    });
    expect(request.context?.walletAddress).toBe(walletAddress);
  });

  it('includes a read-only balance summary when it matches the connected browser wallet', () => {
    const snapshot = buildWalletBalanceSnapshot({
      walletAddress,
      cluster: 'devnet',
      solLamports: 6_000_000_000,
      tokenRows: [],
      prices: new Map(),
      coverage: 'primary',
      pricingEnabled: false,
    });

    const request = buildAgentChatRequest({
      messages: [
        { role: 'user', content: 'What is my current SOL balance?' },
      ],
    }, {
      address: walletAddress,
      cluster: 'devnet',
      uiLanguage: 'en',
      walletBalance: snapshot,
    });

    expect(request.walletAddress).toBeUndefined();
    expect(request.context?.walletBalance).toMatchObject({
      walletAddress,
      cluster: 'devnet',
      coverage: 'primary',
      sol: { amount: 6 },
    });
  });

  it('does not attach stale balance summaries for another wallet', () => {
    const snapshot = buildWalletBalanceSnapshot({
      walletAddress: '11111111111111111111111111111111',
      cluster: 'devnet',
      solLamports: 1_000_000_000,
      tokenRows: [],
      prices: new Map(),
      coverage: 'primary',
      pricingEnabled: false,
    });

    const request = buildAgentChatRequest({
      messages: [
        { role: 'user', content: 'What is my current SOL balance?' },
      ],
    }, {
      address: walletAddress,
      cluster: 'devnet',
      uiLanguage: 'en',
      walletBalance: snapshot,
    });

    expect(request.context?.walletBalance).toBeUndefined();
  });

  it('detects wallet balance questions without treating every chat as wallet-scoped', () => {
    expect(chatMentionsWalletBalance({
      messages: [{ role: 'user', content: 'What is my current SOL balance?' }],
    })).toBe(true);
    expect(chatMentionsWalletBalance({
      messages: [{ role: 'user', content: 'Explain slippage before I swap.' }],
    })).toBe(false);
  });

  it('chatMentionsOwnWallet covers balances/holdings AND address/activity, not general questions', () => {
    // own-wallet questions → true (gated when no wallet is connected)
    expect(chatMentionsOwnWallet('what is my balance')).toBe(true);
    expect(chatMentionsOwnWallet('show my holdings')).toBe(true);
    expect(chatMentionsOwnWallet('what is my portfolio worth')).toBe(true);
    expect(chatMentionsOwnWallet('what is my wallet address')).toBe(true);
    expect(chatMentionsOwnWallet('show my recent transactions')).toBe(true);
    expect(chatMentionsOwnWallet('my wallet activity')).toBe(true);
    // general questions → false (still reach the agent without a wallet)
    expect(chatMentionsOwnWallet('what is the price of SOL')).toBe(false);
    expect(chatMentionsOwnWallet('explain slippage before I swap')).toBe(false);
    expect(chatMentionsOwnWallet('what is a token-2022 mint')).toBe(false);
  });
});
