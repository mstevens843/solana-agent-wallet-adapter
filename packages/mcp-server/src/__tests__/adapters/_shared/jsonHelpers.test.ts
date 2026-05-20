import { describe, expect, it } from 'vitest';

import {
  extractRows,
  isRecord,
  normalizeBaseUrl,
  optionalNumber,
  optionalString,
  parseJson,
  responseErrorDetail,
} from '../../../adapters/_shared/jsonHelpers.js';

describe('_shared/jsonHelpers', () => {
  describe('isRecord', () => {
    it.each([
      ['plain object', { a: 1 }, true],
      ['empty object', {}, true],
      ['null', null, false],
      ['undefined', undefined, false],
      ['array', [1, 2], false],
      ['string', 'hi', false],
      ['number', 42, false],
    ])('%s → %s', (_label, value, expected) => {
      expect(isRecord(value)).toBe(expected);
    });
  });

  describe('normalizeBaseUrl', () => {
    it.each([
      ['no trailing slash', 'https://api.example.com', 'https://api.example.com'],
      ['single trailing slash', 'https://api.example.com/', 'https://api.example.com'],
      ['multiple trailing slashes', 'https://api.example.com///', 'https://api.example.com'],
      ['empty string', '', ''],
    ])('%s', (_label, input, expected) => {
      expect(normalizeBaseUrl(input)).toBe(expected);
    });
  });

  describe('parseJson', () => {
    it('parses valid JSON objects', () => {
      expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    });

    it('returns {} for empty/whitespace text', () => {
      expect(parseJson('')).toEqual({});
      expect(parseJson('   \n  ')).toEqual({});
    });

    it('wraps invalid JSON as { message: text }', () => {
      expect(parseJson('not json')).toEqual({ message: 'not json' });
    });

    it('passes through valid JSON null and arrays', () => {
      expect(parseJson('null')).toBeNull();
      expect(parseJson('[1,2,3]')).toEqual([1, 2, 3]);
    });
  });

  describe('responseErrorDetail', () => {
    it('returns trimmed message when present', () => {
      expect(responseErrorDetail({ message: '  boom  ' })).toBe('boom');
    });

    it('falls back through error then detail in order', () => {
      expect(responseErrorDetail({ error: 'err' })).toBe('err');
      expect(responseErrorDetail({ detail: 'det' })).toBe('det');
      expect(responseErrorDetail({ message: 'msg', error: 'err' })).toBe('msg');
    });

    it('returns undefined for non-records, empty strings, or non-string values', () => {
      expect(responseErrorDetail(null)).toBeUndefined();
      expect(responseErrorDetail('plain string')).toBeUndefined();
      expect(responseErrorDetail({ message: '   ' })).toBeUndefined();
      expect(responseErrorDetail({ unrelated: 'x' })).toBeUndefined();
      expect(responseErrorDetail({ message: 42 })).toBeUndefined();
    });
  });

  describe('extractRows', () => {
    const KEYS = ['rows', 'results', 'data'] as const;

    it('filters arrays to records only', () => {
      expect(extractRows([{ a: 1 }, 'string', null, { b: 2 }], KEYS)).toEqual([{ a: 1 }, { b: 2 }]);
    });

    it('unwraps the first matching candidate key', () => {
      expect(extractRows({ results: [{ a: 1 }], data: [{ b: 2 }] }, KEYS)).toEqual([{ a: 1 }]);
    });

    it('honors candidate key order: rows wins over results', () => {
      expect(extractRows({ data: [{ z: 1 }], rows: [{ a: 1 }] }, KEYS)).toEqual([{ a: 1 }]);
    });

    it('returns [value] when record has no matching candidate key', () => {
      const value = { unknown: 'x' };
      expect(extractRows(value, KEYS)).toEqual([value]);
    });

    it('returns [] for non-record, non-array inputs', () => {
      expect(extractRows('hi', KEYS)).toEqual([]);
      expect(extractRows(null, KEYS)).toEqual([]);
      expect(extractRows(42, KEYS)).toEqual([]);
    });

    it('respects adapter-specific key lists (Tensor keys do not match Phoenix payloads)', () => {
      const phoenixShape = { markets: [{ symbol: 'SOL-PERP' }] };
      const tensorKeys = ['escrowAccounts', 'escrows', 'accounts', 'results', 'data'] as const;
      expect(extractRows(phoenixShape, tensorKeys)).toEqual([phoenixShape]);
    });

    it('returns [] for an empty array input', () => {
      expect(extractRows([], KEYS)).toEqual([]);
    });

    it('falls through to [value] when candidateKeys is empty', () => {
      const value = { k: 'v' };
      expect(extractRows(value, [])).toEqual([value]);
    });
  });

  describe('optionalString', () => {
    it('returns trimmed string when present', () => {
      expect(optionalString({ k: '  hello  ' }, 'k')).toBe('hello');
    });

    it('stringifies finite numbers', () => {
      expect(optionalString({ k: 42 }, 'k')).toBe('42');
      expect(optionalString({ k: 0 }, 'k')).toBe('0');
    });

    it('returns undefined for whitespace-only strings, missing keys, or unsupported types', () => {
      expect(optionalString({ k: '   ' }, 'k')).toBeUndefined();
      expect(optionalString({}, 'missing')).toBeUndefined();
      expect(optionalString({ k: true }, 'k')).toBeUndefined();
      expect(optionalString({ k: null }, 'k')).toBeUndefined();
      expect(optionalString(null, 'k')).toBeUndefined();
      expect(optionalString({ k: Number.NaN }, 'k')).toBeUndefined();
      expect(optionalString({ k: Number.POSITIVE_INFINITY }, 'k')).toBeUndefined();
    });
  });

  describe('optionalNumber', () => {
    it('returns finite numbers directly', () => {
      expect(optionalNumber({ k: 3.14 }, 'k')).toBe(3.14);
      expect(optionalNumber({ k: 0 }, 'k')).toBe(0);
    });

    it('parses finite numeric strings', () => {
      expect(optionalNumber({ k: '  42 ' }, 'k')).toBe(42);
      expect(optionalNumber({ k: '-1.5' }, 'k')).toBe(-1.5);
    });

    it('returns undefined for NaN/Infinity, non-numeric strings, or non-records', () => {
      expect(optionalNumber({ k: Number.NaN }, 'k')).toBeUndefined();
      expect(optionalNumber({ k: Number.POSITIVE_INFINITY }, 'k')).toBeUndefined();
      expect(optionalNumber({ k: 'abc' }, 'k')).toBeUndefined();
      expect(optionalNumber({ k: '   ' }, 'k')).toBeUndefined();
      expect(optionalNumber({}, 'missing')).toBeUndefined();
      expect(optionalNumber(null, 'k')).toBeUndefined();
    });
  });
});
