import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import process from 'node:process';
import type { JsonRecord } from './types.js';

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function removeUndefined(record: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

export function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

export function parseJsonBody(text: string): unknown {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

export function responseError(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const error = body.error;
  if (typeof error === 'string') {
    return error;
  }
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message;
  }
  if (typeof body.message === 'string') {
    return body.message;
  }
  return undefined;
}

export function splitFlag(arg: string): [string, string | undefined] {
  if (!arg.startsWith('-')) {
    return [arg, undefined];
  }
  const index = arg.indexOf('=');
  if (index < 0) {
    return [arg, undefined];
  }
  return [arg.slice(0, index), arg.slice(index + 1)];
}

export function optionArgument(
  argv: string[],
  index: number,
  flag: string,
  inlineValue: string | undefined,
): { value: string; index: number } {
  if (inlineValue !== undefined) {
    return { value: inlineValue, index };
  }
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return { value, index: index + 1 };
}

export function optionValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index >= 0) {
    return args[index + 1];
  }
  const inlinePrefix = `${flag}=`;
  const inline = args.find((arg) => arg.startsWith(inlinePrefix));
  return inline ? inline.slice(inlinePrefix.length) : undefined;
}

export function optionValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  const inlinePrefix = `${flag}=`;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1]) {
      values.push(args[index + 1]!);
      index += 1;
    } else if (args[index]?.startsWith(inlinePrefix)) {
      values.push(args[index]!.slice(inlinePrefix.length));
    }
  }
  return values;
}

export function commandValues(args: string[], valueFlags: Set<string>): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (valueFlags.has(arg)) {
      index += 1;
      continue;
    }
    if ([...valueFlags].some((flag) => arg.startsWith(`${flag}=`))) {
      continue;
    }
    values.push(arg);
  }
  return values;
}

export function parseStringParameters(values: string[]): Record<string, string> {
  const parameters: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator <= 0) {
      throw new Error(`Parameters must use key=value, received: ${value}`);
    }
    const key = value.slice(0, separator).trim();
    const parameterValue = value.slice(separator + 1);
    if (!key) {
      throw new Error(`Parameter key is required, received: ${value}`);
    }
    parameters[key] = parameterValue;
  }
  return parameters;
}

const POSITIVE_DECIMAL_RE = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
export function assertPositiveDecimal(raw: string, field: string): void {
  const trimmed = raw.trim();
  if (!POSITIVE_DECIMAL_RE.test(trimmed) || Number(trimmed) <= 0) {
    throw new Error(`${field} must be a positive decimal number (e.g. 1, 0.05, 10.25); got "${raw}".`);
  }
}

export function assertPositiveInteger(raw: string, field: string): void {
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer; got "${raw}".`);
  }
}

/**
 * Read a file path (positional arg) and parse it as JSON. Used by every command
 * that accepts a `<file.json>` argument; gives consistent error formatting and
 * preserves the original parse error as `cause`.
 */
export async function readJsonFile<T = unknown>(file: string, label = 'file'): Promise<T> {
  const raw = await readFile(resolvePath(file), 'utf8');
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`Failed to parse ${label} ${file} as JSON: ${errorMessage(err)}`, { cause: err });
  }
}

/**
 * Boolean flag detection — true when `--name` is present on argv with no value,
 * or `--name=true`. Returns false for absent or `--name=false`.
 */
export function booleanFlag(positionals: string[], flag: string): boolean {
  const inlinePrefix = `${flag}=`;
  const inline = positionals.find((arg) => arg.startsWith(inlinePrefix));
  if (inline) {
    const raw = inline.slice(inlinePrefix.length).toLowerCase();
    return raw !== 'false' && raw !== '0' && raw !== '';
  }
  return positionals.includes(flag);
}

/**
 * Standard wallet-address fallback: CLI flag → env var. Used by every command
 * that scopes results to a wallet.
 */
export function resolveWalletAddress(positionals: string[]): string | undefined {
  return optionValue(positionals, '--wallet') ?? process.env.AGENTIC_WALLET_ADDRESS;
}
