import { describe, expect, it } from 'vitest';

import {
  PRE_SIGN_REVIEW_TITLE,
  buildCustomTransactionPreSignReview,
  buildSendPreSignReview,
  buildSwapPreSignReview,
  formatTouchedPrograms,
  shortAddress,
  type PreSignReviewRow,
  type PreSignReviewSection,
  type TouchedProgramInput,
} from '../preSignReview.js';

const SENDER = '3Kt5pHQyfd1XQ8eMv1mfA1RkX2gFwGyHkR9pVeMQ4LpW';
const RECIPIENT = '7NUSC4HBn5pFqGZRouwa3xQ5y4MNoYxqaG3HfYwwekoF';
const TAKER = '9wFFAruKcZxYwf2pdrkM5g4uxmYRoYjpqcLW2RWdZmVc';
const HASH = 'b8d29c5e1a8d6f4f23b1d8a0c1ee0773c5b5ee9f01abf012345abcd6789ef012';
const JUPITER_REQUEST_ID = 'jup_req_8f3a91b27c4d4e8d9f12';

describe('shortAddress', () => {
  it('returns the original value when shorter than head + tail + 1', () => {
    expect(shortAddress('abc')).toBe('abc');
    expect(shortAddress('')).toBe('');
  });

  it('shortens long addresses with the default 4/4 window', () => {
    expect(shortAddress(SENDER)).toBe('3Kt5…4LpW');
  });

  it('respects explicit head/tail lengths', () => {
    expect(shortAddress(SENDER, 6, 6)).toBe('3Kt5pH…MQ4LpW');
  });

  it('coerces non-string input to empty string', () => {
    expect(shortAddress(undefined as unknown as string)).toBe('');
  });
});

describe('formatTouchedPrograms', () => {
  it('returns an empty array for missing or empty input', () => {
    expect(formatTouchedPrograms(undefined)).toEqual([]);
    expect(formatTouchedPrograms([])).toEqual([]);
  });

  it('prefers label and keeps the program id in title and copyValue', () => {
    const programs: TouchedProgramInput[] = [
      {
        programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        label: 'SPL Token',
        source: 'known',
      },
    ];
    expect(formatTouchedPrograms(programs)).toEqual<PreSignReviewRow[]>([
      {
        label: 'Program',
        value: 'SPL Token',
        title: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        copyValue: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      },
    ]);
  });

  it('marks unknown programs with warn tone', () => {
    const programs: TouchedProgramInput[] = [
      {
        programId: 'UNKwNownProgRamIdAaBbCcDdEeFfGgHhIiJjKkLlMm',
        source: 'unknown',
      },
    ];
    expect(formatTouchedPrograms(programs)).toEqual<PreSignReviewRow[]>([
      {
        label: 'Program',
        value: 'UNKw…LlMm',
        title: 'UNKwNownProgRamIdAaBbCcDdEeFfGgHhIiJjKkLlMm',
        copyValue: 'UNKwNownProgRamIdAaBbCcDdEeFfGgHhIiJjKkLlMm',
        tone: 'warn',
      },
    ]);
  });

  it('marks writable unknown programs with danger tone', () => {
    const programs: TouchedProgramInput[] = [
      {
        programId: 'WriTableUnKnoWnProgRam1234567890abcDefGhi',
        source: 'unknown',
        writable: true,
      },
    ];
    expect(formatTouchedPrograms(programs)).toEqual<PreSignReviewRow[]>([
      {
        label: 'Program',
        value: 'WriT…fGhi',
        title: 'WriTableUnKnoWnProgRam1234567890abcDefGhi',
        copyValue: 'WriTableUnKnoWnProgRam1234567890abcDefGhi',
        tone: 'danger',
      },
    ]);
  });

  it('skips entries without a program id', () => {
    const programs = [
      { programId: '   ', label: 'Empty' } as TouchedProgramInput,
      { programId: 'OkProgram1234567890abcdEFGHijkLMNOPqrstuv', label: 'Ok' } as TouchedProgramInput,
    ];
    const rows = formatTouchedPrograms(programs);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe('Program');
    expect(rows[0]?.value).toBe('Ok');
  });
});

describe('buildSendPreSignReview', () => {
  it('produces a SOL send review with the expected sections, rows, and primary action', () => {
    const model = buildSendPreSignReview({
      cluster: 'devnet',
      sender: SENDER,
      recipient: RECIPIENT,
      amount: '0.25',
      token: 'SOL',
      estimatedFee: '0.000005 SOL',
      currentBalance: '1.500000 SOL',
      postSendBalance: '1.249995 SOL',
    });

    expect(model.title).toBe(PRE_SIGN_REVIEW_TITLE);
    expect(model.primaryAction).toBe('Open wallet to send');
    expect(model.riskTone).toBe('neutral');
    expect(model.warnings).toEqual([]);
    expect(model.sections).toEqual<PreSignReviewSection[]>([
      {
        title: 'Transfer',
        rows: [
          {
            label: 'Recipient',
            value: '7NUS…ekoF',
            title: RECIPIENT,
            copyValue: RECIPIENT,
          },
          { label: 'Amount', value: '0.25 SOL' },
          { label: 'Fee', value: '0.000005 SOL' },
          { label: 'Balance', value: '1.500000 SOL' },
          { label: 'Post-send', value: '1.249995 SOL' },
        ],
      },
      {
        title: 'Wallet',
        rows: [
          {
            label: 'Wallet',
            value: '3Kt5…4LpW',
            title: SENDER,
            copyValue: SENDER,
          },
        ],
      },
      {
        title: 'Network',
        rows: [{ label: 'Cluster', value: 'devnet' }],
      },
    ]);
  });

  it('warns when an SPL send is missing the recipient', () => {
    const model = buildSendPreSignReview({
      cluster: 'mainnet-beta',
      sender: SENDER,
      amount: '12.5',
      token: 'USDC',
      estimatedFee: '0.000005 SOL',
      currentBalance: '120 USDC',
    });

    expect(model.warnings).toContain('Recipient is missing.');
    expect(model.riskTone).toBe('warn');
    expect(model.sections[0]).toEqual({
      title: 'Transfer',
      rows: [
        { label: 'Amount', value: '12.5 USDC' },
        { label: 'Fee', value: '0.000005 SOL' },
        { label: 'Balance', value: '120 USDC' },
      ],
    });
  });

  it('flags insufficient balance and escalates risk tone to danger', () => {
    const model = buildSendPreSignReview({
      cluster: 'devnet',
      sender: SENDER,
      recipient: RECIPIENT,
      amount: '5',
      token: 'SOL',
      estimatedFee: '0.000005 SOL',
      currentBalance: '1.000000 SOL',
      postSendBalance: '-4.000005 SOL',
      balanceIsInsufficient: true,
    });

    expect(model.warnings).toContain('Amount exceeds current balance.');
    expect(model.riskTone).toBe('danger');
    const transfer = model.sections.find((section) => section.title === 'Transfer');
    expect(transfer?.rows.find((row) => row.label === 'Post-send')).toEqual({
      label: 'Post-send',
      value: '-4.000005 SOL',
      tone: 'warn',
    });
  });

  it('adds a mainnet warning only when caller opts in', () => {
    const opted = buildSendPreSignReview({
      cluster: 'mainnet-beta',
      sender: SENDER,
      recipient: RECIPIENT,
      amount: '0.01',
      token: 'SOL',
      estimatedFee: '0.000005 SOL',
      mainnetWarning: true,
    });
    expect(opted.warnings).toContain('This sends on mainnet-beta with real funds.');

    const offByDefault = buildSendPreSignReview({
      cluster: 'mainnet-beta',
      sender: SENDER,
      recipient: RECIPIENT,
      amount: '0.01',
      token: 'SOL',
      estimatedFee: '0.000005 SOL',
    });
    expect(offByDefault.warnings).not.toContain('This sends on mainnet-beta with real funds.');
  });

  it('omits empty optional fields rather than rendering n/a rows', () => {
    const model = buildSendPreSignReview({
      cluster: 'devnet',
      sender: SENDER,
      recipient: RECIPIENT,
      amount: '0.1',
      token: 'SOL',
      estimatedFee: '0.000005 SOL',
      memo: '   ',
      currentBalance: undefined,
      postSendBalance: null as unknown as string,
    });

    const transfer = model.sections.find((section) => section.title === 'Transfer');
    expect(transfer?.rows.some((row) => row.label === 'Memo')).toBe(false);
    expect(transfer?.rows.some((row) => row.label === 'Balance')).toBe(false);
    expect(transfer?.rows.some((row) => row.label === 'Post-send')).toBe(false);
    for (const section of model.sections) {
      for (const row of section.rows) {
        expect(row.value).not.toMatch(/^n\/a$/i);
        expect(row.value).not.toBe('');
        expect(row.value).not.toBe('—');
      }
    }
  });

  it('warns about a missing fee estimate', () => {
    const model = buildSendPreSignReview({
      cluster: 'devnet',
      sender: SENDER,
      recipient: RECIPIENT,
      amount: '0.1',
      token: 'SOL',
    });
    expect(model.warnings).toContain('Fee estimate is missing.');
  });
});

describe('buildSwapPreSignReview', () => {
  it('produces a swap review with expected sections and trimmed slippage percent', () => {
    const model = buildSwapPreSignReview({
      cluster: 'mainnet-beta',
      taker: TAKER,
      inputToken: 'SOL',
      inputAmount: '1',
      outputToken: 'USDC',
      expectedOutput: '152.43',
      minimumReceived: '150.91',
      slippageBps: 100,
      routeLabel: 'Jupiter v6 · Whirlpool',
      jupiterRequestId: JUPITER_REQUEST_ID,
      priceImpactPct: 0.12,
      priceImpactWarnPct: 1,
    });

    expect(model.title).toBe(PRE_SIGN_REVIEW_TITLE);
    expect(model.primaryAction).toBe('Open wallet to swap');
    expect(model.warnings).toEqual([]);
    expect(model.riskTone).toBe('neutral');
    expect(model.sections).toEqual<PreSignReviewSection[]>([
      {
        title: 'Swap',
        rows: [
          { label: 'Amount', value: '1 SOL' },
          { label: 'Expected out', value: '152.43 USDC' },
          { label: 'Min received', value: '150.91 USDC' },
          { label: 'Slippage', value: '100 bps (1%)' },
          { label: 'Price impact', value: '0.12%' },
        ],
      },
      {
        title: 'Route',
        rows: [
          { label: 'Route', value: 'Jupiter v6 · Whirlpool' },
          {
            label: 'Jupiter id',
            value: 'jup_re…8d9f12',
            title: JUPITER_REQUEST_ID,
            copyValue: JUPITER_REQUEST_ID,
          },
        ],
      },
      {
        title: 'Wallet',
        rows: [
          {
            label: 'Wallet',
            value: '9wFF…ZmVc',
            title: TAKER,
            copyValue: TAKER,
          },
        ],
      },
      {
        title: 'Network',
        rows: [{ label: 'Cluster', value: 'mainnet-beta' }],
      },
    ]);
  });

  it('flags high slippage above 100 bps with a warn tone and warning string', () => {
    const model = buildSwapPreSignReview({
      cluster: 'mainnet-beta',
      taker: TAKER,
      inputToken: 'SOL',
      inputAmount: '1',
      outputToken: 'USDC',
      expectedOutput: '150',
      minimumReceived: '142.5',
      slippageBps: 500,
      routeLabel: 'Jupiter v6',
    });

    const swapSection = model.sections.find((section) => section.title === 'Swap');
    const slippageRow = swapSection?.rows.find((row) => row.label === 'Slippage');
    expect(slippageRow).toEqual({ label: 'Slippage', value: '500 bps (5%)', tone: 'warn' });
    expect(model.warnings).toContain('Slippage is high at 500 bps.');
    expect(model.riskTone).toBe('warn');
  });

  it('warns when price impact exceeds the warn threshold', () => {
    const model = buildSwapPreSignReview({
      cluster: 'mainnet-beta',
      taker: TAKER,
      inputToken: 'SOL',
      inputAmount: '1',
      outputToken: 'USDC',
      expectedOutput: '120',
      minimumReceived: '118',
      slippageBps: 50,
      routeLabel: 'Jupiter v6',
      priceImpactPct: 3.5,
      priceImpactWarnPct: 1,
    });

    const swapSection = model.sections.find((section) => section.title === 'Swap');
    const impactRow = swapSection?.rows.find((row) => row.label === 'Price impact');
    expect(impactRow).toEqual({ label: 'Price impact', value: '3.5%', tone: 'warn' });
    expect(model.warnings).toContain('Price impact is 3.5%.');
  });

  it('warns about missing expected output and route label', () => {
    const model = buildSwapPreSignReview({
      cluster: 'mainnet-beta',
      taker: TAKER,
      inputToken: 'SOL',
      inputAmount: '1',
      outputToken: 'USDC',
      slippageBps: 50,
    });
    expect(model.warnings).toContain('Expected output is missing.');
    expect(model.warnings).toContain('Route label is missing.');
  });

  it('does not render n/a rows when optional swap fields are missing', () => {
    const model = buildSwapPreSignReview({
      cluster: 'devnet',
      taker: TAKER,
      inputToken: 'SOL',
      inputAmount: '1',
      outputToken: 'USDC',
      routeLabel: 'Jupiter v6',
    });
    for (const section of model.sections) {
      for (const row of section.rows) {
        expect(row.value).not.toMatch(/^n\/a$/i);
        expect(row.value).not.toBe('');
        expect(row.value).not.toBe('—');
      }
    }
    const swap = model.sections.find((section) => section.title === 'Swap');
    expect(swap?.rows.some((row) => row.label === 'Slippage')).toBe(false);
    expect(swap?.rows.some((row) => row.label === 'Price impact')).toBe(false);
    expect(swap?.rows.some((row) => row.label === 'Expected out')).toBe(false);
    expect(swap?.rows.some((row) => row.label === 'Min received')).toBe(false);
  });
});

describe('buildCustomTransactionPreSignReview', () => {
  it('produces a custom transaction review with fingerprint, fee payer, instruction count and programs', () => {
    const model = buildCustomTransactionPreSignReview({
      cluster: 'devnet',
      transactionHash: HASH,
      transactionByteLength: 312,
      feePayer: SENDER,
      instructionCount: 3,
      writableAccountCount: 5,
      signerCount: 1,
      touchedPrograms: [
        {
          programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          label: 'SPL Token',
          source: 'known',
        },
      ],
    });

    expect(model.title).toBe(PRE_SIGN_REVIEW_TITLE);
    expect(model.primaryAction).toBe('Open wallet to sign transaction');
    expect(model.warnings).toEqual([]);
    expect(model.riskTone).toBe('neutral');
    expect(model.sections).toEqual<PreSignReviewSection[]>([
      {
        title: 'Transaction',
        rows: [
          {
            label: 'Fingerprint',
            value: 'b8d29c…9ef012',
            title: HASH,
            copyValue: HASH,
          },
          { label: 'Size', value: '312 bytes' },
          { label: 'Instructions', value: '3' },
          { label: 'Writable accounts', value: '5' },
          { label: 'Signers', value: '1' },
        ],
      },
      {
        title: 'Wallet',
        rows: [
          {
            label: 'Fee payer',
            value: '3Kt5…4LpW',
            title: SENDER,
            copyValue: SENDER,
          },
        ],
      },
      {
        title: 'Network',
        rows: [{ label: 'Cluster', value: 'devnet' }],
      },
      {
        title: 'Programs',
        rows: [
          {
            label: 'Program',
            value: 'SPL Token',
            title: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            copyValue: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          },
        ],
      },
    ]);
  });

  it('warns about multiple signers and tones the signer row', () => {
    const model = buildCustomTransactionPreSignReview({
      cluster: 'devnet',
      transactionHash: HASH,
      feePayer: SENDER,
      instructionCount: 4,
      signerCount: 2,
    });

    const tx = model.sections.find((section) => section.title === 'Transaction');
    const signers = tx?.rows.find((row) => row.label === 'Signers');
    expect(signers).toEqual({ label: 'Signers', value: '2', tone: 'warn' });
    expect(model.warnings).toContain('Transaction has 2 signers.');
    expect(model.riskTone).toBe('warn');
  });

  it('escalates risk to danger when a writable unknown program is touched', () => {
    const model = buildCustomTransactionPreSignReview({
      cluster: 'mainnet-beta',
      transactionHash: HASH,
      feePayer: SENDER,
      instructionCount: 2,
      signerCount: 1,
      touchedPrograms: [
        {
          programId: 'WriTableUnKnoWnProgRam1234567890abcDefGhi',
          source: 'unknown',
          writable: true,
        },
      ],
    });

    expect(model.warnings).toContain('Writable unknown program account.');
    expect(model.warnings).toContain('Unknown program touched.');
    expect(model.riskTone).toBe('danger');
    const programs = model.sections.find((section) => section.title === 'Programs');
    expect(programs?.rows[0]?.tone).toBe('danger');
  });

  it('propagates caller-provided warnings verbatim', () => {
    const model = buildCustomTransactionPreSignReview({
      cluster: 'devnet',
      transactionHash: HASH,
      feePayer: SENDER,
      instructionCount: 1,
      signerCount: 1,
      warnings: ['Caller flagged authority change.'],
    });
    expect(model.warnings).toContain('Caller flagged authority change.');
  });

  it('omits empty optional fields entirely', () => {
    const model = buildCustomTransactionPreSignReview({
      cluster: 'devnet',
    });
    expect(model.sections.find((section) => section.title === 'Transaction')).toBeUndefined();
    expect(model.sections.find((section) => section.title === 'Wallet')).toBeUndefined();
    expect(model.sections.find((section) => section.title === 'Programs')).toBeUndefined();
    expect(model.sections.find((section) => section.title === 'Network')).toEqual({
      title: 'Network',
      rows: [{ label: 'Cluster', value: 'devnet' }],
    });
    for (const section of model.sections) {
      for (const row of section.rows) {
        expect(row.value).not.toMatch(/^n\/a$/i);
        expect(row.value).not.toBe('');
        expect(row.value).not.toBe('—');
      }
    }
  });
});

describe('shared invariants', () => {
  it('always uses the canonical title across model builders', () => {
    expect(buildSendPreSignReview({ cluster: 'devnet' }).title).toBe(PRE_SIGN_REVIEW_TITLE);
    expect(buildSwapPreSignReview({ cluster: 'devnet' }).title).toBe(PRE_SIGN_REVIEW_TITLE);
    expect(buildCustomTransactionPreSignReview({ cluster: 'devnet' }).title).toBe(PRE_SIGN_REVIEW_TITLE);
  });

  it('never emits an n/a, empty, or placeholder row across all builders', () => {
    const models = [
      buildSendPreSignReview({ cluster: 'devnet' }),
      buildSwapPreSignReview({ cluster: 'devnet' }),
      buildCustomTransactionPreSignReview({ cluster: 'devnet' }),
    ];
    for (const model of models) {
      for (const section of model.sections) {
        expect(section.rows.length).toBeGreaterThan(0);
        for (const row of section.rows) {
          expect(row.label.trim()).not.toBe('');
          expect(row.value).not.toMatch(/^n\/a$/i);
          expect(row.value).not.toBe('');
          expect(row.value).not.toBe('—');
        }
      }
    }
  });
});
