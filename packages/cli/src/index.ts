#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import process from 'node:process';
import * as readline from 'node:readline/promises';

import {
  DEFAULT_CONFIG,
  JsonLabArtifactStore,
  JsonPreparedActionStore,
  LocalBridgeBackend,
  createBridgeServer,
  defaultLabArtifactStorePath,
  loadConfig,
} from '@solana-agent-wallet-adapter/mcp-server';
import {
  defaultTemplateFieldValues,
  inferTemplateIdForPrompt,
  inferredTemplateParameters,
  templateById,
  type AgentPlan as SharedAgentPlan,
  type AiPlanRequest,
} from '@solana-agent-wallet-adapter/workflow';

type Cluster = 'mainnet-beta' | 'testnet' | 'devnet' | 'localnet';
type PreparedActionKind =
  | 'transfer_sol'
  | 'transfer_spl'
  | 'swap'
  | 'kamino_deposit'
  | 'kamino_withdraw'
  | 'blink_action'
  | (string & {});
type PreparedActionStatus =
  | 'scheduled'
  | 'ready'
  | 'overdue'
  | 'approval_pending'
  | 'approved'
  | 'rejected'
  | 'blocked'
  | 'failed';
type PreparedActionTxStatus = 'pending' | 'confirmed' | 'failed';
type RecurringCadence = 'weekly' | 'monthly' | 'interval_days' | 'interval_hours' | 'interval_minutes';
type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'failed';
type RiskLevel = 'low' | 'medium' | 'high';
type JsonRecord = Record<string, unknown>;

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8787';
const DEFAULT_WALLET_HOST_URL = 'http://127.0.0.1:5174';
const REQUEST_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 750;
const RUNTIME_DIR_NAME = 'solana-agent-wallet';
const WALLET_HOST_HEALTH_PATH = '/__agentic/health';
const NO_OUTPUT = Symbol('no-output');
const DEFAULT_JUPITER_ULTRA_BASE = 'https://api.jup.ag/swap/v2';
const DEFAULT_JUPITER_API_URL = 'https://quote-api.jup.ag';
const DEFAULT_BIRDEYE_REST_BASE = 'https://public-api.birdeye.so';
const SETUP_ENV_KEYS = [
  'SOLANA_RPC_URL',
  'HELIUS_RPC_URL',
  'JUPITER_API_KEY',
  'JUP_API_KEY',
  'JUPITER_SWAP_BASE_URL',
  'JUP_ULTRA_BASE',
  'JUPITER_API_URL',
  'BIRDEYE_API_KEY',
  'BIRDEYE_REST_BASE',
] as const;
const BLINK_BOUNDARY_COPY = 'Prepared Blink action. Wallet approval required.';

interface ParsedArgs {
  options: GlobalOptions;
  positionals: string[];
}

interface GlobalOptions {
  bridgeUrl: string;
  token: string;
  walletHostUrl: string;
  repoRoot: string | null;
  runtimeDir: string;
  envPath: string;
  configPath: string;
  preparedActionsPath: string;
  labArtifactsPath: string;
  walletHostDir: string;
  json: boolean;
  color: boolean;
  help: boolean;
}

interface SetupCommandOptions {
  rpcUrl?: string;
  jupiterApiKey?: string;
  jupiterUltraBase?: string;
  jupiterApiUrl?: string;
  birdeyeApiKey?: string;
  birdeyeRestBase?: string;
  yes: boolean;
}

interface RuntimeSetupStatus {
  envPath: string;
  envFound: boolean;
  rpcUrlConfigured: boolean;
  rpcUrlRedacted: string | null;
  jupiterApiKeyConfigured: boolean;
  jupiterApiKeyRedacted: string | null;
  jupiterUltraBase: string;
  jupiterApiUrl: string;
  birdeyeApiKeyConfigured: boolean;
  birdeyeApiKeyRedacted: string | null;
  birdeyeRestBase: string;
  solTransfersReady: boolean;
  tokenTransfersReady: boolean;
  swapsReady: boolean;
  marketDataReady: boolean;
}

interface PreparedAction {
  id: string;
  kind: PreparedActionKind;
  status: PreparedActionStatus;
  walletAddress: string;
  cluster: Cluster;
  summary: string;
  params: JsonRecord;
  dueAt: string;
  createdAt: string;
  updatedAt: string;
  activeRequestId?: string;
  txid?: string;
  txStatus?: PreparedActionTxStatus;
  confirmedAt?: string;
  txError?: string;
  error?: string;
  note?: string;
  recurringId?: string;
  archived?: boolean;
}

interface RecurringPayment {
  id: string;
  status: 'active' | 'paused';
  walletAddress: string;
  cluster: Cluster;
  token: string;
  recipient: string;
  amount: string;
  cadence: RecurringCadence;
  dayOfWeek?: number;
  dayOfMonth?: number;
  intervalDays?: number;
  intervalHours?: number;
  intervalMinutes?: number;
  localTime?: string;
  startAt?: string;
  maxOccurrences?: number;
  occurrencesCreated?: number;
  note?: string;
  createdAt: string;
  updatedAt: string;
  nextDueAt?: string;
}

interface ActionReceipt {
  actionId: string;
  status: PreparedActionStatus;
  txStatus?: PreparedActionTxStatus;
  txid?: string;
  explorerUrl?: string;
  summary: string;
  note?: string;
  walletAddress: string;
  recipient?: string;
  amount?: string;
  token?: string;
  cluster: Cluster;
  createdAt: string;
  completedAt: string;
  error?: string;
  recurringId?: string;
  occurrenceKey?: string;
}

interface BridgeHealth {
  walletConnected?: boolean;
  walletAddress?: string | null;
  bridgeConnected?: boolean;
  mcpReady?: boolean;
  cluster?: Cluster | null;
  rpcUrl?: string | null;
  rpcWritable?: unknown;
  mainnetEnabled?: boolean;
  capsEnabled?: boolean;
  preparedActionStorePath?: string | null;
  labArtifactStorePath?: string | null;
}

interface WalletStatus {
  connected?: boolean;
  address?: string | null;
  cluster?: Cluster;
  rpcUrl?: string;
  mainnetEnabled?: boolean;
  caps?: unknown;
  tokens?: unknown;
}

interface SigningRequest {
  id: string;
  kind: 'sign_message' | 'sign_transaction' | 'sign_and_send_transaction';
  payload: {
    data: string;
    encoding: 'utf8' | 'base64';
  };
  cluster: Cluster;
  display?: {
    summary?: string;
    riskLevel?: RiskLevel;
  };
  expiresAt?: number;
}

interface ApprovalResource {
  requestId: string;
  status: ApprovalStatus;
  result?: {
    signature: string;
    txid?: string;
  };
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };
}

interface TerminalAppState {
  options: GlobalOptions;
  bridgeProcess: ChildProcess | null;
  browserProcess: ChildProcess | null;
  logs: string[];
  lastActions: PreparedAction[];
  lastRecurring: RecurringPayment[];
  lastReceipts: ActionReceipt[];
}

interface TerminalAgentPlan {
  intent: string;
  route: string;
  risk: RiskLevel;
  constraints: string[];
  createdAt: string;
}

interface BridgeAiStatus {
  available: boolean;
  configured: boolean;
  source: 'env' | 'session' | 'none';
  provider?: string;
  apiFormat?: string;
  baseUrl?: string;
  model?: string;
}

type CliAgentPlan = TerminalAgentPlan | SharedAgentPlan;

interface ResearchArtifact {
  version: 'terminal-research-v1';
  id: string;
  title: string;
  kind: string;
  concept: string;
  input: string;
  walletAddress: string | null;
  cluster: Cluster;
  createdAt: string;
  payloadHash: string;
  signature?: string;
  requestId?: string;
}

interface ResearchLab {
  id: string;
  title: string;
  kind: string;
  defaultInput: string;
  description: string;
}

const RESEARCH_LABS: ResearchLab[] = [
  {
    id: 'flight',
    title: '1. Flight Recorder',
    kind: 'agent_flight_recorder',
    defaultInput:
      'Swap 0.05 SOL to USDC only if simulation shows no new authority grants and the route stays within 50 bps slippage.',
    description: "Bind the agent's stated intent, plan, tool trace, and risk interpretation to the wallet signature.",
  },
  {
    id: 'auction',
    title: '2. Intent Auctions',
    kind: 'signed_intent_auction',
    defaultInput: 'Ask three quote agents for the best SOL to USDC route and select only offers matching my caps.',
    description: 'Sign demand once, then let competing agents attach auditable offers without gaining custody.',
  },
  {
    id: 'cosigner',
    title: '3. Risk Co-Signers',
    kind: 'risk_cosigner_market',
    defaultInput: 'Review this swap request for unknown programs, authority deltas, route drift, and hidden approvals.',
    description: 'Collect multiple agent reviews before the wallet opens for the final settlement signature.',
  },
  {
    id: 'rejection',
    title: '4. Rejection Intelligence',
    kind: 'rejection_fingerprint',
    defaultInput: 'Reject any request that mentions unlimited approvals, private keys, or unknown custody delegation.',
    description: 'Turn a rejection into a reusable local safety fingerprint.',
  },
  {
    id: 'semantic',
    title: '5. Semantic Firewall',
    kind: 'semantic_firewall',
    defaultInput: 'Allow SOL to USDC swap semantics only when touched programs and authority changes match the explanation.',
    description: 'Compare what the agent says with what the eventual transaction does.',
  },
  {
    id: 'nonaction',
    title: '6. Proof of Non-Action',
    kind: 'signed_non_action',
    defaultInput: 'Do nothing unless SOL drops below the signed threshold and liquidity remains above the floor.',
    description: 'Prove the agent checked conditions and intentionally avoided a wallet action.',
  },
  {
    id: 'reputation',
    title: '7. Agent Reputation',
    kind: 'agent_reputation',
    defaultInput: 'Score the agent based on signed successes, rejections, warnings, and restraint proofs.',
    description: 'Make behavior portable across apps through wallet-signed outcome records.',
  },
  {
    id: 'blinks',
    title: '8. Agent-Reviewed Links',
    kind: 'agent_reviewed_blink',
    defaultInput: 'Review this Blink claim, summarize cost and authority deltas, and attach the signed interpretation.',
    description: 'Carry agent interpretation beside a Solana Action before wallet settlement.',
  },
  {
    id: 'capsule',
    title: '9. Intent Time Capsules',
    kind: 'intent_time_capsule',
    defaultInput: 'Seal an intent that can open later only if price, route, deadline, and slippage all match.',
    description: 'Sign future permission without allowing arbitrary future execution.',
  },
  {
    id: 'delegation',
    title: '10. Sub-Agent Delegation',
    kind: 'sub_agent_delegation',
    defaultInput: 'Delegate quote, risk, tax tag, and final explanation slices to specialist agents.',
    description: 'Let agents hire specialists while every responsibility slice remains signed and auditable.',
  },
  {
    id: 'outcome',
    title: '11. Outcome Signatures',
    kind: 'outcome_signature',
    defaultInput: 'Authorize only the acceptable end state: minimum USDC output, no authority grants, and capped fees.',
    description: 'Give agents path freedom while the wallet signs the acceptable result envelope.',
  },
  {
    id: 'insurance',
    title: '12. Request Insurance',
    kind: 'request_insurance',
    defaultInput: 'Quote coverage for route mismatch, simulation divergence, and known exploit classes.',
    description: 'Show deterministic risk-transfer terms beside the signing request.',
  },
  {
    id: 'constitution',
    title: '13. Personal Constitution',
    kind: 'personal_constitution',
    defaultInput: 'My wallet never signs unlimited approvals, mainnet-first tests, or swaps above 100 bps slippage.',
    description: 'Diff each request against a portable wallet-signed personal policy.',
  },
  {
    id: 'receipts',
    title: '14. Tool Receipts',
    kind: 'tool_receipts',
    defaultInput: 'Attach hashes for portfolio read, quote, simulation, policy diff, and final explanation tools.',
    description: 'Prove which tools and data the agent actually used before requesting approval.',
  },
  {
    id: 'apprentice',
    title: '15. Apprenticeship Mode',
    kind: 'apprenticeship_mode',
    defaultInput: 'Run five training scenarios and score the agent before granting live signing authority.',
    description: 'Require signed predictions and scorecards before an agent graduates to production signing.',
  },
];

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const command = parsed.positionals[0];

  if (parsed.options.help || command === undefined || command === 'help') {
    printHelp();
    return;
  }

  if (command === 'app') {
    await runTerminalApp(parsed);
    return;
  }

  const result = await dispatch(parsed);
  printResult(result, parsed.options);
}

async function dispatch(parsed: ParsedArgs): Promise<unknown> {
  const command = parsed.positionals[0];
  switch (command) {
    case 'setup':
      return runSetupCommand(parsed);
    case 'doctor':
      return runDoctor(parsed.options);
    case 'status':
    case 'wallet':
      return bridgeRequest<WalletStatus>(parsed.options, '/bridge/action/status');
    case 'health':
      return bridgeRequest<BridgeHealth>(parsed.options, '/bridge/action/health');
    case 'balances':
      return bridgeRequest(parsed.options, '/bridge/action/balances');
    case 'portfolio':
      return bridgeRequest(parsed.options, '/bridge/action/portfolio');
    case 'inbox':
      return dispatchInbox(parsed);
    case 'schedule':
      return dispatchSchedule(parsed);
    case 'prepare':
      return dispatchPrepare(parsed);
    case 'receipts':
      return bridgeRequest(parsed.options, '/bridge/receipts');
    case 'open':
      await openWalletHost(parsed.options);
      return { opened: walletHostLaunchUrl(parsed.options) };
    case 'connect':
      return connectOneShot(parsed.options);
    case 'research':
    case 'labs':
      return dispatchResearch(parsed);
    case 'bridge':
      return dispatchBridge(parsed);
    case 'wallet-host':
      return dispatchWalletHost(parsed);
    case 'session':
      return dispatchSession(parsed);
    case 'mpp':
      return dispatchMpp(parsed);
    default:
      throw new Error(`Unknown command: ${command ?? ''}. Run solana-agent-wallet help.`);
  }
}

async function dispatchSession(parsed: ParsedArgs): Promise<unknown> {
  // Phase 0 scaffolding for the streaming-session CLI surface. Phase 2E wires
  // each subcommand to the render-web /api/streaming/* endpoints + voucher
  // signing through the device agent (Android) or cloud relay (browser).
  const subcommand = parsed.positionals[1] ?? 'help';
  const knownSubs = new Set(['list', 'create', 'spend', 'revoke', 'history', 'settle']);
  if (subcommand === 'help' || !knownSubs.has(subcommand)) {
    return {
      command: 'session',
      subcommands: ['list', 'create', 'spend', 'revoke', 'history', 'settle'],
      status: 'not_implemented',
      message: 'Not implemented (Phase 2). Scaffolding only — Phase 2E wires this to render-web.',
    };
  }
  return {
    command: 'session',
    subcommand,
    status: 'not_implemented',
    message: 'Not implemented (Phase 2).',
  };
}

async function dispatchMpp(parsed: ParsedArgs): Promise<unknown> {
  // Phase 0 scaffolding for the MPP CLI surface. Phase 1 wires `mpp challenge
  // <file.json>` to /api/mpp/challenge and `mpp config` to /api/mpp/config.
  const subcommand = parsed.positionals[1] ?? 'help';
  const knownSubs = new Set(['challenge', 'config']);
  if (subcommand === 'help' || !knownSubs.has(subcommand)) {
    return {
      command: 'mpp',
      subcommands: ['challenge', 'config'],
      status: 'not_implemented',
      message: 'Not implemented (Phase 1). Scaffolding only — Phase 1 wires this to render-web.',
    };
  }
  return {
    command: 'mpp',
    subcommand,
    status: 'not_implemented',
    message: 'Not implemented (Phase 1).',
  };
}

async function dispatchBridge(parsed: ParsedArgs): Promise<unknown> {
  const subcommand = parsed.positionals[1] ?? 'status';
  if (subcommand === 'status') {
    const doctor = await runDoctor(parsed.options);
    return {
      bridgeUrl: parsed.options.bridgeUrl,
      walletHostUrl: walletHostLaunchUrl(parsed.options),
      doctor,
    };
  }
  if (subcommand === 'open') {
    await openWalletHost(parsed.options);
    return { opened: walletHostLaunchUrl(parsed.options) };
  }
  if (subcommand === 'start') {
    const health = await tryBridgeRequest<BridgeHealth>(parsed.options, '/bridge/health');
    if (health.ok) {
      return { alreadyRunning: true, bridgeUrl: parsed.options.bridgeUrl, health: health.value };
    }
    const child = startBridgeDetached(parsed.options);
    await waitForBridge(parsed.options, 8_000);
    return { started: true, pid: child.pid ?? null, bridgeUrl: parsed.options.bridgeUrl };
  }
  if (subcommand === 'serve') {
    await serveBridge(parsed.options);
    return NO_OUTPUT;
  }
  throw new Error(`Unknown bridge command: ${subcommand}`);
}

async function dispatchWalletHost(parsed: ParsedArgs): Promise<unknown> {
  const subcommand = parsed.positionals[1] ?? 'status';
  if (subcommand === 'status') {
    return {
      walletHostUrl: parsed.options.walletHostUrl,
      walletHostLaunchUrl: walletHostLaunchUrl(parsed.options),
      walletHostDir: parsed.options.walletHostDir,
      assetsAvailable: walletHostAssetsAvailable(parsed.options),
      reachable: await isWalletHostReachable(parsed.options),
    };
  }
  if (subcommand === 'open') {
    await openWalletHost(parsed.options);
    return { opened: walletHostLaunchUrl(parsed.options) };
  }
  if (subcommand === 'serve') {
    await serveWalletHost(parsed.options);
    return NO_OUTPUT;
  }
  throw new Error(`Unknown wallet-host command: ${subcommand}`);
}

async function runSetupCommand(parsed: ParsedArgs): Promise<unknown> {
  const setupOptions = parseSetupCommandOptions(parsed.positionals.slice(1));
  await ensureRuntimeFiles(parsed.options);
  const updates = await setupUpdates(parsed.options, setupOptions, null);
  await writeEnvUpdates(parsed.options.envPath, updates);
  const status = await runtimeSetupStatus(parsed.options);
  if (parsed.options.json) {
    return status;
  }
  printSetupStatus(parsed.options, status);
  return NO_OUTPUT;
}

async function runSetupInteractive(state: TerminalAppState, rl: readline.Interface): Promise<void> {
  await ensureRuntimeFiles(state.options);
  const updates = await setupUpdates(state.options, { yes: false }, rl);
  await writeEnvUpdates(state.options.envPath, updates);
  const status = await runtimeSetupStatus(state.options);
  printSetupStatus(state.options, status);
  if (state.bridgeProcess) {
    printWarn(state.options, 'Restart the terminal app or run /bridge again so the local bridge picks up the new .env values.');
  }
}

async function setupUpdates(
  options: GlobalOptions,
  setupOptions: SetupCommandOptions,
  rl: readline.Interface | null,
): Promise<Record<string, string>> {
  const env = await readEnvValues(options.envPath);
  const currentRpcUrl = firstValue(env.values, 'SOLANA_RPC_URL', 'HELIUS_RPC_URL') ?? '';
  const currentJupiterApiKey = firstValue(env.values, 'JUPITER_API_KEY', 'JUP_API_KEY') ?? '';
  const currentBirdeyeApiKey = env.values.BIRDEYE_API_KEY ?? '';
  let rpcUrl = setupOptions.rpcUrl ?? currentRpcUrl;
  let jupiterApiKey = setupOptions.jupiterApiKey ?? currentJupiterApiKey;
  let jupiterUltraBase = setupOptions.jupiterUltraBase
    ?? env.values.JUPITER_SWAP_BASE_URL
    ?? env.values.JUP_ULTRA_BASE
    ?? DEFAULT_JUPITER_ULTRA_BASE;
  let jupiterApiUrl = setupOptions.jupiterApiUrl
    ?? env.values.JUPITER_API_URL
    ?? DEFAULT_JUPITER_API_URL;
  let birdeyeApiKey = setupOptions.birdeyeApiKey ?? currentBirdeyeApiKey;
  let birdeyeRestBase = setupOptions.birdeyeRestBase
    ?? env.values.BIRDEYE_REST_BASE
    ?? DEFAULT_BIRDEYE_REST_BASE;

  const hasExplicitValues = setupOptions.rpcUrl !== undefined
    || setupOptions.jupiterApiKey !== undefined
    || setupOptions.jupiterUltraBase !== undefined
    || setupOptions.jupiterApiUrl !== undefined
    || setupOptions.birdeyeApiKey !== undefined
    || setupOptions.birdeyeRestBase !== undefined;
  const shouldPrompt = rl !== null || (!setupOptions.yes && process.stdin.isTTY && !hasExplicitValues);
  if (shouldPrompt) {
    const setupRl = rl ?? readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      printSection('Local Runtime Setup');
      console.log(`Writing setup to ${options.envPath}`);
      rpcUrl = await promptExistingSecret(setupRl, 'Solana RPC URL', currentRpcUrl);
      jupiterApiKey = await promptExistingSecret(setupRl, 'Jupiter API key', currentJupiterApiKey);
      jupiterUltraBase = await prompt(setupRl, 'Jupiter Swap API v2 base URL', jupiterUltraBase);
      jupiterApiUrl = await prompt(setupRl, 'Legacy Jupiter API URL', jupiterApiUrl);
      birdeyeApiKey = await promptExistingSecret(setupRl, 'BirdEye API key', currentBirdeyeApiKey);
      birdeyeRestBase = await prompt(setupRl, 'BirdEye REST base URL', birdeyeRestBase);
    } finally {
      if (!rl) {
        setupRl.close();
      }
    }
  }

  const updates: Record<string, string> = {};
  if (rpcUrl.trim()) {
    const normalizedRpcUrl = normalizeSetupUrl(rpcUrl, 'Solana RPC URL');
    updates.SOLANA_RPC_URL = normalizedRpcUrl;
    updates.HELIUS_RPC_URL = normalizedRpcUrl;
  }
  if (jupiterApiKey.trim()) {
    updates.JUPITER_API_KEY = jupiterApiKey.trim();
    updates.JUP_API_KEY = jupiterApiKey.trim();
  }
  updates.JUPITER_SWAP_BASE_URL = normalizeSetupUrl(jupiterUltraBase || DEFAULT_JUPITER_ULTRA_BASE, 'Jupiter Swap API v2 base URL');
  updates.JUP_ULTRA_BASE = updates.JUPITER_SWAP_BASE_URL;
  updates.JUPITER_API_URL = normalizeSetupUrl(jupiterApiUrl || DEFAULT_JUPITER_API_URL, 'Legacy Jupiter API URL');
  if (birdeyeApiKey.trim()) {
    updates.BIRDEYE_API_KEY = birdeyeApiKey.trim();
  }
  updates.BIRDEYE_REST_BASE = normalizeSetupUrl(birdeyeRestBase || DEFAULT_BIRDEYE_REST_BASE, 'BirdEye REST base URL');
  return updates;
}

function parseSetupCommandOptions(args: string[]): SetupCommandOptions {
  const options: SetupCommandOptions = { yes: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const [flag, inlineValue] = splitFlag(arg);
    if (flag === '--yes' || flag === '-y') {
      options.yes = true;
      continue;
    }
    if (flag === '--rpc-url' || flag === '--solana-rpc-url' || flag === '--helius-rpc-url') {
      const value = optionArgument(args, index, flag, inlineValue);
      options.rpcUrl = value.value;
      index = value.index;
      continue;
    }
    if (flag === '--jupiter-api-key' || flag === '--jup-api-key') {
      const value = optionArgument(args, index, flag, inlineValue);
      options.jupiterApiKey = value.value;
      index = value.index;
      continue;
    }
    if (flag === '--jupiter-swap-base-url' || flag === '--jupiter-swap-base' || flag === '--jupiter-ultra-base' || flag === '--jup-ultra-base' || flag === '--jupiter-base-url') {
      const value = optionArgument(args, index, flag, inlineValue);
      options.jupiterUltraBase = value.value;
      index = value.index;
      continue;
    }
    if (flag === '--jupiter-api-url') {
      const value = optionArgument(args, index, flag, inlineValue);
      options.jupiterApiUrl = value.value;
      index = value.index;
      continue;
    }
    if (flag === '--birdeye-api-key') {
      const value = optionArgument(args, index, flag, inlineValue);
      options.birdeyeApiKey = value.value;
      index = value.index;
      continue;
    }
    if (flag === '--birdeye-rest-base' || flag === '--birdeye-api-url') {
      const value = optionArgument(args, index, flag, inlineValue);
      options.birdeyeRestBase = value.value;
      index = value.index;
      continue;
    }
    throw new Error(`Unknown setup option: ${arg}`);
  }
  return options;
}

async function dispatchInbox(parsed: ParsedArgs): Promise<unknown> {
  const op = parsed.positionals[1] ?? 'list';
  if (op === 'list' || op === 'compact') {
    const response = await refreshPreparedActions(parsed.options);
    if (parsed.options.json) {
      return response;
    }
    const filter = parsed.positionals[2] ?? 'all';
    const visible = filterPreparedActions(response.actions, filter);
    printSection('Approval Inbox');
    console.log(`${visible.length} shown, ${response.actions.length} total. Filter: ${filter}`);
    if (op === 'compact') {
      renderPreparedActionsCompact(visible);
    } else {
      renderPreparedActionsDetailed(visible);
    }
    return NO_OUTPUT;
  }
  if (op === 'inspect') {
    const actionId = parsed.positionals[2];
    if (!actionId) {
      throw new Error('Usage: solana-agent-wallet inbox inspect <action-id>');
    }
    const action = await inspectPreparedAction(parsed.options, actionId);
    if (parsed.options.json) {
      return action;
    }
    printSection(`Prepared Action ${action.id}`);
    printPreparedActionDetail(action, 0);
    return NO_OUTPUT;
  }

  const actionId = parsed.positionals[2];
  if (!actionId) {
    throw new Error(`inbox ${op} requires an action id.`);
  }

  if (op === 'approve') {
    const action = await inspectPreparedAction(parsed.options, actionId);
    assertActionApprovable(action);
    await connectOneShot(parsed.options);
    await openWalletHost(parsed.options).catch(() => undefined);
    return bridgeRequest(parsed.options, '/bridge/prepared-actions/execute', {
      method: 'POST',
      body: JSON.stringify({ actionId: action.id }),
    });
  }
  if (op === 'reject') {
    const action = await inspectPreparedAction(parsed.options, actionId);
    assertActionRejectable(action);
    const reason = optionValue(parsed.positionals, '--reason') ?? 'Rejected from terminal.';
    return bridgeRequest(parsed.options, '/bridge/prepared-actions/reject', {
      method: 'POST',
      body: JSON.stringify({ actionId: action.id, reason }),
    });
  }
  if (op === 'archive') {
    return bridgeRequest(parsed.options, '/bridge/prepared-actions/archive', {
      method: 'POST',
      body: JSON.stringify({ actionId }),
    });
  }
  if (op === 'delete') {
    return bridgeRequest(parsed.options, '/bridge/prepared-actions/delete', {
      method: 'POST',
      body: JSON.stringify({ actionId }),
    });
  }

  throw new Error(`Unknown inbox command: ${op}`);
}

async function dispatchResearch(parsed: ParsedArgs): Promise<unknown> {
  const op = parsed.positionals[1] ?? 'list';
  if (op === 'list') {
    return { labs: RESEARCH_LABS };
  }
  if (op === 'sign') {
    const labKey = parsed.positionals[2];
    if (!labKey) {
      throw new Error('Usage: solana-agent-wallet research sign <number|id> [artifact input]');
    }
    const lab = resolveResearchLab(labKey);
    const input = parsed.positionals.slice(3).join(' ') || lab.defaultInput;
    const state = createOneShotState(parsed.options);
    await connectInteractive(state, { waitForWallet: true, detached: true });
    const artifact = await buildResearchArtifact(parsed.options, lab, input);
    const approval = await signTextWithWallet(
      state,
      researchSigningMessage(artifact),
      `${artifact.title} artifact`,
      'low',
    );
    artifact.signature = approval.result?.signature;
    artifact.requestId = approval.requestId;
    await saveResearchArtifact(parsed.options, artifact);
    return artifact;
  }
  throw new Error(`Unknown research command: ${op}`);
}

async function dispatchSchedule(parsed: ParsedArgs): Promise<unknown> {
  const op = parsed.positionals[1] ?? 'list';
  if (op === 'list') {
    return bridgeRequest(parsed.options, '/bridge/recurring-payments');
  }
  const recurringId = parsed.positionals[2];
  if (!recurringId) {
    throw new Error(`schedule ${op} requires a recurring id.`);
  }
  if (op === 'pause' || op === 'resume' || op === 'delete') {
    return bridgeRequest(parsed.options, `/bridge/recurring-payments/${op}`, {
      method: 'POST',
      body: JSON.stringify({ recurringId }),
    });
  }
  throw new Error(`Unknown schedule command: ${op}`);
}

async function dispatchPrepare(parsed: ParsedArgs): Promise<unknown> {
  const kind = parsed.positionals[1];
  const prepareValueFlags = new Set([
    '--note',
    '--due-at',
    '--slippage-bps',
    '--url',
    '--blink-url',
    '--connector',
    '--protocol',
    '--operation',
    '--account',
    '--expected-amount',
    '--expected-token',
    '--expected-recipient',
    '--position',
    '--parameter',
    '--param',
  ]);
  const rawArgs = commandValues(parsed.positionals.slice(2), prepareValueFlags);
  const note = optionValue(parsed.positionals, '--note');
  const dueAt = optionValue(parsed.positionals, '--due-at');
  const slippageBpsRaw = optionValue(parsed.positionals, '--slippage-bps');
  const slippageBps = slippageBpsRaw ? Number(slippageBpsRaw) : undefined;

  if (kind === 'transfer-sol') {
    const recipient = rawArgs[0];
    const amountSol = rawArgs[1];
    if (!recipient || !amountSol) {
      throw new Error('Usage: solana-agent-wallet prepare transfer-sol <recipient> <amount-sol>');
    }
    await connectOneShot(parsed.options);
    return bridgeRequest(parsed.options, '/bridge/action/prepare-transfer-sol', {
      method: 'POST',
      body: JSON.stringify(removeUndefined({ recipient, amountSol, dueAt, note })),
    });
  }

  if (kind === 'transfer-spl') {
    const token = rawArgs[0];
    const recipient = rawArgs[1];
    const amount = rawArgs[2];
    if (!token || !recipient || !amount) {
      throw new Error('Usage: solana-agent-wallet prepare transfer-spl <token> <recipient> <amount>');
    }
    await connectOneShot(parsed.options);
    return bridgeRequest(parsed.options, '/bridge/action/prepare-transfer-spl', {
      method: 'POST',
      body: JSON.stringify(removeUndefined({ token, recipient, amount, dueAt, note })),
    });
  }

  if (kind === 'swap') {
    const amount = rawArgs[0];
    const inputToken = rawArgs[1] ?? 'SOL';
    const outputToken = rawArgs[2] ?? 'USDC';
    if (!amount) {
      throw new Error('Usage: solana-agent-wallet prepare swap <amount> [input-token] [output-token]');
    }
    await connectOneShot(parsed.options);
    return bridgeRequest(parsed.options, '/bridge/action/prepare-swap', {
      method: 'POST',
      body: JSON.stringify(removeUndefined({ amount, inputToken, outputToken, slippageBps, dueAt, note })),
    });
  }

  if (kind === 'blink') {
    const blinkUrl = optionValue(parsed.positionals, '--url') ?? optionValue(parsed.positionals, '--blink-url') ?? rawArgs[0];
    if (!blinkUrl) {
      throw new Error('Usage: solana-agent-wallet prepare blink --url <url> [--connector <id>] [--operation <label>]');
    }
    const parameters = parseStringParameters([
      ...optionValues(parsed.positionals, '--parameter'),
      ...optionValues(parsed.positionals, '--param'),
    ]);
    await connectOneShot(parsed.options);
    return bridgeRequest(parsed.options, '/bridge/action/prepare-blink', {
      method: 'POST',
      body: JSON.stringify(removeUndefined({
        blinkUrl,
        connector: optionValue(parsed.positionals, '--connector'),
        protocol: optionValue(parsed.positionals, '--protocol'),
        operation: optionValue(parsed.positionals, '--operation'),
        account: optionValue(parsed.positionals, '--account'),
        expectedAmount: optionValue(parsed.positionals, '--expected-amount'),
        expectedToken: optionValue(parsed.positionals, '--expected-token'),
        expectedRecipient: optionValue(parsed.positionals, '--expected-recipient'),
        position: optionValue(parsed.positionals, '--position'),
        parameters: Object.keys(parameters).length > 0 ? parameters : undefined,
        dueAt,
        note,
      })),
    });
  }

  throw new Error('Usage: solana-agent-wallet prepare <transfer-sol|transfer-spl|swap|blink> ...');
}

async function runTerminalApp(parsed: ParsedArgs): Promise<void> {
  const state: TerminalAppState = {
    options: parsed.options,
    bridgeProcess: null,
    browserProcess: null,
    logs: [],
    lastActions: [],
    lastRecurring: [],
    lastReceipts: [],
  };
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  process.once('SIGINT', () => {
    cleanupApp(state);
    process.exit(0);
  });

  try {
    renderBanner(state);
    await bootstrapTerminalApp(state);
    await renderDashboard(state);
    printCommandMenu();

    while (true) {
      const line = (await rl.question(colorize(state.options, 'sawa> ', 'green'))).trim();
      if (!line) {
        continue;
      }
      const shouldExit = await handleTerminalCommand(state, rl, line);
      if (shouldExit) {
        break;
      }
    }
  } finally {
    rl.close();
    cleanupApp(state);
  }
}

async function bootstrapTerminalApp(state: TerminalAppState): Promise<void> {
  printMuted(state.options, 'Checking local bridge and wallet host...');
  await ensureBridge(state).catch((err) => {
    pushLog(state, `bridge bootstrap failed: ${errorMessage(err)}`);
    printWarn(state.options, `Bridge was not started automatically: ${errorMessage(err)}`);
  });
  await ensureBrowserHost(state).catch((err) => {
    pushLog(state, `wallet host bootstrap failed: ${errorMessage(err)}`);
    printWarn(state.options, `Wallet host was not started automatically: ${errorMessage(err)}`);
  });
  await openWalletHost(state.options).catch((err) => {
    pushLog(state, `open wallet host failed: ${errorMessage(err)}`);
  });
}

function createOneShotState(options: GlobalOptions): TerminalAppState {
  return {
    options,
    bridgeProcess: null,
    browserProcess: null,
    logs: [],
    lastActions: [],
    lastRecurring: [],
    lastReceipts: [],
  };
}

async function connectOneShot(options: GlobalOptions): Promise<JsonRecord> {
  const state = createOneShotState(options);
  await connectInteractive(state, { waitForWallet: true, detached: true });
  const status = await bridgeRequest<WalletStatus>(options, '/bridge/action/status');
  return {
    connected: Boolean(status.connected),
    address: status.address ?? null,
    cluster: status.cluster ?? null,
    walletHost: walletHostLaunchUrl(options),
  };
}

async function connectInteractive(
  state: TerminalAppState,
  options: { waitForWallet: boolean; detached?: boolean },
): Promise<void> {
  if (options.detached) {
    await ensureBridgeDetached(state.options);
    await ensureBrowserHostDetached(state.options);
  } else {
    await ensureBridge(state);
    await ensureBrowserHost(state);
  }
  await openWalletHost(state.options);
  const status = await tryBridgeRequest<WalletStatus>(state.options, '/bridge/action/status');
  if (status.ok && status.value.connected && status.value.address) {
    if (!state.options.json) {
      printOk(state.options, `Wallet connected: ${status.value.address}`);
    }
    return;
  }
  if (!state.options.json) {
    printSection('Connect Wallet');
    console.log(`Opened: ${walletHostLaunchUrl(state.options)}`);
    console.log('In the browser window:');
    console.log('1. Unlock Phantom, Backpack, Solflare, or another Wallet Standard wallet.');
    console.log('2. Connect the wallet.');
    console.log('3. Click Connect bridge if the page shows that button.');
    console.log('4. Return here; the terminal will detect the wallet.');
  }
  if (!options.waitForWallet) {
    return;
  }
  const connected = await waitForWalletConnection(state.options, 120_000);
  if (!state.options.json) {
    printOk(state.options, `Wallet connected: ${connected.address ?? 'connected'}`);
  }
}

async function handleTerminalCommand(
  state: TerminalAppState,
  rl: readline.Interface,
  line: string,
): Promise<boolean> {
  const [command, ...args] = splitCommandLine(line);
  const name = command?.startsWith('/') ? command.slice(1).toLowerCase() : 'plan';
  const naturalLanguage = command?.startsWith('/') ? args.join(' ') : line;

  try {
    switch (name) {
      case 'help':
      case '?':
        printCommandMenu();
        return false;
      case 'quit':
      case 'exit':
        return true;
      case 'doctor':
        printDoctor(state.options, await runDoctor(state.options));
        return false;
      case 'setup':
        await runSetupInteractive(state, rl);
        return false;
      case 'status':
      case 'wallet':
        await printWallet(state);
        return false;
      case 'balances':
        await printBalances(state);
        return false;
      case 'portfolio':
        await printPortfolio(state);
        return false;
      case 'open':
        await ensureBrowserHost(state);
        await openWalletHost(state.options);
        printOk(state.options, 'Opened the browser wallet host.');
        return false;
      case 'connect':
        await connectInteractive(state, { waitForWallet: true });
        return false;
      case 'bridge':
        await ensureBridge(state);
        printOk(state.options, `Bridge reachable at ${state.options.bridgeUrl}.`);
        return false;
      case 'inbox':
        await printInbox(state, args[0] === 'compact' ? args[1] ?? 'all' : args[0] ?? 'all', args[0] === 'compact');
        return false;
      case 'inspect':
        await inspectPreparedActionInteractive(state, args[0]);
        return false;
      case 'approve':
      case 'sign':
        await approvePreparedAction(state, args[0]);
        return false;
      case 'reject':
        await rejectPreparedAction(state, args[0], args.slice(1).join(' ') || undefined);
        return false;
      case 'archive':
        await archivePreparedAction(state, args[0]);
        return false;
      case 'schedule':
        await runScheduleCommand(state, rl, args);
        return false;
      case 'plan':
        await runPlanCommand(state, rl, naturalLanguage);
        return false;
      case 'research':
      case 'labs':
        await runResearchCommand(state, rl, args);
        return false;
      case 'receipts':
        await printReceipts(state);
        return false;
      case 'logs':
        printLogs(state);
        return false;
      case 'quote':
        await runQuoteCommand(state, rl);
        return false;
      case 'refresh':
        await renderDashboard(state);
        return false;
      default:
        printWarn(state.options, `Unknown command: /${name}. Run /help.`);
        return false;
    }
  } catch (err) {
    printError(state.options, errorMessage(err));
    return false;
  }
}

async function printWallet(state: TerminalAppState): Promise<void> {
  const [statusResult, healthResult] = await Promise.all([
    tryBridgeRequest<WalletStatus>(state.options, '/bridge/action/status'),
    tryBridgeRequest<BridgeHealth>(state.options, '/bridge/action/health'),
  ]);
  if (!statusResult.ok) {
    throw statusResult.error;
  }
  const status = statusResult.value;
  const health = healthResult.ok ? healthResult.value : {};
  printSection('Wallet');
  console.log(`Address: ${status.address ? short(status.address, 10) : 'not connected'}`);
  console.log(`Connected: ${status.connected ? 'yes' : 'no'}`);
  console.log(`Cluster: ${status.cluster ?? health.cluster ?? 'unknown'}`);
  console.log(`RPC: ${status.rpcUrl ?? health.rpcUrl ?? 'unknown'}`);
  console.log(`Mainnet caps: ${status.mainnetEnabled ? 'enabled' : 'disabled'}`);
  console.log(`Wallet host: ${walletHostLaunchUrl(state.options)}`);
}

async function requireWalletConnected(state: TerminalAppState): Promise<WalletStatus> {
  const current = await tryBridgeRequest<WalletStatus>(state.options, '/bridge/action/status');
  if (current.ok && current.value.connected && current.value.address) {
    return current.value;
  }
  await connectInteractive(state, { waitForWallet: true });
  return bridgeRequest<WalletStatus>(state.options, '/bridge/action/status');
}

async function printBalances(state: TerminalAppState): Promise<void> {
  await requireWalletConnected(state);
  const balances = await bridgeRequest<JsonRecord>(state.options, '/bridge/action/balances');
  printSection('Balances');
  console.log(`Address: ${String(balances.address ?? '')}`);
  console.log(`SOL: ${String(balances.sol ?? '0')}`);
  const tokens = Array.isArray(balances.tokens) ? balances.tokens : [];
  if (tokens.length > 0) {
    renderUnknownTable(tokens, ['symbol', 'amount', 'mint']);
  }
}

async function printPortfolio(state: TerminalAppState): Promise<void> {
  await requireWalletConnected(state);
  const portfolio = await bridgeRequest<JsonRecord>(state.options, '/bridge/action/portfolio');
  printSection('Portfolio');
  console.log(`Address: ${String(portfolio.address ?? '')}`);
  console.log(`SOL: ${String(portfolio.sol ?? '0')}`);
  const configuredTokens = Array.isArray(portfolio.configuredTokens) ? portfolio.configuredTokens : [];
  const unknownTokenAccounts = Array.isArray(portfolio.unknownTokenAccounts) ? portfolio.unknownTokenAccounts : [];
  const recentSignatures = Array.isArray(portfolio.recentSignatures) ? portfolio.recentSignatures : [];
  if (configuredTokens.length > 0) {
    console.log('\nConfigured tokens');
    renderUnknownTable(configuredTokens, ['symbol', 'amount', 'mint']);
  }
  if (unknownTokenAccounts.length > 0) {
    console.log('\nOther token accounts');
    renderUnknownTable(unknownTokenAccounts, ['amount', 'mint', 'account']);
  }
  if (recentSignatures.length > 0) {
    console.log('\nRecent signatures');
    renderUnknownTable(recentSignatures, ['signature', 'slot', 'err']);
  }
}

async function printInbox(state: TerminalAppState, filter = 'all', compact = false): Promise<void> {
  const response = await refreshPreparedActions(state.options);
  const visible = filterPreparedActions(response.actions, filter);
  state.lastActions = visible;
  printSection('Approval Inbox');
  console.log(`${visible.length} shown, ${response.actions.length} total. Filter: ${filter}`);
  if (compact) {
    renderPreparedActionsCompact(visible);
  } else {
    renderPreparedActionsDetailed(visible);
  }
}

async function approvePreparedAction(state: TerminalAppState, idOrIndex: string | undefined): Promise<void> {
  const action = await resolveAction(state, idOrIndex);
  assertActionApprovable(action);
  await connectInteractive(state, { waitForWallet: true });
  printMuted(state.options, 'Approval request sent. Use the browser wallet popup to complete signing.');
  const result = await bridgeRequest(state.options, '/bridge/prepared-actions/execute', {
    method: 'POST',
    body: JSON.stringify({ actionId: action.id }),
  });
  printOk(state.options, `Approved prepared action ${action.id}.`);
  console.log(stableJson(result));
  await printInbox(state, 'all').catch(() => undefined);
}

async function rejectPreparedAction(
  state: TerminalAppState,
  idOrIndex: string | undefined,
  reason: string | undefined,
): Promise<void> {
  const action = await resolveAction(state, idOrIndex);
  assertActionRejectable(action);
  const result = await bridgeRequest(state.options, '/bridge/prepared-actions/reject', {
    method: 'POST',
    body: JSON.stringify({ actionId: action.id, reason: reason ?? 'Rejected from terminal.' }),
  });
  printOk(state.options, `Rejected prepared action ${action.id}.`);
  console.log(stableJson(result));
}

async function archivePreparedAction(state: TerminalAppState, idOrIndex: string | undefined): Promise<void> {
  const action = await resolveAction(state, idOrIndex);
  const result = await bridgeRequest(state.options, '/bridge/prepared-actions/archive', {
    method: 'POST',
    body: JSON.stringify({ actionId: action.id }),
  });
  printOk(state.options, `Archived prepared action ${action.id}.`);
  console.log(stableJson(result));
}

async function inspectPreparedActionInteractive(
  state: TerminalAppState,
  idOrIndex: string | undefined,
): Promise<void> {
  const action = await resolveAction(state, idOrIndex);
  printSection(`Prepared Action ${action.id}`);
  printPreparedActionDetail(action, 0);
}

async function runScheduleCommand(
  state: TerminalAppState,
  rl: readline.Interface,
  args: string[],
): Promise<void> {
  const op = args[0] ?? 'new';
  if (op === 'list') {
    const response = await bridgeRequest<{ recurringPayments?: RecurringPayment[] }>(
      state.options,
      '/bridge/recurring-payments',
    );
    state.lastRecurring = response.recurringPayments ?? [];
    printSection('Schedule');
    renderRecurringPayments(state.lastRecurring);
    return;
  }
  if (op === 'pause' || op === 'resume' || op === 'delete') {
    const recurringId = args[1];
    if (!recurringId) {
      throw new Error(`/schedule ${op} requires a recurring id.`);
    }
    const result = await bridgeRequest(state.options, `/bridge/recurring-payments/${op}`, {
      method: 'POST',
      body: JSON.stringify({ recurringId }),
    });
    printOk(state.options, `Recurring payment ${op}: ${recurringId}`);
    console.log(stableJson(result));
    return;
  }

  await requireWalletConnected(state);
  printSection('New Schedule');
  const token = (await prompt(rl, 'Token', 'SOL')).toUpperCase();
  const recipient = await promptRequired(rl, 'Recipient address');
  const amount = await promptRequired(rl, `Amount ${token}`);
  const cadenceChoice = (await prompt(rl, 'Cadence (weekly/monthly/days/hours/minutes)', 'weekly')).toLowerCase();
  const localTime = await prompt(rl, 'Local time HH:MM', '09:00');
  const note = await prompt(rl, 'Note', 'Terminal recurring approval');
  const body: JsonRecord = { token, recipient, amount, localTime, note };

  if (cadenceChoice === 'weekly') {
    body.cadence = 'weekly';
    body.dayOfWeek = Number(await prompt(rl, 'Day of week 0=Sun 6=Sat', '1'));
  } else if (cadenceChoice === 'monthly') {
    body.cadence = 'monthly';
    body.dayOfMonth = Number(await prompt(rl, 'Day of month 1-31', '1'));
  } else if (cadenceChoice === 'hours') {
    body.cadence = 'interval_hours';
    body.intervalHours = Number(await prompt(rl, 'Every N hours', '24'));
  } else if (cadenceChoice === 'minutes') {
    body.cadence = 'interval_minutes';
    body.intervalMinutes = Number(await prompt(rl, 'Every N minutes', '60'));
  } else {
    body.cadence = 'interval_days';
    body.intervalDays = Number(await prompt(rl, 'Every N days', '7'));
  }

  const maxOccurrencesRaw = await prompt(rl, 'Max occurrences (blank for uncapped)', '');
  if (maxOccurrencesRaw) {
    body.maxOccurrences = Number(maxOccurrencesRaw);
  }

  const result = await bridgeRequest(state.options, '/bridge/recurring-payments', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  printOk(state.options, 'Recurring approval created.');
  console.log(stableJson(result));
}

async function runPlanCommand(
  state: TerminalAppState,
  rl: readline.Interface,
  naturalLanguage: string,
): Promise<void> {
  printSection('Agent Plan');
  const intent = naturalLanguage || await promptRequired(rl, 'User request');
  const aiPlan = await generateBridgeAiPlanIfConfigured(state.options, intent).catch((err) => {
    printWarn(state.options, `AI planner unavailable; using deterministic template fallback. ${errorMessage(err)}`);
    return null;
  });
  const plan: CliAgentPlan = aiPlan ?? buildAgentPlan(intent);
  if (aiPlan) {
    printMuted(state.options, 'Source: local bridge AI draft. Wallet approval is still required.');
  } else {
    printMuted(state.options, 'Source: deterministic terminal template. Configure bridge AI for richer drafts.');
  }
  printAgentPlan(plan);

  if (await confirm(rl, 'Sign this plan as an off-chain proof?', false)) {
    const artifact = await signTextWithWallet(state, agentPlanSigningMessage(plan), 'Agent plan approval proof', planRisk(plan));
    printOk(state.options, `Plan signed: ${short(artifact.result?.signature ?? artifact.requestId, 12)}`);
  }

  if (await confirm(rl, 'Queue an approval from this plan?', true)) {
    await queuePlanAction(state, rl, plan);
  }
}

async function queuePlanAction(
  state: TerminalAppState,
  rl: readline.Interface,
  plan: CliAgentPlan,
): Promise<void> {
  await requireWalletConnected(state);
  if (isSharedAgentPlan(plan)) {
    await queueSharedAgentPlanAction(state, rl, plan);
    return;
  }
  if (plan.route === 'swap') {
    const amount = await prompt(rl, 'Amount', '0.01');
    const inputToken = (await prompt(rl, 'Input token', 'SOL')).toUpperCase();
    const outputToken = (await prompt(rl, 'Output token', 'USDC')).toUpperCase();
    const slippageBps = Number(await prompt(rl, 'Slippage bps', '50'));
    const response = await bridgeRequest<{ preparedAction?: PreparedAction }>(
      state.options,
      '/bridge/action/prepare-swap',
      {
        method: 'POST',
        body: JSON.stringify({
          inputToken,
          outputToken,
          amount,
          slippageBps,
          note: plan.intent,
        }),
      },
    );
    printOk(state.options, `Queued swap approval ${response.preparedAction?.id ?? ''}.`);
    return;
  }

  if (plan.route === 'transfer') {
    const recipient = await promptRequired(rl, 'Recipient address');
    const amountSol = await prompt(rl, 'Amount SOL', '0.01');
    const response = await bridgeRequest<{ preparedAction?: PreparedAction }>(
      state.options,
      '/bridge/action/prepare-transfer-sol',
      {
        method: 'POST',
        body: JSON.stringify({ recipient, amountSol, note: plan.intent }),
      },
    );
    printOk(state.options, `Queued SOL transfer approval ${response.preparedAction?.id ?? ''}.`);
    return;
  }

  printWarn(state.options, 'This plan is a research/proof plan only; no transaction route was queued.');
}

async function queueSharedAgentPlanAction(
  state: TerminalAppState,
  rl: readline.Interface,
  plan: SharedAgentPlan,
): Promise<void> {
  const note = [plan.intent, plan.userNotes].filter(Boolean).join(' | ').slice(0, 500);
  if (plan.actionType === 'transfer_sol') {
    const recipient = await planParamOrPrompt(rl, plan, 'recipient', 'Recipient address');
    const amountSol = await planParamOrPrompt(rl, plan, 'amount', 'Amount SOL', '0.01');
    const response = await bridgeRequest<{ preparedAction?: PreparedAction }>(
      state.options,
      '/bridge/action/prepare-transfer-sol',
      {
        method: 'POST',
        body: JSON.stringify({ recipient, amountSol, note }),
      },
    );
    printOk(state.options, `Queued SOL transfer approval ${response.preparedAction?.id ?? ''}.`);
    return;
  }

  if (plan.actionType === 'transfer_spl') {
    const token = await planParamOrPrompt(rl, plan, 'token', 'Token', 'USDC');
    const recipient = await planParamOrPrompt(rl, plan, 'recipient', 'Recipient address');
    const amount = await planParamOrPrompt(rl, plan, 'amount', `Amount ${token}`, '10');
    const response = await bridgeRequest<{ preparedAction?: PreparedAction }>(
      state.options,
      '/bridge/action/prepare-transfer-spl',
      {
        method: 'POST',
        body: JSON.stringify({ token, recipient, amount, note }),
      },
    );
    printOk(state.options, `Queued SPL transfer approval ${response.preparedAction?.id ?? ''}.`);
    return;
  }

  if (plan.actionType === 'swap') {
    const amount = await planParamOrPrompt(rl, plan, 'amount', 'Amount', '0.01');
    const inputToken = (await planParamOrPrompt(rl, plan, 'inputToken', 'Input token', 'SOL')).toUpperCase();
    const outputToken = (await planParamOrPrompt(rl, plan, 'outputToken', 'Output token', 'USDC')).toUpperCase();
    const slippageBps = Number(await planParamOrPrompt(rl, plan, 'slippageBps', 'Slippage bps', '50'));
    const response = await bridgeRequest<{ preparedAction?: PreparedAction }>(
      state.options,
      '/bridge/action/prepare-swap',
      {
        method: 'POST',
        body: JSON.stringify({
          inputToken,
          outputToken,
          amount,
          slippageBps: Number.isFinite(slippageBps) ? slippageBps : 50,
          note,
        }),
      },
    );
    printOk(state.options, `Queued swap approval ${response.preparedAction?.id ?? ''}.`);
    return;
  }

  if (plan.actionType === 'recurring_payment') {
    const token = await planParamOrPrompt(rl, plan, 'token', 'Token', 'USDC');
    const recipient = await planParamOrPrompt(rl, plan, 'recipient', 'Recipient address');
    const amount = await planParamOrPrompt(rl, plan, 'amount', `Amount ${token}`, '5');
    const cadence = await planParamOrPrompt(rl, plan, 'cadence', 'Cadence (weekly/monthly/days)', 'monthly');
    const body: Record<string, unknown> = {
      actionKind: 'transfer',
      token,
      recipient,
      amount,
      note,
    };
    if (cadence === 'weekly') {
      body.cadence = 'weekly';
      body.dayOfWeek = Number(await prompt(rl, 'Day of week 0=Sun 6=Sat', '1'));
    } else if (cadence === 'monthly') {
      body.cadence = 'monthly';
      body.dayOfMonth = Number(await prompt(rl, 'Day of month 1-31', '1'));
    } else {
      body.cadence = 'interval_days';
      body.intervalDays = Number(await prompt(rl, 'Every N days', '7'));
    }
    const response = await bridgeRequest<{ recurringPayment?: { id: string }; payment?: { id: string } }>(
      state.options,
      '/bridge/recurring-payments',
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );
    printOk(state.options, `Queued recurring approval ${response.recurringPayment?.id ?? response.payment?.id ?? ''}.`);
    return;
  }

  if (plan.actionType === 'blink_action') {
    const blinkUrl = await planParamOrPrompt(rl, plan, 'blinkUrl', 'Blink / Action URL');
    const response = await bridgeRequest<{ preparedAction?: PreparedAction }>(
      state.options,
      '/bridge/action/prepare-blink',
      {
        method: 'POST',
        body: JSON.stringify(removeUndefined({
          blinkUrl,
          connector: plan.parameters.connectorId,
          protocol: plan.parameters.protocol,
          operation: plan.parameters.operation,
          expectedAmount: plan.parameters.expectedAmount ?? plan.parameters.amount,
          expectedToken: plan.parameters.expectedToken,
          expectedRecipient: plan.parameters.expectedRecipient,
          position: plan.parameters.position,
          note,
        })),
      },
    );
    printOk(state.options, `Queued Blink approval ${response.preparedAction?.id ?? ''}.`);
    return;
  }

  printWarn(state.options, 'This AI plan is proof-only in the CLI; no transaction route was queued.');
}

async function runResearchCommand(
  state: TerminalAppState,
  rl: readline.Interface,
  args: string[],
): Promise<void> {
  printSection('Research Workbench');
  if (args[0] === 'list') {
    printResearchLabs();
    return;
  }
  printResearchLabs();
  const selected = args[0] ?? await prompt(rl, 'Research concept number or id', '1');
  const lab = resolveResearchLab(selected);
  printSection(lab.title);
  console.log(lab.description);
  console.log(`Default input: ${lab.defaultInput}`);
  const inlineInput = args.slice(1).join(' ');
  const input = inlineInput || await prompt(rl, 'Artifact input', lab.defaultInput);
  const artifact = await buildResearchArtifact(state.options, lab, input);
  console.log(stableJson(artifact));

  if (await confirm(rl, 'Sign this research artifact?', true)) {
    const approval = await signTextWithWallet(
      state,
      researchSigningMessage(artifact),
      `${artifact.title} artifact`,
      'low',
    );
    artifact.signature = approval.result?.signature;
    artifact.requestId = approval.requestId;
    await saveResearchArtifact(state.options, artifact);
    printOk(state.options, `Research artifact signed and saved: ${artifact.id}`);
  }
}

async function runQuoteCommand(state: TerminalAppState, rl: readline.Interface): Promise<void> {
  await requireWalletConnected(state);
  printSection('Swap Quote');
  const amount = await prompt(rl, 'Amount', '0.01');
  const inputToken = (await prompt(rl, 'Input token', 'SOL')).toUpperCase();
  const outputToken = (await prompt(rl, 'Output token', 'USDC')).toUpperCase();
  const slippageBps = Number(await prompt(rl, 'Slippage bps', '50'));
  const result = await bridgeRequest(state.options, '/bridge/action/swap-quote', {
    method: 'POST',
    body: JSON.stringify({ amount, inputToken, outputToken, slippageBps }),
  });
  console.log(stableJson(result));
}

async function printReceipts(state: TerminalAppState): Promise<void> {
  const response = await bridgeRequest<{ receipts?: ActionReceipt[] }>(state.options, '/bridge/receipts');
  state.lastReceipts = response.receipts ?? [];
  printSection('Receipts');
  if (state.lastReceipts.length === 0) {
    console.log('No receipts yet.');
    return;
  }
  renderTable(
    state.lastReceipts.map((receipt) => [
      short(receipt.actionId, 8),
      receipt.status,
      receipt.txStatus ?? '',
      receipt.amount ? `${receipt.amount} ${receipt.token ?? ''}` : '',
      short(receipt.txid ?? receipt.error ?? receipt.summary, 22),
    ]),
    ['Action', 'Status', 'Tx', 'Amount', 'Evidence'],
  );
}

function printLogs(state: TerminalAppState): void {
  printSection('Logs');
  if (state.logs.length === 0) {
    console.log('No terminal app logs yet.');
    return;
  }
  for (const line of state.logs.slice(-80)) {
    console.log(line);
  }
}

async function signTextWithWallet(
  state: TerminalAppState,
  message: string,
  summary: string,
  riskLevel: RiskLevel,
): Promise<ApprovalResource> {
  await requireWalletConnected(state);
  const status = await tryBridgeRequest<WalletStatus>(state.options, '/bridge/action/status');
  const cluster = status.ok && status.value.cluster ? status.value.cluster : 'mainnet-beta';
  const request: SigningRequest = {
    id: `sar_${randomBytes(12).toString('hex')}`,
    kind: 'sign_message',
    payload: {
      data: message,
      encoding: 'utf8',
    },
    cluster,
    display: { summary, riskLevel },
    expiresAt: Date.now() + REQUEST_TIMEOUT_MS,
  };
  await ensureBrowserHost(state);
  await openWalletHost(state.options);
  const initial = await bridgeRequest<ApprovalResource>(state.options, '/bridge/submit', {
    method: 'POST',
    body: JSON.stringify({ request }),
  });
  printMuted(state.options, `Waiting for wallet approval ${initial.requestId}...`);
  return pollApproval(state.options, initial);
}

async function pollApproval(options: GlobalOptions, initial: ApprovalResource): Promise<ApprovalResource> {
  let current = initial;
  const start = Date.now();
  while (current.status === 'pending') {
    if (Date.now() - start > REQUEST_TIMEOUT_MS) {
      throw new Error(`Approval ${current.requestId} timed out after ${REQUEST_TIMEOUT_MS}ms.`);
    }
    await sleep(POLL_INTERVAL_MS);
    current = await bridgeRequest<ApprovalResource>(
      options,
      `/bridge/poll?requestId=${encodeURIComponent(current.requestId)}`,
    );
  }
  if (current.status !== 'approved') {
    throw new Error(current.error?.message ?? `Approval ${current.status} for ${current.requestId}.`);
  }
  return current;
}

async function renderDashboard(state: TerminalAppState): Promise<void> {
  const [health, inbox] = await Promise.all([
    tryBridgeRequest<BridgeHealth>(state.options, '/bridge/health'),
    tryBridgeRequest<{ actions?: PreparedAction[] }>(state.options, '/bridge/prepared-actions'),
  ]);
  const actions = inbox.ok ? inbox.value.actions ?? [] : [];
  state.lastActions = actions;

  printSection('Dashboard');
  console.log(`Wallet: ${health.ok && health.value.walletAddress ? short(health.value.walletAddress, 10) : 'not connected'}`);
  console.log(`Network: ${health.ok ? health.value.cluster ?? 'unknown' : 'unreachable'}`);
  console.log(`Bridge: ${health.ok ? 'online' : 'offline'} (${state.options.bridgeUrl})`);
  console.log(`Queue: ${actions.filter((action) => action.status === 'ready' || action.status === 'overdue').length} awaiting review`);
  console.log(`Wallet host: ${walletHostLaunchUrl(state.options)}`);
}

async function refreshPreparedActions(options: GlobalOptions): Promise<{ materialized: PreparedAction[]; actions: PreparedAction[] }> {
  const [actionsResponse, txResponse] = await Promise.all([
    bridgeRequest<{ materialized?: PreparedAction[]; actions?: PreparedAction[] }>(options, '/bridge/prepared-actions'),
    bridgeRequest<{ actions?: PreparedAction[] }>(options, '/bridge/prepared-actions/tx-status', {
      method: 'POST',
      body: '{}',
    }).catch(() => null),
  ]);
  return {
    materialized: actionsResponse.materialized ?? [],
    actions: txResponse?.actions ?? actionsResponse.actions ?? [],
  };
}

async function inspectPreparedAction(options: GlobalOptions, idOrPrefix: string): Promise<PreparedAction> {
  const response = await refreshPreparedActions(options);
  return resolveActionFromList(response.actions, idOrPrefix);
}

async function resolveAction(state: TerminalAppState, idOrIndex: string | undefined): Promise<PreparedAction> {
  if (state.lastActions.length === 0) {
    await printInbox(state, 'all', true);
  }
  if (!idOrIndex) {
    if (state.lastActions.length === 1) {
      return state.lastActions[0]!;
    }
    throw new Error('Provide an action id or row number. Run /inbox to choose an action.');
  }
  if (/^\d+$/.test(idOrIndex)) {
    const index = Number(idOrIndex) - 1;
    const action = state.lastActions[index];
    if (!action) {
      throw new Error(`No inbox row ${idOrIndex}. Run /inbox to refresh the visible rows.`);
    }
    return action;
  }
  return resolveActionFromList(state.lastActions, idOrIndex);
}

function resolveActionFromList(actions: PreparedAction[], idOrPrefix: string): PreparedAction {
  const exact = actions.find((action) => action.id === idOrPrefix);
  if (exact) {
    return exact;
  }
  const prefixed = actions.filter((action) => action.id.startsWith(idOrPrefix));
  if (prefixed.length === 1) {
    return prefixed[0]!;
  }
  if (prefixed.length > 1) {
    throw new Error(`Action prefix ${idOrPrefix} matches ${prefixed.length} actions. Use the full action id.`);
  }
  throw new Error(`Unknown prepared action: ${idOrPrefix}. Run /inbox to see available actions.`);
}

function assertActionApprovable(action: PreparedAction): void {
  if (action.archived) {
    throw new Error(`Action ${action.id} is archived and cannot be approved.`);
  }
  if (action.status !== 'ready' && action.status !== 'overdue') {
    throw new Error(
      `Action ${action.id} cannot be approved from status ${action.status}. Only ready or overdue actions can open wallet approval.`,
    );
  }
}

function assertActionRejectable(action: PreparedAction): void {
  if (action.archived) {
    throw new Error(`Action ${action.id} is archived and cannot be rejected.`);
  }
  if (action.status === 'approved' || action.status === 'rejected') {
    throw new Error(`Action ${action.id} is already ${action.status}. Use /receipts or /inspect ${action.id} for history.`);
  }
}

async function resolveActionId(state: TerminalAppState, idOrIndex: string | undefined): Promise<string> {
  if (!idOrIndex) {
    if (state.lastActions.length === 0) {
      await printInbox(state, 'all');
    }
    if (state.lastActions.length === 1) {
      return state.lastActions[0]!.id;
    }
    throw new Error('Provide an action id or inbox row number. Run /inbox first.');
  }
  if (/^\d+$/.test(idOrIndex)) {
    if (state.lastActions.length === 0) {
      await printInbox(state, 'all');
    }
    const index = Number(idOrIndex) - 1;
    const action = state.lastActions[index];
    if (!action) {
      throw new Error(`No inbox row ${idOrIndex}.`);
    }
    return action.id;
  }
  const exact = state.lastActions.find((action) => action.id === idOrIndex);
  if (exact) {
    return exact.id;
  }
  const prefixed = state.lastActions.filter((action) => action.id.startsWith(idOrIndex));
  if (prefixed.length === 1) {
    return prefixed[0]!.id;
  }
  return idOrIndex;
}

async function ensureBridge(state: TerminalAppState): Promise<void> {
  const health = await tryBridgeRequest<BridgeHealth>(state.options, '/bridge/health');
  if (health.ok) {
    return;
  }
  const child = startBridgeProcess(state.options);
  state.bridgeProcess = child;
  attachProcessLogs(state, child, 'bridge');
  await waitForBridge(state.options, 10_000);
}

async function ensureBridgeDetached(options: GlobalOptions): Promise<void> {
  const health = await tryBridgeRequest<BridgeHealth>(options, '/bridge/health');
  if (health.ok) {
    return;
  }
  startBridgeDetached(options);
  await waitForBridge(options, 10_000);
}

async function ensureBrowserHost(state: TerminalAppState): Promise<void> {
  if (await isWalletHostReachable(state.options)) {
    return;
  }
  const url = new URL(state.options.walletHostUrl);
  const host = url.hostname || '127.0.0.1';
  const port = url.port || '5174';
  const child = walletHostAssetsAvailable(state.options)
    ? startWalletHostProcess(state.options)
    : startRepoWalletHostProcess(state.options, host, port, false);
  state.browserProcess = child;
  attachProcessLogs(state, child, 'wallet-host');
  const started = await waitForWalletHost(state.options, 10_000);
  if (!started) {
    throw new Error(`Wallet host did not become reachable at ${state.options.walletHostUrl}.`);
  }
}

async function ensureBrowserHostDetached(options: GlobalOptions): Promise<void> {
  if (await isWalletHostReachable(options)) {
    return;
  }
  const url = new URL(options.walletHostUrl);
  const host = url.hostname || '127.0.0.1';
  const port = url.port || '5174';
  const child = walletHostAssetsAvailable(options)
    ? startWalletHostDetached(options)
    : startRepoWalletHostProcess(options, host, port, true);
  child.unref();
  const started = await waitForWalletHost(options, 10_000);
  if (!started) {
    throw new Error(`Wallet host did not become reachable at ${options.walletHostUrl}.`);
  }
}

function startBridgeProcess(options: GlobalOptions): ChildProcess {
  const invocation = cliInvocation(['bridge', 'serve', ...childGlobalArgs(options)]);
  const child = spawn(invocation.command, invocation.args, {
    cwd: processCwd(options),
    env: bridgeEnv(options),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

function startBridgeDetached(options: GlobalOptions): ChildProcess {
  const invocation = cliInvocation(['bridge', 'serve', ...childGlobalArgs(options)]);
  const child = spawn(invocation.command, invocation.args, {
    cwd: processCwd(options),
    env: bridgeEnv(options),
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  return child;
}

function startWalletHostProcess(options: GlobalOptions): ChildProcess {
  const invocation = cliInvocation(['wallet-host', 'serve', ...childGlobalArgs(options)]);
  return spawn(invocation.command, invocation.args, {
    cwd: processCwd(options),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function startWalletHostDetached(options: GlobalOptions): ChildProcess {
  const invocation = cliInvocation(['wallet-host', 'serve', ...childGlobalArgs(options)]);
  return spawn(invocation.command, invocation.args, {
    cwd: processCwd(options),
    env: process.env,
    stdio: 'ignore',
    detached: true,
  });
}

function startRepoWalletHostProcess(
  options: GlobalOptions,
  host: string,
  port: string,
  detached: boolean,
): ChildProcess {
  if (!options.repoRoot) {
    throw new Error(`Wallet host assets are missing from ${options.walletHostDir}. Reinstall the CLI package.`);
  }
  const child = spawn('pnpm', [
    '-F',
    '@solana-agent-wallet-adapter/browser-demo',
    'exec',
    'vite',
    '--host',
    host,
    '--port',
    port,
    '--strictPort',
  ], {
    cwd: options.repoRoot,
    env: process.env,
    stdio: detached ? 'ignore' : ['ignore', 'pipe', 'pipe'],
    detached,
  });
  if (detached) {
    child.unref();
  }
  return child;
}

async function serveBridge(options: GlobalOptions): Promise<void> {
  await ensureRuntimeFiles(options);
  await loadDotEnvFile(options.envPath);
  const config = await loadConfig(options.configPath);
  const { host, port } = listenParts(options.bridgeUrl, 8787);
  const backend = new LocalBridgeBackend({
    cluster: config.cluster,
    rpcUrl: config.rpcUrl,
    token: options.token,
  });
  const bridge = createBridgeServer({
    backend,
    actionConfig: config,
    preparedActions: new JsonPreparedActionStore(options.preparedActionsPath),
    labArtifacts: new JsonLabArtifactStore(options.labArtifactsPath),
    host,
    port,
  });
  await bridge.start();
  console.error(`[solana-agent-wallet] bridge listening: ${options.bridgeUrl}`);
  await waitForShutdown(() => bridge.stop());
}

async function serveWalletHost(options: GlobalOptions): Promise<void> {
  if (!walletHostAssetsAvailable(options)) {
    throw new Error(`Wallet host assets are missing from ${options.walletHostDir}. Run pnpm -F @solana-agent-wallet-adapter/cli build before serving from the repo.`);
  }
  const { host, port } = listenParts(options.walletHostUrl, 5174);
  const server = createServer((req, res) => {
    void handleWalletHostRequest(options.walletHostDir, req, res);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => resolveListen());
  });
  console.error(`[solana-agent-wallet] wallet host listening: ${options.walletHostUrl}`);
  await waitForShutdown(async () => {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((err) => (err ? rejectClose(err) : resolveClose()));
    });
  });
}

async function handleWalletHostRequest(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writeStaticResponse(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
    return;
  }
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  if (url.pathname === WALLET_HOST_HEALTH_PATH) {
    const body = req.method === 'HEAD'
      ? Buffer.alloc(0)
      : `${stableJson({ ok: true, service: 'agentic-wallet-host' })}\n`;
    writeStaticResponse(res, 200, 'application/json; charset=utf-8', body);
    return;
  }
  const rootPath = resolve(root);
  const filePath = resolveWalletHostPath(rootPath, url.pathname);
  const isAssetRequest = extname(url.pathname) !== '';
  const fallbackPath = join(rootPath, 'index.html');
  const candidate = filePath ?? fallbackPath;
  const bodyPath = await readableFilePath(candidate).catch(() => null)
    ?? (isAssetRequest ? null : await readableFilePath(fallbackPath).catch(() => null));
  if (!bodyPath) {
    writeStaticResponse(res, 404, 'text/plain; charset=utf-8', 'Not found');
    return;
  }
  const body = req.method === 'HEAD' ? Buffer.alloc(0) : await readFile(bodyPath);
  writeStaticResponse(res, 200, contentType(bodyPath), body);
}

function resolveWalletHostPath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const requestPath = decoded === '/' || decoded.endsWith('/') ? `${decoded}index.html` : decoded;
  const normalized = normalize(requestPath.replace(/^\/+/, ''));
  const candidate = resolve(root, normalized);
  const pathRelative = relative(root, candidate);
  if (pathRelative === '' || (!pathRelative.startsWith('..') && !pathRelative.includes(`..${sep}`))) {
    return candidate;
  }
  return null;
}

async function readableFilePath(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile()) {
    throw new Error(`${path} is not a file.`);
  }
  return path;
}

function writeStaticResponse(
  res: ServerResponse,
  statusCode: number,
  type: string,
  body: Buffer | string,
): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', type);
  res.setHeader('cache-control', statusCode === 200 ? 'no-cache' : 'no-store');
  res.end(body);
}

function contentType(path: string): string {
  switch (extname(path)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

async function ensureRuntimeFiles(options: GlobalOptions): Promise<void> {
  await mkdir(options.runtimeDir, { recursive: true });
  await mkdir(dirname(options.configPath), { recursive: true });
  await mkdir(dirname(options.preparedActionsPath), { recursive: true });
  await mkdir(dirname(options.labArtifactsPath), { recursive: true });
  if (!existsSync(options.configPath)) {
    await writeFile(options.configPath, `${stableJson(DEFAULT_CONFIG)}\n`, 'utf8');
  }
}

async function loadDotEnvFile(path: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw err;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const equals = trimmed.indexOf('=');
    if (equals <= 0) {
      continue;
    }
    const key = trimmed.slice(0, equals).trim();
    const value = unquoteEnv(trimmed.slice(equals + 1).trim());
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function runtimeSetupStatus(options: GlobalOptions): Promise<RuntimeSetupStatus> {
  const env = await readEnvValues(options.envPath);
  const rpcUrl = firstValue(env.values, 'SOLANA_RPC_URL', 'HELIUS_RPC_URL') ?? '';
  const jupiterApiKey = firstValue(env.values, 'JUPITER_API_KEY', 'JUP_API_KEY') ?? '';
  const jupiterUltraBase = env.values.JUPITER_SWAP_BASE_URL ?? env.values.JUP_ULTRA_BASE ?? DEFAULT_JUPITER_ULTRA_BASE;
  const jupiterApiUrl = env.values.JUPITER_API_URL ?? DEFAULT_JUPITER_API_URL;
  const birdeyeApiKey = env.values.BIRDEYE_API_KEY ?? '';
  const birdeyeRestBase = env.values.BIRDEYE_REST_BASE ?? DEFAULT_BIRDEYE_REST_BASE;
  const rpcUrlConfigured = Boolean(rpcUrl);
  const jupiterApiKeyConfigured = Boolean(jupiterApiKey);
  const birdeyeApiKeyConfigured = Boolean(birdeyeApiKey);
  return {
    envPath: options.envPath,
    envFound: env.found,
    rpcUrlConfigured,
    rpcUrlRedacted: rpcUrl ? redactUrlSecret(rpcUrl) : null,
    jupiterApiKeyConfigured,
    jupiterApiKeyRedacted: jupiterApiKey ? redactSecret(jupiterApiKey) : null,
    jupiterUltraBase,
    jupiterApiUrl,
    birdeyeApiKeyConfigured,
    birdeyeApiKeyRedacted: birdeyeApiKey ? redactSecret(birdeyeApiKey) : null,
    birdeyeRestBase,
    solTransfersReady: rpcUrlConfigured,
    tokenTransfersReady: rpcUrlConfigured,
    swapsReady: rpcUrlConfigured && jupiterApiKeyConfigured && Boolean(jupiterUltraBase),
    marketDataReady: birdeyeApiKeyConfigured && Boolean(birdeyeRestBase),
  };
}

async function readEnvValues(path: string): Promise<{ found: boolean; raw: string; values: Record<string, string> }> {
  try {
    const raw = await readFile(path, 'utf8');
    return { found: true, raw, values: parseEnvValues(raw) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { found: false, raw: '', values: {} };
    }
    throw err;
  }
}

function parseEnvValues(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const key = envKeyFromLine(line);
    if (!key) {
      continue;
    }
    const equals = line.indexOf('=');
    values[key] = unquoteEnv(line.slice(equals + 1).trim());
  }
  return values;
}

async function writeEnvUpdates(path: string, updates: Record<string, string>): Promise<void> {
  const env = await readEnvValues(path);
  await mkdir(dirname(path), { recursive: true });
  const next = applyEnvUpdates(env.raw, updates);
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, next, 'utf8');
  await rename(tempPath, path);
  await chmod(path, 0o600).catch(() => undefined);
}

function applyEnvUpdates(raw: string, updates: Record<string, string>): string {
  const normalized = raw.replace(/\r\n/g, '\n');
  const lines = normalized ? normalized.split('\n') : ['# Solana Agent Wallet local runtime setup'];
  const seen = new Set<string>();
  const rewritten = lines.map((line) => {
    const key = envKeyFromLine(line);
    const value = key ? updates[key] : undefined;
    if (!key || value === undefined) {
      return line;
    }
    seen.add(key);
    return `${key}=${formatEnvValue(value)}`;
  });
  const missing = SETUP_ENV_KEYS.filter((key) => updates[key] !== undefined && !seen.has(key));
  if (missing.length > 0 && rewritten.length > 0 && rewritten[rewritten.length - 1] !== '') {
    rewritten.push('');
  }
  for (const key of missing) {
    rewritten.push(`${key}=${formatEnvValue(updates[key] ?? '')}`);
  }
  return `${rewritten.join('\n').replace(/\n+$/, '')}\n`;
}

function envKeyFromLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }
  const equals = trimmed.indexOf('=');
  if (equals <= 0) {
    return null;
  }
  const key = trimmed.slice(0, equals).trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : null;
}

function formatEnvValue(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error('Environment values cannot contain newlines.');
  }
  return value;
}

function unquoteEnv(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function firstValue(values: Record<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = values[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function normalizeSetupUrl(value: string, label: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use http or https.`);
  }
  return parsed.search || parsed.hash ? trimmed : trimmed.replace(/\/+$/, '');
}

function redactSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) {
    return 'configured';
  }
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function redactUrlSecret(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(api[-_]?key|apikey|key|token)$/i.test(key)) {
        const current = url.searchParams.get(key) ?? '';
        url.searchParams.set(key, current ? `...${current.slice(-4)}` : '...');
      }
    }
    if (url.username) {
      url.username = '...';
    }
    if (url.password) {
      url.password = '...';
    }
    return url.toString();
  } catch {
    return redactSecret(value);
  }
}

async function promptExistingSecret(
  rl: readline.Interface,
  label: string,
  currentValue: string,
): Promise<string> {
  const hint = currentValue ? ` [configured: ${redactUrlSecret(currentValue)}; blank keeps]` : '';
  const answer = (await rl.question(`${label}${hint}: `)).trim();
  return answer || currentValue;
}

function listenParts(url: string, defaultPort: number): { host: string; port: number } {
  const parsed = new URL(url);
  const port = Number(parsed.port || defaultPort);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid listen port in ${url}.`);
  }
  return {
    host: parsed.hostname || '127.0.0.1',
    port,
  };
}

async function waitForShutdown(close: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolveStop, rejectStop) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) {
        return;
      }
      stopping = true;
      close().then(resolveStop, rejectStop);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

function walletHostAssetsAvailable(options: GlobalOptions): boolean {
  return existsSync(join(options.walletHostDir, 'index.html'));
}

function childGlobalArgs(options: GlobalOptions): string[] {
  return [
    '--bridge-url',
    options.bridgeUrl,
    '--token',
    options.token,
    '--wallet-host-url',
    options.walletHostUrl,
    '--runtime-dir',
    options.runtimeDir,
    '--env',
    options.envPath,
    '--config',
    options.configPath,
    '--prepared-actions',
    options.preparedActionsPath,
    '--lab-artifacts',
    options.labArtifactsPath,
    '--wallet-host-dir',
    options.walletHostDir,
  ];
}

function cliInvocation(args: string[]): { command: string; args: string[] } {
  if (isStandaloneBinary()) {
    return { command: process.execPath, args };
  }
  return { command: process.execPath, args: [fileURLToPath(import.meta.url), ...args] };
}

function isStandaloneBinary(): boolean {
  return Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);
}

function processCwd(options: GlobalOptions): string {
  return options.repoRoot ?? options.runtimeDir;
}

function bridgeEnv(options: GlobalOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BRIDGE_TOKEN: options.token,
    AGENT_WALLET_PREPARED_ACTIONS: options.preparedActionsPath,
    AGENT_WALLET_LAB_ARTIFACTS: options.labArtifactsPath,
  };
}

async function waitForBridge(options: GlobalOptions, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const health = await tryBridgeRequest<BridgeHealth>(options, '/bridge/health');
    if (health.ok) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`Bridge did not become reachable at ${options.bridgeUrl}.`);
}

async function waitForUrl(url: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isUrlReachable(url)) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function waitForWalletHost(options: GlobalOptions, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isWalletHostReachable(options)) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function waitForWalletConnection(options: GlobalOptions, timeoutMs: number): Promise<WalletStatus> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await tryBridgeRequest<WalletStatus>(options, '/bridge/action/status');
    if (status.ok && status.value.connected && status.value.address) {
      return status.value;
    }
    await sleep(750);
  }
  throw new Error(`No wallet connected yet. Keep ${walletHostLaunchUrl(options)} open, connect your wallet, then run /wallet or /connect again.`);
}

async function isUrlReachable(url: string): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(url, { method: 'GET' }, 1_500);
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

async function isWalletHostReachable(options: GlobalOptions): Promise<boolean> {
  if (walletHostAssetsAvailable(options)) {
    return isAgenticWalletHostReachable(options.walletHostUrl);
  }
  if (options.repoRoot) {
    return isUrlReachable(options.walletHostUrl);
  }
  return false;
}

async function isAgenticWalletHostReachable(walletHostUrl: string): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(walletHostHealthUrl(walletHostUrl), { method: 'GET' }, 1_500);
    if (!response.ok) {
      return false;
    }
    const body = parseJsonBody(await response.text());
    return isRecord(body) && body.ok === true && body.service === 'agentic-wallet-host';
  } catch {
    return false;
  }
}

function walletHostHealthUrl(walletHostUrl: string): string {
  const url = new URL(walletHostUrl.endsWith('/') ? walletHostUrl : `${walletHostUrl}/`);
  url.pathname = WALLET_HOST_HEALTH_PATH;
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function runDoctor(options: GlobalOptions): Promise<JsonRecord> {
  await ensureRuntimeFiles(options);
  const bridgeHealth = await tryBridgeRequest<BridgeHealth>(options, '/bridge/health');
  const actionHealth = await tryBridgeRequest<BridgeHealth>(options, '/bridge/action/health');
  const walletHost = await isWalletHostReachable(options);
  const setup = await runtimeSetupStatus(options);
  return {
    bridgeUrl: options.bridgeUrl,
    walletHostUrl: options.walletHostUrl,
    walletHostLaunchUrl: walletHostLaunchUrl(options),
    tokenConfigured: Boolean(options.token),
    repoRoot: options.repoRoot,
    runtimeDir: options.runtimeDir,
    configPath: options.configPath,
    preparedActionsPath: options.preparedActionsPath,
    labArtifactsPath: options.labArtifactsPath,
    walletHostDir: options.walletHostDir,
    files: {
      env: existsSync(options.envPath),
      config: existsSync(options.configPath),
      preparedActionsDir: existsSync(dirname(options.preparedActionsPath)),
      labArtifactsDir: existsSync(dirname(options.labArtifactsPath)),
      walletHostAssets: walletHostAssetsAvailable(options),
    },
    bridge: bridgeHealth.ok ? { reachable: true, health: bridgeHealth.value } : {
      reachable: false,
      error: errorMessage(bridgeHealth.error),
    },
    actionService: actionHealth.ok ? { reachable: true, health: actionHealth.value } : {
      reachable: false,
      error: errorMessage(actionHealth.error),
    },
    walletHost: {
      reachable: walletHost,
    },
    setup,
  };
}

async function bridgeRequest<T = unknown>(
  options: GlobalOptions,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = bridgeUrl(options, path);
  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      ...init,
      headers: {
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    }, REQUEST_TIMEOUT_MS + 5_000);
  } catch (err) {
    throw new Error(`Local wallet bridge is not reachable at ${options.bridgeUrl}. Run solana-agent-wallet app or bridge start. ${errorMessage(err)}`);
  }

  const text = await response.text();
  const body = parseJsonBody(text);
  if (!response.ok) {
    const error = responseError(body);
    throw new Error(formatBridgeError(options, error ?? `Local wallet bridge returned HTTP ${response.status}.`));
  }
  return body as T;
}

async function tryBridgeRequest<T>(
  options: GlobalOptions,
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await bridgeRequest<T>(options, path, init) };
  } catch (error) {
    return { ok: false, error };
  }
}

function bridgeUrl(options: GlobalOptions, path: string): URL {
  const base = options.bridgeUrl.endsWith('/') ? options.bridgeUrl : `${options.bridgeUrl}/`;
  const url = new URL(path.startsWith('/') ? path.slice(1) : path, base);
  url.searchParams.set('token', options.token);
  return url;
}

async function fetchWithTimeout(input: URL | string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function openWalletHost(options: GlobalOptions): Promise<void> {
  await openUrl(walletHostLaunchUrl(options));
}

function walletHostLaunchUrl(options: GlobalOptions): string {
  const url = new URL(options.walletHostUrl);
  url.searchParams.set('bridgeUrl', options.bridgeUrl);
  url.searchParams.set('token', options.token);
  return url.toString();
}

async function openUrl(url: string): Promise<void> {
  if (process.env.AGENT_WALLET_SKIP_OPEN === '1') {
    return;
  }
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/C', 'start', '', url] : [url];
  const child = spawn(command, args, {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
}

async function saveResearchArtifact(options: GlobalOptions, artifact: ResearchArtifact): Promise<void> {
  const dir = dirname(options.preparedActionsPath);
  const path = join(dir, 'research-artifacts.json');
  await mkdir(dir, { recursive: true });
  const existing = await readJsonFile<{ artifacts?: ResearchArtifact[] }>(path).catch(() => ({ artifacts: [] }));
  const artifacts = [artifact, ...(existing.artifacts ?? []).filter((item) => item.id !== artifact.id)].slice(0, 50);
  await writeFile(path, `${stableJson({ artifacts })}\n`, 'utf8');
}

async function readJsonFile<T>(path: string): Promise<T> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as T;
}

function cleanupApp(state: TerminalAppState): void {
  if (state.bridgeProcess && !state.bridgeProcess.killed) {
    state.bridgeProcess.kill('SIGTERM');
  }
  if (state.browserProcess && !state.browserProcess.killed) {
    state.browserProcess.kill('SIGTERM');
  }
}

function attachProcessLogs(state: TerminalAppState, child: ChildProcess, label: string): void {
  child.stdout?.on('data', (chunk: Buffer) => {
    pushLog(state, `[${label}] ${chunk.toString('utf8').trim()}`);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    pushLog(state, `[${label}] ${chunk.toString('utf8').trim()}`);
  });
  child.once('exit', (code, signal) => {
    pushLog(state, `[${label}] exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
  });
}

function pushLog(state: TerminalAppState, line: string): void {
  if (!line.trim()) {
    return;
  }
  state.logs.push(`${new Date().toISOString()} ${line}`);
  if (state.logs.length > 400) {
    state.logs.splice(0, state.logs.length - 400);
  }
}

async function generateBridgeAiPlanIfConfigured(
  options: GlobalOptions,
  intent: string,
): Promise<SharedAgentPlan | null> {
  const status = await tryBridgeRequest<BridgeAiStatus>(options, '/bridge/ai/status');
  if (!status.ok || !status.value.available) {
    return null;
  }
  const request = bridgeAiPlanRequest(intent);
  return bridgeRequest<SharedAgentPlan>(options, '/bridge/ai/generate-plan', {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

function bridgeAiPlanRequest(intent: string): AiPlanRequest {
  const template = templateById(inferTemplateIdForPrompt(intent, 'custom-request'));
  const parameters = inferredTemplateParameters(
    template,
    intent,
    defaultTemplateFieldValues(template),
  );
  return {
    prompt: intent,
    userNotes: intent,
    template: {
      id: template.id,
      category: template.category,
      title: template.title,
      description: template.description,
      actionType: template.actionType,
      risk: template.risk,
    },
    parameters,
  };
}

function buildAgentPlan(intent: string): TerminalAgentPlan {
  const normalized = intent.toLowerCase();
  const route = normalized.includes('swap')
    ? 'swap'
    : normalized.includes('send') || normalized.includes('transfer') || normalized.includes('pay')
      ? 'transfer'
      : 'research';
  const risk: RiskLevel = normalized.includes('mainnet') || normalized.includes('large') ? 'medium' : 'low';
  const constraints = [
    'Wallet signature required before custody action.',
    'Bridge exposes route, amount, and policy before signing.',
    'Receipts remain available after approval, rejection, or archival.',
  ];
  if (route === 'swap') {
    constraints.push('Swap route should stay inside configured slippage and token caps.');
  }
  if (route === 'transfer') {
    constraints.push('Transfer amount must fit configured SOL/token caps.');
  }
  return {
    intent,
    route,
    risk,
    constraints,
    createdAt: new Date().toISOString(),
  };
}

function printAgentPlan(plan: CliAgentPlan): void {
  console.log(`Intent: ${plan.intent}`);
  console.log(`Route: ${plan.route}`);
  console.log(`Risk: ${plan.risk}`);
  if (isSharedAgentPlan(plan)) {
    console.log(`Action: ${plan.actionType}`);
    if (plan.fields.length) {
      console.log('Fields:');
      for (const fieldEntry of plan.fields) {
        console.log(`- ${fieldEntry.label}: ${fieldEntry.value}`);
      }
    }
    if (plan.safeguards.length) {
      console.log('Safeguards:');
      for (const safeguard of plan.safeguards) {
        console.log(`- ${safeguard}`);
      }
    }
  } else {
    console.log('Constraints:');
    for (const constraint of plan.constraints) {
      console.log(`- ${constraint}`);
    }
  }
}

function agentPlanSigningMessage(plan: CliAgentPlan): string {
  const constraints = isSharedAgentPlan(plan)
    ? plan.safeguards.join(' | ')
    : plan.constraints.join(' | ');
  return [
    'Solana Agent Wallet Adapter',
    'Agent plan approval proof',
    `Intent: ${plan.intent}`,
    `Route: ${plan.route}`,
    `Risk: ${plan.risk}`,
    `Constraints: ${constraints}`,
    `Created: ${isSharedAgentPlan(plan) ? new Date().toISOString() : plan.createdAt}`,
    `Hash: ${sha256(stableJson(plan))}`,
  ].join('\n');
}

function isSharedAgentPlan(plan: CliAgentPlan): plan is SharedAgentPlan {
  return 'actionType' in plan && 'parameters' in plan && 'safeguards' in plan;
}

function planRisk(plan: CliAgentPlan): RiskLevel {
  const risk = plan.risk.toLowerCase();
  if (risk.includes('high')) return 'high';
  if (risk.includes('medium')) return 'medium';
  return 'low';
}

async function planParamOrPrompt(
  rl: readline.Interface,
  plan: SharedAgentPlan,
  key: string,
  label: string,
  fallback = '',
): Promise<string> {
  const value = plan.parameters[key]?.trim();
  if (value) return value;
  return fallback ? prompt(rl, label, fallback) : promptRequired(rl, label);
}

function researchSigningMessage(artifact: ResearchArtifact): string {
  return [
    'Solana Agent Wallet Adapter',
    `Research artifact: ${artifact.title}`,
    `Artifact: ${artifact.id}`,
    `Wallet: ${artifact.walletAddress ?? 'unknown'}`,
    `Cluster: ${artifact.cluster}`,
    `Hash: ${artifact.payloadHash}`,
  ].join('\n');
}

function printResearchLabs(): void {
  for (const lab of RESEARCH_LABS) {
    console.log(`${lab.title} (${lab.id})`);
    console.log(`  ${lab.description}`);
  }
  console.log('\nUse /research <number|id> to create and optionally sign one artifact.');
  console.log('Blank artifact input uses that lab default.');
}

function resolveResearchLab(value: string): ResearchLab {
  const normalized = value.trim().toLowerCase();
  const index = Number(normalized);
  if (Number.isInteger(index) && index >= 1 && index <= RESEARCH_LABS.length) {
    return RESEARCH_LABS[index - 1]!;
  }
  const exact = RESEARCH_LABS.find((lab) => lab.id === normalized || lab.kind === normalized);
  if (exact) {
    return exact;
  }
  const prefixed = RESEARCH_LABS.filter(
    (lab) => lab.id.startsWith(normalized) || lab.kind.startsWith(normalized),
  );
  if (prefixed.length === 1) {
    return prefixed[0]!;
  }
  throw new Error(`Unknown research lab: ${value}. Run /research list.`);
}

async function buildResearchArtifact(
  options: GlobalOptions,
  lab: ResearchLab,
  input: string,
): Promise<ResearchArtifact> {
  const status = await tryBridgeRequest<WalletStatus>(options, '/bridge/action/status');
  const cluster = status.ok && status.value.cluster ? status.value.cluster : 'mainnet-beta';
  const walletAddress = status.ok ? status.value.address ?? null : null;
  const baseArtifact = {
    version: 'terminal-research-v1' as const,
    id: `research_${randomBytes(6).toString('hex')}`,
    title: lab.title,
    kind: lab.kind,
    concept: lab.description,
    input,
    walletAddress,
    cluster,
    createdAt: new Date().toISOString(),
  };
  const payloadHash = sha256(stableJson(baseArtifact));
  return { ...baseArtifact, payloadHash };
}

function filterPreparedActions(actions: PreparedAction[], filter: string): PreparedAction[] {
  if (filter === 'all') {
    return actions;
  }
  if (filter === 'ready') {
    return actions.filter((action) => action.status === 'ready' || action.status === 'overdue');
  }
  if (filter === 'scheduled') {
    return actions.filter((action) => action.status === 'scheduled');
  }
  if (filter === 'recurring') {
    return actions.filter((action) => Boolean(action.recurringId));
  }
  return actions.filter((action) => action.status === filter);
}

function renderPreparedActionsDetailed(actions: PreparedAction[]): void {
  if (actions.length === 0) {
    console.log('No prepared actions.');
    return;
  }
  actions.forEach((action, index) => {
    printPreparedActionDetail(action, index + 1);
    if (index < actions.length - 1) {
      console.log('');
    }
  });
  console.log('\nUse /approve <row>, /reject <row>, /archive <row>, or /inspect <row>. Use /inbox compact for a table.');
}

function printPreparedActionDetail(action: PreparedAction, row: number): void {
  const blink = isBlinkAction(action);
  const amount = amountLabel(action);
  const token = tokenLabel(action);
  const recipient = recipientLabel(action);
  console.log(row > 0 ? `[${row}] ${action.id}` : action.id);
  if (blink) {
    console.log('  Blink action');
  }
  console.log(`  Status: ${action.status}${action.txStatus ? ` (${action.txStatus})` : ''}`);
  console.log(`  Kind: ${action.kind}`);
  console.log(`  Summary: ${action.summary}`);
  console.log(`  Due: ${timeLabel(action.dueAt)} (${action.dueAt})`);
  console.log(`  Wallet: ${action.walletAddress}`);
  if (!blink && (amount || token || recipient)) {
    console.log(`  Action: ${[amount, token, recipient ? `to ${recipient}` : ''].filter(Boolean).join(' ')}`);
  }
  if (blink) {
    printBlinkActionDetail(action);
  }
  if (action.note) {
    console.log(`  Note: ${action.note}`);
  }
  if (action.recurringId) {
    console.log(`  Recurring: ${action.recurringId}`);
  }
  if (action.txid) {
    console.log(`  Txid: ${action.txid}`);
  }
  if (action.error) {
    console.log(`  Error: ${action.error}`);
  }
  const params = printablePreparedActionParams(action);
  if (Object.keys(params).length > 0) {
    console.log(`  Params: ${stableJson(params).replace(/\n/g, '\n    ')}`);
  }
}

function renderPreparedActionsCompact(actions: PreparedAction[]): void {
  if (actions.length === 0) {
    console.log('No prepared actions.');
    return;
  }
  renderTable(
    actions.map((action, index) => [
      String(index + 1),
      action.status,
      preparedActionKindLabel(action),
      timeLabel(action.dueAt),
      preparedActionSummaryLabel(action),
      action.id,
    ]),
    ['#', 'Status', 'Kind', 'Due', 'Summary', 'Id'],
  );
}

function renderRecurringPayments(payments: RecurringPayment[]): void {
  if (payments.length === 0) {
    console.log('No recurring approvals.');
    return;
  }
  renderTable(
    payments.map((payment) => [
      short(payment.id, 12),
      payment.status,
      `${payment.amount} ${payment.token}`,
      payment.cadence,
      payment.nextDueAt ? timeLabel(payment.nextDueAt) : '',
      short(payment.recipient, 12),
    ]),
    ['Id', 'Status', 'Amount', 'Cadence', 'Next', 'Recipient'],
  );
}

function isBlinkAction(action: PreparedAction): boolean {
  return action.kind === 'blink_action'
    || stringParam(action, 'connectorActionSource') === 'blink'
    || Boolean(stringParam(action, 'blinkUrl') || stringParam(action, 'actionUrl'));
}

function preparedActionKindLabel(action: PreparedAction): string {
  return isBlinkAction(action) ? 'blink' : action.kind;
}

function preparedActionSummaryLabel(action: PreparedAction): string {
  if (!isBlinkAction(action)) {
    return action.summary;
  }
  return [blinkProtocolLabel(action), blinkOperationLabel(action), blinkUrlHost(action)].filter(Boolean).join(' ');
}

function printBlinkActionDetail(action: PreparedAction): void {
  const connector = firstStringParam(action, 'connectorId', 'connector');
  const protocol = firstStringParam(action, 'protocol') || connector || 'Blink';
  const operation = blinkOperationLabel(action);
  const url = firstStringParam(action, 'actionUrl', 'blinkUrl');
  const expected = expectedBlinkLabel(action);
  console.log(`  Protocol: ${protocol}`);
  if (connector && connector !== protocol) {
    console.log(`  Connector: ${connector}`);
  }
  console.log(`  Operation: ${operation}`);
  if (url) {
    console.log(`  URL: ${url}`);
    console.log(`  Host: ${blinkUrlHost(action)}`);
  }
  if (expected) {
    console.log(`  Expected: ${expected}`);
  }
  const position = firstStringParam(action, 'position');
  if (position) {
    console.log(`  Position: ${position}`);
  }
  const message = firstStringParam(action, 'blinkMessage');
  if (message) {
    console.log(`  Message: ${message}`);
  }
  if (typeof action.params.transactionBase64 === 'string') {
    console.log('  Transaction: prepared transaction bytes present');
  }
  if (Array.isArray(action.params.transactions)) {
    console.log(`  Transactions: ${action.params.transactions.length} prepared transaction entries`);
  }
  console.log(`  Boundary: ${BLINK_BOUNDARY_COPY}`);
}

function blinkProtocolLabel(action: PreparedAction): string {
  return firstStringParam(action, 'protocol', 'connectorId', 'connector') || 'Blink';
}

function blinkOperationLabel(action: PreparedAction): string {
  return firstStringParam(action, 'operation', 'blinkLabel', 'blinkTitle') || action.summary || 'Blink action';
}

function blinkUrlHost(action: PreparedAction): string {
  const url = firstStringParam(action, 'actionUrl', 'blinkUrl');
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return short(url, 48);
  }
}

function expectedBlinkLabel(action: PreparedAction): string {
  const amount = amountLabel(action);
  const token = tokenLabel(action);
  const recipient = recipientLabel(action);
  return [amount, token, recipient ? `to ${recipient}` : ''].filter(Boolean).join(' ');
}

function amountLabel(action: PreparedAction): string {
  if (isBlinkAction(action)) {
    return firstStringParam(action, 'expectedAmount', 'amount');
  }
  if (action.kind === 'transfer_sol') {
    return stringParam(action, 'amountSol') || stringParam(action, 'amount');
  }
  return stringParam(action, 'amount');
}

function tokenLabel(action: PreparedAction): string {
  if (isBlinkAction(action)) {
    return firstStringParam(action, 'expectedToken', 'token');
  }
  if (action.kind === 'transfer_sol') {
    return 'SOL';
  }
  return stringParam(action, 'token') || stringParam(action, 'inputToken');
}

function recipientLabel(action: PreparedAction): string {
  return isBlinkAction(action)
    ? firstStringParam(action, 'expectedRecipient', 'recipient')
    : stringParam(action, 'recipient');
}

function firstStringParam(action: PreparedAction, ...keys: string[]): string {
  for (const key of keys) {
    const value = stringParam(action, key);
    if (value) return value;
  }
  return '';
}

function stringParam(action: PreparedAction, key: string): string {
  const value = action.params[key];
  return typeof value === 'string' ? value : '';
}

function printablePreparedActionParams(action: PreparedAction): JsonRecord {
  const hidden = new Set(['transactionBase64', 'transactions']);
  if (isBlinkAction(action)) {
    for (const key of [
      'actionUrl',
      'blinkUrl',
      'blinkTitle',
      'blinkLabel',
      'blinkMessage',
      'connector',
      'connectorId',
      'connectorActionSource',
      'expectedAmount',
      'expectedRecipient',
      'expectedToken',
      'operation',
      'position',
      'protocol',
    ]) {
      hidden.add(key);
    }
  }
  return Object.fromEntries(Object.entries(action.params).filter(([key]) => !hidden.has(key)));
}

function renderUnknownTable(rows: unknown[], columns: string[]): void {
  renderTable(
    rows.map((row) => {
      const record = isRecord(row) ? row : {};
      return columns.map((column) => short(String(record[column] ?? ''), 24));
    }),
    columns,
  );
}

function renderTable(rows: string[][], headers: string[]): void {
  const allRows = [headers, ...rows];
  const widths = headers.map((_, column) => {
    const longest = Math.max(...allRows.map((row) => (row[column] ?? '').length));
    return Math.min(Math.max(longest, headers[column]?.length ?? 0), column === headers.length - 1 ? 64 : 22);
  });
  const formatRow = (row: string[]) => row
    .map((cell, index) => padCell(short(cell, widths[index] ?? 16), widths[index] ?? 16))
    .join('  ');
  console.log(formatRow(headers));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) {
    console.log(formatRow(row));
  }
}

function padCell(value: string, width: number): string {
  if (value.length >= width) {
    return value;
  }
  return `${value}${' '.repeat(width - value.length)}`;
}

function printDoctor(options: GlobalOptions, doctor: JsonRecord): void {
  printSection('Doctor');
  const files = isRecord(doctor.files) ? doctor.files : {};
  const setup = isRecord(doctor.setup) ? doctor.setup : {};
  console.log(`Bridge URL: ${String(doctor.bridgeUrl ?? '')}`);
  console.log(`Wallet host: ${String(doctor.walletHostLaunchUrl ?? '')}`);
  console.log(`Runtime dir: ${String(doctor.runtimeDir ?? '')}`);
  console.log(`Repo root: ${String(doctor.repoRoot ?? 'not detected')}`);
  console.log(`.env: ${files.env ? 'found' : 'missing'}`);
  console.log(`Config: ${files.config ? 'found' : 'missing'}`);
  console.log(`Prepared action dir: ${files.preparedActionsDir ? 'found' : 'missing'}`);
  console.log(`Wallet host assets: ${files.walletHostAssets ? 'found' : 'missing'}`);
  const bridge = isRecord(doctor.bridge) ? doctor.bridge : {};
  console.log(`Bridge: ${bridge.reachable ? 'reachable' : `offline (${String(bridge.error ?? 'unknown')})`}`);
  const walletHost = isRecord(doctor.walletHost) ? doctor.walletHost : {};
  console.log(`Browser wallet host: ${walletHost.reachable ? 'reachable' : 'offline'}`);
  console.log(`Setup RPC: ${setup.rpcUrlConfigured ? `configured (${String(setup.rpcUrlRedacted ?? '')})` : 'missing'}`);
  console.log(`Setup Jupiter: ${setup.jupiterApiKeyConfigured ? `configured (${String(setup.jupiterApiKeyRedacted ?? '')})` : 'missing'}`);
  console.log(`Setup BirdEye: ${setup.birdeyeApiKeyConfigured ? `configured (${String(setup.birdeyeApiKeyRedacted ?? '')})` : 'missing'}`);
  console.log(`Setup swaps: ${setup.swapsReady ? 'ready' : 'not ready'}`);
  console.log(`Setup market data: ${setup.marketDataReady ? 'ready' : 'not ready'}`);
  if (options.json) {
    console.log(stableJson(doctor));
  }
}

function printSetupStatus(options: GlobalOptions, status: RuntimeSetupStatus): void {
  printSection('Setup');
  console.log(`.env: ready at ${status.envPath}`);
  console.log(`RPC: ${status.rpcUrlConfigured ? `configured (${status.rpcUrlRedacted ?? ''})` : 'missing'}`);
  console.log(`Jupiter key: ${status.jupiterApiKeyConfigured ? `configured (${status.jupiterApiKeyRedacted ?? ''})` : 'missing'}`);
  console.log(`Jupiter Swap API v2: ${status.jupiterUltraBase}`);
  console.log(`Legacy Jupiter API: ${status.jupiterApiUrl}`);
  console.log(`BirdEye key: ${status.birdeyeApiKeyConfigured ? `configured (${status.birdeyeApiKeyRedacted ?? ''})` : 'missing'}`);
  console.log(`BirdEye REST: ${status.birdeyeRestBase}`);
  console.log(`SOL sends: ${status.solTransfersReady ? 'ready' : 'missing RPC'}`);
  console.log(`Token sends: ${status.tokenTransfersReady ? 'ready' : 'missing RPC'}`);
  console.log(`Swaps: ${status.swapsReady ? 'ready' : 'missing RPC or Jupiter key'}`);
  console.log(`Market data: ${status.marketDataReady ? 'ready' : 'missing BirdEye key'}`);
  if (!status.swapsReady) {
    printWarn(options, 'Run setup again with --rpc-url and --jupiter-api-key before expecting swaps to execute.');
  }
  if (!status.marketDataReady) {
    printWarn(options, 'Run setup again with --birdeye-api-key before expecting token search and card prices.');
  }
}

function renderBanner(state: TerminalAppState): void {
  console.log(colorize(state.options, '\nSolana Agent Wallet Terminal', 'green'));
  console.log('Wallet-held approvals, agent plans, inbox review, schedules, and signed research artifacts.');
  console.log(`Bridge ${state.options.bridgeUrl} | Wallet host ${state.options.walletHostUrl}\n`);
}

function printCommandMenu(): void {
  printSection('Commands');
  console.log('/setup             Configure local RPC and Jupiter credentials');
  console.log('/connect           Open browser wallet host and wait for wallet bridge connection');
  console.log('/wallet            Wallet, network, RPC, custody state');
  console.log('/inbox [filter]    Prepared approvals. Filters: all, ready, scheduled, approved, failed, recurring');
  console.log('/inbox compact     Compact inbox table');
  console.log('/inspect <id|#>    Full details for one prepared action');
  console.log('/approve <id|#>    Open wallet host and approve a prepared action');
  console.log('/reject <id|#>     Reject a prepared action');
  console.log('/schedule          Create recurring payment approval');
  console.log('/schedule list     List recurring approvals');
  console.log('/plan [request]    Build/sign/queue an agent plan from natural language');
  console.log('/research list     Show all 15 research labs');
  console.log('/research <id|#>   Create a signed research artifact');
  console.log('/receipts          Show approval receipts');
  console.log('/balances          SOL and configured token balances');
  console.log('/quote             Swap quote helper');
  console.log('/doctor            Local bridge and host diagnostics');
  console.log('/open              Open browser wallet host');
  console.log('/logs              Local terminal app logs');
  console.log('/quit              Exit\n');
}

function printHelp(): void {
  console.log(`Solana Agent Wallet CLI

Usage:
  solana-agent-wallet setup
  solana-agent-wallet app
  solana-agent-wallet doctor
  solana-agent-wallet status
  solana-agent-wallet balances
  solana-agent-wallet portfolio
  solana-agent-wallet connect
  solana-agent-wallet inbox list
  solana-agent-wallet inbox inspect <action-id>
  solana-agent-wallet inbox approve <action-id>
  solana-agent-wallet inbox reject <action-id>
  solana-agent-wallet prepare transfer-sol <recipient> <amount-sol>
  solana-agent-wallet prepare transfer-spl <token> <recipient> <amount>
  solana-agent-wallet prepare swap <amount> [input-token] [output-token]
  solana-agent-wallet prepare blink --url <url> [--connector <id>] [--operation <label>]
  solana-agent-wallet schedule list
  solana-agent-wallet receipts
  solana-agent-wallet research list
  solana-agent-wallet research sign <number|id> [artifact input]
  solana-agent-wallet open
  solana-agent-wallet bridge serve
  solana-agent-wallet bridge start
  solana-agent-wallet wallet-host serve

Setup options:
  --rpc-url <url>            SOLANA_RPC_URL and HELIUS_RPC_URL
  --jupiter-api-key <key>    JUPITER_API_KEY and JUP_API_KEY
  --jupiter-swap-base-url <url> Default: ${DEFAULT_JUPITER_ULTRA_BASE}
  --jupiter-api-url <url>    Default: ${DEFAULT_JUPITER_API_URL}
  --birdeye-api-key <key>    BIRDEYE_API_KEY for token search and prices
  --birdeye-rest-base <url>  Default: ${DEFAULT_BIRDEYE_REST_BASE}
  --yes                     Do not prompt; only write provided values/default URLs

Global options:
  --bridge-url <url>         Default: ${DEFAULT_BRIDGE_URL}
  --token <token>            Default: BRIDGE_TOKEN or a generated per-run token
  --wallet-host-url <url>    Default: ${DEFAULT_WALLET_HOST_URL}
  --runtime-dir <path>       Installed config/data dir
  --repo-root <path>         Use repo-local config/data for development fallback
  --env <path>               Bridge .env path
  --config <path>            agent-wallet.config.json path
  --prepared-actions <path>  Prepared action store path
  --lab-artifacts <path>     Signed lab artifact archive path
  --wallet-host-dir <path>   Built wallet host static asset directory
  --json                     Print scriptable JSON
  --no-color                 Disable ANSI colors
`);
}

function printResult(result: unknown, options: GlobalOptions): void {
  if (result === NO_OUTPUT) {
    return;
  }
  if (options.json) {
    console.log(stableJson(result));
    return;
  }
  console.log(stableJson(result));
}

function printSection(title: string): void {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

function printOk(options: GlobalOptions, message: string): void {
  console.log(colorize(options, message, 'green'));
}

function printWarn(options: GlobalOptions, message: string): void {
  console.warn(colorize(options, message, 'yellow'));
}

function printError(options: GlobalOptions, message: string): void {
  console.error(colorize(options, message, 'red'));
}

function printMuted(options: GlobalOptions, message: string): void {
  console.log(colorize(options, message, 'muted'));
}

function colorize(options: GlobalOptions, value: string, color: 'green' | 'yellow' | 'red' | 'muted'): string {
  if (!options.color) {
    return value;
  }
  const codes = {
    green: ['\u001b[32m', '\u001b[0m'],
    yellow: ['\u001b[33m', '\u001b[0m'],
    red: ['\u001b[31m', '\u001b[0m'],
    muted: ['\u001b[2m', '\u001b[0m'],
  } as const;
  const [start, end] = codes[color];
  return `${start}${value}${end}`;
}

function parseArgs(argv: string[]): ParsedArgs {
  const repoRoot = findRepoRoot(process.cwd());
  const runtimeDir = process.env.AGENT_WALLET_HOME
    ? resolve(process.env.AGENT_WALLET_HOME)
    : repoRoot ?? defaultUserRuntimeDir();
  const options: GlobalOptions = {
    bridgeUrl: stripTrailingSlash(process.env.AGENT_WALLET_BRIDGE_URL ?? process.env.BRIDGE_URL ?? DEFAULT_BRIDGE_URL),
    token: process.env.BRIDGE_TOKEN ?? randomBridgeToken(),
    walletHostUrl: stripTrailingSlash(process.env.AGENT_WALLET_WALLET_HOST_URL ?? DEFAULT_WALLET_HOST_URL),
    repoRoot,
    runtimeDir,
    envPath: repoRoot ? join(repoRoot, '.env') : join(runtimeDir, '.env'),
    configPath: repoRoot ? join(repoRoot, 'agent-wallet.config.json') : join(runtimeDir, 'agent-wallet.config.json'),
    preparedActionsPath: repoRoot
      ? join(repoRoot, '.agent-wallet', 'prepared-actions.json')
      : join(runtimeDir, 'prepared-actions.json'),
    labArtifactsPath: repoRoot
      ? join(repoRoot, '.agent-wallet', 'lab-artifacts.json')
      : join(runtimeDir, 'lab-artifacts.json'),
    walletHostDir: defaultWalletHostDir(),
    json: false,
    color: process.env.NO_COLOR !== '1',
    help: false,
  };
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--') {
      if (index === 0 && positionals.length === 0) {
        continue;
      }
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
    if (flag === '--bridge-url') {
      const value = optionArgument(argv, index, flag, inlineValue);
      options.bridgeUrl = stripTrailingSlash(value.value);
      index = value.index;
      continue;
    }
    if (flag === '--token') {
      const value = optionArgument(argv, index, flag, inlineValue);
      options.token = value.value;
      index = value.index;
      continue;
    }
    if (flag === '--wallet-host-url') {
      const value = optionArgument(argv, index, flag, inlineValue);
      options.walletHostUrl = stripTrailingSlash(value.value);
      index = value.index;
      continue;
    }
    if (flag === '--repo-root') {
      const value = optionArgument(argv, index, flag, inlineValue);
      options.repoRoot = resolve(value.value);
      options.runtimeDir = options.repoRoot;
      options.envPath = join(options.repoRoot, '.env');
      options.configPath = join(options.repoRoot, 'agent-wallet.config.json');
      options.preparedActionsPath = join(options.repoRoot, '.agent-wallet', 'prepared-actions.json');
      options.labArtifactsPath = defaultLabArtifactStorePath(options.preparedActionsPath);
      index = value.index;
      continue;
    }
    if (flag === '--runtime-dir') {
      const value = optionArgument(argv, index, flag, inlineValue);
      options.runtimeDir = resolve(value.value);
      options.envPath = join(options.runtimeDir, '.env');
      options.configPath = join(options.runtimeDir, 'agent-wallet.config.json');
      options.preparedActionsPath = join(options.runtimeDir, 'prepared-actions.json');
      options.labArtifactsPath = defaultLabArtifactStorePath(options.preparedActionsPath);
      index = value.index;
      continue;
    }
    if (flag === '--env') {
      const value = optionArgument(argv, index, flag, inlineValue);
      options.envPath = resolve(value.value);
      index = value.index;
      continue;
    }
    if (flag === '--config') {
      const value = optionArgument(argv, index, flag, inlineValue);
      options.configPath = resolve(value.value);
      index = value.index;
      continue;
    }
    if (flag === '--prepared-actions') {
      const value = optionArgument(argv, index, flag, inlineValue);
      options.preparedActionsPath = resolve(value.value);
      options.labArtifactsPath = defaultLabArtifactStorePath(options.preparedActionsPath);
      index = value.index;
      continue;
    }
    if (flag === '--lab-artifacts') {
      const value = optionArgument(argv, index, flag, inlineValue);
      options.labArtifactsPath = resolve(value.value);
      index = value.index;
      continue;
    }
    if (flag === '--wallet-host-dir') {
      const value = optionArgument(argv, index, flag, inlineValue);
      options.walletHostDir = resolve(value.value);
      index = value.index;
      continue;
    }

    positionals.push(arg);
  }

  return { options, positionals };
}

function randomBridgeToken(): string {
  return randomBytes(24).toString('base64url');
}

function splitFlag(arg: string): [string, string | undefined] {
  if (!arg.startsWith('-')) {
    return [arg, undefined];
  }
  const index = arg.indexOf('=');
  if (index < 0) {
    return [arg, undefined];
  }
  return [arg.slice(0, index), arg.slice(index + 1)];
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
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return { value, index: index + 1 };
}

function findRepoRoot(start: string): string | null {
  let current = resolve(start);
  while (true) {
    if (
      existsSync(join(current, 'package.json')) &&
      existsSync(join(current, 'packages', 'mcp-server'))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function defaultWalletHostDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'wallet-host');
}

function defaultUserRuntimeDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(base, RUNTIME_DIR_NAME);
  }
  return join(homedir(), `.${RUNTIME_DIR_NAME}`);
}

function optionValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index >= 0) {
    return args[index + 1];
  }
  const inlinePrefix = `${flag}=`;
  const inline = args.find((arg) => arg.startsWith(inlinePrefix));
  return inline ? inline.slice(inlinePrefix.length) : undefined;
}

function optionValues(args: string[], flag: string): string[] {
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

function commandValues(args: string[], valueFlags: Set<string>): string[] {
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

function splitCommandLine(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = null;
      continue;
    }
    if (char === ' ' && quote === null) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

function parseStringParameters(values: string[]): Record<string, string> {
  const parameters: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator <= 0) {
      throw new Error(`Blink parameters must use key=value, received: ${value}`);
    }
    const key = value.slice(0, separator).trim();
    const parameterValue = value.slice(separator + 1);
    if (!key) {
      throw new Error(`Blink parameter key is required, received: ${value}`);
    }
    parameters[key] = parameterValue;
  }
  return parameters;
}

async function prompt(rl: readline.Interface, label: string, defaultValue: string): Promise<string> {
  const answer = (await rl.question(`${label}${defaultValue ? ` [${defaultValue}]` : ''}: `)).trim();
  return answer || defaultValue;
}

async function promptRequired(rl: readline.Interface, label: string): Promise<string> {
  while (true) {
    const answer = (await rl.question(`${label}: `)).trim();
    if (answer) {
      return answer;
    }
    console.log(`${label} is required.`);
  }
}

async function confirm(rl: readline.Interface, label: string, defaultValue: boolean): Promise<boolean> {
  const hint = defaultValue ? 'Y/n' : 'y/N';
  const answer = (await rl.question(`${label} [${hint}]: `)).trim().toLowerCase();
  if (!answer) {
    return defaultValue;
  }
  return answer === 'y' || answer === 'yes';
}

function parseJsonBody(text: string): unknown {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function responseError(body: unknown): string | undefined {
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

function formatBridgeError(options: GlobalOptions, message: string): string {
  if (/No browser wallet is connected/i.test(message)) {
    return [
      'No browser wallet is connected to the local bridge.',
      `Open ${walletHostLaunchUrl(options)}`,
      'Connect your wallet in that browser tab, then click Connect bridge if prompted.',
      'You can also run solana-agent-wallet connect or /connect.',
    ].join(' ');
  }
  return message;
}

function removeUndefined(record: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function short(value: string, max = 16): string {
  if (value.length <= max) {
    return value;
  }
  if (max <= 6) {
    return value.slice(0, max);
  }
  const head = Math.ceil((max - 3) / 2);
  const tail = Math.floor((max - 3) / 2);
  return `${value.slice(0, head)}...${value.slice(value.length - tail)}`;
}

function timeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

main().catch((err) => {
  const parsed = (() => {
    try {
      return parseArgs(process.argv.slice(2));
    } catch {
      return null;
    }
  })();
  if (parsed?.options.color) {
    printError(parsed.options, errorMessage(err));
  } else {
    console.error(errorMessage(err));
  }
  process.exit(1);
});
