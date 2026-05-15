export const SKILL_CATEGORY_VALUES = [
  'dca',
  'yield',
  'stops',
  'bridge',
  'donation',
  'custom',
] as const;

export type SkillCategory = (typeof SKILL_CATEGORY_VALUES)[number];

export const DEFAULT_API_URL = 'http://localhost:3000';

export interface SkillsCliOptions {
  help: boolean;
  json: boolean;
  color: boolean;
  authorWallet?: string;
  category?: SkillCategory;
  outDir?: string;
  force: boolean;
  dryRun: boolean;
  manifestPath?: string;
  apiUrl: string;
  cookie?: string;
}

export interface ParsedArgs {
  options: SkillsCliOptions;
  positionals: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const options: SkillsCliOptions = {
    help: false,
    json: false,
    color: process.env.NO_COLOR !== '1' && process.env.NO_COLOR !== 'true',
    authorWallet: process.env.AGENTIC_AUTHOR_WALLET,
    apiUrl: stripTrailingSlash(process.env.AGENTIC_API_URL ?? DEFAULT_API_URL),
    cookie: process.env.AGENTIC_COOKIE,
    force: false,
    dryRun: false,
  };

  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    const [flag, inlineValue] = splitFlag(arg);

    if (flag === '--help' || flag === '-h') {
      options.help = true;
      continue;
    }
    if (flag === '--json') {
      options.json = true;
      continue;
    }
    if (flag === '--no-color') {
      options.color = false;
      continue;
    }
    if (flag === '--color') {
      options.color = true;
      continue;
    }
    if (flag === '--force') {
      options.force = true;
      continue;
    }
    if (flag === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (flag === '--author-wallet') {
      const value = optionArgument(argv, index, flag, inlineValue);
      options.authorWallet = value.value;
      index = value.index;
      continue;
    }
    if (flag === '--category') {
      const value = optionArgument(argv, index, flag, inlineValue);
      if (!isSkillCategory(value.value)) {
        throw new Error(
          `Invalid --category "${value.value}". Expected one of: ${SKILL_CATEGORY_VALUES.join(', ')}.`,
        );
      }
      options.category = value.value;
      index = value.index;
      continue;
    }
    if (flag === '--out') {
      const value = optionArgument(argv, index, flag, inlineValue);
      options.outDir = value.value;
      index = value.index;
      continue;
    }
    if (flag === '--manifest') {
      const value = optionArgument(argv, index, flag, inlineValue);
      options.manifestPath = value.value;
      index = value.index;
      continue;
    }
    if (flag === '--api-url') {
      const value = optionArgument(argv, index, flag, inlineValue);
      options.apiUrl = stripTrailingSlash(value.value);
      index = value.index;
      continue;
    }
    if (flag === '--cookie') {
      const value = optionArgument(argv, index, flag, inlineValue);
      options.cookie = value.value;
      index = value.index;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}. Run agentic-skill help.`);
    }

    positionals.push(arg);
  }

  return { options, positionals };
}

function isSkillCategory(value: string): value is SkillCategory {
  return (SKILL_CATEGORY_VALUES as readonly string[]).includes(value);
}

function splitFlag(arg: string): [string, string | undefined] {
  if (!arg.startsWith('-')) {
    return [arg, undefined];
  }
  const eq = arg.indexOf('=');
  if (eq < 0) {
    return [arg, undefined];
  }
  return [arg.slice(0, eq), arg.slice(eq + 1)];
}

function optionArgument(
  argv: string[],
  index: number,
  flag: string,
  inlineValue: string | undefined,
): { value: string; index: number } {
  if (inlineValue !== undefined) {
    return { value: inlineValue, index };
  }
  if (index + 1 >= argv.length) {
    throw new Error(`${flag} requires a value`);
  }
  return { value: argv[index + 1]!, index: index + 1 };
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
