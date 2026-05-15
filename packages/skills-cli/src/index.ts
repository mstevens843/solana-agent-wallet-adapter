#!/usr/bin/env node
import { printHelp } from './help.js';
import { runInit } from './init.js';
import { errorMessage, NO_OUTPUT, printError, printResult, type CliResult } from './output.js';
import { parseArgs, type ParsedArgs } from './parseArgs.js';
import { runPublish } from './publish.js';
import { runTest } from './test.js';

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const command = parsed.positionals[0];

  if (parsed.options.help || command === undefined || command === 'help') {
    printHelp();
    return;
  }

  const result = await dispatch(parsed, command);
  printResult(result, parsed.options);
}

async function dispatch(parsed: ParsedArgs, command: string): Promise<CliResult> {
  switch (command) {
    case 'init':
      return runInit(parsed);
    case 'test':
      return runTest(parsed);
    case 'publish':
      return runPublish(parsed);
    default:
      throw new Error(`Unknown command: ${command}. Run agentic-skill help.`);
  }
}

void main().catch((err) => {
  const parsed = (() => {
    try {
      return parseArgs(process.argv.slice(2));
    } catch {
      return null;
    }
  })();
  const message = errorMessage(err);
  if (parsed) {
    printError(parsed.options, message);
  } else {
    console.error(message);
  }
  process.exit(1);
});

export { NO_OUTPUT };
