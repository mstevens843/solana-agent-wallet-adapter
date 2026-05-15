import type { SkillsCliOptions } from './parseArgs.js';

export const NO_OUTPUT: unique symbol = Symbol('no-output');

export type CliResult = unknown | typeof NO_OUTPUT;

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function printResult(result: CliResult, options: SkillsCliOptions): void {
  if (result === NO_OUTPUT) {
    return;
  }
  console.log(stableJson(result));
}

export function printError(options: SkillsCliOptions, message: string): void {
  console.error(colorize(options, message, 'red'));
}

export function printOk(options: SkillsCliOptions, message: string): void {
  console.log(colorize(options, message, 'green'));
}

export function printWarn(options: SkillsCliOptions, message: string): void {
  console.warn(colorize(options, message, 'yellow'));
}

type Color = 'green' | 'yellow' | 'red';

function colorize(options: SkillsCliOptions, value: string, color: Color): string {
  if (!options.color) {
    return value;
  }
  const codes: Record<Color, [string, string]> = {
    green: ['[32m', '[0m'],
    yellow: ['[33m', '[0m'],
    red: ['[31m', '[0m'],
  };
  const [open, close] = codes[color];
  return `${open}${value}${close}`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
