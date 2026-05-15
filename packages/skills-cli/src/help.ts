import { DEFAULT_API_URL, SKILL_CATEGORY_VALUES } from './parseArgs.js';

export function printHelp(): void {
  console.log(`Agentic Skill CLI

Usage:
  agentic-skill init <skill-id>
  agentic-skill test [manifest.json]
  agentic-skill publish [manifest.json]
  agentic-skill help

Commands:
  init <skill-id>   Scaffold a manifest + vitest test file.
  test              Validate a manifest locally, run coherence checks,
                    dry-run the no-signing executor, and preview the
                    next 3 scheduled runs.
  publish           POST a validated manifest to /api/skills/manifests.

Init flags:
  --author-wallet <pubkey>  Required (or env AGENTIC_AUTHOR_WALLET).
  --category <name>         One of: ${SKILL_CATEGORY_VALUES.join(', ')}.
                            Default: custom.
  --out <dir>               Output directory. Default: ./skills/<skill-id>.
  --force                   Overwrite an existing manifest.
  --dry-run                 Print to stdout; do not write files.

Test flags:
  --manifest <path>         Path to manifest.json. Default: positional arg
                            or ./manifest.json.

Publish flags:
  --manifest <path>         Path to manifest.json. Default: positional arg
                            or ./manifest.json.
  --api-url <url>           Base URL. Default: ${DEFAULT_API_URL}
                            (env AGENTIC_API_URL).
  --cookie <header-value>   Session cookie (env AGENTIC_COOKIE).
                            Copy from your browser's DevTools.

Global options:
  --json                    Print structured JSON output.
  --no-color                Disable ANSI color.
  -h, --help                Show this help.

Environment:
  AGENTIC_AUTHOR_WALLET     Default --author-wallet.
  AGENTIC_API_URL           Default --api-url.
  AGENTIC_COOKIE            Default --cookie.
  NO_COLOR=1                Disable colors.
`);
}
