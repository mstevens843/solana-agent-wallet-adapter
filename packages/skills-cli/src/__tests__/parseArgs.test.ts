import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_API_URL, parseArgs } from '../parseArgs.js';

const ENV_KEYS = ['AGENTIC_AUTHOR_WALLET', 'AGENTIC_API_URL', 'AGENTIC_COOKIE', 'NO_COLOR'] as const;
type EnvKey = (typeof ENV_KEYS)[number];

describe('parseArgs', () => {
  const saved: Partial<Record<EnvKey, string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('parses positional commands', () => {
    const parsed = parseArgs(['init', 'friday-dca']);
    expect(parsed.positionals).toEqual(['init', 'friday-dca']);
  });

  it('supports --flag=value form', () => {
    const parsed = parseArgs(['init', 'friday-dca', '--author-wallet=ABC123']);
    expect(parsed.options.authorWallet).toBe('ABC123');
  });

  it('supports --flag value form', () => {
    const parsed = parseArgs(['init', 'friday-dca', '--author-wallet', 'ABC123']);
    expect(parsed.options.authorWallet).toBe('ABC123');
  });

  it('preserves positionals after --', () => {
    const parsed = parseArgs(['init', '--', '--literal-arg', 'second']);
    expect(parsed.positionals).toEqual(['init', '--literal-arg', 'second']);
  });

  it('sets --help', () => {
    const parsed = parseArgs(['--help']);
    expect(parsed.options.help).toBe(true);
  });

  it('sets -h shorthand', () => {
    const parsed = parseArgs(['-h']);
    expect(parsed.options.help).toBe(true);
  });

  it('sets --json', () => {
    const parsed = parseArgs(['test', '--json']);
    expect(parsed.options.json).toBe(true);
  });

  it('disables color with --no-color', () => {
    const parsed = parseArgs(['init', 'a-b', '--no-color']);
    expect(parsed.options.color).toBe(false);
  });

  it('disables color with NO_COLOR=1', () => {
    process.env.NO_COLOR = '1';
    const parsed = parseArgs(['init', 'a-b']);
    expect(parsed.options.color).toBe(false);
  });

  it('reads AGENTIC_AUTHOR_WALLET from env', () => {
    process.env.AGENTIC_AUTHOR_WALLET = 'WALLET_FROM_ENV';
    const parsed = parseArgs(['init', 'friday-dca']);
    expect(parsed.options.authorWallet).toBe('WALLET_FROM_ENV');
  });

  it('flag --author-wallet beats env', () => {
    process.env.AGENTIC_AUTHOR_WALLET = 'env-wallet';
    const parsed = parseArgs(['init', 'friday-dca', '--author-wallet', 'flag-wallet']);
    expect(parsed.options.authorWallet).toBe('flag-wallet');
  });

  it('reads AGENTIC_API_URL from env and strips trailing slash', () => {
    process.env.AGENTIC_API_URL = 'https://example.com/';
    const parsed = parseArgs(['publish']);
    expect(parsed.options.apiUrl).toBe('https://example.com');
  });

  it('defaults --api-url to http://localhost:3000', () => {
    const parsed = parseArgs(['publish']);
    expect(parsed.options.apiUrl).toBe(DEFAULT_API_URL);
  });

  it('reads AGENTIC_COOKIE from env', () => {
    process.env.AGENTIC_COOKIE = 'session=abc';
    const parsed = parseArgs(['publish']);
    expect(parsed.options.cookie).toBe('session=abc');
  });

  it('parses --category', () => {
    const parsed = parseArgs(['init', 'a-b', '--category', 'dca']);
    expect(parsed.options.category).toBe('dca');
  });

  it('rejects unknown --category', () => {
    expect(() => parseArgs(['init', 'a-b', '--category', 'bogus'])).toThrow(/Invalid --category/);
  });

  it('parses --out, --force, --dry-run', () => {
    const parsed = parseArgs(['init', 'a-b', '--out', '/tmp/x', '--force', '--dry-run']);
    expect(parsed.options.outDir).toBe('/tmp/x');
    expect(parsed.options.force).toBe(true);
    expect(parsed.options.dryRun).toBe(true);
  });

  it('parses --manifest', () => {
    const parsed = parseArgs(['test', '--manifest', '/tmp/m.json']);
    expect(parsed.options.manifestPath).toBe('/tmp/m.json');
  });

  it('rejects unknown flags', () => {
    expect(() => parseArgs(['init', 'a-b', '--bogus'])).toThrow(/Unknown flag/);
  });

  it('throws when a flag is missing its value', () => {
    expect(() => parseArgs(['init', 'a-b', '--author-wallet'])).toThrow(/requires a value/);
  });
});
