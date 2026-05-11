import { describe, expect, it } from 'vitest';

import {
  type ClassifiedTransactionFailure,
  type TransactionFailureKind,
  classifyTransactionFailure,
  normalizeErrorMessage,
  shouldCheckChainBeforeFailing,
  shouldRetrySignedBroadcast,
  transactionFailureToastCopy,
} from '../transactionFailure.js';

function classify(
  message: string | Error | unknown,
  context: { hasSignedBytes?: boolean; txid?: string } = {},
): ClassifiedTransactionFailure {
  return classifyTransactionFailure(message, context);
}

function expectKind(result: ClassifiedTransactionFailure, kind: TransactionFailureKind): void {
  expect(result.kind).toBe(kind);
}

describe('classifyTransactionFailure — wallet rejected', () => {
  const cases: Array<[string, string]> = [
    ['user rejected', 'User rejected the request.'],
    ['user denied', 'User denied transaction signature.'],
    ['rejected by user', 'Transaction was rejected by user.'],
    ['cancelled', 'Signing was cancelled.'],
    ['canceled', 'Operation canceled in wallet.'],
    ['approval denied', 'Approval denied by wallet.'],
    ['wallet declined', 'Wallet declined the request.'],
    ['request rejected', 'Phantom: request rejected.'],
  ];

  for (const [label, message] of cases) {
    it(`matches "${label}"`, () => {
      const result = classify(message);
      expectKind(result, 'wallet_rejected');
      expect(result.title).toBe('Wallet approval rejected');
      expect(result.retryableSignedBroadcast).toBe(false);
      expect(result.maybeSubmitted).toBe(false);
      expect(result.safeToAskWalletAgain).toBe(true);
      expect(result.shouldCheckChainBeforeFailing).toBe(false);
    });
  }
});

describe('classifyTransactionFailure — wallet unavailable', () => {
  const cases = [
    'Wallet not connected',
    'No wallet selected for this action',
    'Wallet unavailable: install Phantom',
    'Adapter unavailable',
    'Unsupported wallet method',
    'signTransaction not supported',
    'signAndSendTransaction not supported',
  ];

  for (const message of cases) {
    it(`matches "${message}"`, () => {
      const result = classify(message);
      expectKind(result, 'wallet_unavailable');
      expect(result.retryableSignedBroadcast).toBe(false);
      expect(result.maybeSubmitted).toBe(false);
      expect(result.safeToAskWalletAgain).toBe(true);
    });
  }
});

describe('classifyTransactionFailure — config missing', () => {
  const cases = [
    'Missing RPC URL for cluster',
    'Missing Helius endpoint',
    'Missing Jupiter integration token',
    'Missing JUP API key',
    'Missing API key',
    'Transaction execution is not configured.',
    'Unauthorized setup',
    'Environment variable missing: HELIUS_API_KEY',
  ];

  for (const message of cases) {
    it(`matches "${message}"`, () => {
      const result = classify(message);
      expectKind(result, 'config_missing');
      expect(result.title).toBe('Transaction execution not configured');
      expect(result.message).toContain('Add RPC/Jupiter setup');
      expect(result.retryableSignedBroadcast).toBe(false);
      expect(result.safeToAskWalletAgain).toBe(false);
    });
  }
});

describe('classifyTransactionFailure — retryable RPC/network', () => {
  it('classifies fetch timeout without signed bytes as rpc_timeout, retryable, not maybeSubmitted', () => {
    const result = classify('Request timed out after 30000ms');
    expectKind(result, 'rpc_timeout');
    expect(result.retryableSignedBroadcast).toBe(true);
    expect(result.maybeSubmitted).toBe(false);
    expect(result.safeToAskWalletAgain).toBe(false);
    expect(result.shouldCheckChainBeforeFailing).toBe(true);
  });

  it('classifies fetch timeout with signed bytes as ambiguous, maybeSubmitted: true', () => {
    const result = classify('Request timed out after 30000ms', { hasSignedBytes: true });
    expectKind(result, 'rpc_timeout');
    expect(result.maybeSubmitted).toBe(true);
    expect(result.retryableSignedBroadcast).toBe(true);
    expect(result.safeToAskWalletAgain).toBe(false);
    expect(result.shouldCheckChainBeforeFailing).toBe(true);
    expect(result.title).toBe('Submitted status unknown');
  });

  it('classifies Failed to fetch as network_unreachable', () => {
    const result = classify('TypeError: Failed to fetch');
    expectKind(result, 'network_unreachable');
    expect(result.retryableSignedBroadcast).toBe(true);
  });

  it('classifies ECONNRESET as network_unreachable', () => {
    const result = classify('fetch failed: ECONNRESET');
    expectKind(result, 'network_unreachable');
  });

  it('classifies ETIMEDOUT as rpc_timeout (timeout wins over network code)', () => {
    const result = classify('ETIMEDOUT');
    expectKind(result, 'rpc_timeout');
  });

  it('classifies ENOTFOUND as network_unreachable', () => {
    const result = classify('getaddrinfo ENOTFOUND helius-rpc.com');
    expectKind(result, 'network_unreachable');
  });

  it('classifies "aborted" as rpc_timeout', () => {
    const result = classify('The user aborted a request.');
    expectKind(result, 'rpc_timeout');
  });
});

describe('classifyTransactionFailure — rate limit and 5xx', () => {
  it('classifies 429 as rate_limited', () => {
    const result = classify('HTTP 429: too many requests');
    expectKind(result, 'rate_limited');
    expect(result.retryableSignedBroadcast).toBe(true);
  });

  it('classifies "rate limit" as rate_limited', () => {
    const result = classify('Helius rate limit exceeded');
    expectKind(result, 'rate_limited');
  });

  it('classifies HTTP 500 as network_unreachable', () => {
    const result = classify('HTTP 500 Internal Server Error from RPC');
    expectKind(result, 'network_unreachable');
    expect(result.retryableSignedBroadcast).toBe(true);
  });

  it('classifies HTTP 502 as network_unreachable', () => {
    const result = classify('Bad gateway: HTTP 502');
    expectKind(result, 'network_unreachable');
  });

  it('classifies HTTP 503 as network_unreachable', () => {
    const result = classify('Status 503 service unavailable');
    expectKind(result, 'network_unreachable');
  });

  it('classifies HTTP 504 as network_unreachable', () => {
    const result = classify('Status 504 gateway timeout');
    expectKind(result, 'network_unreachable');
  });

  it('classifies "service unavailable" as network_unreachable', () => {
    const result = classify('Service unavailable, try later');
    expectKind(result, 'network_unreachable');
  });

  it('classifies "gateway timeout" as network_unreachable', () => {
    const result = classify('upstream gateway timeout reading response');
    expectKind(result, 'network_unreachable');
  });

  it('rate_limited with signed bytes is ambiguous and retryable', () => {
    const result = classify('Helius rate limit', { hasSignedBytes: true });
    expectKind(result, 'rate_limited');
    expect(result.maybeSubmitted).toBe(true);
    expect(result.retryableSignedBroadcast).toBe(true);
    expect(result.safeToAskWalletAgain).toBe(false);
  });
});

describe('classifyTransactionFailure — already processed / duplicate signature', () => {
  const cases = [
    'Transaction already processed',
    'already processed',
    'duplicate signature 4Nd1mY...',
    'this transaction has already been processed',
  ];

  for (const message of cases) {
    it(`matches "${message}"`, () => {
      const result = classify(message);
      expectKind(result, 'unknown_maybe_submitted');
      expect(result.maybeSubmitted).toBe(true);
      expect(result.retryableSignedBroadcast).toBe(false);
      expect(result.safeToAskWalletAgain).toBe(false);
      expect(result.shouldCheckChainBeforeFailing).toBe(true);
    });
  }
});

describe('classifyTransactionFailure — expired blockhash', () => {
  it('matches "blockhash not found" without txid', () => {
    const result = classify('Blockhash not found');
    expectKind(result, 'expired_blockhash');
    expect(result.maybeSubmitted).toBe(false);
    expect(result.safeToAskWalletAgain).toBe(false);
    expect(result.shouldCheckChainBeforeFailing).toBe(false);
  });

  it('matches "block height exceeded"', () => {
    const result = classify('Transaction was not confirmed: block height exceeded');
    expectKind(result, 'expired_blockhash');
  });

  it('matches "last valid block height exceeded"', () => {
    const result = classify('Last valid block height exceeded.');
    expectKind(result, 'expired_blockhash');
  });

  it('matches "expired blockhash"', () => {
    const result = classify('expired blockhash detected');
    expectKind(result, 'expired_blockhash');
  });

  it('with txid: maybeSubmitted true and chain check required', () => {
    const result = classify('blockhash not found', { txid: 'sigABC' });
    expectKind(result, 'expired_blockhash');
    expect(result.maybeSubmitted).toBe(true);
    expect(result.shouldCheckChainBeforeFailing).toBe(true);
    expect(result.safeToAskWalletAgain).toBe(false);
  });
});

describe('classifyTransactionFailure — simulation/preflight', () => {
  const cases = [
    'Simulation failed: program error',
    'Preflight failure on send',
    'Transaction simulation failed: 0x1',
    'Custom program error: 0x1771',
    'InstructionError: [0, "ProgramFailedToComplete"]',
  ];

  for (const message of cases) {
    it(`matches "${message}" without signature context`, () => {
      const result = classify(message);
      expectKind(result, 'simulation_failed');
      expect(result.maybeSubmitted).toBe(false);
      expect(result.safeToAskWalletAgain).toBe(true);
    });
  }

  it('simulation message + txid -> onchain_failed', () => {
    const result = classify('InstructionError: [0, "InvalidAccountData"]', { txid: 'sig123' });
    expectKind(result, 'onchain_failed');
    expect(result.maybeSubmitted).toBe(true);
    expect(result.safeToAskWalletAgain).toBe(false);
  });

  it('simulation message + hasSignedBytes -> simulation_failed but not safe to ask wallet again', () => {
    const result = classify('Simulation failed', { hasSignedBytes: true });
    expectKind(result, 'simulation_failed');
    expect(result.safeToAskWalletAgain).toBe(false);
  });
});

describe('classifyTransactionFailure — on-chain failed', () => {
  it('matches explicit on-chain marker', () => {
    const result = classify('Transaction failed on-chain with custom error', { txid: 'sigZ' });
    expectKind(result, 'onchain_failed');
    expect(result.title).toBe('Transaction failed on-chain');
    expect(result.message).toBe('The transaction reached chain status and failed. Review the error before retrying.');
    expect(result.retryableSignedBroadcast).toBe(false);
    expect(result.maybeSubmitted).toBe(true);
    expect(result.safeToAskWalletAgain).toBe(false);
    expect(result.shouldCheckChainBeforeFailing).toBe(false);
  });

  it('matches "finalized status failed"', () => {
    const result = classify('finalized status failed for signature 5ab...');
    expectKind(result, 'onchain_failed');
  });
});

describe('classifyTransactionFailure — slippage/quote', () => {
  const cases = [
    'slippage tolerance exceeded',
    'Output threshold not met',
    'route not found for input mint',
    'Quote expired, refresh and retry',
    'No route available between mints',
    'Jupiter execute failed: ROUTE_NOT_FOUND',
    'Price impact too high',
  ];

  for (const message of cases) {
    it(`matches "${message}" without context`, () => {
      const result = classify(message);
      expectKind(result, 'slippage_or_quote_failed');
      expect(result.maybeSubmitted).toBe(false);
      expect(result.safeToAskWalletAgain).toBe(true);
    });
  }

  it('with hasSignedBytes: maybeSubmitted true, not safe to ask again', () => {
    const result = classify('slippage tolerance exceeded', { hasSignedBytes: true });
    expectKind(result, 'slippage_or_quote_failed');
    expect(result.maybeSubmitted).toBe(true);
    expect(result.safeToAskWalletAgain).toBe(false);
  });

  it('with txid: maybeSubmitted true, not safe to ask again', () => {
    const result = classify('Quote expired', { txid: 'sig123' });
    expectKind(result, 'slippage_or_quote_failed');
    expect(result.maybeSubmitted).toBe(true);
    expect(result.safeToAskWalletAgain).toBe(false);
  });
});

describe('classifyTransactionFailure — insufficient funds', () => {
  const cases = [
    'Insufficient funds for transfer',
    'insufficient lamports for fee',
    'account does not have enough SOL',
  ];

  for (const message of cases) {
    it(`matches "${message}"`, () => {
      const result = classify(message);
      expectKind(result, 'insufficient_funds');
      expect(result.retryableSignedBroadcast).toBe(false);
      expect(result.maybeSubmitted).toBe(false);
      expect(result.safeToAskWalletAgain).toBe(true);
    });
  }
});

describe('classifyTransactionFailure — invalid transaction', () => {
  const cases = [
    'Signature verification failed',
    'failed to sanitize transaction',
    'Invalid transaction: bad encoding',
    'Transaction too large to send',
    'Versioned transaction not supported',
  ];

  for (const message of cases) {
    it(`matches "${message}"`, () => {
      const result = classify(message);
      expectKind(result, 'invalid_transaction');
      expect(result.retryableSignedBroadcast).toBe(false);
      expect(result.maybeSubmitted).toBe(false);
      expect(result.safeToAskWalletAgain).toBe(false);
    });
  }
});

describe('classifyTransactionFailure — unknown', () => {
  it('without signed bytes: maybeSubmitted false, safe to ask again', () => {
    const result = classify('Some weird error nobody mapped');
    expectKind(result, 'unknown_maybe_submitted');
    expect(result.maybeSubmitted).toBe(false);
    expect(result.safeToAskWalletAgain).toBe(true);
    expect(result.retryableSignedBroadcast).toBe(false);
    expect(result.shouldCheckChainBeforeFailing).toBe(false);
  });

  it('with hasSignedBytes: ambiguous, retryable, not safe to ask again', () => {
    const result = classify('Some weird error nobody mapped', { hasSignedBytes: true });
    expectKind(result, 'unknown_maybe_submitted');
    expect(result.maybeSubmitted).toBe(true);
    expect(result.safeToAskWalletAgain).toBe(false);
    expect(result.retryableSignedBroadcast).toBe(true);
    expect(result.shouldCheckChainBeforeFailing).toBe(true);
  });

  it('with txid: ambiguous, retryable, not safe to ask again', () => {
    const result = classify('Some weird error nobody mapped', { txid: 'sig1' });
    expectKind(result, 'unknown_maybe_submitted');
    expect(result.maybeSubmitted).toBe(true);
    expect(result.safeToAskWalletAgain).toBe(false);
    expect(result.shouldCheckChainBeforeFailing).toBe(true);
  });

  it('empty error returns generic but safe to ask again', () => {
    const result = classify(undefined);
    expectKind(result, 'unknown_maybe_submitted');
    expect(result.safeToAskWalletAgain).toBe(true);
    expect(result.maybeSubmitted).toBe(false);
  });
});

describe('classifyTransactionFailure — input types', () => {
  it('accepts Error instance', () => {
    const result = classify(new Error('User rejected the request.'));
    expectKind(result, 'wallet_rejected');
  });

  it('accepts object with message field', () => {
    const result = classify({ message: 'Insufficient funds for transfer' });
    expectKind(result, 'insufficient_funds');
  });

  it('accepts string', () => {
    const result = classify('Missing RPC URL');
    expectKind(result, 'config_missing');
  });

  it('treats null/undefined as empty', () => {
    expect(classify(null).kind).toBe('unknown_maybe_submitted');
    expect(classify(undefined).technicalMessage).toBe('');
  });
});

describe('shouldRetrySignedBroadcast', () => {
  it('is true for timeout', () => {
    expect(shouldRetrySignedBroadcast('Request timed out')).toBe(true);
  });

  it('is true for network unreachable', () => {
    expect(shouldRetrySignedBroadcast('Failed to fetch')).toBe(true);
  });

  it('is true for rate limited', () => {
    expect(shouldRetrySignedBroadcast('HTTP 429')).toBe(true);
  });

  it('is true for 5xx', () => {
    expect(shouldRetrySignedBroadcast('HTTP 503 service unavailable')).toBe(true);
  });

  it('is false for wallet_rejected', () => {
    expect(shouldRetrySignedBroadcast('User rejected the request')).toBe(false);
  });

  it('is false for wallet_unavailable', () => {
    expect(shouldRetrySignedBroadcast('Wallet not connected')).toBe(false);
  });

  it('is false for config_missing', () => {
    expect(shouldRetrySignedBroadcast('Missing RPC URL')).toBe(false);
  });

  it('is false for onchain_failed', () => {
    expect(shouldRetrySignedBroadcast('Transaction failed on-chain')).toBe(false);
  });

  it('is false for expired_blockhash', () => {
    expect(shouldRetrySignedBroadcast('Blockhash not found')).toBe(false);
  });

  it('is false for slippage_or_quote_failed', () => {
    expect(shouldRetrySignedBroadcast('Slippage tolerance exceeded')).toBe(false);
  });

  it('is false for simulation_failed', () => {
    expect(shouldRetrySignedBroadcast('Simulation failed')).toBe(false);
  });

  it('is false for insufficient_funds', () => {
    expect(shouldRetrySignedBroadcast('Insufficient funds')).toBe(false);
  });

  it('is false for invalid_transaction', () => {
    expect(shouldRetrySignedBroadcast('Signature verification failed')).toBe(false);
  });

  it('is false for unknown without signed bytes (empty context)', () => {
    expect(shouldRetrySignedBroadcast('Some weird error nobody mapped')).toBe(false);
  });

  it('is false for already processed (no rebroadcast of duplicate sig)', () => {
    expect(shouldRetrySignedBroadcast('Transaction already processed')).toBe(false);
  });
});

describe('shouldCheckChainBeforeFailing', () => {
  it('is true for rpc_timeout', () => {
    expect(shouldCheckChainBeforeFailing('Request timed out')).toBe(true);
  });

  it('is true for network_unreachable', () => {
    expect(shouldCheckChainBeforeFailing('Failed to fetch')).toBe(true);
  });

  it('is true for rate_limited', () => {
    expect(shouldCheckChainBeforeFailing('HTTP 429')).toBe(true);
  });

  it('is true for already-processed (unknown_maybe_submitted)', () => {
    expect(shouldCheckChainBeforeFailing('Transaction already processed')).toBe(true);
  });

  it('is false for wallet_rejected', () => {
    expect(shouldCheckChainBeforeFailing('User rejected')).toBe(false);
  });

  it('is false for config_missing', () => {
    expect(shouldCheckChainBeforeFailing('Missing RPC URL')).toBe(false);
  });

  it('is false for onchain_failed', () => {
    expect(shouldCheckChainBeforeFailing('Transaction failed on-chain')).toBe(false);
  });

  it('is false for simulation_failed without txid', () => {
    expect(shouldCheckChainBeforeFailing('Simulation failed')).toBe(false);
  });

  it('is false for slippage', () => {
    expect(shouldCheckChainBeforeFailing('Slippage tolerance exceeded')).toBe(false);
  });

  it('is false for insufficient funds', () => {
    expect(shouldCheckChainBeforeFailing('Insufficient funds')).toBe(false);
  });

  it('is false for invalid transaction', () => {
    expect(shouldCheckChainBeforeFailing('Signature verification failed')).toBe(false);
  });

  it('is false for unknown without signed bytes', () => {
    expect(shouldCheckChainBeforeFailing('weird error')).toBe(false);
  });

  it('is false for expired_blockhash without txid (signature signature alone is sufficient)', () => {
    // shouldCheckChainBeforeFailing uses an empty context, so blockhash w/o
    // context returns false. That is correct: with no txid there is nothing
    // to look up on-chain.
    expect(shouldCheckChainBeforeFailing('Blockhash not found')).toBe(false);
  });
});

describe('transactionFailureToastCopy', () => {
  it('renders ambiguous title and message for unknown_maybe_submitted (no retry)', () => {
    const result = classify('already processed');
    const copy = transactionFailureToastCopy(result);
    expect(copy.title).toBe('Submitted status unknown');
    expect(copy.message).toBe('Checking the signed transaction status.');
  });

  it('renders retry message for retryable signed broadcast (e.g. timeout with signed bytes)', () => {
    const result = classify('Request timed out', { hasSignedBytes: true });
    const copy = transactionFailureToastCopy(result);
    expect(copy.title).toBe('Submitted status unknown');
    expect(copy.message).toBe('Retrying only the same signed transaction. Do not approve this request again.');
  });

  it('renders on-chain failure copy', () => {
    const result = classify('Transaction failed on-chain');
    const copy = transactionFailureToastCopy(result);
    expect(copy.title).toBe('Transaction failed on-chain');
    expect(copy.message).toBe('The transaction reached chain status and failed. Review the error before retrying.');
  });

  it('renders config-missing copy', () => {
    const result = classify('Missing RPC URL');
    const copy = transactionFailureToastCopy(result);
    expect(copy.title).toBe('Transaction execution not configured');
    expect(copy.message).toBe('Transaction execution is not configured. Add RPC/Jupiter setup before trying again.');
  });

  it('falls back to per-kind title and message for non-ambiguous classes', () => {
    const result = classify('User rejected');
    const copy = transactionFailureToastCopy(result);
    expect(copy.title).toBe('Wallet approval rejected');
    expect(copy.message).toContain('Wallet approval was rejected');
  });
});

describe('normalizeErrorMessage', () => {
  it('returns empty for null/undefined', () => {
    expect(normalizeErrorMessage(undefined)).toBe('');
    expect(normalizeErrorMessage(null)).toBe('');
  });

  it('returns string input verbatim aside from trim', () => {
    expect(normalizeErrorMessage('  hello  ')).toBe('hello');
  });

  it('reads Error.message and preserves casing', () => {
    expect(normalizeErrorMessage(new Error('User Rejected'))).toBe('User Rejected');
  });

  it('reads object.message', () => {
    expect(normalizeErrorMessage({ message: 'Network error' })).toBe('Network error');
  });

  it('falls back to object.error then object.reason', () => {
    expect(normalizeErrorMessage({ error: 'oops' })).toBe('oops');
    expect(normalizeErrorMessage({ reason: 'because' })).toBe('because');
  });

  it('json-stringifies arbitrary objects as a fallback', () => {
    expect(normalizeErrorMessage({ foo: 1 })).toBe('{"foo":1}');
  });

  it('strips stack trace frames after the message line', () => {
    const err = new Error('Real message');
    err.stack = 'Real message\n    at Object.<anonymous> (/x/y/z.ts:1:1)\n    at next (...)';
    // Normalizer reads .message, not .stack, but if the message itself
    // contains a stack it must be stripped.
    expect(normalizeErrorMessage('Real message\n    at foo (file.ts:1:1)')).toBe('Real message');
  });

  it('redacts api-key query params on RPC URLs', () => {
    const message =
      'Failed to fetch https://mainnet.helius-rpc.com/?api-key=abcd-1234-secret-xyz: 500';
    const out = normalizeErrorMessage(message);
    expect(out).not.toContain('abcd-1234-secret-xyz');
    expect(out).toContain('api-key=[redacted]');
  });

  it('redacts apiKey= body params', () => {
    const out = normalizeErrorMessage('Error: invalid apiKey=topsecret123');
    expect(out).toContain('apiKey=[redacted]');
    expect(out).not.toContain('topsecret123');
  });

  it('redacts Bearer tokens', () => {
    const out = normalizeErrorMessage('Authorization failed: Bearer abc.def.ghi');
    expect(out).toContain('Bearer [redacted]');
    expect(out).not.toContain('abc.def.ghi');
  });

  it('redacts secret= and token= patterns', () => {
    const out = normalizeErrorMessage('config secret=hush, token=open-sesame, password=p@ss');
    expect(out).not.toContain('hush');
    expect(out).not.toContain('open-sesame');
    expect(out).not.toContain('p@ss');
    expect(out).toContain('secret=[redacted]');
    expect(out).toContain('token=[redacted]');
    expect(out).toContain('password=[redacted]');
  });

  it('collapses runaway whitespace', () => {
    const out = normalizeErrorMessage('a\n\n\n   b\t\t  c');
    expect(out).toBe('a b c');
  });

  it('truncates very long messages', () => {
    const longMessage = 'x'.repeat(2000);
    const out = normalizeErrorMessage(longMessage);
    expect(out.length).toBeLessThanOrEqual(400);
  });

  it('preserves original casing for matching-safe substrings', () => {
    // Internally we lower-case for matching; but the public string keeps
    // its original casing.
    const out = normalizeErrorMessage('User Rejected The Request.');
    expect(out).toBe('User Rejected The Request.');
  });

  it('redacts helius URL with api-key in path', () => {
    const out = normalizeErrorMessage('GET https://rpc.helius.xyz/?api-key=deadbeef failed');
    expect(out).not.toContain('deadbeef');
  });
});

describe('classifyTransactionFailure — invariants', () => {
  // These tests reinforce the safety invariants spelled out in the spec.

  it('never returns safeToAskWalletAgain:true for a network failure with signed bytes', () => {
    const result = classify('Failed to fetch', { hasSignedBytes: true });
    expect(result.safeToAskWalletAgain).toBe(false);
  });

  it('never returns safeToAskWalletAgain:true for a timeout with txid', () => {
    const result = classify('timed out', { txid: 'sigABC' });
    expect(result.safeToAskWalletAgain).toBe(false);
  });

  it('never returns safeToAskWalletAgain:true for already processed with no context', () => {
    // "already processed" itself implies the wallet has signed at some point;
    // the classifier must not ask wallet again even without explicit context.
    const result = classify('already processed');
    expect(result.safeToAskWalletAgain).toBe(false);
  });

  it('never returns safeToAskWalletAgain:true for onchain_failed', () => {
    const result = classify('transaction failed on-chain');
    expect(result.safeToAskWalletAgain).toBe(false);
  });

  it('expired_blockhash with no context still does not auto re-prompt wallet', () => {
    const result = classify('blockhash not found');
    expect(result.safeToAskWalletAgain).toBe(false);
  });

  it('preserves technicalMessage as the normalized original message', () => {
    const result = classify('  User Rejected   ');
    expect(result.technicalMessage).toBe('User Rejected');
  });

  it('redacts secrets in the technicalMessage', () => {
    const result = classify('Failed to fetch https://x.com/?api-key=hunter2 504');
    expect(result.technicalMessage).not.toContain('hunter2');
  });

  it('wallet_rejected wins over network terms inside the same string', () => {
    // Pattern priority: wallet rejection must beat ambiguous network text.
    const result = classify('User rejected: gateway timeout');
    expectKind(result, 'wallet_rejected');
  });

  it('config_missing wins over generic timeout', () => {
    const result = classify('Missing RPC URL (request timed out)');
    expectKind(result, 'config_missing');
  });
});
