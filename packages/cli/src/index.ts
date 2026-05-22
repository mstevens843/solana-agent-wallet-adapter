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

// v1.0 command modules — added alongside the legacy dispatchers in this file.
import { dispatchDeviceAgent } from './commands/deviceAgent.js';
import { dispatchPrepareConnector, dispatchConnectorGroup } from './commands/connector.js';
import { dispatchMarket, dispatchTokens } from './commands/market.js';
import { dispatchRead } from './commands/read.js';
import { dispatchPlan as dispatchAiPlan } from './commands/plan.js';
import { dispatchSwap as dispatchSwapCommand } from './commands/swap.js';
import { dispatchHeliusHistory } from './commands/helius.js';
import {
  dispatchScheduleCreate,
  dispatchScheduleOccurrences,
  dispatchScheduleNotifications,
  dispatchScheduleRotateNotifications,
} from './commands/schedule.js';
import { dispatchAuth } from './commands/auth.js';
import { dispatchProfile } from './commands/profile.js';
import { dispatchPrefs } from './commands/prefs.js';
import { dispatchSpendLimits } from './commands/spendLimits.js';
import { dispatchVoucher } from './commands/voucher.js';
import { dispatchMppExtra } from './commands/mppInbound.js';
import { dispatchBridgeRouter } from './commands/bridgeRouter.js';
import { dispatchCloudWorkspace } from './commands/cloudWorkspace.js';
import { dispatchSkills } from './commands/skills.js';
import { dispatchSignals } from './commands/signals.js';
import { dispatchAp2, dispatchAcp } from './commands/mandates.js';
import { dispatchAudit } from './commands/audit.js';
import { dispatchBirdeye } from './commands/birdeye.js';
import { dispatchCoingecko } from './commands/coingecko.js';
import { dispatchHeliusGroup } from './commands/heliusCloud.js';
import { dispatchSolana } from './commands/solana.js';
import { dispatchApprovals } from './commands/approvals.js';
import { dispatchCompleted } from './commands/completed.js';
import { dispatchPlans } from './commands/plansList.js';
import { dispatchEvidence } from './commands/evidence.js';
import { dispatchLabArtifacts } from './commands/labArtifacts.js';
import { dispatchBridgeAgents } from './commands/bridgeAgents.js';
import {
  PREPARE_ALIASES,
  isPrepareAlias,
  resolveAliasKind,
} from './commands/prepareAliases.js';
import { loadSession, sessionStatusSummary } from './auth/sessionStore.js';
import { renderWebRequest as renderWebRequestClient } from './http/index.js';

// v1.1 — flow-first command surface. Mirrors the web app's tabs (Draft, Needs
// Approval, Active Repeats, Done). Browser only opens for the four wallet
// signing intents (connect, disconnect, approve, sign). All form filling stays
// in the terminal.
import {
  runNewMenu,
  runNewSend,
  runNewSpl,
  runNewSwap,
  runNewConnector,
  runSwapQuote,
} from './flows/new.js';
import {
  runRepeatMenu,
  runRepeatScheduled,
  runRepeatRecurring,
  runRepeatConnector,
} from './flows/repeat.js';
import { runConnectorsMenu } from './flows/connectors.js';
import { runAgent, runAsk } from './flows/agent.js';
import { isMainnetCluster } from './flows/safetyGate.js';
import { friendlyBridgeError } from './flows/_shared.js';
import { runSignIn, runSignOut, showSignInStatus } from './flows/signIn.js';
import { pickInbox, pickDoneFilter } from './flows/menus.js';
import { runDoneList, type DoneFilter } from './flows/done.js';
import { pickPendingAction } from './flows/pickAction.js';
import { runScheduleManage } from './flows/scheduleManage.js';
import { runSessionsMenu } from './flows/sessions.js';
import { runAgentPaymentsMenu } from './flows/agentPayments.js';
import { runSkillsMenu } from './flows/skills.js';
import { runPreferencesMenu } from './flows/preferences.js';
import { ensureTtyOrExit, withCancelGuard, select as tuiSelect, header as tuiHeader, badge as tuiBadge, kv as tuiKv, divider as tuiDivider, password as tuiPassword, input as tuiInput, confirm as tuiConfirm, spinner as tuiSpinner } from './tui/index.js';
import { PROOF_SPECS, listProofSpecs, resolveProofSpec, type ProofSpec } from './forms/proofSpecs.js';
import { promptProofForm } from './forms/proofForm.js';

const CLI_VERSION = '1.0.0';

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
const DEFAULT_RENDER_WEB_URL = 'http://127.0.0.1:3000';
const REQUEST_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 750;
const RUNTIME_DIR_NAME = 'solana-agent-wallet';
const WALLET_HOST_HEALTH_PATH = '/__agentic/health';
// Re-export the shared NO_OUTPUT so commands in src/commands/ can return it
// and printResult recognizes the same symbol.
import { NO_OUTPUT } from './shared/types.js';
const DEFAULT_JUPITER_ULTRA_BASE = 'https://api.jup.ag/swap/v2';
const DEFAULT_JUPITER_API_URL = 'https://quote-api.jup.ag';
const DEFAULT_BIRDEYE_REST_BASE = 'https://public-api.birdeye.so';
const SETUP_ENV_KEYS = [
  'SOLANA_RPC_URL',
  'HELIUS_RPC_URL',
  'HELIUS_API_KEY',
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
  renderWebUrl: string;
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
  heliusApiKey?: string;
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
  // Set when the artifact was authored via the /proof flow. Lets /proof-list
  // group by tier without re-parsing kinds.
  category?: 'common' | 'advanced';
  fields?: Record<string, string>;
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

  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(parsed.options.json ? stableJson({ version: CLI_VERSION }) : CLI_VERSION);
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
      return runDoctorWithFlags(parsed);
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

    // v1.0 — bridge surfaces
    case 'device-agent':
      return dispatchDeviceAgent(parsed);
    case 'connector':
      return dispatchConnectorGroup(parsed);
    case 'connectors':
      if (parsed.positionals.length === 1) {
        await runConnectorsMenu(parsed.options);
        return NO_OUTPUT;
      }
      return dispatchConnectorGroup({
        ...parsed,
        positionals: ['connector', ...parsed.positionals.slice(1)],
      });
    case 'read':
      return dispatchRead(parsed);
    case 'market':
      return dispatchMarket(parsed);
    case 'tokens':
      return dispatchTokens(parsed);
    case 'helius-history':
      return dispatchHeliusHistory(parsed);
    case 'plan':
    case 'ai':
      return dispatchAiPlan(parsed);
    case 'swap':
      return dispatchSwapCommand(parsed);

    // v1.0 — render-web identity & preferences
    case 'auth':
      return dispatchAuth(parsed);
    case 'profile':
      return dispatchProfile(parsed);
    case 'prefs':
      return dispatchPrefs(parsed);
    case 'spend-limits':
      return dispatchSpendLimits(parsed);

    // v1.0 — payment surfaces beyond core session/mpp
    case 'bridge-router':
      return dispatchBridgeRouter(parsed);
    case 'cloud-workspace':
      return dispatchCloudWorkspace(parsed);

    // v1.0 — skills, signals, mandates, audit
    case 'skills':
      return dispatchSkills(parsed);
    case 'signals':
      return dispatchSignals(parsed);
    case 'ap2':
      return dispatchAp2(parsed);
    case 'acp':
      return dispatchAcp(parsed);
    case 'audit':
      return dispatchAudit(parsed);

    // v1.0 final sweep — full endpoint coverage
    case 'birdeye':
      return dispatchBirdeye(parsed);
    case 'coingecko':
      return dispatchCoingecko(parsed);
    case 'helius':
      return dispatchHeliusGroup(parsed);
    case 'solana':
      return dispatchSolana(parsed);
    case 'approvals':
      return dispatchApprovals(parsed);
    case 'completed':
      return dispatchCompleted(parsed);
    case 'plans':
      return dispatchPlans(parsed);
    case 'evidence':
      return dispatchEvidence(parsed);
    case 'bridge-agents':
      return dispatchBridgeAgents(parsed);

    // v1.1 — flow-first one-shot commands. Each requires an interactive TTY
    // (inquirer prompts), spawns the bridge + wallet host if needed, then
    // drops into the form. The cancel guard prints "Cancelled." cleanly if
    // the user hits Ctrl+C mid-prompt.
    case 'new':
      ensureTtyOrExit('new');
      await connectOneShot(parsed.options);
      await withCancelGuard(() => runNewMenu(parsed.options));
      return NO_OUTPUT;
    case 'new-send':
      ensureTtyOrExit('new-send');
      await connectOneShot(parsed.options);
      await withCancelGuard(() => runNewSend(parsed.options));
      return NO_OUTPUT;
    case 'new-spl':
      ensureTtyOrExit('new-spl');
      await connectOneShot(parsed.options);
      await withCancelGuard(() => runNewSpl(parsed.options));
      return NO_OUTPUT;
    case 'new-swap':
      ensureTtyOrExit('new-swap');
      await connectOneShot(parsed.options);
      await withCancelGuard(() => runNewSwap(parsed.options));
      return NO_OUTPUT;
    case 'swap-quote':
      ensureTtyOrExit('swap-quote');
      await connectOneShot(parsed.options);
      await withCancelGuard(() => runSwapQuote(parsed.options));
      return NO_OUTPUT;
    case 'new-connector':
      ensureTtyOrExit('new-connector');
      await connectOneShot(parsed.options);
      await withCancelGuard(() => runNewConnector(parsed.options));
      return NO_OUTPUT;
    case 'repeat':
      ensureTtyOrExit('repeat');
      await connectOneShot(parsed.options);
      await withCancelGuard(() => runRepeatMenu(parsed.options));
      return NO_OUTPUT;
    case 'repeat-scheduled':
      ensureTtyOrExit('repeat-scheduled');
      await connectOneShot(parsed.options);
      await withCancelGuard(() => runRepeatScheduled(parsed.options));
      return NO_OUTPUT;
    case 'repeat-recurring':
      ensureTtyOrExit('repeat-recurring');
      await connectOneShot(parsed.options);
      await withCancelGuard(() => runRepeatRecurring(parsed.options));
      return NO_OUTPUT;
    case 'repeat-connector':
      ensureTtyOrExit('repeat-connector');
      await connectOneShot(parsed.options);
      await withCancelGuard(() => runRepeatConnector(parsed.options));
      return NO_OUTPUT;
    case 'agent': {
      ensureTtyOrExit('agent');
      const agentState = createOneShotState(parsed.options);
      await withCancelGuard(() => runAgent(parsed.options, (plan, note) => signPlanAsProof(agentState, plan, note)));
      return NO_OUTPUT;
    }
    case 'ask':
      ensureTtyOrExit('ask');
      await withCancelGuard(() => runAsk(parsed.options, parsed.positionals.slice(1).join(' ').trim() || undefined));
      return NO_OUTPUT;
    case 'sign-in':
      ensureTtyOrExit('sign-in');
      await withCancelGuard(() => runSignIn(parsed.options));
      return NO_OUTPUT;
    case 'sign-out':
      await runSignOut(parsed.options);
      return NO_OUTPUT;
    case 'sign-in-status':
      await showSignInStatus(parsed.options);
      return NO_OUTPUT;
    case 'sessions':
      if (parsed.positionals.length === 1) {
        ensureTtyOrExit('sessions');
        await withCancelGuard(() => runSessionsMenu(parsed.options));
        return NO_OUTPUT;
      }
      // /sessions <sub> → legacy session command tree
      return dispatchSession({
        ...parsed,
        positionals: ['session', ...parsed.positionals.slice(1)],
      });

    // v1.2 — Round 3 flow-first commands (interactive only — TTY guarded)
    case 'proof':
    case 'proof-new':
    case 'proof-list':
    case 'proof-show':
    case 'proof-delete': {
      ensureTtyOrExit(command);
      await connectOneShot(parsed.options);
      const oneShotState = createOneShotState(parsed.options);
      const sub = command === 'proof' ? parsed.positionals.slice(1)
        : command === 'proof-new' ? ['new', ...parsed.positionals.slice(1)]
        : command === 'proof-list' ? ['list']
        : command === 'proof-show' ? ['show', ...parsed.positionals.slice(1)]
        : ['delete', ...parsed.positionals.slice(1)];
      await withCancelGuard(() => runProofCommand(oneShotState, sub));
      return NO_OUTPUT;
    }
    case 'agent-payments':
      ensureTtyOrExit('agent-payments');
      await withCancelGuard(() => runAgentPaymentsMenu(parsed.options));
      return NO_OUTPUT;
    case 'api-keys':
    case 'keys':
      ensureTtyOrExit('api-keys');
      await withCancelGuard(() => runApiKeysMenu(createOneShotState(parsed.options)));
      return NO_OUTPUT;
    case 'preferences':
    case 'prefs-menu':
      ensureTtyOrExit('preferences');
      await withCancelGuard(() => runPreferencesMenu(parsed.options));
      return NO_OUTPUT;
    case 'done':
      ensureTtyOrExit('done');
      {
        const filter = (parsed.positionals[1] as DoneFilter | undefined) ?? await pickDoneFilter();
        await runDoneList(parsed.options, filter);
      }
      return NO_OUTPUT;

    default:
      // Friendly prepare aliases: route `prepare marinade-stake ...` etc. before failing.
      if (command === 'prepare-alias' && parsed.positionals[1] && isPrepareAlias(parsed.positionals[1])) {
        return dispatchPrepareConnector({
          ...parsed,
          positionals: ['prepare', 'connector', parsed.positionals[1], ...parsed.positionals.slice(2)],
        });
      }
      throw new Error(`Unknown command: ${command ?? ''}. Run solana-agent-wallet help.`);
  }
}

async function dispatchSession(parsed: ParsedArgs): Promise<unknown> {
  const subcommand = parsed.positionals[1] ?? 'help';

  // v1.0 — `session voucher sign|verify` routes to the new voucher module.
  if (subcommand === 'voucher') {
    return dispatchVoucher(parsed);
  }

  const knownSubs = new Set(['list', 'create', 'spend', 'revoke', 'history', 'settle']);
  if (subcommand === 'help' || !knownSubs.has(subcommand)) {
    return {
      command: 'session',
      subcommands: ['list', 'create', 'spend', 'revoke', 'history', 'settle', 'voucher'],
      renderWebUrl: parsed.options.renderWebUrl,
    };
  }

  const rawArgs = commandValues(parsed.positionals.slice(2), new Set(['--wallet', '--allowlist']));
  if (subcommand === 'list') {
    const walletAddress = optionValue(parsed.positionals, '--wallet');
    return streamingRenderWebRequest(parsed.options, streamingSessionsPath({ walletAddress }));
  }

  if (subcommand === 'create') {
    const tokenMint = rawArgs[0];
    const capAmount = rawArgs[1];
    const expiresInSeconds = rawArgs[2];
    if (!tokenMint || !capAmount || !expiresInSeconds) {
      throw new Error('Usage: solana-agent-wallet session create <token-mint> <cap-amount> <expires-in-seconds> [--allowlist <addr,addr>]');
    }
    // Phase 5.18 — validate before round-tripping render-web so users get a
    // friendly local error instead of an opaque 400.
    assertPositiveDecimal(capAmount, 'cap-amount');
    assertPositiveInteger(expiresInSeconds, 'expires-in-seconds');
    return streamingRenderWebRequest(parsed.options, '/api/streaming/sessions', {
      method: 'POST',
      body: JSON.stringify(removeUndefined({
        tokenMint,
        capAmount,
        expiresAt: expiresAtFromSeconds(expiresInSeconds),
        recipientAllowlist: parseAllowlist(optionValue(parsed.positionals, '--allowlist')),
      })),
    });
  }

  const sessionId = rawArgs[0];
  if (!sessionId) {
    throw new Error(`Usage: solana-agent-wallet session ${subcommand} <session-id>`);
  }

  if (subcommand === 'spend') {
    const amount = rawArgs[1];
    const recipient = rawArgs[2];
    if (!amount || !recipient) {
      throw new Error('Usage: solana-agent-wallet session spend <session-id> <amount> <recipient>');
    }
    // Phase 5.18 — same local validation as session create.
    assertPositiveDecimal(amount, 'amount');
    return streamingRenderWebRequest(parsed.options, `/api/streaming/sessions/${encodeURIComponent(sessionId)}/voucher-relay`, {
      method: 'POST',
      body: JSON.stringify({ amount, recipient }),
    });
  }

  if (subcommand === 'revoke') {
    return streamingRenderWebRequest(parsed.options, `/api/streaming/sessions/${encodeURIComponent(sessionId)}/revoke`, {
      method: 'POST',
      body: '{}',
    });
  }

  if (subcommand === 'history') {
    const [session, receipt] = await Promise.all([
      streamingRenderWebRequest(parsed.options, `/api/streaming/sessions/${encodeURIComponent(sessionId)}`),
      streamingRenderWebRequest(parsed.options, `/api/streaming/sessions/${encodeURIComponent(sessionId)}/receipt`),
    ]);
    return { session, receipt };
  }

  return streamingRenderWebRequest(parsed.options, `/api/streaming/sessions/${encodeURIComponent(sessionId)}/settle`, {
    method: 'POST',
    body: '{}',
  });
}

async function dispatchMpp(parsed: ParsedArgs): Promise<unknown> {
  const subcommand = parsed.positionals[1] ?? 'help';

  // v1.0 — inbound + pay-with-session live in the mppInbound module.
  if (subcommand === 'inbound' || subcommand === 'pay') {
    return dispatchMppExtra(parsed);
  }

  const knownSubs = new Set(['challenge', 'config']);
  if (subcommand === 'help' || !knownSubs.has(subcommand)) {
    return {
      command: 'mpp',
      subcommands: ['challenge', 'config', 'inbound', 'pay'],
      renderWebUrl: parsed.options.renderWebUrl,
    };
  }
  if (subcommand === 'config') {
    return mppRenderWebRequest(parsed.options, '/api/mpp/config');
  }
  const file = parsed.positionals[2];
  if (!file) {
    throw new Error('Usage: solana-agent-wallet mpp challenge <file.json>');
  }
  const raw = await readFile(resolve(file), 'utf8');
  const parsedJson = JSON.parse(raw) as unknown;
  const body = isRecord(parsedJson) && parsedJson.challenge !== undefined
    ? parsedJson
    : { challenge: parsedJson };
  return mppRenderWebRequest(parsed.options, '/api/mpp/challenge', {
    method: 'POST',
    body: JSON.stringify(body),
  });
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
  const currentHeliusApiKey = env.values.HELIUS_API_KEY ?? '';
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
  let heliusApiKey = setupOptions.heliusApiKey ?? currentHeliusApiKey;

  const hasExplicitValues = setupOptions.rpcUrl !== undefined
    || setupOptions.jupiterApiKey !== undefined
    || setupOptions.jupiterUltraBase !== undefined
    || setupOptions.jupiterApiUrl !== undefined
    || setupOptions.birdeyeApiKey !== undefined
    || setupOptions.birdeyeRestBase !== undefined
    || setupOptions.heliusApiKey !== undefined;
  const shouldPrompt = rl !== null || (!setupOptions.yes && process.stdin.isTTY && !hasExplicitValues);
  if (shouldPrompt) {
    const setupRl = rl ?? readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      printSection('Local Runtime Setup');
      console.log(`Writing setup to ${options.envPath}`);
      rpcUrl = await promptExistingSecret(setupRl, 'Solana RPC URL', currentRpcUrl);
      heliusApiKey = await promptExistingSecret(setupRl, 'Helius API key (unlocks mint creation + tx history atoms; blank to skip)', currentHeliusApiKey);
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
  if (heliusApiKey.trim()) {
    updates.HELIUS_API_KEY = heliusApiKey.trim();
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
    if (flag === '--helius-api-key') {
      const value = optionArgument(args, index, flag, inlineValue);
      options.heliusApiKey = value.value;
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
    await openWalletHost(parsed.options, { intent: 'approve', actionId: action.id }).catch(() => undefined);
    const result = await bridgeRequest(parsed.options, '/bridge/prepared-actions/execute', {
      method: 'POST',
      body: JSON.stringify({ actionId: action.id }),
    });
    if (parsed.positionals.includes('--wait')) {
      const waitTimeoutRaw = optionValue(parsed.positionals, '--wait-timeout-ms');
      const timeoutMs = waitTimeoutRaw ? Number(waitTimeoutRaw) : 60_000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error('--wait-timeout-ms must be a positive number.');
      }
      const finalStatus = await waitForPreparedActionTxStatus(parsed.options, action.id, timeoutMs);
      return { execute: result, txStatus: finalStatus };
    }
    return result;
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
  if (op === 'artifacts') {
    return dispatchLabArtifacts(parsed);
  }
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
  // v1.0 — schedule create + cloud-side metadata.
  if (op === 'create') {
    return dispatchScheduleCreate(parsed);
  }
  if (op === 'occurrences') {
    return dispatchScheduleOccurrences(parsed);
  }
  if (op === 'notifications') {
    return dispatchScheduleNotifications(parsed);
  }
  if (op === 'rotate-notifications') {
    return dispatchScheduleRotateNotifications(parsed);
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

  // v1.0 — generic `prepare connector <kind> --param k=v` unlocks all connector
  // write actions via the bridge's generic dispatcher. Also accepts the top-20
  // friendly aliases directly as `prepare <alias>`.
  if (kind === 'connector') {
    return dispatchPrepareConnector(parsed);
  }
  if (kind && isPrepareAlias(kind)) {
    return dispatchPrepareConnector({
      ...parsed,
      // Rewrite to the connector dispatcher signature: positionals[2] is the kind.
      positionals: ['prepare', 'connector', resolveAliasKind(kind), ...parsed.positionals.slice(2)],
    });
  }

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

  const aliasHint = PREPARE_ALIASES.slice(0, 6).map((entry) => entry.alias).join(', ');
  throw new Error(
    'Usage: solana-agent-wallet prepare <transfer-sol|transfer-spl|swap|blink|connector|<alias>> ...\n' +
    `Friendly aliases include: ${aliasHint}, ... (run "connector list" for the full registry).`,
  );
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
    await maybePrintOnboardingHint(state);
    printCommandMenu();

    console.log(colorize(state.options, 'Type a command to get started (try /connect).', 'muted'));

    while (true) {
      const line = (await rl.question(colorize(state.options, 'agentic> ', 'green'))).trim();
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

// First-boot onboarding hint: shows once per launch when the user has no keys
// configured AND no wallet connected. Skipped silently for returning users.
async function maybePrintOnboardingHint(state: TerminalAppState): Promise<void> {
  const env = await readEnvValues(state.options.envPath).catch(() => ({ found: false, raw: '', values: {} as Record<string, string> }));
  const hasKey = (k: string): boolean => {
    const fromFile = env.values[k];
    if (typeof fromFile === 'string' && fromFile.trim().length > 0) return true;
    return Boolean(process.env[k] && process.env[k]!.length > 0);
  };
  const anyKey = hasKey('SOLANA_RPC_URL') || hasKey('HELIUS_RPC_URL') || hasKey('JUPITER_API_KEY') || hasKey('BIRDEYE_API_KEY') || hasKey('HELIUS_API_KEY');
  const status = await tryBridgeRequest<WalletStatus>(state.options, '/bridge/action/status');
  const walletConnected = status.ok && status.value.connected;
  if (anyKey || walletConnected) return;

  console.log();
  console.log(colorize(state.options, 'New here? Quick setup:', 'green'));
  console.log('  1. /api-keys     — add your RPC + Jupiter / Birdeye / Helius keys (web fallback works without)');
  console.log('  2. /sign-in      — SIWS into your cloud workspace (optional, enables cross-device sync)');
  console.log('  3. /connect      — link a Solana wallet via the browser (Phantom, Backpack, Solflare…)');
  console.log('  4. /new or /agent — your first action');
  console.log();
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
  // v1.1 — the browser tab no longer opens on boot. It opens only for the four
  // wallet-signing intents (connect, disconnect, approve, sign). Run /connect
  // when you want to attach a wallet.
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
  options: { waitForWallet: boolean; detached?: boolean; cli?: CliIntent },
): Promise<void> {
  const cli: CliIntent = options.cli ?? { intent: 'connect' };
  if (options.detached) {
    await ensureBridgeDetached(state.options);
    await ensureBrowserHostDetached(state.options);
  } else {
    await ensureBridge(state);
    await ensureBrowserHost(state);
  }
  const status = await tryBridgeRequest<WalletStatus>(state.options, '/bridge/action/status');
  if (status.ok && status.value.connected && status.value.address && cli.intent === 'connect') {
    if (!state.options.json) {
      printOk(state.options, `Wallet connected: ${status.value.address}`);
    }
    return;
  }
  await openWalletHost(state.options, cli);
  if (!state.options.json) {
    printSection('Connect Wallet');
    console.log(`Opened: ${walletHostLaunchUrl(state.options, cli)}`);
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

async function disconnectInteractive(state: TerminalAppState): Promise<void> {
  await ensureBridge(state);
  await ensureBrowserHost(state);
  const status = await tryBridgeRequest<WalletStatus>(state.options, '/bridge/action/status');
  if (status.ok && !status.value.connected) {
    if (!state.options.json) {
      printOk(state.options, 'Wallet already disconnected.');
    }
    return;
  }
  await openWalletHost(state.options, { intent: 'disconnect' });
  if (!state.options.json) {
    printSection('Disconnect Wallet');
    console.log(`Opened: ${walletHostLaunchUrl(state.options, { intent: 'disconnect' })}`);
    console.log('In the browser window, click "Disconnect wallet". The terminal will detect the change.');
  }
  const start = Date.now();
  while (Date.now() - start < 120_000) {
    const probe = await tryBridgeRequest<WalletStatus>(state.options, '/bridge/action/status');
    if (probe.ok && !probe.value.connected) {
      if (!state.options.json) {
        printOk(state.options, 'Wallet disconnected.');
      }
      return;
    }
    await sleep(750);
  }
  throw new Error('Wallet still connected after 120s. Click "Disconnect wallet" in the browser and try /disconnect again.');
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
      case 'version':
      case '-v':
      case '--version':
        await printVersionInfo(state);
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
      case 'disconnect':
        await disconnectInteractive(state);
        return false;
      case 'bridge':
        await ensureBridge(state);
        printOk(state.options, `Bridge reachable at ${state.options.bridgeUrl}.`);
        return false;
      case 'inbox':
        if (args.length === 0) {
          const which = await pickInbox();
          if (which === 'new') {
            await printInbox(state, 'ready', false);
          } else {
            await withCancelGuard(() => runScheduleManage(state.options));
          }
        } else {
          await printInbox(state, args[0] === 'compact' ? args[1] ?? 'all' : args[0] ?? 'all', args[0] === 'compact');
        }
        return false;
      case 'inbox-new':
        await printInbox(state, 'ready', false);
        return false;
      case 'inbox-repeat':
        await withCancelGuard(() => runScheduleManage(state.options));
        return false;
      case 'repeat-manage':
        await withCancelGuard(() => runScheduleManage(state.options));
        return false;
      case 'agent-payments':
        await withCancelGuard(() => runAgentPaymentsMenu(state.options));
        return false;
      case 'api-keys':
      case 'keys':
        await withCancelGuard(() => runApiKeysMenu(state));
        return false;
      case 'preferences':
      case 'prefs-menu':
        await withCancelGuard(() => runPreferencesMenu(state.options));
        return false;
      case 'skills':
        if (args.length === 0) {
          await withCancelGuard(() => runSkillsMenu(state.options));
          return false;
        }
        // /skills <sub> falls through to the legacy dispatch tree for scripting.
        return await (async () => {
          const parsedArgs: ParsedArgs = { options: state.options, positionals: ['skills', ...args] };
          const result = await dispatch(parsedArgs);
          printResult(result, state.options);
          return false;
        })();
      case 'proof':
        await withCancelGuard(() => runProofCommand(state, args));
        return false;
      case 'proof-new':
        await withCancelGuard(() => runProofCommand(state, ['new', ...args]));
        return false;
      case 'proof-list':
        await runProofCommand(state, ['list']);
        return false;
      case 'proof-show':
        await runProofCommand(state, ['show', ...args]);
        return false;
      case 'proof-delete':
        await runProofCommand(state, ['delete', ...args]);
        return false;
      case 'sessions':
        if (args.length === 0) {
          await withCancelGuard(() => runSessionsMenu(state.options));
          return false;
        }
        // /sessions <subcommand> falls through to the legacy session command tree
        // for scripting (list / create / spend / revoke / history / settle).
        return await (async () => {
          const parsedArgs: ParsedArgs = { options: state.options, positionals: ['session', ...args] };
          const result = await dispatch(parsedArgs);
          printResult(result, state.options);
          return false;
        })();
      case 'done': {
        const filter: DoneFilter = args.length === 0
          ? await pickDoneFilter()
          : (args[0] as DoneFilter);
        await runDoneList(state.options, filter);
        return false;
      }
      case 'done-completed':
        await runDoneList(state.options, 'one-time');
        return false;
      case 'done-repeats':
        await runDoneList(state.options, 'repeats');
        return false;
      case 'done-proofs':
        await runDoneList(state.options, 'proofs');
        return false;
      case 'done-receipts':
        await runDoneList(state.options, 'receipts');
        return false;
      case 'inspect': {
        const id = args[0] ?? await pickPendingAction(state.options, 'inspect');
        if (id) await inspectPreparedActionInteractive(state, id);
        return false;
      }
      case 'approve':
      case 'sign': {
        const id = args[0] ?? await pickPendingAction(state.options, 'approve');
        if (id) await approvePreparedAction(state, id);
        return false;
      }
      case 'reject': {
        const id = args[0] ?? await pickPendingAction(state.options, 'reject');
        const reason = args.slice(1).join(' ') || undefined;
        if (id) await rejectPreparedAction(state, id, reason);
        return false;
      }
      case 'archive': {
        const id = args[0] ?? await pickPendingAction(state.options, 'archive');
        if (id) await archivePreparedAction(state, id);
        return false;
      }
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

      // v1.1 — flow-first command surface. Mirrors the web app's templates and
      // tabs. Browser only opens for wallet signing intents (connect, approve,
      // sign); all form input stays in the terminal. Each flow body runs
      // through `withCancelGuard` so Ctrl+C prints "Cancelled." cleanly.
      case 'new':
        await requireWalletConnected(state);
        await withCancelGuard(() => runNewMenu(state.options));
        return false;
      case 'new-send':
        await requireWalletConnected(state);
        await withCancelGuard(() => runNewSend(state.options));
        return false;
      case 'new-spl':
        await requireWalletConnected(state);
        await withCancelGuard(() => runNewSpl(state.options));
        return false;
      case 'new-swap':
        await requireWalletConnected(state);
        await withCancelGuard(() => runNewSwap(state.options));
        return false;
      case 'swap-quote':
        await requireWalletConnected(state);
        await withCancelGuard(() => runSwapQuote(state.options));
        return false;
      case 'new-connector':
        await requireWalletConnected(state);
        await withCancelGuard(() => runNewConnector(state.options));
        return false;
      case 'repeat':
        await requireWalletConnected(state);
        await withCancelGuard(() => runRepeatMenu(state.options));
        return false;
      case 'repeat-scheduled':
        await requireWalletConnected(state);
        await withCancelGuard(() => runRepeatScheduled(state.options));
        return false;
      case 'repeat-recurring':
        await requireWalletConnected(state);
        await withCancelGuard(() => runRepeatRecurring(state.options));
        return false;
      case 'repeat-connector':
        await requireWalletConnected(state);
        await withCancelGuard(() => runRepeatConnector(state.options));
        return false;
      case 'connectors': {
        if (args.length === 0) {
          await withCancelGuard(() => runConnectorsMenu(state.options));
          return false;
        }
        // /connectors <subcommand> falls through to the legacy connector group
        // dispatcher (list | info | read | prepare) so scripts keep working.
        const parsedArgs: ParsedArgs = { options: state.options, positionals: ['connector', ...args] };
        const result = await dispatch(parsedArgs);
        printResult(result, state.options);
        return false;
      }
      case 'agent':
        await withCancelGuard(() => runAgent(state.options, (plan, note) => signPlanAsProof(state, plan, note)));
        return false;
      case 'ask':
        await withCancelGuard(() => runAsk(state.options, args.join(' ').trim() || undefined));
        return false;
      case 'sign-in':
        await withCancelGuard(() => runSignIn(state.options));
        return false;
      case 'sign-out':
        await runSignOut(state.options);
        return false;
      case 'sign-in-status':
        await showSignInStatus(state.options);
        return false;

      // v1.0 — interactive REPL access to the new command groups. These all
      // delegate to the same dispatchers as one-shot mode so behavior stays
      // consistent. Results print as JSON via printResult.
      // Note: `plan` stays mapped to the natural-language runPlanCommand above
      // for backward compatibility; `ai` is the new explicit AI-workflow group
      // (status / generate / review / ask).
      case 'auth':
      case 'profile':
      case 'prefs':
      case 'spend-limits':
      case 'device-agent':
      case 'connector':
      case 'read':
      case 'market':
      case 'tokens':
      case 'helius-history':
      case 'swap':
      case 'ai':
      case 'signals':
      case 'ap2':
      case 'acp':
      case 'audit':
      case 'bridge-router':
      case 'cloud-workspace':
      case 'mpp':
      case 'session':
      case 'prepare':
      // v1.0 final sweep — new groups also reachable from REPL.
      case 'birdeye':
      case 'coingecko':
      case 'helius':
      case 'solana':
      case 'approvals':
      case 'completed':
      case 'plans':
      case 'evidence':
      case 'bridge-agents': {
        const parsed: ParsedArgs = { options: state.options, positionals: [name, ...args] };
        const result = await dispatch(parsed);
        printResult(result, state.options);
        return false;
      }

      default:
        printWarn(state.options, `Unknown command: /${name}. Run /help.`);
        return false;
    }
  } catch (err) {
    const friendly = friendlyBridgeError(err, state.options);
    if (friendly) {
      printError(state.options, friendly);
    } else {
      printError(state.options, errorMessage(err));
    }
    return false;
  }
}

// `friendlyBridgeError` is shared with flow modules — see flows/_shared.ts.

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
  const tokens = Array.isArray(balances.tokens) ? balances.tokens : [];
  const rows = [
    { symbol: 'SOL', amount: String(balances.sol ?? '0'), mint: 'native' },
    ...tokens,
  ];
  renderUnknownTable(rows, ['symbol', 'amount', 'mint']);
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
  const [actionsResponse, recurringResponse] = await Promise.all([
    refreshPreparedActions(state.options),
    tryBridgeRequest<{ recurringPayments?: RecurringPayment[] }>(state.options, '/bridge/recurring-payments'),
  ]);
  const visible = filterPreparedActions(actionsResponse.actions, filter);
  state.lastActions = visible;
  const counts = computeInboxCounts(actionsResponse.actions, recurringResponse.ok ? recurringResponse.value.recurringPayments ?? [] : []);
  printSection('Approval Inbox');
  console.log(
    `${colorize(state.options, 'Needs approval', 'cyan')}: ${counts.needsApproval}`
    + `  ·  ${colorize(state.options, 'Active repeats', 'cyan')}: ${counts.activeRepeats}`
    + `  ·  ${colorize(state.options, 'Failed', 'cyan')}: ${counts.failed}`
    + `  ·  ${colorize(state.options, 'Completed', 'cyan')}: ${counts.completed}`,
  );
  console.log(`Filter: ${filter}  ·  ${visible.length} shown / ${actionsResponse.actions.length} total`);
  if (compact) {
    renderPreparedActionsCompact(visible);
  } else {
    renderPreparedActionsDetailed(visible);
  }
}

function computeInboxCounts(
  actions: PreparedAction[],
  recurring: RecurringPayment[],
): { needsApproval: number; activeRepeats: number; failed: number; completed: number } {
  const needsApproval = actions.filter((a) => a.status === 'ready' || a.status === 'overdue' || a.status === 'blocked').length;
  const failed = actions.filter((a) => a.status === 'failed' || a.txStatus === 'failed').length;
  const completed = actions.filter((a) => a.status === 'approved' && (a.txStatus === 'confirmed' || a.txStatus === 'pending')).length;
  const activeRepeats = recurring.filter((r) => r.status === 'active').length;
  return { needsApproval, activeRepeats, failed, completed };
}

async function approvePreparedAction(state: TerminalAppState, idOrIndex: string | undefined): Promise<void> {
  const action = await resolveAction(state, idOrIndex);
  assertActionApprovable(action);
  await connectInteractive(state, { waitForWallet: true });
  await openWalletHost(state.options, { intent: 'approve', actionId: action.id }).catch(() => undefined);
  printMuted(state.options, 'Approval request sent. Use the browser wallet popup to complete signing.');
  const result = await bridgeRequest(state.options, '/bridge/prepared-actions/execute', {
    method: 'POST',
    body: JSON.stringify({ actionId: action.id }),
  });
  printOk(state.options, `Approved prepared action ${action.id}.`);
  renderApproveResult(state.options, result, action);
  // Auto-poll once after a short delay to upgrade pending -> confirmed/failed.
  const tx = await waitForPreparedActionTxStatus(state.options, action.id, 10_000).catch(() => 'timeout' as const);
  if (tx === 'confirmed') {
    printOk(state.options, 'On-chain: confirmed.');
  } else if (tx === 'failed') {
    printError(state.options, 'On-chain: failed.');
  } else if (tx === 'timeout') {
    printMuted(state.options, 'Still pending — re-run /inbox to refresh status.');
  }
}

function renderApproveResult(options: GlobalOptions, raw: unknown, action: PreparedAction): void {
  const result = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const innerAction = (result.preparedAction && typeof result.preparedAction === 'object'
    ? result.preparedAction
    : {}) as Record<string, unknown>;
  const innerResult = (result.result && typeof result.result === 'object'
    ? result.result
    : {}) as Record<string, unknown>;
  const txid = (innerAction.txid ?? innerResult.txid ?? action.txid) as string | undefined;
  const explorer = (innerResult.explorerUrl ?? (txid ? explorerTxUrl(txid, action.cluster) : '')) as string;
  const amount = (innerResult.amountSol ?? innerResult.amount ?? amountLabel(action)) as string | undefined;
  const recipient = (innerResult.recipient ?? action.params['recipient'] ?? recipientLabel(action)) as string | undefined;

  const rows: Array<[string, string]> = [];
  if (action.id) rows.push(['Action', action.id]);
  if (amount) rows.push(['Amount', `${amount} ${tokenLabel(action) ?? ''}`.trim()]);
  if (recipient) rows.push(['Recipient', String(recipient)]);
  rows.push(['Wallet', action.walletAddress]);
  rows.push(['Network', action.cluster]);
  if (txid) {
    rows.push(['Txid', txid]);
    rows.push(['Explorer', explorer]);
  }
  const status = innerAction.status ?? action.status;
  const txStatus = innerAction.txStatus ?? action.txStatus;
  rows.push(['Status', `${status}${txStatus ? ` (${txStatus})` : ''}`]);

  console.log();
  console.log(colorize(options, 'Approved', 'green'));
  for (const [label, value] of rows) {
    console.log(`  ${colorize(options, label.padEnd(9), 'muted')}  ${value}`);
  }
  console.log();
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

// `/api-keys` — friendly view + editor for the local env keys the bridge uses
// when resolving policy atoms. Mirrors the web's setup screens. Keys go to
// ~/.solana-agent-wallet/.env and live alongside whatever /setup wrote. Missing
// keys silently degrade to web-search fallback in the agent review pipeline.
type ApiKeyId = 'rpc' | 'helius' | 'jupiter' | 'birdeye';

interface ApiKeyRow {
  id: ApiKeyId;
  label: string;
  envKey: string;
  provides: string;
  testFn: (options: GlobalOptions) => Promise<TestResult>;
  secret: boolean;
}

async function runApiKeysMenu(state: TerminalAppState): Promise<void> {
  while (true) {
    const env = await readEnvValues(state.options.envPath);
    const rows: ApiKeyRow[] = [
      { id: 'rpc',     label: 'Solana RPC URL',  envKey: 'SOLANA_RPC_URL', provides: 'on-chain reads + tx send (also aliased as HELIUS_RPC_URL)', secret: false, testFn: testRpc },
      { id: 'helius',  label: 'Helius API key',  envKey: 'HELIUS_API_KEY', provides: 'token age (mint creation) + parsed tx history',                  secret: true,  testFn: testHelius },
      { id: 'jupiter', label: 'Jupiter API key', envKey: 'JUPITER_API_KEY', provides: 'live token prices + swap routes + token audit',                  secret: true,  testFn: testJupiter },
      { id: 'birdeye', label: 'BirdEye API key', envKey: 'BIRDEYE_API_KEY', provides: 'token security (mint/freeze authority) + market depth',           secret: true,  testFn: testBirdeye },
    ];

    console.log();
    console.log(`${colorize(state.options, 'API keys', 'green')}  ·  ${colorize(state.options, state.options.envPath, 'muted')}`);
    console.log(colorize(state.options, 'Missing keys are fine — the agent falls back to web search for that tier.', 'muted'));
    console.log();

    const choices: Array<{ name: string; value: string }> = rows.map((row, i) => {
      const value = env.values[row.envKey] ?? '';
      const status = value ? colorize(state.options, '● set', 'green') : colorize(state.options, '○ missing', 'yellow');
      const preview = value ? maskedPreview(value, row.secret) : '—';
      return { name: `${String(i + 1).padStart(2, ' ')}.  ${status}  ${row.label.padEnd(18)} ${preview}`, value: row.id };
    });
    choices.push({ name: '← Back to main menu', value: '__back__' });

    const pickedId = await tuiSelect<string>({
      message: 'Pick an API key to manage',
      pageSize: choices.length,
      choices,
    });
    if (pickedId === '__back__') return;
    const row = rows.find((r) => r.id === pickedId);
    if (!row) continue;
    await manageApiKey(state, env.values[row.envKey] ?? '', row);
  }
}

async function manageApiKey(
  state: TerminalAppState,
  current: string,
  row: ApiKeyRow,
): Promise<void> {
  console.log();
  console.log(tuiHeader(row.label));
  console.log(tuiKv([
    ['Env var',  row.envKey],
    ['Current',  current ? maskedPreview(current, row.secret) : tuiBadge('not set', 'muted')],
    ['Provides', row.provides],
  ]));
  console.log(tuiDivider());

  const action = await tuiSelect<'set' | 'replace' | 'remove' | 'test' | 'back'>({
    message: 'What next?',
    choices: current
      ? [
          { name: 'Replace value',   value: 'replace' },
          { name: 'Remove (unset)',  value: 'remove' },
          { name: 'Test reachability', value: 'test' },
          { name: '← Back',          value: 'back' },
        ]
      : [
          { name: 'Set value',       value: 'set' },
          { name: 'Test reachability', value: 'test' },
          { name: '← Back',          value: 'back' },
        ],
  });
  if (action === 'back') return;
  if (action === 'remove') {
    const yes = await tuiConfirm({ message: `Unset ${row.envKey}?`, default: false });
    if (!yes) return;
    await writeEnvUpdates(state.options.envPath, { [row.envKey]: '' });
    console.log(tuiBadge(`${row.envKey} unset.`, 'ok'));
    return;
  }
  if (action === 'test') {
    const spin = tuiSpinner(`Testing ${row.label}…`);
    try {
      const result = await row.testFn(state.options);
      if (result.ok) {
        spin.succeed(result.detail);
      } else {
        spin.fail(`${result.detail}  [${result.kind}]`);
        // Surface a recovery tip based on the failure category.
        if (result.kind === 'unauthorized') console.log(tuiBadge('Tip: set or replace the key from the menu, then test again.', 'muted'));
        if (result.kind === 'bridge-offline') console.log(tuiBadge('Tip: run /doctor or /bridge start to bring the bridge back online.', 'muted'));
      }
    } catch (err) {
      spin.fail(`Test failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  // set or replace
  const rawNext = row.secret
    ? await tuiPassword({ message: `${row.label} value:` })
    : await tuiInput({ message: `${row.label} value:`, default: current });
  if (!rawNext.trim()) {
    console.log(tuiBadge('Empty input — no change.', 'muted'));
    return;
  }
  let next = rawNext.trim();
  // URL keys go through normalizeSetupUrl so users can't save malformed URLs
  // (also normalizes http→https, removes trailing slash, etc. — same as /setup).
  if (row.envKey === 'SOLANA_RPC_URL') {
    try {
      next = normalizeSetupUrl(next, row.label);
    } catch (err) {
      console.log(tuiBadge(`Invalid URL: ${err instanceof Error ? err.message : String(err)}`, 'err'));
      return;
    }
  }
  const updates: Record<string, string> = { [row.envKey]: next };
  // Special: setting SOLANA_RPC_URL also writes HELIUS_RPC_URL (matches /setup).
  if (row.envKey === 'SOLANA_RPC_URL') updates.HELIUS_RPC_URL = next;
  // Special: setting JUPITER_API_KEY also writes JUP_API_KEY (legacy alias).
  if (row.envKey === 'JUPITER_API_KEY') updates.JUP_API_KEY = next;
  await writeEnvUpdates(state.options.envPath, updates);
  console.log(tuiBadge(`${row.envKey} saved.  Now: ${maskedPreview(next, row.secret)}`, 'ok'));
}

type TestKind = 'ok' | 'missing' | 'unauthorized' | 'network' | 'bridge-offline';

interface TestResult {
  ok: boolean;
  kind: TestKind;
  detail: string;
}

function categorizeError(err: unknown): { kind: TestKind; detail: string } {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('api key')) {
    return { kind: 'unauthorized', detail: `${message} (key missing or rejected)` };
  }
  if (lower.includes('econnrefused') || lower.includes('socket') || lower.includes('connect') || lower.includes('bridge unreachable')) {
    return { kind: 'bridge-offline', detail: `${message} (is the bridge running?)` };
  }
  if (lower.includes('timeout') || lower.includes('etimedout')) {
    return { kind: 'network', detail: `${message} (network timeout)` };
  }
  return { kind: 'network', detail: message };
}

async function testRpc(options: GlobalOptions): Promise<TestResult> {
  try {
    const health = await bridgeRequest<BridgeHealth>(options, '/bridge/action/health');
    const cluster = health.cluster ?? 'unknown';
    const ok = Boolean(health.bridgeConnected ?? true);
    return { ok, kind: ok ? 'ok' : 'network', detail: `Reachable — cluster ${cluster}` };
  } catch (err) {
    const { kind, detail } = categorizeError(err);
    return { ok: false, kind, detail };
  }
}

async function testHelius(options: GlobalOptions): Promise<TestResult> {
  // Use the connected wallet if available so the Helius probe gets a real
  // address. Falls back to the system program (which Helius will respond to
  // with an empty list — still a valid auth + reachability check).
  let wallet = '11111111111111111111111111111111';
  const status = await tryBridgeRequest<{ connected?: boolean; address?: string }>(options, '/bridge/action/status');
  if (status.ok && status.value.connected && typeof status.value.address === 'string') {
    wallet = status.value.address;
  }
  try {
    await bridgeRequest(options, '/bridge/action/helius-history', {
      method: 'POST',
      body: JSON.stringify({ wallet, limit: 1 }),
    });
    return { ok: true, kind: 'ok', detail: `Helius reachable (probed ${wallet.slice(0, 8)}…).` };
  } catch (err) {
    const { kind, detail } = categorizeError(err);
    return { ok: false, kind, detail };
  }
}

async function testJupiter(options: GlobalOptions): Promise<TestResult> {
  try {
    const result = await bridgeRequest<{ data?: unknown }>(options, '/bridge/action/swap-quote', {
      method: 'POST',
      body: JSON.stringify({ amount: '0.01', inputToken: 'SOL', outputToken: 'USDC' }),
    });
    return { ok: Boolean(result), kind: 'ok', detail: 'Jupiter quote endpoint OK.' };
  } catch (err) {
    const { kind, detail } = categorizeError(err);
    return { ok: false, kind, detail };
  }
}

async function testBirdeye(options: GlobalOptions): Promise<TestResult> {
  try {
    // The bridge exposes /bridge/birdeye/search; calling it with a common
    // symbol ("SOL") is a cheap reachability + auth probe.
    await bridgeRequest(options, '/bridge/birdeye/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'SOL', limit: 1 }),
    });
    return { ok: true, kind: 'ok', detail: 'BirdEye search reachable.' };
  } catch (err) {
    const { kind, detail } = categorizeError(err);
    return { ok: false, kind, detail };
  }
}

function maskedPreview(value: string, secret: boolean): string {
  if (!secret) return value.length > 50 ? `${value.slice(0, 47)}…` : value;
  if (value.length <= 8) return '••••';
  return `••••${value.slice(-4)}`;
}

// `/proof` — friendly Save Proof flow mirroring the web's "More → Save Proof"
// page. Supports Common (5 multi-field receipts) and Advanced (15 evidence
// labs). Signs with the existing wallet-host signing handshake and persists
// to both the local artifact store and the bridge archive (matching the web).
async function runProofCommand(
  state: TerminalAppState,
  args: string[],
): Promise<void> {
  const sub = (args[0] ?? '').toLowerCase();
  if (sub === 'list') {
    await listProofs(state);
    return;
  }
  if (sub === 'show') {
    const id = args[1];
    if (!id) throw new Error('Usage: /proof show <artifact-id>');
    await showProof(state, id);
    return;
  }
  if (sub === 'delete') {
    const id = args[1];
    if (!id) throw new Error('Usage: /proof delete <artifact-id>');
    await deleteProof(state, id);
    return;
  }
  // bare /proof, /proof new, or /proof <kind|id> → new flow
  await newProofFlow(state, args);
}

async function newProofFlow(state: TerminalAppState, args: string[]): Promise<void> {
  await requireWalletConnected(state);

  let spec: ProofSpec | undefined;
  if (args[0] && args[0] !== 'new') {
    spec = resolveProofSpec(args[0]);
  }
  if (!spec) {
    const category = await tuiSelect<'common' | 'advanced'>({
      message: 'Which proof tier?',
      choices: [
        { name: 'Common Proofs (5) — guided forms',         value: 'common',   description: 'Intent · Policy · Risk · Rejection · Tool Trace' },
        { name: 'Advanced Proofs (15) — single-text labs',   value: 'advanced', description: 'Flight Recorder · Intent Auctions · Risk Co-Signers · …' },
      ],
    });
    const candidates = listProofSpecs(category);
    const pickedId = await tuiSelect<string>({
      message: 'Which proof type?',
      pageSize: Math.min(20, candidates.length + 1),
      choices: candidates.map((s) => ({
        name: s.title,
        value: s.id,
        description: s.summary.slice(0, 80),
      })),
    });
    spec = listProofSpecs().find((s) => s.id === pickedId);
  }
  if (!spec) {
    printError(state.options, 'Could not resolve proof spec.');
    return;
  }

  const draft = await promptProofForm(spec);
  const artifact = await buildResearchArtifact(state.options, { id: spec.id, title: spec.title, kind: spec.kind, defaultInput: spec.defaultInput ?? '', description: spec.description }, draft.input);
  artifact.category = spec.category;
  if (Object.keys(draft.fields).length > 0) artifact.fields = draft.fields;

  // Preview before signing.
  console.log();
  console.log(tuiHeader('Preview'));
  console.log(tuiKv([
    ['Title',   spec.title],
    ['Tier',    spec.category === 'common' ? tuiBadge('Common', 'ok') : tuiBadge('Advanced', 'warn')],
    ['Kind',    spec.kind],
    ['Wallet',  artifact.walletAddress ?? '—'],
    ['Network', artifact.cluster],
    ['Hash',    artifact.payloadHash.slice(0, 16) + '…'],
  ]));
  console.log(tuiDivider());
  printMuted(state.options, 'Your wallet signs this evidence record only. No transaction is submitted.');

  const approval = await signTextWithWallet(state, researchSigningMessage(artifact), `${artifact.title} proof`, 'low');
  artifact.signature = approval.result?.signature;
  artifact.requestId = approval.requestId;

  // Local store (matches /research save behaviour).
  await saveResearchArtifact(state.options, artifact);
  // Bridge archive (matches web "/bridge/lab-artifacts" POST).
  await tryBridgeSaveArtifact(state.options, artifact);

  console.log();
  console.log(tuiBadge('Proof saved', 'ok') + `  ${spec.title}`);
  console.log(tuiKv([
    ['ID',        artifact.id],
    ['Signature', artifact.signature ? `${artifact.signature.slice(0, 22)}…` : '—'],
  ]));
}

async function listProofs(state: TerminalAppState): Promise<void> {
  const artifacts = await fetchAllArtifacts(state.options);
  printSection('Proofs');
  if (artifacts.length === 0) {
    console.log('No saved proofs yet. Run /proof to create one.');
    return;
  }
  const common = artifacts.filter((a) => artifactCategory(a) === 'common');
  const advanced = artifacts.filter((a) => artifactCategory(a) === 'advanced');
  console.log(`${tuiBadge('Common', 'ok')}: ${common.length}  ·  ${tuiBadge('Advanced', 'warn')}: ${advanced.length}  ·  Total: ${artifacts.length}`);
  console.log('');
  artifacts.forEach((a, i) => {
    const cat = artifactCategory(a);
    const chip = cat === 'common' ? tuiBadge('Common', 'ok') : tuiBadge('Advanced', 'warn');
    console.log(`[${i + 1}] ${chip}  ${a.title}  ${a.kind}`);
    console.log(`    ${a.id}`);
    console.log(`    ${timeLabel(a.createdAt)}  ·  hash ${a.payloadHash.slice(0, 12)}…  ·  ${a.signature ? 'signed' : 'unsigned'}`);
    if (i < artifacts.length - 1) console.log('');
  });
  console.log('\nTip: /proof show <id>  ·  /proof delete <id>  ·  /proof new');
}

async function showProof(state: TerminalAppState, id: string): Promise<void> {
  const artifacts = await fetchAllArtifacts(state.options);
  const found = resolveArtifact(artifacts, id);
  if (!found) {
    throw new Error(`Proof not found: ${id}`);
  }
  console.log();
  console.log(tuiHeader(found.title));
  console.log(tuiKv([
    ['ID',         found.id],
    ['Kind',       found.kind],
    ['Tier',       artifactCategory(found) === 'common' ? tuiBadge('Common', 'ok') : tuiBadge('Advanced', 'warn')],
    ['Wallet',     found.walletAddress ?? '—'],
    ['Network',    found.cluster],
    ['Created',    found.createdAt],
    ['Hash',       found.payloadHash],
    ['Signature',  found.signature ?? '—'],
  ]));
  if (found.fields && Object.keys(found.fields).length > 0) {
    console.log('');
    console.log(tuiHeader('Fields'));
    console.log(tuiKv(Object.entries(found.fields)));
  } else if (found.input) {
    console.log('');
    console.log(tuiHeader('Input'));
    console.log(`  ${found.input.split('\n').join('\n  ')}`);
  }
  console.log(tuiDivider());
}

async function deleteProof(state: TerminalAppState, id: string): Promise<void> {
  const artifacts = await fetchAllArtifacts(state.options);
  const found = resolveArtifact(artifacts, id);
  if (!found) {
    throw new Error(`Proof not found: ${id}`);
  }
  await bridgeRequest(state.options, '/bridge/lab-artifacts/delete', {
    method: 'POST',
    body: JSON.stringify({ artifactId: found.id }),
  }).catch(() => undefined);
  // Also remove from local research-artifacts.json mirror.
  await removeLocalArtifact(state.options, found.id).catch(() => undefined);
  printOk(state.options, `Deleted proof ${found.id}.`);
}

async function fetchAllArtifacts(options: GlobalOptions): Promise<ResearchArtifact[]> {
  try {
    const response = await bridgeRequest<{ artifacts?: ResearchArtifact[] }>(options, '/bridge/lab-artifacts');
    return Array.isArray(response.artifacts) ? response.artifacts : [];
  } catch {
    // Fallback: local mirror only.
    const dir = dirname(options.preparedActionsPath);
    const path = join(dir, 'research-artifacts.json');
    const local = await readJsonFile<{ artifacts?: ResearchArtifact[] }>(path).catch(() => ({ artifacts: [] }));
    return local.artifacts ?? [];
  }
}

function resolveArtifact(artifacts: ResearchArtifact[], idOrIndex: string): ResearchArtifact | undefined {
  const n = Number(idOrIndex);
  if (Number.isInteger(n) && n >= 1 && n <= artifacts.length) return artifacts[n - 1];
  return artifacts.find((a) => a.id === idOrIndex || a.id.startsWith(idOrIndex));
}

function artifactCategory(a: ResearchArtifact): 'common' | 'advanced' {
  if (a.category === 'common' || a.category === 'advanced') return a.category;
  // Heuristic: receipt-style kinds match the 5 common types from the spec.
  const COMMON_KINDS = new Set(['intent_receipt', 'policy_receipt', 'risk_review_receipt', 'rejection_receipt', 'tool_trace_receipt']);
  return COMMON_KINDS.has(a.kind) ? 'common' : 'advanced';
}

async function tryBridgeSaveArtifact(options: GlobalOptions, artifact: ResearchArtifact): Promise<void> {
  try {
    await bridgeRequest(options, '/bridge/lab-artifacts', {
      method: 'POST',
      body: JSON.stringify({ artifact }),
    });
  } catch {
    // The local research-artifacts.json copy stays as a fallback when the
    // bridge archive isn't reachable — non-fatal.
  }
}

async function removeLocalArtifact(options: GlobalOptions, artifactId: string): Promise<void> {
  const dir = dirname(options.preparedActionsPath);
  const path = join(dir, 'research-artifacts.json');
  const existing = await readJsonFile<{ artifacts?: ResearchArtifact[] }>(path).catch(() => ({ artifacts: [] }));
  const next = (existing.artifacts ?? []).filter((a) => a.id !== artifactId);
  await writeFile(path, `${stableJson({ artifacts: next })}\n`, 'utf8');
}

// Signs the current AI plan (intent + NOTE) as an off-chain evidence record.
// Lives in index.ts because it needs the wallet-host handshake (signTextWithWallet)
// which is state-coupled. Mirrors the web's "Sign this plan as proof" affordance:
// no transaction is queued; the artifact lands in /bridge/lab-artifacts and shows
// up under /proof-list and /done --filter proofs.
async function signPlanAsProof(
  state: TerminalAppState,
  plan: unknown,
  policyNote: string,
): Promise<{ id: string; payloadHash: string } | null> {
  // Refuse empty / null plans — nothing useful to sign.
  if (!plan || typeof plan !== 'object' || Object.keys(plan as Record<string, unknown>).length === 0) {
    printWarn(state.options, 'Plan is empty — nothing to sign as proof.');
    return null;
  }
  await requireWalletConnected(state);
  const status = await tryBridgeRequest<WalletStatus>(state.options, '/bridge/action/status');
  const cluster = (status.ok && status.value.cluster ? status.value.cluster : 'mainnet-beta') as Cluster;
  const walletAddress = status.ok ? status.value.address ?? null : null;

  const baseArtifact = {
    version: 'terminal-research-v1' as const,
    id: `proof_${randomBytes(8).toString('hex')}`,
    title: 'Agent plan proof',
    kind: 'agent_plan_proof' as const,
    concept: 'Off-chain wallet-signed evidence record of an AI-generated plan + policy NOTE.',
    input: stableJson({ plan, policyNote: policyNote || null }),
    walletAddress,
    cluster,
    createdAt: new Date().toISOString(),
  };
  const payloadHash = sha256(stableJson(baseArtifact));
  const artifact: ResearchArtifact = {
    ...baseArtifact,
    payloadHash,
    category: 'advanced',
  };

  const approval = await signTextWithWallet(
    state,
    researchSigningMessage(artifact),
    'Agent plan proof',
    'low',
  );
  if (approval.result?.signature) artifact.signature = approval.result.signature;
  if (approval.requestId) artifact.requestId = approval.requestId;

  // Persist locally + on the bridge archive (matches /proof behaviour).
  await saveResearchArtifact(state.options, artifact);
  await tryBridgeSaveArtifact(state.options, artifact);

  return { id: artifact.id, payloadHash: artifact.payloadHash };
}

// `/version` — at-a-glance summary of where the CLI is pointed and what's
// configured. Useful when filing support issues or before running an
// important command. Pulls live status from the bridge.
async function printVersionInfo(state: TerminalAppState): Promise<void> {
  const [health, status, env] = await Promise.all([
    tryBridgeRequest<BridgeHealth>(state.options, '/bridge/health'),
    tryBridgeRequest<WalletStatus>(state.options, '/bridge/action/status'),
    readEnvValues(state.options.envPath).catch(() => ({ found: false, raw: '', values: {} as Record<string, string> })),
  ]);
  printSection('Version & runtime');
  const keyOk = (k: string): boolean => Boolean((env.values[k] ?? process.env[k] ?? '').trim().length);
  console.log(`CLI:        ${CLI_VERSION}`);
  console.log(`Bridge:     ${state.options.bridgeUrl}${health.ok ? colorize(state.options, '  online', 'green') : colorize(state.options, '  offline', 'red')}`);
  console.log(`Wallet host: ${state.options.walletHostUrl}`);
  console.log(`Render-web: ${state.options.renderWebUrl}`);
  console.log(`Wallet:     ${status.ok && status.value.connected ? status.value.address : colorize(state.options, 'not connected', 'yellow')}`);
  console.log(`Network:    ${health.ok ? health.value.cluster ?? 'unknown' : '—'}`);
  console.log(`Keys:       RPC ${keyOk('SOLANA_RPC_URL') || keyOk('HELIUS_RPC_URL') ? '✓' : '✗'} · Jup ${keyOk('JUPITER_API_KEY') || keyOk('JUP_API_KEY') ? '✓' : '✗'} · Birdeye ${keyOk('BIRDEYE_API_KEY') ? '✓' : '✗'} · Helius ${keyOk('HELIUS_API_KEY') ? '✓' : '✗'}`);
  console.log(`Env file:   ${state.options.envPath}${env.found ? '' : colorize(state.options, '  (not found)', 'muted')}`);
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
  // Detailed view: one block per receipt, with explorer link + summary.
  state.lastReceipts.forEach((receipt, index) => {
    const head = `[${index + 1}] ${short(receipt.actionId, 12)}  ${colorize(state.options, receipt.status, receipt.status === 'approved' ? 'green' : 'red')}`;
    console.log(head);
    if (receipt.summary) console.log(`  ${receipt.summary}`);
    const amount = receipt.amount ? `${receipt.amount} ${receipt.token ?? ''}` : '';
    if (amount) console.log(`  Amount:   ${amount}`);
    if (receipt.recipient) console.log(`  Recipient: ${receipt.recipient}`);
    if (receipt.txid) {
      console.log(`  Txid:     ${receipt.txid}`);
      console.log(`  Explorer: ${explorerTxUrl(receipt.txid, receipt.cluster)}`);
    }
    if (receipt.txStatus) {
      const tone = receipt.txStatus === 'confirmed' ? 'green' : receipt.txStatus === 'failed' ? 'red' : 'yellow';
      console.log(`  On-chain: ${colorize(state.options, receipt.txStatus, tone)}`);
    }
    if (receipt.error) console.log(`  Error:    ${colorize(state.options, receipt.error, 'red')}`);
    if (receipt.completedAt) console.log(`  Completed: ${timeLabel(receipt.completedAt)}`);
    if (index < state.lastReceipts.length - 1) console.log('');
  });
  console.log(`\nTip: copy a Txid into any Solana explorer for full details. /receipts shows the raw JSON.`);
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
  await openWalletHost(state.options, { intent: 'sign', requestId: request.id });
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
  const [health, inbox, recurring, session, artifacts, env] = await Promise.all([
    tryBridgeRequest<BridgeHealth>(state.options, '/bridge/health'),
    tryBridgeRequest<{ actions?: PreparedAction[] }>(state.options, '/bridge/prepared-actions'),
    tryBridgeRequest<{ recurringPayments?: RecurringPayment[] }>(state.options, '/bridge/recurring-payments'),
    loadSession(state.options).catch(() => null),
    tryBridgeRequest<{ artifacts?: ResearchArtifact[] }>(state.options, '/bridge/lab-artifacts'),
    readEnvValues(state.options.envPath).catch(() => ({ found: false, raw: '', values: {} as Record<string, string> })),
  ]);
  const actions = inbox.ok ? inbox.value.actions ?? [] : [];
  const schedules = recurring.ok ? recurring.value.recurringPayments ?? [] : [];
  state.lastActions = actions;
  state.lastRecurring = schedules;
  const queueNew = actions.filter((a) => a.status === 'ready' || a.status === 'overdue' || a.status === 'blocked').length;
  const queueRepeat = schedules.filter((s) => s.status === 'active').length;
  const proofCount = artifacts.ok ? (artifacts.value.artifacts ?? []).length : 0;
  const authSummary = sessionStatusSummary(session);

  const cluster = health.ok ? health.value.cluster ?? 'unknown' : 'unreachable';
  const networkLabel = isMainnetCluster(cluster)
    ? `${cluster}  ${colorize(state.options, '[MAINNET — real money]', 'red')}`
    : cluster;

  printSection('Dashboard');
  console.log(`Wallet:     ${health.ok && health.value.walletAddress ? short(health.value.walletAddress, 10) : 'not connected'}`);
  console.log(`Network:    ${networkLabel}`);
  console.log(`Bridge:     ${health.ok ? 'online' : 'offline'} (${state.options.bridgeUrl})`);
  console.log(`Signed in:  ${authSummary.authenticated ? `yes — ${authSummary.walletAddress ? short(authSummary.walletAddress, 10) : 'no wallet'}` : 'no  (try /sign-in)'}`);
  console.log(`Inbox-new:  ${queueNew} prepared approval${queueNew === 1 ? '' : 's'} awaiting review`);
  console.log(`Inbox-repeat: ${queueRepeat} active schedule${queueRepeat === 1 ? '' : 's'}`);
  console.log(`Proofs:     ${proofCount} saved`);
  console.log(`Keys:       ${apiKeySummary(state.options, env.values)}`);
}

function apiKeySummary(options: GlobalOptions, envValues: Record<string, string>): string {
  // Reads the on-disk .env file (passed in from renderDashboard) so changes
  // made via /api-keys reflect immediately, no restart required. Falls back
  // to process.env for shell-injected overrides.
  const has = (k: string): boolean => {
    const fromFile = envValues[k];
    if (typeof fromFile === 'string' && fromFile.trim().length > 0) return true;
    return Boolean(process.env[k] && process.env[k]!.length > 0);
  };
  const chip = (name: string, on: boolean): string => `${name} ${on ? '✓' : '✗'}`;
  const tier = [
    chip('RPC',     has('SOLANA_RPC_URL') || has('HELIUS_RPC_URL')),
    chip('Jup',     has('JUPITER_API_KEY') || has('JUP_API_KEY')),
    chip('Birdeye', has('BIRDEYE_API_KEY')),
    chip('Helius',  has('HELIUS_API_KEY')),
  ].join(' · ');
  const allSet = (has('SOLANA_RPC_URL') || has('HELIUS_RPC_URL'))
    && has('JUPITER_API_KEY')
    && has('BIRDEYE_API_KEY')
    && has('HELIUS_API_KEY');
  return allSet ? tier : `${tier}  ${colorize(options, '(web fallback for missing tiers)', 'muted')}`;
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

/**
 * Poll `/bridge/prepared-actions/tx-status` until the action's txStatus is
 * `confirmed` or `failed`, or until timeout. Used by `inbox approve --wait`
 * to block until on-chain confirmation lands.
 */
async function waitForPreparedActionTxStatus(
  options: GlobalOptions,
  actionId: string,
  timeoutMs: number,
): Promise<PreparedActionTxStatus | 'timeout'> {
  const start = Date.now();
  const pollIntervalMs = 1500;
  while (Date.now() - start < timeoutMs) {
    try {
      const status = await bridgeRequest<{ actions?: PreparedAction[] }>(
        options,
        '/bridge/prepared-actions/tx-status',
        { method: 'POST', body: JSON.stringify({ actionId }) },
      );
      const action = status.actions?.find((a) => a.id === actionId);
      const tx = action?.txStatus;
      if (tx === 'confirmed' || tx === 'failed') {
        return tx;
      }
    } catch {
      // transient — keep polling
    }
    await sleep(pollIntervalMs);
  }
  return 'timeout';
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
  // Empty string in `updates` means "remove this key entirely" — drop the line.
  const dropKeys = new Set(Object.keys(updates).filter((k) => updates[k] === ''));
  const rewritten: string[] = [];
  for (const line of lines) {
    const key = envKeyFromLine(line);
    if (key && dropKeys.has(key)) {
      seen.add(key);
      continue; // drop the line
    }
    const value = key ? updates[key] : undefined;
    if (!key || value === undefined) {
      rewritten.push(line);
      continue;
    }
    seen.add(key);
    rewritten.push(`${key}=${formatEnvValue(value)}`);
  }
  const missing = SETUP_ENV_KEYS.filter((key) => updates[key] !== undefined && updates[key] !== '' && !seen.has(key));
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

/**
 * `doctor` with v1.0 flags: `--strict` exits 6 on any reachable:false probe,
 * `--section <name>` returns only the named section. Both are useful in CI
 * scripts (`doctor --section renderWeb --json --strict` exits non-zero if the
 * cloud is offline).
 *
 * One-shot non-JSON mode prints the human-readable banner via printDoctor;
 * --json mode prints the raw record (no banner). REPL flow has its own
 * `case 'doctor':` that calls printDoctor directly.
 */
async function runDoctorWithFlags(parsed: ParsedArgs): Promise<unknown> {
  const section = optionValue(parsed.positionals, '--section');
  const strict = parsed.positionals.includes('--strict');
  const full = await runDoctor(parsed.options);

  const result: JsonRecord = section
    ? (() => {
        if (!Object.prototype.hasOwnProperty.call(full, section)) {
          throw new Error(`Unknown doctor section: ${section}. Available: ${Object.keys(full).filter((k) => isRecord((full as JsonRecord)[k])).join(', ')}`);
        }
        const value = (full as JsonRecord)[section];
        return { [section]: value };
      })()
    : full;

  const failures = strict ? collectDoctorFailures(result) : [];

  if (parsed.options.json) {
    if (strict && failures.length > 0) {
      console.log(stableJson({ ...result, strict: { failed: true, failures } }));
      process.exit(6);
    }
    // Default JSON path — fall through to printResult.
    return result;
  }

  // Human-readable: print the doctor banner (skip when --section narrows down).
  if (section) {
    console.log(stableJson(result));
  } else {
    printDoctor(parsed.options, full);
  }
  if (strict && failures.length > 0) {
    printError(parsed.options, `\nStrict: ${failures.length} probe(s) unreachable: ${failures.join(', ')}`);
    process.exit(6);
  }
  return NO_OUTPUT;
}

function collectDoctorFailures(doctor: JsonRecord): string[] {
  const fails: string[] = [];
  for (const [key, value] of Object.entries(doctor)) {
    if (isRecord(value) && value.reachable === false) {
      fails.push(key);
    }
  }
  return fails;
}

async function runDoctor(options: GlobalOptions): Promise<JsonRecord> {
  await ensureRuntimeFiles(options);
  // v1.0 — parallelize all probes; each section sets reachable:false on error.
  const [
    bridgeHealth,
    actionHealth,
    walletHost,
    setup,
    connectorRegistry,
    aiStatus,
    deviceAgentStatus,
    renderSession,
    cliSession,
    apiKeys,
  ] = await Promise.all([
    tryBridgeRequest<BridgeHealth>(options, '/bridge/health'),
    tryBridgeRequest<BridgeHealth>(options, '/bridge/action/health'),
    isWalletHostReachable(options),
    runtimeSetupStatus(options),
    tryBridgeRequest<JsonRecord>(options, '/bridge/action/connector-capabilities'),
    tryBridgeRequest<JsonRecord>(options, '/bridge/ai/status'),
    probeDeviceAgent(options),
    probeRenderSession(options),
    loadSession(options),
    probeApiKeys(options),
  ]);
  return {
    bridgeUrl: options.bridgeUrl,
    walletHostUrl: options.walletHostUrl,
    walletHostLaunchUrl: walletHostLaunchUrl(options),
    renderWebUrl: options.renderWebUrl,
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
    connectorRegistry: connectorRegistry.ok
      ? {
          reachable: true,
          connectorCount: Array.isArray((connectorRegistry.value as { connectors?: unknown[] }).connectors)
            ? (connectorRegistry.value as { connectors: unknown[] }).connectors.length
            : null,
        }
      : { reachable: false, error: errorMessage(connectorRegistry.error) },
    ai: aiStatus.ok ? { reachable: true, status: aiStatus.value } : { reachable: false },
    deviceAgent: deviceAgentStatus,
    renderWeb: {
      ...renderSession,
      cliSession: sessionStatusSummary(cliSession),
    },
    apiKeys,
  };
}

// Probes each API-key tier the agent decision pipeline depends on. Returns a
// per-tier { configured, reachable, detail } record so /doctor can render a
// colored row for each.
async function probeApiKeys(options: GlobalOptions): Promise<JsonRecord> {
  const env = await readEnvValues(options.envPath).catch(() => ({ found: false, raw: '', values: {} as Record<string, string> }));
  const configured = (key: string): boolean => {
    const fromFile = env.values[key];
    if (typeof fromFile === 'string' && fromFile.trim().length > 0) return true;
    return Boolean(process.env[key] && process.env[key]!.length > 0);
  };
  const wrap = async (
    label: string,
    hasKey: boolean,
    probe?: () => Promise<{ ok: boolean; detail: string }>,
  ): Promise<JsonRecord> => {
    if (!hasKey) return { label, configured: false, reachable: false, detail: 'key not set' };
    if (!probe) return { label, configured: true, reachable: true, detail: 'key set (no probe wired)' };
    try {
      const r = await probe();
      return { label, configured: true, reachable: r.ok, detail: r.detail };
    } catch (err) {
      return { label, configured: true, reachable: false, detail: errorMessage(err) };
    }
  };
  const [rpc, jupiter, birdeye, helius] = await Promise.all([
    wrap('Solana RPC',  configured('SOLANA_RPC_URL') || configured('HELIUS_RPC_URL')),
    wrap('Jupiter',     configured('JUPITER_API_KEY') || configured('JUP_API_KEY'),
      async () => {
        await bridgeRequest(options, '/bridge/action/swap-quote', {
          method: 'POST',
          body: JSON.stringify({ amount: '0.01', inputToken: 'SOL', outputToken: 'USDC' }),
        });
        return { ok: true, detail: 'quote endpoint OK' };
      },
    ),
    wrap('BirdEye',     configured('BIRDEYE_API_KEY'),
      async () => {
        await bridgeRequest(options, '/bridge/birdeye/search', {
          method: 'POST',
          body: JSON.stringify({ query: 'SOL', limit: 1 }),
        });
        return { ok: true, detail: 'search reachable' };
      },
    ),
    wrap('Helius',      configured('HELIUS_API_KEY'),
      async () => {
        await bridgeRequest(options, '/bridge/action/helius-history', {
          method: 'POST',
          body: JSON.stringify({ wallet: '11111111111111111111111111111111', limit: 1 }),
        });
        return { ok: true, detail: 'enhanced endpoint reachable' };
      },
    ),
  ]);
  return { rpc, jupiter, birdeye, helius };
}

async function probeDeviceAgent(options: GlobalOptions): Promise<{ reachable: boolean; status?: unknown; error?: string }> {
  try {
    const value = await renderWebRequestClient(options, '/api/device-agent/status', undefined, {
      label: 'Device Agent',
      useBearer: false,
    });
    return { reachable: true, status: value };
  } catch (err) {
    return { reachable: false, error: errorMessage(err) };
  }
}

async function probeRenderSession(options: GlobalOptions): Promise<{ reachable: boolean; authenticated?: boolean; walletAddress?: string | null; error?: string }> {
  try {
    const value = await renderWebRequestClient<{ walletAddress?: string; authenticated?: boolean }>(options, '/api/session', undefined, {
      label: 'Render-web session',
    });
    return { reachable: true, authenticated: !!value.authenticated, walletAddress: value.walletAddress ?? null };
  } catch (err) {
    return { reachable: false, error: errorMessage(err) };
  }
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

async function mppRenderWebRequest<T = unknown>(
  options: GlobalOptions,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = renderWebUrl(options, path);
  const cookie = process.env.AGENTIC_RENDER_WEB_COOKIE ?? process.env.AGENTIC_CLOUD_COOKIE ?? process.env.AGENTIC_SESSION_COOKIE;
  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...(init.headers ?? {}),
      },
    }, REQUEST_TIMEOUT_MS);
  } catch (err) {
    throw new Error(`Render-web MPP API is not reachable at ${options.renderWebUrl}. ${errorMessage(err)}`);
  }

  const text = await response.text();
  const body = parseJsonBody(text);
  if (!response.ok) {
    const error = responseError(body);
    throw new Error(error ?? `Render-web MPP API returned HTTP ${response.status}.`);
  }
  return body as T;
}

async function streamingRenderWebRequest<T = unknown>(
  options: GlobalOptions,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = renderWebUrl(options, path);
  const cookie = process.env.AGENTIC_RENDER_WEB_COOKIE ?? process.env.AGENTIC_CLOUD_COOKIE ?? process.env.AGENTIC_SESSION_COOKIE;
  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...(init.headers ?? {}),
      },
    }, REQUEST_TIMEOUT_MS);
  } catch (err) {
    throw new Error(`Render-web streaming API is not reachable at ${options.renderWebUrl}. ${errorMessage(err)}`);
  }

  const text = await response.text();
  const body = parseJsonBody(text);
  if (!response.ok) {
    const error = responseError(body);
    throw new Error(error ?? `Render-web streaming API returned HTTP ${response.status}.`);
  }
  return body as T;
}

function streamingSessionsPath(input: { walletAddress?: string }): string {
  if (!input.walletAddress) return '/api/streaming/sessions';
  const query = new URLSearchParams({ walletAddress: input.walletAddress });
  return `/api/streaming/sessions?${query.toString()}`;
}

function expiresAtFromSeconds(raw: string): string {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isInteger(seconds)) {
    throw new Error('expires-in-seconds must be a positive integer.');
  }
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function parseAllowlist(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const entries = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  return entries.length ? entries : undefined;
}

// Phase 5.18 — pre-flight CLI input validation so users get a friendly error
// before the render-web round-trip turns a typo into an opaque 400.
const POSITIVE_DECIMAL_RE = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
function assertPositiveDecimal(raw: string, field: string): void {
  const trimmed = raw.trim();
  if (!POSITIVE_DECIMAL_RE.test(trimmed) || Number(trimmed) <= 0) {
    throw new Error(`${field} must be a positive decimal number (e.g. 1, 0.05, 10.25); got "${raw}".`);
  }
}
function assertPositiveInteger(raw: string, field: string): void {
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer; got "${raw}".`);
  }
}

function bridgeUrl(options: GlobalOptions, path: string): URL {
  const base = options.bridgeUrl.endsWith('/') ? options.bridgeUrl : `${options.bridgeUrl}/`;
  const url = new URL(path.startsWith('/') ? path.slice(1) : path, base);
  url.searchParams.set('token', options.token);
  return url;
}

function renderWebUrl(options: GlobalOptions, path: string): URL {
  const base = options.renderWebUrl.endsWith('/') ? options.renderWebUrl : `${options.renderWebUrl}/`;
  return new URL(path.startsWith('/') ? path.slice(1) : path, base);
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

async function openWalletHost(options: GlobalOptions, cli?: CliIntent): Promise<void> {
  await openUrl(walletHostLaunchUrl(options, cli));
}

type CliIntent =
  | { intent: 'connect' | 'disconnect' | 'approve'; actionId?: string; requestId?: never }
  | { intent: 'sign'; requestId: string; actionId?: never };

function walletHostLaunchUrl(options: GlobalOptions, cli?: CliIntent): string {
  const url = new URL(options.walletHostUrl);
  url.pathname = '/app';
  url.searchParams.set('bridgeUrl', options.bridgeUrl);
  url.searchParams.set('token', options.token);
  if (cli) {
    url.searchParams.set('mode', 'cli');
    url.searchParams.set('intent', cli.intent);
    if (cli.actionId) url.searchParams.set('actionId', cli.actionId);
    if (cli.requestId) url.searchParams.set('requestId', cli.requestId);
  }
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
  console.log('\nTip: /approve <#> · /inspect <#> · /reject <#> · /archive <#>  ·  /inbox compact for the table view.');
}

function kindBadgeText(kind: string): { label: string; tone: 'green' | 'yellow' | 'red' | 'muted' | 'cyan' | 'blue' } {
  if (kind === 'transfer_sol' || kind === 'transfer_spl') return { label: 'Transfer', tone: 'cyan' };
  if (kind === 'swap') return { label: 'Swap', tone: 'blue' };
  if (kind === 'blink_action') return { label: 'Blink', tone: 'muted' };
  if (/recurring/i.test(kind)) return { label: 'Recurring', tone: 'yellow' };
  if (/(_open|_close|_modify_collateral|_place_trigger|phoenix_)/.test(kind)) return { label: 'Perp', tone: 'yellow' };
  if (/(magiceden_|tensor_)/.test(kind)) return { label: 'NFT', tone: 'yellow' };
  if (/(_stake|_unstake|_claim)/.test(kind)) return { label: 'Stake', tone: 'green' };
  if (/(_deposit|_withdraw|_borrow|_repay|_liquidity)/.test(kind)) return { label: 'DeFi', tone: 'green' };
  if (/(wormhole_)/.test(kind)) return { label: 'Bridge', tone: 'blue' };
  if (/(squads_|realms_)/.test(kind)) return { label: 'Gov', tone: 'cyan' };
  if (/(pyth_)/.test(kind)) return { label: 'Oracle', tone: 'muted' };
  return { label: 'Connector', tone: 'muted' };
}

function printPreparedActionDetail(action: PreparedAction, row: number): void {
  const blink = isBlinkAction(action);
  const amount = amountLabel(action);
  const token = tokenLabel(action);
  const recipient = recipientLabel(action);
  const badge = kindBadgeText(action.kind);
  console.log(row > 0 ? `[${row}] ${action.id}` : action.id);
  console.log(`  [${badge.label}]  ${blink ? 'Blink action  ·  ' : ''}${action.kind}`);
  console.log(`  Status: ${action.status}${action.txStatus ? ` (${action.txStatus})` : ''}`);
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
    console.log(`  Explorer: ${explorerTxUrl(action.txid, action.cluster)}`);
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

function explorerTxUrl(txid: string, cluster?: string): string {
  const clusterParam = !cluster || cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`;
  return `https://solscan.io/tx/${txid}${clusterParam}`;
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
  // v1.0 — new sections.
  const connectorRegistry = isRecord(doctor.connectorRegistry) ? doctor.connectorRegistry : {};
  const ai = isRecord(doctor.ai) ? doctor.ai : {};
  const aiStatus = isRecord(ai.status) ? ai.status : {};
  const deviceAgent = isRecord(doctor.deviceAgent) ? doctor.deviceAgent : {};
  const renderWeb = isRecord(doctor.renderWeb) ? doctor.renderWeb : {};
  const cliSession = isRecord(renderWeb.cliSession) ? renderWeb.cliSession : {};
  console.log(`Connector registry: ${connectorRegistry.reachable ? `${String(connectorRegistry.connectorCount ?? '?')} connectors` : 'offline'}`);
  const aiBlurb = aiStatus.available
    ? `reachable (${String(aiStatus.provider ?? aiStatus.apiFormat ?? 'configured')}${aiStatus.model ? ` / ${String(aiStatus.model)}` : ''})`
    : ai.reachable ? 'reachable (not configured — run "device-agent set-key")' : 'offline';
  console.log(`Bridge AI: ${aiBlurb}`);
  console.log(`Device Agent: ${deviceAgent.reachable ? 'reachable (cloud)' : 'offline (cloud)'}`);
  console.log(`Render-web: ${renderWeb.reachable ? `reachable${renderWeb.authenticated ? ' (signed in)' : ''}` : 'offline'}`);
  const cliWallet = typeof cliSession.walletAddress === 'string' ? short(cliSession.walletAddress, 12) : '';
  console.log(`CLI session: ${cliSession.authenticated ? `signed in${cliWallet ? ` (${cliWallet})` : ''}${cliSession.staleSoon ? ' — token expires soon' : ''}` : 'signed out — run "solana-agent-wallet auth login"'}`);
  // v1.1 — API keys & AI tier health (drives policy atom resolution).
  const apiKeys = isRecord(doctor.apiKeys) ? doctor.apiKeys : {};
  console.log('');
  printSection('API keys & AI');
  for (const tier of ['rpc', 'jupiter', 'birdeye', 'helius'] as const) {
    const row = isRecord(apiKeys[tier]) ? apiKeys[tier] as JsonRecord : {};
    const label = String(row.label ?? tier);
    const detail = String(row.detail ?? '');
    const tone: 'green' | 'yellow' | 'red' =
      row.reachable === true && row.configured === true ? 'green'
        : row.configured === false ? 'yellow'
        : 'red';
    const chip = tone === 'green' ? '✓' : tone === 'yellow' ? '○' : '✗';
    console.log(`${colorize(options, chip, tone)}  ${label.padEnd(11)}  ${detail}`);
  }
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
  printSection('Quick start');
  console.log('/sign-in           Sign in to your cloud workspace (SIWS)');
  console.log('/connect           Connect your wallet (opens browser, then stays in CLI)');
  console.log('/new               New action: send · spl · swap · connector');
  console.log('/repeat            New schedule: scheduled · recurring · connector');
  console.log('/agent             Natural-language → bridge AI plan with policy NOTE atom resolution');
  console.log('/ask <question>    Follow-up Q&A about the last /agent plan');
  console.log('/api-keys          RPC · Jupiter · Birdeye · Helius (set / replace / remove / test)');
  console.log('/inbox             Needs approval · active repeats');
  console.log('/done              All · One-time · Repeats · Proofs · Receipts');
  console.log('/connectors        Manage 19 protocol connectors + BYO API keys');
  console.log('                   /new-connector now uses live catalog pickers (vaults, pools, banks…)');
  console.log('                   Read-only actions sign as evidence (no approval queue).');
  console.log('/proof             Save Proof — Common (5) + Advanced (15) wallet-signed records');
  console.log('/agent-payments    Profile · Pay merchant · Incoming MPP requests');
  console.log('/skills            Skills hub — Browse · Installed · My Profile · Publish');
  console.log('/preferences       5-card preferences — Workspace · AI · Agents · Rules · Tokens');
  console.log('');
  printSection('Direct flows');
  console.log('/new-send          Send SOL');
  console.log('/new-spl           Send an SPL token');
  console.log('/new-swap          Swap (Jupiter)');
  console.log('/new-connector     Run a connector action (~80 actions across 19 protocols)');
  console.log('/swap-quote        Quote-only swap preview (no queueing)');
  console.log('/repeat-scheduled  Recurring SOL/SPL transfer');
  console.log('/repeat-recurring  Jupiter recurring (time / DCA order)');
  console.log('/repeat-connector  Recurring connector action');
  console.log('/repeat-manage     Pause / resume / delete active schedules');
  console.log('/inbox-new         One-time prepared approvals only');
  console.log('/inbox-repeat      Active recurring schedules (with row actions)');
  console.log('/sessions          Streaming payment sessions (revoke / settle)');
  console.log('/proof-new         Pick a proof type and sign a new evidence record');
  console.log('/proof-list        List saved proofs (Common + Advanced)');
  console.log('/done <filter>     all · one-time · repeats · proofs · receipts');
  console.log('/inspect <id|#>    Full details for one prepared action');
  console.log('/approve <id|#>    Approve via browser wallet popup');
  console.log('/reject <id|#>     Reject a prepared action');
  console.log('/sign-out          Sign out of the cloud workspace');
  console.log('');
  printSection('Setup & diagnostics');
  console.log('/setup             Configure local RPC and Jupiter credentials');
  console.log('/disconnect        Disconnect the active wallet from the bridge');
  console.log('/wallet            Wallet, network, RPC, custody state');
  console.log('/balances          SOL and configured token balances');
  console.log('/doctor            Local bridge and host diagnostics');
  console.log('/open              Open browser wallet host');
  console.log('/logs              Local terminal app logs');
  console.log('/refresh           Re-render dashboard');
  console.log('');
  printSection('Legacy & advanced (still available)');
  console.log('/schedule list|create|pause|resume|delete    Recurring approvals (raw)');
  console.log('/inbox <filter>                              Prepared approvals (any status)');
  console.log('/plan <request>                              Build/sign/queue an agent plan');
  console.log('/research list | <id|#>                      Signed research artifacts');
  console.log('/receipts          Show approval receipts');
  console.log('/quote             Swap quote helper');
  console.log('');
  console.log('v1.0 hosted / connector commands (all support --json):');
  console.log('/auth login | logout | status     Sign in to Agentic cloud (SIWS)');
  console.log('/profile show | publish | delete  Agent profile (A2A) management');
  console.log('/prefs show | get | set           Cloud preferences + BYO connector keys');
  console.log('/spend-limits list                Spend envelope state (read-only)');
  console.log('/device-agent status | set-key    On-device LLM control');
  console.log('/ai plan generate|review|ask      Bridge AI planning');
  console.log('/connector list | info | read     20-protocol connector registry');
  console.log('/read <connector> <capability>    Generic connector read facts');
  console.log('/prepare <kind|alias> ...         Generic connector prepare (marinade-stake etc.)');
  console.log('/swap quote|order|execute         Jupiter swap (use --cloud for render-web)');
  console.log('/market <mint>                    Combined token snapshot');
  console.log('/tokens search <query>            Token list / safety lookup');
  console.log('/helius-history <wallet>          Recent transfer history');
  console.log('/birdeye <subcmd>                 Birdeye market data (15 endpoints)');
  console.log('/coingecko <subcmd>               CoinGecko market data');
  console.log('/solana <subcmd>                  Solana RPC proxies (blockhash, send-tx, …)');
  console.log('/approvals <subcmd>               Advanced approval + finalization ops');
  console.log('/completed list                   Completed approvals history');
  console.log('/plans list                       Saved plans');
  console.log('/evidence list                    Evidence facts collected by agents');
  console.log('/skills list | install | run …    Skills hub');
  console.log('/signals list | subscribe …       Copy-trading signals');
  console.log('/ap2 inspect | acp preview        AP2/ACP mandate inspectors');
  console.log('/audit tail [--follow]            Audit trail (use --follow to stream)');
  console.log('/bridge-router quote <usd> <to>   Fiat → cheapest Solana settlement route');
  console.log('/bridge-agents list | issue       Local bridge agent token management');
  console.log('/cloud-workspace delete           Delete entire cloud workspace (signed)');
  console.log('/quit              Exit\n');
}

function printHelp(): void {
  console.log(`Solana Agent Wallet CLI

Flow-first commands (recommended — run "app" for the interactive REPL):
  solana-agent-wallet app                                # interactive REPL with all flows
  solana-agent-wallet sign-in                            # SIWS into cloud workspace
  solana-agent-wallet sign-in-status                     # show current sign-in state
  solana-agent-wallet sign-out
  solana-agent-wallet new                                # menu: send · spl · swap · connector
  solana-agent-wallet new-send                           # SOL transfer form
  solana-agent-wallet new-spl                            # SPL transfer form
  solana-agent-wallet new-swap                           # Jupiter swap form
  solana-agent-wallet new-connector                      # 19 protocols + live entity pickers (vaults/pools/banks) + read-only evidence
  solana-agent-wallet swap-quote                         # quote-only swap preview (no queue)
  solana-agent-wallet repeat                             # menu: scheduled · recurring · connector
  solana-agent-wallet repeat-scheduled                   # recurring SOL/SPL transfer
  solana-agent-wallet repeat-recurring                   # Jupiter recurring (DCA / time order)
  solana-agent-wallet repeat-connector                   # recurring connector action (Jupiter today)
  solana-agent-wallet repeat-manage                      # pause / resume / delete active schedules
  solana-agent-wallet connectors                         # manage 19 connectors + BYO API keys + enable/disable
  solana-agent-wallet sessions                           # streaming payment sessions (revoke / settle)
  solana-agent-wallet proof [new|list|show <id>|delete <id>]   # Save Proof — Common (5) + Advanced (15)
  solana-agent-wallet agent-payments                     # Profile · Pay merchant · Incoming requests
  solana-agent-wallet skills                             # Browse · Installed · My Profile · Publish
  solana-agent-wallet preferences                        # 5-card preferences (Workspace · AI · Agents · Rules · Tokens)
  solana-agent-wallet done [all|one-time|repeats|proofs|receipts]   # unified done filter
  solana-agent-wallet agent                              # natural-language → bridge AI plan; supports policy NOTE atom resolution
  solana-agent-wallet ask "<question>"                  # follow-up Q&A about the last /agent plan
  solana-agent-wallet api-keys                           # manage RPC · Jupiter · Birdeye · Helius env keys

Setup / diagnostics:
  solana-agent-wallet setup
  solana-agent-wallet doctor [--strict] [--section <name>]
  solana-agent-wallet status
  solana-agent-wallet balances
  solana-agent-wallet portfolio
  solana-agent-wallet connect
  solana-agent-wallet inbox list
  solana-agent-wallet inbox inspect <action-id>
  solana-agent-wallet inbox approve <action-id> [--wait] [--wait-timeout-ms N]
  solana-agent-wallet inbox reject <action-id>
  solana-agent-wallet prepare transfer-sol <recipient> <amount-sol>
  solana-agent-wallet prepare transfer-spl <token> <recipient> <amount>
  solana-agent-wallet prepare swap <amount> [input-token] [output-token]
  solana-agent-wallet prepare blink --url <url> [--connector <id>] [--operation <label>]
  solana-agent-wallet prepare connector <kind> [--param key=value ...] [--wallet <addr>] [--cluster <name>]
  solana-agent-wallet prepare <alias> ...           # e.g. marinade-stake, jito-stake, kamino-deposit (run "connector list" for full registry)
  solana-agent-wallet connector list | info <id> | read <id> <capability>
  solana-agent-wallet read <connectorId> [capability] [--wallet <addr>] [--param k=v]
  solana-agent-wallet market <mint> [--with-metadata] [--with-ohlcv]
  solana-agent-wallet tokens search <query>
  solana-agent-wallet helius-history <wallet> [--limit 25] [--type transfer]
  solana-agent-wallet schedule list | create | pause <id> | resume <id> | delete <id>
  solana-agent-wallet schedule create <token> <recipient> <amount> <cadence> [options]
  solana-agent-wallet session list [--wallet <addr>]
  solana-agent-wallet session create <token-mint> <cap-amount> <expires-in-seconds> [--allowlist <addr,addr>]
  solana-agent-wallet session spend <session-id> <amount> <recipient>
  solana-agent-wallet session voucher sign <session-id> --amount <amt> --recipient <addr>
  solana-agent-wallet session voucher verify <voucher.json>
  solana-agent-wallet session revoke <session-id>
  solana-agent-wallet session history <session-id>
  solana-agent-wallet session settle <session-id>
  solana-agent-wallet mpp challenge <file.json>
  solana-agent-wallet mpp config
  solana-agent-wallet mpp inbound list
  solana-agent-wallet mpp pay <approval-id> [--session-id <id>]
  solana-agent-wallet device-agent status | configure | start | stop | clear | set-key --from-env VAR
  solana-agent-wallet device-agent generate-plan "intent" | review-plan <id> | ask <id> "q"
  solana-agent-wallet ai status | plan generate "intent" | plan review <action-id> | plan ask <action-id> "question"
  solana-agent-wallet swap quote <amount> [--input-token SOL --output-token USDC]
  solana-agent-wallet swap order <amount> [...]
  solana-agent-wallet swap execute <amount> [...]
  solana-agent-wallet auth login --wallet <addr> | logout | status | nonce | session
  solana-agent-wallet profile show | publish <agent-card.json> | delete
  solana-agent-wallet prefs show | get <namespace> | set <namespace> --file <payload.json>
  solana-agent-wallet prefs agent-policies show | set --file <policies.json>
  solana-agent-wallet prefs connector-keys list | set <connector> --from-env <VAR> | remove <connector> | test <connector>
  solana-agent-wallet spend-limits list           # read-only; configure via wallet host UI
  solana-agent-wallet bridge-router quote <amount-usd> <recipient> [--target-mint <mint>] [--cluster <c>] [--max-slippage-bps N] [--holdings <holdings.json>]
  solana-agent-wallet skills init | test | publish     # proxy to agentic-skill
  solana-agent-wallet skills list | detail <id> | installs | install <id> --manifest-version <v> --caps <caps.json> [--accept-monetization]
  solana-agent-wallet skills pause/resume/uninstall <install-id> | earnings [author]
  solana-agent-wallet signals list | feed <id> | subscriptions | subscribe <feed-id> [--caps caps.json] | pause/resume/revoke <subscription-id>
  solana-agent-wallet ap2 list | inspect <mandate-id> | receipt <mandate-id>
  solana-agent-wallet acp preview <cart.json> | approve <cart.json>
  solana-agent-wallet audit tail [--limit N] [--record-type T] [--record-id ID] [--follow] [--poll-interval-ms N]
  solana-agent-wallet cloud-workspace delete [--confirm]
  solana-agent-wallet birdeye <subcommand> ...           # price-multi, search, ohlcv, … (15 endpoints)
  solana-agent-wallet coingecko endpoints | global | read | token-evidence
  solana-agent-wallet helius cloud-transfers <wallet> [--limit N] [--direction in|out|any]
  solana-agent-wallet solana blockhash | send-tx <base64> | tx-status <sig> | account-info <addr>
  solana-agent-wallet approvals list | prepare-tx <id> | execute <id> | finalize <op> <id> [<fid>] | cleanup-recurring
  solana-agent-wallet completed list [--limit N] [--since ISO]
  solana-agent-wallet plans list [--limit N]
  solana-agent-wallet evidence list [--connector <id>] [--limit N]
  solana-agent-wallet research artifacts list | save <file.json> | delete <id>
  solana-agent-wallet bridge-agents list | register --name <n> | issue <id> [--ttl-seconds N] | delete <id>
  solana-agent-wallet schedule occurrences <id> | notifications <id> | rotate-notifications <id>
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
  --render-web-url <url>     Default: ${DEFAULT_RENDER_WEB_URL}
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

function colorize(options: GlobalOptions, value: string, color: 'green' | 'yellow' | 'red' | 'muted' | 'cyan' | 'blue'): string {
  if (!options.color) {
    return value;
  }
  const codes = {
    green: ['\u001b[32m', '\u001b[0m'],
    yellow: ['\u001b[33m', '\u001b[0m'],
    red: ['\u001b[31m', '\u001b[0m'],
    muted: ['\u001b[2m', '\u001b[0m'],
    cyan: ['[36m', '[0m'],
    blue: ['[34m', '[0m'],
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
    renderWebUrl: stripTrailingSlash(
      process.env.AGENTIC_RENDER_WEB_URL ??
        process.env.AGENTIC_PUBLIC_ORIGIN ??
        process.env.RENDER_WEB_URL ??
        DEFAULT_RENDER_WEB_URL,
    ),
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
    if (flag === '--render-web-url') {
      const value = optionArgument(argv, index, flag, inlineValue);
      options.renderWebUrl = stripTrailingSlash(value.value);
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
