// Thin facade over @inquirer/prompts + ANSI helpers used by the new /new, /repeat,
// /connectors, /agent, /inbox, /done flows. The legacy readline `prompt()`,
// `promptRequired()`, `confirm()` helpers in src/index.ts stay for existing
// command handlers — only new flows go through here.

import {
  select as inquirerSelect,
  input as inquirerInput,
  confirm as inquirerConfirm,
  password as inquirerPassword,
  editor as inquirerEditor,
} from '@inquirer/prompts';

export type Kind = 'ok' | 'warn' | 'err' | 'info' | 'muted';

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  underline: '\x1b[4m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

export function header(text: string): string {
  return `${ANSI.bold}${ANSI.underline}${text}${ANSI.reset}`;
}

export function badge(text: string, kind: Kind = 'info'): string {
  const color =
    kind === 'ok' ? ANSI.green
      : kind === 'warn' ? ANSI.yellow
      : kind === 'err' ? ANSI.red
      : kind === 'muted' ? ANSI.gray
      : ANSI.cyan;
  return `${color}${text}${ANSI.reset}`;
}

export function kv(rows: Array<[string, string]>): string {
  if (rows.length === 0) return '';
  const max = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${ANSI.gray}${k.padEnd(max)}${ANSI.reset}  ${v}`).join('\n');
}

export function divider(): string {
  return `${ANSI.gray}${'─'.repeat(60)}${ANSI.reset}`;
}

export interface Spinner {
  stop(): void;
  succeed(text?: string): void;
  fail(text?: string): void;
  update(text: string): void;
}

export function spinner(label: string): Spinner {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  let current = label;
  const stream = process.stderr;
  const tty = Boolean(stream.isTTY);
  const handle = tty
    ? setInterval(() => {
        stream.write(`\r${ANSI.cyan}${frames[i % frames.length]}${ANSI.reset} ${current}`);
        i += 1;
      }, 80)
    : null;
  if (!tty) {
    stream.write(`… ${label}\n`);
  }
  function clear(): void {
    if (handle) {
      clearInterval(handle);
      stream.write('\r\x1b[K');
    }
  }
  return {
    stop(): void {
      clear();
    },
    succeed(text?: string): void {
      clear();
      stream.write(`${ANSI.green}✓${ANSI.reset} ${text ?? current}\n`);
    },
    fail(text?: string): void {
      clear();
      stream.write(`${ANSI.red}✗${ANSI.reset} ${text ?? current}\n`);
    },
    update(text: string): void {
      current = text;
      if (!tty) {
        stream.write(`… ${text}\n`);
      }
    },
  };
}

// `@inquirer/prompts` re-exports — wrapped so future changes (TTY fallback,
// telemetry, theming) only touch this file.

export interface SelectChoice<T> {
  name: string;
  value: T;
  description?: string;
  disabled?: boolean | string;
}

export async function select<T>(opts: {
  message: string;
  choices: Array<SelectChoice<T>>;
  default?: T;
  pageSize?: number;
}): Promise<T> {
  return inquirerSelect<T>({
    message: opts.message,
    choices: opts.choices,
    ...(opts.default !== undefined ? { default: opts.default } : {}),
    pageSize: opts.pageSize ?? 12,
  });
}

export async function input(opts: {
  message: string;
  default?: string;
  validate?: (value: string) => boolean | string;
}): Promise<string> {
  const built: Parameters<typeof inquirerInput>[0] = {
    message: opts.message,
  };
  if (opts.default !== undefined) built.default = opts.default;
  if (opts.validate) built.validate = opts.validate;
  return inquirerInput(built);
}

export async function confirm(opts: {
  message: string;
  default?: boolean;
}): Promise<boolean> {
  return inquirerConfirm({
    message: opts.message,
    default: opts.default ?? false,
  });
}

export async function password(opts: {
  message: string;
  mask?: string;
}): Promise<string> {
  return inquirerPassword({
    message: opts.message,
    mask: opts.mask ?? '*',
  });
}

export async function editor(opts: {
  message: string;
  default?: string;
}): Promise<string> {
  const built: Parameters<typeof inquirerEditor>[0] = {
    message: opts.message,
  };
  if (opts.default !== undefined) built.default = opts.default;
  return inquirerEditor(built);
}

// Multi-line free text. Falls back to plain input + 'press Enter twice to end'
// when @inquirer/prompts editor isn't usable (no $EDITOR set, no TTY).
export async function multilineInput(opts: {
  message: string;
  default?: string;
}): Promise<string> {
  if (process.stdin.isTTY && process.env.EDITOR) {
    return editor(opts);
  }
  const built: Parameters<typeof inquirerInput>[0] = {
    message: `${opts.message} (single line; set $EDITOR for multi-line)`,
  };
  if (opts.default !== undefined) built.default = opts.default;
  return inquirerInput(built);
}

// `@inquirer/prompts` throws an `ExitPromptError` when the user hits Ctrl+C.
// We catch it in every flow so a cancellation prints "Cancelled." instead of
// a stack trace. The error class isn't exported under a stable name; match by
// `.name`.
export function isExitPromptError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name;
  return name === 'ExitPromptError' || name === 'AbortPromptError';
}

// Guard for one-shot flows that need interactive input. REPL flows skip this
// because the REPL itself requires a TTY. Exits with code 2 so CI failures are
// easy to spot.
export function ensureTtyOrExit(commandName: string): void {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      `${ANSI.red}✗${ANSI.reset} /${commandName} requires an interactive terminal — stdin is not a TTY.\n`,
    );
    process.exit(2);
  }
}

// Convenience wrapper for flows: runs the body, catches Ctrl+C / abort cleanly,
// rethrows other errors so the REPL/dispatch loop can render them as usual.
export async function withCancelGuard(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (err) {
    if (isExitPromptError(err)) {
      process.stdout.write(`\n${ANSI.gray}Cancelled.${ANSI.reset}\n`);
      return;
    }
    throw err;
  }
}
