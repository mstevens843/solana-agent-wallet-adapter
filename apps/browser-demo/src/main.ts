import bs58 from 'bs58';
import nacl from 'tweetnacl';

import {
  ProtocolError,
  SolanaSigningClient,
  type AdapterCapabilities,
  type Cluster,
  type ProtocolErrorPayload,
  type SigningRequest,
  type SigningResult,
  type WalletBackend,
} from '@solana-agent-wallet-adapter/core';
import {
  detectMwaEnvironment,
  registerAgentMobileWalletAdapter,
  type MwaEnvironment,
  type RegisterAgentMobileWalletAdapterResult,
} from '@solana-agent-wallet-adapter/mwa-mobile-web';
import {
  listAvailableWallets,
  WalletStandardWebBackend,
  type DiscoveredWallet,
} from '@solana-agent-wallet-adapter/wallet-standard-web';
import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';

import {
  AI_PROVIDER_PRESETS,
  AGENT_PLAN_TEMPLATES,
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  DEFAULT_AI_PROVIDER_ID,
  aiFormatLabel,
  aiProviderPresetById,
  buildTemplatePlan,
  defaultTemplateFieldValues,
  generateHostedAiPlan,
  generateSessionAiPlan,
  redactSecrets,
  templateById,
  templateFieldLabel,
  type AgentPlan,
  type AgentPlanTemplate,
  type AgentPlanTemplateField,
  type AiSettings,
  type BridgeAiStatus,
} from './planner.js';
import './styles.css';

type StepState = 'idle' | 'active' | 'done' | 'error';
type StepName = 'discover' | 'connect' | 'sign' | 'transaction' | 'bridge' | 'inbox' | 'lab' | 'ai';
type ActiveTab = 'wallet' | 'agent' | 'inbox' | 'schedule' | 'labs';
type ArtifactView = 'create' | 'signed';
type ToastKind = 'success' | 'error';
type RuntimePathId = 'exec' | 'install' | 'desktop';
type AppRoute = (typeof ROUTE_PATHS)[number];
type InboxFilter = 'all' | 'ready' | 'scheduled' | 'approved' | 'failed' | 'rejected' | 'one-time' | 'recurring';
type PreparedActionKind = 'transfer_sol' | 'transfer_spl' | 'swap';
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
type InstructionData = ConstructorParameters<typeof TransactionInstruction>[0]['data'];
type IosNativeWalletId = 'phantom' | 'solflare' | 'backpack' | 'jupiter';

interface IosNativeEnvironment {
  isNative: boolean;
  platform: string;
  isIos: boolean;
  isIosNative: boolean;
  callbackScheme: string;
}

interface IosNativeWalletOption {
  id: IosNativeWalletId;
  name: string;
  detail: string;
  transport: 'encrypted-deeplink' | 'walletconnect';
  appStoreUrl: string;
}

interface AgenticAndroidBridge {
  openMwaExample?: () => void;
  isExampleTabEnabled?: () => boolean;
}

interface IosNativeRestoreResult {
  backend: IosNativeMaintenanceBackend;
  address: string;
  walletId: IosNativeWalletId;
  walletName: string;
  cacheCount: number;
}

type IosNativeMaintenanceBackend = WalletBackend & {
  clearTransientState(reason: string): Promise<void>;
  clearStateFullReset(reason: string): Promise<void>;
  clearAllCachedAuthorizations(): Promise<void>;
};

const CLUSTERS: Cluster[] = ['mainnet-beta', 'devnet', 'testnet', 'localnet'];
const DEMO_MESSAGE = 'Approve this Solana agent action with user custody.';
const DEMO_MEMO = 'Solana Agent Wallet Adapter demo';
const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8787';
const DEFAULT_BRIDGE_TOKEN = 'local-agent-wallet';
const DEFAULT_AGENT_PROMPT = '';
const STORAGE_KEY = 'solana-agent-wallet-demo-v2';
const LAB_STORAGE_KEY = 'solana-agent-wallet-lab-artifacts-v1';
const LAB_ARCHIVE_DB_NAME = 'solana-agent-wallet-lab-artifacts';
const LAB_ARCHIVE_DB_VERSION = 1;
const LAB_ARCHIVE_STORE_NAME = 'artifacts';
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const RELEASE_BASE_URL =
  'https://github.com/mstevens843/solana-agent-wallet-adapter/releases/latest/download';
const RELEASE_PAGE_URL =
  'https://github.com/mstevens843/solana-agent-wallet-adapter/releases/latest';
const NPM_GLOBAL_INSTALL_COMMAND = 'npm install -g @solana-agent-wallet-adapter/cli';
const NPM_EXEC_COMMAND = 'npm exec @solana-agent-wallet-adapter/cli -- app';
const INSTALLED_APP_COMMAND = 'solana-agent-wallet app';
const CUSTOM_AI_MODEL_VALUE = '__custom__';
const ROUTE_PATHS = ['/', '/docs', '/app', '/cli', '/desktop', '/android', '/demo', '/mwa-test', '/privacy', '/terms'] as const;
const ROUTE_PATH_SET = new Set<string>(ROUTE_PATHS);
const SHOW_DEV_CONTROLS = resolveDevControls();
const SHOW_ANDROID_EXAMPLE_TAB = resolveAndroidExampleTab();
const HASH_ROUTE_MAP = new Map<string, AppRoute>([
  ['#top', '/'],
  ['#docs', '/docs'],
  ['#browser', '/app'],
  ['#app', '/app'],
  ['#cli', '/cli'],
  ['#desktop', '/desktop'],
  ['#android', '/android'],
  ['#workspace', '/demo'],
  ['#mwa-test', '/mwa-test'],
]);
type NavItem = {
  route: AppRoute;
  label: string;
  pill?: boolean;
  mobileHidden?: boolean;
  mobileLabel?: string;
};

const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { route: '/', label: 'Home' },
  { route: '/docs', label: 'Docs' },
  { route: '/cli', label: 'CLI', mobileHidden: true },
  { route: '/desktop', label: 'Desktop App', mobileHidden: true },
  { route: '/demo', label: 'Launch Demo', mobileLabel: 'Demo' },
  ...(SHOW_ANDROID_EXAMPLE_TAB ? [{ route: '/mwa-test' as AppRoute, label: 'MWA', mobileHidden: true }] : []),
  { route: '/app', label: 'Launch App', pill: true, mobileLabel: 'App' },
];
const ROUTE_TITLES: Record<string, string> = {
  '/mwa-test': 'MWA · Agentic',
  '/privacy': 'Privacy Policy · Agentic',
  '/terms': 'Terms of Service · Agentic',
};
const RUNTIME_PATHS: RuntimePath[] = [
  {
    id: 'exec',
    eyebrow: 'No install',
    label: 'One-shot CLI',
    detail: 'Start the local approval app from npm.',
    command: NPM_EXEC_COMMAND,
    terminalCommand: NPM_EXEC_COMMAND,
    badge: 'No install',
    actionLabel: 'Copy',
    actionKind: 'copy',
    copyName: 'CLI one-shot command',
    bridgeLine: 'Bridge starts from terminal',
    walletLine: 'Wallet host opens for Phantom, Backpack, or Solflare',
  },
  {
    id: 'install',
    eyebrow: 'Reusable',
    label: 'Install once',
    detail: 'Keep the approval app available from any terminal.',
    command: NPM_GLOBAL_INSTALL_COMMAND,
    terminalCommand: INSTALLED_APP_COMMAND,
    badge: 'Install',
    actionLabel: 'Copy',
    actionKind: 'copy',
    copyName: 'CLI install command',
    bridgeLine: 'Install once, then run solana-agent-wallet app',
    walletLine: 'Local wallet host stays on your machine',
  },
  {
    id: 'desktop',
    eyebrow: 'App UI',
    label: 'Desktop App',
    detail: 'Use bundled controls, logs, and diagnostics.',
    command: '/desktop',
    terminalCommand: '/desktop',
    badge: 'App UI',
    actionLabel: 'View Desktop App',
    actionKind: 'link',
    href: '/desktop',
    bridgeLine: 'Desktop runtime manages the local bridge',
    walletLine: 'Browser wallet still approves every request',
  },
];
const CLI_RELEASE_ASSETS = [
  ['macOS Apple Silicon', 'solana-agent-wallet-macos-arm64.tar.gz'],
  ['macOS Intel', 'solana-agent-wallet-macos-x64.tar.gz'],
  ['Linux x64', 'solana-agent-wallet-linux-x64.tar.gz'],
  ['Windows x64', 'solana-agent-wallet-windows-x64.zip'],
] as const;
const DESKTOP_RELEASE_ASSETS = [
  ['macOS Apple Silicon', 'agentic-desktop-macos-arm64.dmg'],
  ['macOS Intel', 'agentic-desktop-macos-x64.dmg'],
  ['Windows x64', 'agentic-desktop-windows-x64.msi'],
  ['Linux x64', 'agentic-desktop-linux-x64.AppImage'],
] as const;
const ANDROID_RELEASE_ASSETS = [
  ['Android APK', 'agentic-android.apk'],
  ['Android App Bundle', 'agentic-android.aab'],
] as const;
const AGENTIC_MARK_LOGO = new URL('../../../assets/agentic/saturn-source-cutout.png', import.meta.url).href;

type BrandLogoId =
  | 'backpack'
  | 'claude'
  | 'codex'
  | 'jupiter'
  | 'phantom'
  | 'solana'
  | 'solanaMobile'
  | 'solflare'
  | 'vercel';

const BRAND_LOGOS: Record<BrandLogoId, string> = {
  backpack: new URL('./assets/logos/backpack.svg', import.meta.url).href,
  claude: new URL('./assets/logos/claude.svg', import.meta.url).href,
  codex: new URL('./assets/logos/codex.svg', import.meta.url).href,
  jupiter: new URL('./assets/logos/jupiter.svg', import.meta.url).href,
  phantom: new URL('./assets/logos/phantom.svg', import.meta.url).href,
  solana: new URL('./assets/logos/solana.svg', import.meta.url).href,
  solanaMobile: new URL('./assets/logos/solana-mobile.svg', import.meta.url).href,
  solflare: new URL('./assets/logos/solflare.svg', import.meta.url).href,
  vercel: new URL('./assets/logos/vercel.svg', import.meta.url).href,
};
const IOS_NATIVE_WALLETS: ReadonlyArray<IosNativeWalletOption> = [
  {
    id: 'phantom',
    name: 'Phantom',
    detail: 'Encrypted iOS deeplink',
    transport: 'encrypted-deeplink',
    appStoreUrl: 'https://apps.apple.com/app/phantom-crypto-wallet/id1598432977',
  },
  {
    id: 'solflare',
    name: 'Solflare',
    detail: 'Encrypted iOS deeplink',
    transport: 'encrypted-deeplink',
    appStoreUrl: 'https://apps.apple.com/app/solflare/id1580902717',
  },
  {
    id: 'backpack',
    name: 'Backpack',
    detail: 'Encrypted iOS deeplink',
    transport: 'encrypted-deeplink',
    appStoreUrl: 'https://apps.apple.com/app/backpack-crypto-wallet/id6445964121',
  },
  {
    id: 'jupiter',
    name: 'Jupiter',
    detail: 'WalletConnect path',
    transport: 'walletconnect',
    appStoreUrl: 'https://apps.apple.com/app/jupiter-mobile/id6474343098',
  },
];

function detectIosNativeEnvironment(): IosNativeEnvironment {
  return {
    isNative: false,
    platform: 'web',
    isIos: false,
    isIosNative: false,
    callbackScheme: 'agenticwallet',
  };
}

function listIosNativeWalletOptions(): ReadonlyArray<IosNativeWalletOption> {
  return IOS_NATIVE_WALLETS;
}

async function iosNativeCacheSummary(): Promise<{ count: number }> {
  return { count: 0 };
}

async function restoreLatestIosNativeWallet(_options?: {
  cluster: Cluster;
  appUrl: string;
  rpcUrl?: string;
  logLevel?: 'silent' | 'error' | 'info' | 'debug';
}): Promise<IosNativeRestoreResult | null> {
  return null;
}

const IosNativeWalletBackend = class {
  constructor() {
    throw new Error('iOS native wallet backend is not available in the web build yet.');
  }
} as unknown as new (options: {
  walletId: IosNativeWalletId;
  cluster: Cluster;
  appUrl: string;
  rpcUrl?: string;
  logLevel?: 'silent' | 'error' | 'info' | 'debug';
}) => IosNativeMaintenanceBackend;

interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message: string;
}

interface RuntimePath {
  id: RuntimePathId;
  eyebrow: string;
  label: string;
  detail: string;
  command: string;
  terminalCommand: string;
  badge: string;
  actionLabel: string;
  actionKind: 'copy' | 'link';
  copyName?: string;
  href?: string;
  bridgeLine: string;
  walletLine: string;
}

interface PreparedAction {
  id: string;
  kind: PreparedActionKind;
  status: PreparedActionStatus;
  walletAddress: string;
  cluster: Cluster;
  summary: string;
  params: Record<string, unknown>;
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
}

interface BridgeHealth {
  walletConnected?: boolean;
  walletAddress?: string | null;
  bridgeConnected?: boolean;
  mcpReady?: boolean;
  cluster?: Cluster | null;
  rpcUrl?: string | null;
  rpcWritable?: { ok: boolean; message: string };
  mainnetEnabled?: boolean;
  capsEnabled?: boolean;
  preparedActionStorePath?: string | null;
  labArtifactStorePath?: string | null;
}

interface BalanceView {
  address: string;
  cluster: Cluster;
  sol: string;
  lamports: string;
  tokens: Array<{ symbol: string; mint: string; amount: string; rawAmount: string }>;
}

interface LabDefinition {
  id: string;
  title: string;
  kind: string;
  defaultInput: string;
  description: string;
}

interface LabArtifact {
  id: string;
  labId: string;
  title: string;
  kind: string;
  createdAt: string;
  walletAddress: string;
  cluster: Cluster;
  input: string;
  payload: LabPayload;
  preSignatureHash: string;
  signingMessage: string;
  signature: string;
  verified: boolean;
  artifactHash: string;
}

interface LabPayload {
  status: 'approved' | 'blocked' | 'warn' | 'observed';
  thesis: string;
  nextSignatureGate: string;
  metrics: Array<{ label: string; value: string; tone: 'good' | 'warn' | 'danger' | 'neutral' }>;
  evidence: Array<{ title: string; detail: string; tone: 'good' | 'warn' | 'danger' | 'neutral'; hash: string }>;
}

interface RecurringDraft {
  token: string;
  recipient: string;
  amount: string;
  cadence: RecurringCadence;
  localTime: string;
  dayOfWeek: string;
  dayOfMonth: string;
  intervalDays: string;
  intervalHours: string;
  intervalMinutes: string;
  startAt: string;
  maxOccurrences: string;
  note: string;
}

interface PersistedState {
  selectedWalletName?: string;
  selectedIosWalletId?: IosNativeWalletId;
  cluster?: Cluster;
  bridgeUrl?: string;
  bridgeToken?: string;
}

interface DemoState {
  activeTab: ActiveTab;
  artifactView: ArtifactView;
  selectedRuntimePath: RuntimePathId;
  recentCopyId: string;
  inboxFilter: InboxFilter;
  wallets: DiscoveredWallet[];
  selectedWalletName: string;
  iosNativeEnvironment: IosNativeEnvironment;
  iosWallets: ReadonlyArray<IosNativeWalletOption>;
  selectedIosWalletId: IosNativeWalletId;
  iosAuthCacheCount: number;
  iosNativeStatus: string;
  address: string;
  signature: string;
  txSignature: string;
  txid: string;
  customTransactionBase64: string;
  transactionStatus: string;
  agentPrompt: string;
  selectedTemplateId: string;
  templateFields: Record<string, string>;
  agentPlan: AgentPlan | null;
  agentSignature: string;
  agentPreparedActionId: string;
  aiSettings: AiSettings;
  aiStatus: BridgeAiStatus | null;
  toasts: Toast[];
  capabilities: AdapterCapabilities | null;
  error: string;
  busy: boolean;
  cluster: Cluster;
  bridgeUrl: string;
  bridgeToken: string;
  bridgeActive: boolean;
  bridgeStatus: string;
  bridgeRpcUrl: string;
  health: BridgeHealth | null;
  balances: BalanceView | null;
  preparedActions: PreparedAction[];
  materializedActions: PreparedAction[];
  recurringPayments: RecurringPayment[];
  receipts: ActionReceipt[];
  recurringDraft: RecurringDraft;
  mwaEnvironment: MwaEnvironment;
  mwaRegistration: RegisterAgentMobileWalletAdapterResult | null;
  activeLab: string;
  labInputs: Record<string, string>;
  labArtifacts: LabArtifact[];
  labArchiveStatus: string;
  steps: Record<StepName, StepState>;
}

const LABS: LabDefinition[] = [
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

const persisted = loadPersistedState();
const initialCluster = SHOW_DEV_CONTROLS ? (persisted.cluster ?? 'mainnet-beta') : 'mainnet-beta';
const initialTemplate = templateById('custom-request');
const defaultWorkspaceTab: ActiveTab = 'agent';
const initialAiMode: AiSettings['mode'] = defaultAiMode();

const state: DemoState = {
  activeTab: defaultWorkspaceTab,
  artifactView: 'create',
  selectedRuntimePath: 'exec',
  recentCopyId: '',
  inboxFilter: 'all',
  wallets: [],
  selectedWalletName: persisted.selectedWalletName ?? '',
  iosNativeEnvironment: detectIosNativeEnvironment(),
  iosWallets: listIosNativeWalletOptions(),
  selectedIosWalletId: persisted.selectedIosWalletId ?? 'phantom',
  iosAuthCacheCount: 0,
  iosNativeStatus: 'iOS native wallet idle.',
  address: '',
  signature: '',
  txSignature: '',
  txid: '',
  customTransactionBase64: '',
  transactionStatus: '',
  agentPrompt: DEFAULT_AGENT_PROMPT,
  selectedTemplateId: initialTemplate.id,
  templateFields: defaultTemplateFieldValues(initialTemplate),
  agentPlan: null,
  agentSignature: '',
  agentPreparedActionId: '',
  aiSettings: {
    mode: initialAiMode,
    provider: DEFAULT_AI_PROVIDER_ID,
    apiFormat: aiProviderPresetById(DEFAULT_AI_PROVIDER_ID).apiFormat,
    baseUrl: DEFAULT_AI_BASE_URL,
    model: DEFAULT_AI_MODEL,
    apiKey: '',
  },
  aiStatus: null,
  toasts: [],
  capabilities: null,
  error: '',
  busy: false,
  cluster: initialCluster,
  bridgeUrl: persisted.bridgeUrl ?? DEFAULT_BRIDGE_URL,
  bridgeToken: persisted.bridgeToken ?? DEFAULT_BRIDGE_TOKEN,
  bridgeActive: false,
  bridgeStatus: 'Bridge idle.',
  bridgeRpcUrl: '',
  health: null,
  balances: null,
  preparedActions: [],
  materializedActions: [],
  recurringPayments: [],
  receipts: [],
  recurringDraft: defaultRecurringDraft(),
  mwaEnvironment: detectMwaEnvironment(),
  mwaRegistration: null,
  activeLab: LABS[0]!.id,
  labInputs: defaultLabInputs(),
  labArtifacts: loadLabArtifacts(),
  labArchiveStatus: 'Browser archive loading.',
  steps: {
    discover: 'idle',
    connect: 'idle',
    sign: 'idle',
    transaction: 'idle',
    bridge: 'idle',
    inbox: 'idle',
    lab: 'idle',
    ai: 'idle',
  },
};

let client: SolanaSigningClient | null = null;
let walletBackend: WalletBackend | null = null;
let nextToastId = 1;
let bridgePollTimer: number | null = null;
let bridgeRequestBusy = false;
let lastPassiveInboxRefresh = 0;
let copyResetTimer: number | null = null;
let templatePickerController: AbortController | null = null;

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('Missing #app');
}
const appRoot = app;

normalizeInitialRoute();
render();
window.addEventListener('popstate', () => render());
void bootstrap();

async function bootstrap(): Promise<void> {
  state.mwaRegistration = await registerAgentMobileWalletAdapter({
    appIdentity: {
      name: 'Agentic',
      uri: window.location.origin,
    },
    chains: ['solana:devnet', 'solana:mainnet-beta'],
    logLevel: 'info',
  });
  state.mwaEnvironment = state.mwaRegistration.environment;
  state.iosNativeEnvironment = detectIosNativeEnvironment();
  await refreshIosNativeCacheState();
  if (state.iosNativeEnvironment.isIosNative) {
    await restoreIosNativeSession();
  }
  await hydrateLabArtifactArchive();
  await loadBridgeConfig(false);
  if (state.aiSettings.mode === 'bridge') {
    await refreshBridgeAiStatus(false);
  }
  render();
}

function render(): void {
  const route = currentRoute();
  applyRouteTitle(route);
  closeTemplatePickerInteractions();
  appRoot.innerHTML = pageShell(pageContent(route), route);
  bind();
}

function normalizeInitialRoute(): void {
  const legacyRoute = HASH_ROUTE_MAP.get(window.location.hash);
  if (legacyRoute) {
    window.history.replaceState({}, '', legacyRoute);
    return;
  }

  const normalizedPath = normalizePathname(window.location.pathname);
  if (normalizedPath === '/browser') {
    window.history.replaceState({}, '', '/app');
    return;
  }

  if (isAppRoute(normalizedPath) && window.location.pathname !== normalizedPath) {
    window.history.replaceState({}, '', normalizedPath);
  }
}

function currentRoute(): AppRoute | null {
  const path = normalizePathname(window.location.pathname);
  return isAppRoute(path) ? path : null;
}

function navigateTo(route: AppRoute): void {
  const currentPath = normalizePathname(window.location.pathname);
  if (currentPath !== route) {
    window.history.pushState({}, '', route);
  }
  render();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function normalizePathname(pathname: string): string {
  if (pathname === '/') return '/';
  return pathname.replace(/\/+$/, '') || '/';
}

function isAppRoute(pathname: string): pathname is AppRoute {
  return ROUTE_PATH_SET.has(pathname);
}

function pageShell(content: string, activeRoute: AppRoute | null): string {
  const routeClass = activeRoute ? `route-${activeRoute === '/' ? 'home' : activeRoute.slice(1).replace(/[^a-z0-9-]/g, '-')}` : 'route-unknown';
  const platformClass = state.iosNativeEnvironment.isIosNative ? 'ios-native-shell' : agenticAndroidBridge() ? 'android-shell' : '';
  return `
    <section class="shell homepage-shell ${routeClass} ${platformClass}">
      ${toastStack()}
      ${homepageNav(activeRoute)}
      ${content}
      ${homepageFooter()}
    </section>
  `;
}

function pageContent(route: AppRoute | null): string {
  switch (route) {
    case '/':
      return homePage();
    case '/docs':
      return docsPage();
    case '/app':
      return appPage();
    case '/cli':
      return cliPage();
    case '/desktop':
      return desktopPage();
    case '/android':
      return androidPage();
    case '/demo':
      return demoPage();
    case '/mwa-test':
      return SHOW_ANDROID_EXAMPLE_TAB ? mwaTestPage() : notFoundPage();
    case '/privacy':
      return privacyPage();
    case '/terms':
      return termsPage();
    default:
      return notFoundPage();
  }
}

function applyRouteTitle(route: AppRoute | null): void {
  document.title = ROUTE_TITLES[route ?? ''] ?? 'Agentic | Solana Agent Wallet Adapter';
}

function homePage(): string {
  return `
    ${heroSection()}
    ${gapSection()}
    ${walletDirectorySection()}
    ${homepageDemoCtaSection()}
  `;
}

function docsPage(): string {
  return `
    ${docsSection()}
    ${gapSection()}
    ${walletDirectorySection()}
  `;
}

function appPage(): string {
  return appWorkspace('app');
}

function cliPage(): string {
  return `
    ${cliInstallSection()}
    ${localDevelopmentSection()}
  `;
}

function desktopPage(): string {
  return desktopDownloadSection();
}

function androidPage(): string {
  return androidDownloadSection();
}

function demoPage(): string {
  return `
    ${guidedDemoPage()}
    ${appWorkspace('demo')}
  `;
}

function notFoundPage(): string {
  return `
    <section class="docs-section page-not-found" aria-labelledby="not-found-title">
      <div class="section-heading">
        <p class="eyebrow mini">Not found</p>
        <h2 id="not-found-title">This Agentic page does not exist.</h2>
        <p>Use the navigation bar to open docs, install paths, the guided demo, or the hosted app.</p>
      </div>
    </section>
  `;
}

function privacyPage(): string {
  return `
    <section class="docs-section legal-page" aria-labelledby="privacy-title">
      <div class="section-heading">
        <p class="eyebrow mini">Legal</p>
        <h2 id="privacy-title">Privacy Policy</h2>
        <p class="legal-meta">Last updated: 2026-05-07</p>
      </div>
      <article class="legal-prose">
        <p>SolPulse LLC ("SolPulse," "we," "our," or "us") values your privacy and is committed to protecting your information. This Privacy Policy describes how we collect, use, store, and disclose information when you access or use the Agentic websites, command-line interface, desktop app, browser app, mobile clients, runtime bridge, APIs, or related services (collectively, the "Platform" or "Agentic"). Agentic is a non-custodial wallet authority adapter — we do not take possession of your assets or private keys. You remain in full control of your wallets and signatures at all times, but certain data you provide or that we collect may still constitute personal data under applicable privacy laws.</p>
        <p>By accessing or using Agentic, you acknowledge that you have read, understood, and agree to this Privacy Policy. If you disagree with any portion of this Policy, please discontinue use of the Platform.</p>

        <h3>Quick Summary</h3>
        <ul>
          <li><strong>No private keys:</strong> Agentic does not ask for, collect, store, transmit, recover, or custody seed phrases, private keys, or wallet recovery credentials.</li>
          <li><strong>No hosted account required:</strong> the current public app does not require an Agentic account.</li>
          <li><strong>Local-first runtime:</strong> CLI, desktop, bridge settings, approval queues, bridge tokens, Android MWA authorization cache, and app logs are designed to stay on your device unless you choose to send information to us for support or connect them to third-party services.</li>
          <li><strong>Android permissions:</strong> the Android app currently requests Internet access and foreground data-sync service permissions for wallet approval and bridge polling. It does not request camera, microphone, contacts, SMS, phone, precise location, health, calendar, or file-system permissions.</li>
          <li><strong>No ad sale:</strong> we do not sell personal information and do not share it for cross-context behavioral advertising.</li>
          <li><strong>Public blockchain:</strong> wallet addresses, transaction IDs, signatures, balances, token activity, timing, and other on-chain data may be public, permanent, and outside our control.</li>
        </ul>

        <h3>1. Information We Collect</h3>
        <p><strong>A. Information You Provide</strong></p>
        <ul>
          <li>Contact details such as your email address (when you contact support)</li>
          <li>Wallet information such as your Solana public key when you connect a wallet to a demo or web flow (which may be considered personal data when linked to other identifiers)</li>
          <li>Any content you submit via forms, customer support, feedback surveys, community channels, or app-store review communications</li>
          <li>AI planner prompts, templates, parameters, policy notes, and model settings you enter when you use the optional planner features</li>
          <li>Session AI keys or bridge AI keys you choose to enter. Browser session keys are intended to be used for the current session only; bridge session keys are intended to stay in the local bridge process memory unless you configure otherwise. We do not ask you to send AI keys to SolPulse servers.</li>
        </ul>
        <p>We do not require know-your-customer (KYC) verification because the Platform is non-custodial and does not match, settle, or take the other side of any trade. However, regulations may change; we reserve the right to request additional information to comply with applicable laws or to prevent fraud, money laundering, or other illicit activity.</p>
        <p><strong>B. Information We Collect Automatically</strong></p>
        <ul>
          <li>Technical data such as your IP address, browser type, device operating system, and user-agent information</li>
          <li>Usage data such as access timestamps, referral URLs, pages visited, and actions taken on the public website</li>
          <li>Wallet-connection events on the website (for example, when you connect, approve, or disconnect a wallet for a demo)</li>
          <li>Approximate geolocation information inferred from your IP address, to comply with sanctions and jurisdictional restrictions</li>
          <li>Android app technical data needed for Mobile Wallet Adapter operation, such as wallet package or URI availability checks, public wallet address, account label if supplied by the wallet, cluster, wallet capabilities, shortened signatures or transaction IDs in local logs, foreground service status, and bridge polling status</li>
          <li>App diagnostics, errors, and security telemetry such as request IDs, timestamps, status codes, rejected wallet operations, and redacted log metadata</li>
        </ul>
        <p>The Agentic CLI, desktop runtime, Android MWA surface, and bridge run <strong>locally on your device</strong> and are not telemetered to SolPulse by default. Approval rails, prepared-action queues, Android authorization cache, signing flows, bridge tokens, and local logs execute or persist on your machine; we do not receive telemetry on transaction content unless you contact us with a support request that you elect to attach.</p>
        <p><strong>C. Public Blockchain Data</strong></p>
        <p>Transactions you broadcast to the Solana blockchain are publicly accessible and cannot be erased. We do not control or store on-chain data, but we may analyse publicly available blockchain information to detect suspicious activity, debug issues, or improve documentation.</p>

        <h3>2. How We Use Your Information</h3>
        <ul>
          <li>To provide, operate, maintain, and improve the Platform and its tooling</li>
          <li>To respond to support requests and feedback</li>
          <li>To analyse usage patterns and improve performance and reliability of the public website</li>
          <li>To enforce our Terms of Service, detect and prevent fraud, abuse, or other misuse</li>
          <li>To communicate with you about updates, new features, or regulatory notices (with your consent where required)</li>
          <li>To comply with applicable laws, regulations, and legal processes</li>
        </ul>
        <p>We do not sell your personal data. We may share it with service providers who help us operate the Platform under strict confidentiality obligations, and with regulators or law enforcement if required by law.</p>

        <h3>3. Cookies, Local Storage & Analytics</h3>
        <p>The Agentic website uses browser-based storage methods such as IndexedDB and localStorage to maintain app state, selected wallet name, selected cluster, bridge URL, bridge token, lab artifacts, UI preferences, and similar local workspace data. When a local bridge is connected, signed lab artifacts may also be mirrored to a local bridge archive file. The Android app may store Mobile Wallet Adapter authorization records in app-private storage so you can reconnect a previously approved wallet. You may clear browser storage, app storage, or local runtime files, but doing so may remove preferences, authorization cache, receipts, or local artifacts.</p>
        <p>We may add Google Analytics 4 to the public marketing site or hosted app. If enabled, Google Analytics may collect or process usage events, page views, device/browser information, approximate location, and related identifiers according to Google&apos;s terms and settings. We will not use Google Analytics to sell personal information or for cross-context behavioral advertising, and we will update the Google Play Data Safety form before enabling analytics in the Android distribution.</p>

        <h3>4. Data Storage & Security</h3>
        <p>We implement reasonable technical and organizational measures designed to protect your personal information. Examples include encryption in transit via SSL/TLS, secure infrastructure, and access controls. Despite these measures, no method of transmission or storage is completely secure; you use the Platform at your own risk.</p>
        <p>We retain your information only as long as necessary to provide the Platform, comply with our legal obligations, resolve disputes, and enforce our agreements. Where feasible, we minimize data and may anonymize or aggregate information to further protect your privacy. You remain responsible for securing your device, browser profile, wallet app, seed phrase, bridge token, AI provider key, and any third-party agent software you connect.</p>

        <h3>5. Children's Privacy</h3>
        <p>Agentic does not knowingly collect or store data from anyone under the age of 18. If you are a parent or guardian and believe your child has submitted information to us, contact us at support@solpulse.trade and we'll promptly delete it.</p>

        <h3>6. Information Sharing</h3>
        <p>We may share your data with service providers who support our infrastructure, analytics, or communications; legal authorities, if required by law or in connection with a legal investigation; and third-party tools, only when necessary and never for marketing resale purposes.</p>

        <h3>7. International Data Transfers</h3>
        <p>SolPulse LLC operates globally. Your information may be processed in countries outside of your jurisdiction of residence, which may have different data protection laws. Where required by law, we use appropriate safeguards, such as standard contractual clauses, to protect cross-border data transfers. By using the Platform, you consent to this processing and transfer of your information.</p>

        <h3>8. Your Rights</h3>
        <p>Depending on your jurisdiction, you may have the right to request access to your personal information, request deletion of your personal data, or opt out of email communications. To exercise these rights, email us at support@solpulse.trade. We will remove your personal data within 30 days of a verified request, except where retention is required by law (e.g., compliance logs).</p>

        <h3>9. Updates to This Policy</h3>
        <p>We may update this Privacy Policy from time to time. The most current version will always be available at https://agenticwalletadapter.com/privacy. Your continued use of Agentic after changes are posted signifies your acceptance of those changes.</p>

        <h3>10. Contact Us</h3>
        <p>If you have any questions or requests regarding this Privacy Policy, you can reach us at:</p>
        <ul>
          <li>📧 Email: support@solpulse.trade</li>
          <li>📍 Location: SolPulse LLC, 1621 Central Ave, Cheyenne, WY 82001</li>
        </ul>

        <h3>11. Do Not Sell or Share Personal Information</h3>
        <p>We do not sell your personal information and we do not share it for cross-context behavioral advertising. We disclose personal information only to service providers and processors under written agreements to operate the Platform, or where required by law.</p>

        <h3>12. Legal Bases for Processing (where applicable)</h3>
        <ul>
          <li><strong>Contract:</strong> to provide and support the Platform you request.</li>
          <li><strong>Legitimate Interests:</strong> to secure, improve, and support the Platform; prevent fraud and abuse; understand usage.</li>
          <li><strong>Consent:</strong> for optional diagnostics, marketing communications, or non-essential cookies.</li>
          <li><strong>Legal Obligation:</strong> to satisfy regulatory, tax, accounting, and law-enforcement requirements.</li>
        </ul>

        <h3>13. Data Retention & Deletion</h3>
        <ul>
          <li><strong>Public-website usage logs:</strong> approximately 30–90 days, extendable for security or abuse investigations.</li>
          <li><strong>Support tickets &amp; attachments:</strong> active ticket duration plus up to 24 months.</li>
          <li><strong>Google Analytics 4 data, if enabled:</strong> retained according to the configured Google Analytics property retention settings and applicable Google controls.</li>
          <li><strong>Local-device data (CLI, runtime, desktop bridge, Android MWA app, local logs, authorization cache, bridge tokens, session AI keys, and receipts):</strong> stays on your device under your control; we do not retain it unless you send it to us.</li>
          <li><strong>Public blockchain data:</strong> may be permanent and cannot be deleted or modified by SolPulse.</li>
          <li><strong>Legal, safety, and compliance records:</strong> retained as long as necessary to satisfy legal obligations, sanctions controls, fraud prevention, security, dispute resolution, or legal defense.</li>
        </ul>

        <h3>14. Third-Party Services & Processors</h3>
        <p>We rely on third-party providers to operate the public-facing parts of the Platform. These providers act as processors or service providers under contracts that restrict their use of personal information to the services we request.</p>
        <ul>
          <li><strong>Wallet Standard wallets</strong> (Phantom, Solflare, Backpack, Glow, etc.) — chosen by you. When you connect a wallet, that wallet provider's privacy policy applies to wallet-side data, including key custody and recovery.</li>
          <li><strong>Mobile Wallet Adapter wallets and Android platform services</strong> — chosen by you or provided by the Android/browser environment to route approvals, foreground data-sync behavior, and wallet handoffs.</li>
          <li><strong>Solana RPC providers</strong> (e.g., Helius, public mainnet RPC, or configured RPC endpoints) — for on-chain reads, simulations, balance checks, and transaction submission initiated by you, your wallet, or your agent.</li>
          <li><strong>Hosting (Render), Google Play, Chrome/Custom Tabs/TWA, and app-store services</strong> — to distribute or serve the public website and Android app surfaces.</li>
          <li><strong>Optional AI clients and providers</strong> (Anthropic Claude, OpenAI/Codex, Vercel AI SDK, third-party MCP servers, or OpenAI-compatible providers you configure) — your chosen agent client, browser session key, local bridge, or hosted BYOK request calls them under its own terms and privacy policy. Hosted BYOK relays your API key to the selected provider for that request and does not store it.</li>
          <li><strong>Google Analytics 4</strong> (if enabled) — aggregated usage measurement for product and reliability analysis, subject to Google Analytics configuration and applicable consent requirements.</li>
        </ul>

        <h3>15. Additional Rights by Jurisdiction</h3>
        <p>Depending on where you live (e.g., EEA/UK, California), you may have additional rights, such as portability, restriction, objection to certain processing, and the right to appeal automated decisions. To exercise any rights beyond those listed above, contact us using the details in the "Contact Us" section.</p>

        <h3>16. AML / CTF & Sanctions Processing</h3>
        <p>Although Agentic is a non-custodial software interface and is not itself a regulated financial intermediary, we may collect and process limited identifiers, contact information, wallet addresses, approximate location signals, device or session identifiers, and screening results from compliance service providers to comply with anti-money-laundering (AML), counter-terrorist-financing (CTF), and sanctions requirements. Where required, we may request additional verification or documentation. Processing is based on our legal obligations and our legitimate interests in maintaining Platform integrity and compliance. We may disclose relevant information to competent authorities or service providers when legally required or to prevent fraud or abuse.</p>

        <h3>17. Geographic Restrictions</h3>
        <p>We may use IP address, coarse location, and related technical signals to determine feature availability and to restrict access from prohibited or high-risk jurisdictions for compliance and safety purposes. These signals are approximate and do not constitute precise geolocation. We may retain logs necessary to demonstrate compliance with sanctions and other legal requirements.</p>

        <h3>18. Third-Party Data, Content & Links</h3>
        <p>The Platform may display market data, token metadata, pricing, RPC results, or other content provided by third parties and may include links to external websites. We do not control third-party content and are not responsible for its accuracy or availability. Your interactions with third-party services are governed by their own terms and policies. Where technically necessary, we may transmit limited identifiers to such services to enable functionality.</p>

        <h3>19. Security Telemetry & Malicious Code</h3>
        <p>While we employ reasonable safeguards, we cannot guarantee that files or data available through the Platform are free from viruses, malware, or other harmful components, or that services will be immune to denial-of-service or similar attacks. To protect the Platform, we may collect security telemetry such as error codes, request metadata, and limited device signals for detection, prevention, and response. You remain responsible for appropriate device and account security measures.</p>

        <h3>20. Tutorials, Documentation & Help Resources</h3>
        <p>Tutorials, videos, FAQs, and helpdesk responses describe Platform functionality only and are not personalized advice, suitability assessments, or recommendations. We may process the content of your help requests and attachments to resolve issues and improve quality. Aggregated, de-identified analytics may be used to improve support resources.</p>

        <h3>21. Google Play Data Safety & Financial Features</h3>
        <p>If Agentic is distributed through Google Play, the Google Play Data Safety form and any Financial features declaration must be kept consistent with this Privacy Policy and the actual Android app behavior. Because Agentic involves cryptocurrency wallet actions, SolPulse may disclose financial-feature information to Google Play and may update app availability, disclosures, or functionality to satisfy store policy or applicable law.</p>
      </article>
    </section>
  `;
}

function termsPage(): string {
  return `
    <section class="docs-section legal-page" aria-labelledby="terms-title">
      <div class="section-heading">
        <p class="eyebrow mini">Legal</p>
        <h2 id="terms-title">Terms of Service</h2>
        <p class="legal-meta">Last updated: 2026-05-07</p>
      </div>
      <article class="legal-prose">
        <p>These Terms of Service ("Terms") constitute a legally binding agreement between you ("you" or "User") and SolPulse LLC ("SolPulse," "we," "our," or "us"). These Terms govern your use of the Agentic websites, command-line interface, desktop app, browser app, mobile clients, runtime bridge, APIs, and other services provided by SolPulse (collectively, the "Platform" or "Agentic"). By accessing or using the Platform, you acknowledge that you have read, understood, and agree to be bound by these Terms. If you do not agree, you must not use the Platform.</p>

        <h3>1. Eligibility</h3>
        <p>You may use the Platform only if you are at least 18 years of age and have the legal capacity to enter into a binding contract. You are solely responsible for ensuring that your use of the Platform complies with all laws and regulations applicable to you. Access to the Platform may not be legal for certain persons or in certain countries. If use of the Platform is prohibited by law in your jurisdiction, you must not use it.</p>

        <h3>2. Use of the Platform</h3>
        <p>The Platform is provided for your personal and lawful use only. You agree that you will not:</p>
        <ul>
          <li>Use the Platform for any unlawful or fraudulent purpose, including activities that violate anti-money laundering or sanctions laws</li>
          <li>Interfere with or disrupt the integrity or performance of the Platform, or attempt to circumvent any measures we use to prevent or restrict access</li>
          <li>Transmit viruses, worms, or other malicious code</li>
          <li>Use robots, scrapers, or other automated means not provided by us to access the public website in a manner that sends more requests to our servers than a human can reasonably produce in the same period</li>
          <li>Use another User's account or session credentials without permission, or share your own</li>
        </ul>
        <p><strong>2a. License Grant.</strong> Subject to your continued compliance with these Terms, SolPulse grants you a limited, revocable, non-exclusive, non-transferable, non-sublicensable license to access and use the Platform for your personal, non-commercial activity. No other rights are granted. Any rights not expressly granted are reserved. You may not rent, lease, resell, sublicense, or commercially exploit the Platform, or any part of it, without our prior written consent.</p>

        <h3>3. Web3 Access & Wallets</h3>
        <p>Agentic is a <strong>non-custodial wallet authority adapter</strong>: we do not hold or control your cryptocurrency, your private keys, or your seed phrase. You connect your own Wallet Standard, Mobile Wallet Adapter, or other supported wallet (such as Phantom, Solflare, Backpack, or Glow), and you remain responsible for:</p>
        <ul>
          <li>Generating, maintaining, and safeguarding your own private keys, seed phrases, and wallet credentials</li>
          <li>Reviewing every prepared transaction surfaced by the Platform — including transfers, approvals, swaps, and any agent-initiated action — before signing it</li>
          <li>Configuring and revoking any caps, allowlists, recurring payments, or pre-approved categories you enable</li>
        </ul>
        <p>Because the Platform is non-custodial, <strong>losing access to your private keys will permanently prevent you from accessing your assets</strong>. We have no ability to reset, retrieve, or restore lost keys or funds.</p>
        <p>If you use a third-party embedded wallet, hardware wallet, or wallet-as-a-service product, key recovery and custody are subject to that provider's terms and infrastructure. We do not control third-party wallet providers and are not liable for their unavailability, security breaches, or loss of access.</p>

        <p><strong>3a. Agent / MCP Risk.</strong> Agentic exists to let AI agents — including but not limited to large language models, MCP servers, third-party agent frameworks, scheduled bots, and any automation you connect to the Platform — propose wallet actions for your review. <strong>The agent's request is a proposal; your click is the authority.</strong> You acknowledge and accept that:</p>
        <ul>
          <li>AI agents and LLMs can hallucinate, be prompt-injected, behave unexpectedly, or be authored by malicious third parties</li>
          <li>A buggy or hostile agent could attempt to author transactions that drain, lock, or otherwise harm your wallet if signed</li>
          <li>Agentic's role is to surface the proposed action so you can review it; the Platform does not auto-approve and does not vet the agent's intent</li>
          <li>AI providers (Anthropic, OpenAI, third-party MCP authors, Vercel AI, etc.) are not SolPulse's agents, employees, or representatives; their behavior is not under our control</li>
          <li>Optional AI planner features only draft plans or explanations; they do not make a transaction safe, signed, submitted, profitable, reversible, or suitable for you</li>
          <li>You remain solely responsible for what you sign, including approvals issued by automation or pre-authorized categories you enabled</li>
        </ul>

        <p><strong>3b. What Agentic Does Not Do.</strong> Agentic does <strong>not</strong>:</p>
        <ul>
          <li>Custody, hold, or escrow your digital assets</li>
          <li>Generate, store, or recover seed phrases or private keys</li>
          <li>Auto-approve transactions on your behalf</li>
          <li>Call AI providers on your behalf — your chosen agent client makes those calls under its own privacy policy</li>
          <li>Match, settle, or take the other side of any trade</li>
          <li>Operate an order book, an exchange, or a liquidity pool</li>
        </ul>

        <p><strong>3c. Bring-Your-Own AI Keys.</strong> If you paste or configure an AI provider key, base URL, model name, prompt, template, or plan parameter in Agentic, you are instructing your browser, local bridge, or chosen client to contact that provider. You are responsible for the provider you choose, its terms, its privacy practices, its billing, and the content you send to it. SolPulse does not guarantee that provider responses are accurate, secure, compliant, or fit for any purpose. Never enter a wallet seed phrase, private key, recovery phrase, or unrestricted credential into any AI prompt, MCP server, bridge, or support request.</p>

        <h3>4. Future Paid Features</h3>
        <p>The Platform is currently provided without subscription fees. SolPulse may, in the future, offer paid features, subscriptions, or premium tiers. If we do, the pricing, billing terms, and payment schedule will be presented at signup, and your use of those paid features will be subject to these Terms together with any additional, feature-specific terms posted at the time of purchase. Network fees, RPC fees, protocol fees, and any other third-party fees you incur when broadcasting transactions through the Platform are set by third parties and not by SolPulse.</p>

        <h3>5. Risk Disclosure</h3>
        <p><strong>Crypto and agent-action risk.</strong> The cryptocurrency market is extremely volatile, and the use of AI agents to interact with on-chain protocols is novel and carries unique risk. By using the Platform, you acknowledge and agree that:</p>
        <ul>
          <li>You are solely responsible for your transactions and decisions and assume all risk associated with them</li>
          <li>You may lose some or all of your capital; there is no guarantee of profit or asset preservation</li>
          <li>An AI agent or MCP server can prepare transactions you did not intend; reviewing each approval is your responsibility</li>
          <li>Past performance of any strategy, agent, market, or protocol does not guarantee future results</li>
          <li>Market manipulation, pump-and-dump schemes, prompt injection, hostile MCP servers, and other fraudulent or adversarial activities may affect your outcomes; you should conduct your own due diligence and remain vigilant</li>
        </ul>
        <p>SolPulse provides software and a consent rail. We are <strong>not</strong> a broker-dealer, investment adviser, or financial advisor. Nothing on the Platform constitutes financial advice. Please consult a qualified professional before making financial decisions.</p>
        <p><strong>Voluntary assumption of risk.</strong> By using the Platform, you voluntarily assume all risks associated with cryptocurrency activity and agent-mediated transactions, including the risk of total and permanent loss of all funds in your wallet. You acknowledge that digital assets are not legal tender, are not backed by any government, and are not insured by any federal or state agency (including the FDIC or SIPC). You agree not to hold SolPulse liable for any losses, missed actions, failed transactions, or adverse outcomes resulting from your use of the Platform or from agents you connect to it.</p>

        <h3>6. Compliance & Regulatory Status</h3>
        <p>Agentic is a non-custodial software interface that brokers wallet authority between you and the agents you choose to connect. We do not operate an exchange, an order book, a matching engine, or a liquidity pool. We do not take the other side of any trade. We do not hold, custody, or control your funds or private keys at any time. All transactions are signed by you in your own wallet and broadcast to public networks (such as Solana) through third-party RPC providers and on-chain protocols.</p>
        <p>SolPulse intends Agentic to operate as non-custodial software and not as a money transmitter, broker, dealer, exchange, investment adviser, bank, fiduciary, payment processor, or other regulated financial intermediary. Laws and regulations regarding digital assets, wallets, AI agents, and automated approvals are evolving and may be interpreted differently by different authorities. You are responsible for determining whether use of the Platform is permitted under the laws of your jurisdiction and for complying with any applicable licensing, registration, tax, accounting, or reporting obligations. We reserve the right to implement KYC/AML procedures, sanctions screening, geoblocking, app-store declarations, feature restrictions, or other compliance measures as necessary to meet legal requirements or risk controls.</p>

        <h3>7. No Warranty</h3>
        <p>The Platform and all related services are provided on an "as is" and "as available" basis without warranty of any kind. To the fullest extent permitted by law, SolPulse disclaims all warranties, express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, accuracy, non-infringement, and uninterrupted or error-free operation. We do not guarantee the availability, timeliness, completeness, or reliability of any information, agent integration, or feature offered through the Platform. You use the Platform at your own risk.</p>

        <h3>8. Limitation of Liability</h3>
        <p>To the maximum extent permitted by law, SolPulse and its directors, employees, agents, and affiliates will not be liable to you for any indirect, incidental, special, punitive, or consequential damages arising out of or in connection with your use of the Platform, even if we have been advised of the possibility of such damages. This limitation applies to, but is not limited to: any loss of profits, revenue, or data; loss of digital assets or cryptocurrency; trading or position losses; missed or failed transactions; liquidation events; losses from rug pulls, scams, exploits, prompt injection, hostile agents, or malicious MCP servers; losses caused by third-party protocol failures; losses due to network congestion, RPC outages, or MEV; losses from automation or agent malfunction; business interruption; or any other economic disadvantage. In no event shall our aggregate liability exceed the greater of (a) the amount you paid to us in the twelve months preceding the claim, or (b) one hundred US dollars (USD $100). Some jurisdictions do not allow limitations on implied warranties or liability; in such jurisdictions, our liability shall be limited to the greatest extent permitted by law.</p>
        <p><strong>Claims Only Against the Company.</strong> You agree that any claim you may have in connection with the Platform may be brought only against SolPulse LLC and not against its owners, officers, directors, employees, contractors, affiliates, service providers, or licensors in their personal or individual capacity. This limitation applies to the fullest extent permitted by law.</p>

        <h3>9. Intellectual Property</h3>
        <p>All intellectual property rights in the Platform, including but not limited to branding, UI, documentation, hosted service configuration, app-store listings, images, names, logos, and non-open-source assets, remain the property of SolPulse or its licensors. Open-source code published by SolPulse is governed by the open-source license included with that code, currently Apache-2.0 for this repository. These Terms do not reduce rights granted to you under that open-source license, but they do not grant rights to use SolPulse names, logos, trade dress, hosted services, app listings, or other brand assets except as expressly permitted in writing.</p>
        <p>All trademarks, service marks, trade names, logos, and brand identifiers appearing on the Platform that are not owned by SolPulse are the property of their respective owners. Reference to any third-party mark, protocol, token, or service is for identification only and does not imply endorsement, partnership, or affiliation.</p>
        <p><strong>9a. Copyright & DMCA.</strong> SolPulse respects the intellectual property rights of others and expects users of the Platform to do the same. If you believe material accessible on or from the Platform infringes your copyright, you may request its removal by sending a written notice of infringement to our designated agent that includes: (a) a physical or electronic signature of the copyright owner or a person authorized to act on their behalf; (b) identification of the copyrighted work claimed to be infringed; (c) identification of the allegedly infringing material and information reasonably sufficient to locate it on the Platform; (d) your contact information (name, address, telephone number, and email); (e) a statement that you have a good-faith belief that the use is not authorized by the copyright owner, its agent, or the law; and (f) a statement, made under penalty of perjury, that the information in your notice is accurate and that you are the copyright owner or authorized to act on the owner's behalf. Send notices to our DMCA agent at support@solpulse.trade with the subject line "DMCA Notice." We may, in appropriate circumstances and at our discretion, terminate the accounts of users who are repeat infringers. Knowingly submitting a false or misleading notice of infringement may subject you to liability under applicable law.</p>

        <h3>10. Termination & Suspension</h3>
        <p>We may suspend, restrict, or terminate your access to the Platform at any time, with or without notice, if we believe you have violated these Terms, engaged in fraudulent or illegal activity, or if your use of the Platform poses a security or regulatory risk. You agree that we will not be liable to you or any third party for any termination of your access. Upon termination, your right to use the Platform ceases immediately. Any provisions of these Terms that by their nature should survive termination (including ownership rights, warranty disclaimers, limitation of liability, indemnification, and dispute resolution) shall remain in effect.</p>

        <h3>11. Indemnification</h3>
        <p>You agree to indemnify, defend, and hold harmless SolPulse and its directors, officers, employees, and agents from and against any claims, liabilities, damages, losses, and expenses (including reasonable attorney's fees) arising out of or related to (a) your use or misuse of the Platform, (b) your violation of these Terms, (c) your violation of any rights of another person or entity, or (d) your violation of any applicable law or regulation. We reserve the right to assume exclusive control of any matter otherwise subject to indemnification by you, in which case you agree to cooperate with our defence.</p>

        <h3>12. Governing Law & Dispute Resolution</h3>
        <p>These Terms, and any dispute arising out of or in connection with the Platform or these Terms, shall be governed by and construed in accordance with the laws of the State of Wyoming, without regard to conflict of law principles. You agree that any dispute, claim, or controversy arising out of or relating to these Terms or the breach, termination, enforcement, interpretation, or validity thereof (collectively, "Disputes") shall be resolved by binding arbitration administered by the American Arbitration Association (AAA) under its Consumer Arbitration Rules, conducted remotely or in the State of Wyoming. Either party may bring claims in small claims court if the claim qualifies. The arbitration shall be conducted on an individual basis and not on a class or representative basis. <strong>YOU AGREE THAT ANY CLAIMS WILL BE RESOLVED ON AN INDIVIDUAL BASIS AND NOT AS PART OF ANY CLASS, CONSOLIDATED, OR REPRESENTATIVE ACTION.</strong> You understand that by agreeing to arbitrate disputes, you are waiving your right to a jury trial and to participate in a class action. If this arbitration clause is found to be unenforceable, then all Disputes shall be subject to the exclusive jurisdiction of the federal and state courts located in the State of Wyoming, and you consent to the personal jurisdiction of such courts.</p>
        <p><strong>Thirty-Day Opt-Out.</strong> You have the right to opt out of the arbitration and class-action waiver provisions set forth above by sending written notice to support@solpulse.trade with the subject line "Arbitration Opt-Out" within thirty (30) days of the date you first accept these Terms. Your notice must include your full legal name, the email address associated with your account or contact, and a clear statement that you wish to opt out of arbitration. Opting out does not affect any other provision of these Terms, including the governing-law and venue selections.</p>
        <p><strong>Prevailing Party Fees.</strong> In any arbitration or legal proceeding arising out of or relating to these Terms, the prevailing party shall be entitled to recover its reasonable attorneys' fees, expert fees, arbitration filing fees, and costs, to the extent permitted by applicable law and the rules of the forum.</p>

        <h3>13. Changes to Terms</h3>
        <p>We may update these Terms from time to time. The latest version will always be posted at https://agenticwalletadapter.com/terms. Continued use after changes constitutes acceptance.</p>

        <h3>14. Contact</h3>
        <ul>
          <li>📧 Email: support@solpulse.trade</li>
          <li>📍 Location: SolPulse LLC, 1621 Central Ave, Cheyenne, WY 82001</li>
        </ul>
        <p><strong>14a. Privacy.</strong> Your use of the Platform is also governed by our <a href="/privacy">Privacy Policy</a>, which is incorporated into these Terms by reference. The Privacy Policy describes what data we collect, how we use it, with whom we share it, and your rights regarding your personal information. By using the Platform you consent to the collection, use, and sharing of your data as described in the Privacy Policy. If you do not agree with the Privacy Policy, you must not use the Platform.</p>
        <p><strong>14b. Electronic Communications & Signatures.</strong> By using the Platform, you consent to receive communications from SolPulse electronically, including by email, in-app notice, or other channel where you have provided contact information, and you agree that all agreements, notices, disclosures, and other communications we provide to you electronically satisfy any legal requirement that such communications be in writing. You further agree that your electronic acceptance of these Terms — for example, by clicking "I accept," connecting a wallet, or continuing to use the Platform after notice of updates — constitutes a legally binding signature under the U.S. Electronic Signatures in Global and National Commerce Act (15 U.S.C. § 7001 et seq.) and any applicable state Uniform Electronic Transactions Act. You may withdraw this consent only by discontinuing use of the Platform.</p>

        <h3>15. Action Approval & Execution</h3>
        <p>Actions surfaced by the Platform are prepared off-chain by the agent or other software you connect, displayed for your review, signed by your wallet, and broadcast to the relevant blockchain network through third-party RPC providers and on-chain protocols. Any pre-action estimate displayed by the Platform — including price, slippage, fees, route, or expected outcome — is for informational convenience only and may differ from the actual on-chain result due to network conditions, slippage, routing changes, MEV activity, or third-party protocol behavior. Approvals can expire, fail to land, partial-fill, or be re-ordered, front-run, censored, or delayed by the network or validators. Adjusting compute unit prices or priority tips may improve inclusion probabilities but does not guarantee execution or price. SolPulse does not guarantee that any signed transaction will land or settle, and is not responsible for the outcomes of transactions you authorize.</p>

        <h3>16. Third-Party Services & Data Sources</h3>
        <p>The Platform may rely on third-party services and data sources such as wallet providers, RPC nodes, AI clients, MCP servers, DEX aggregators/routers, market data providers, block explorers, messaging services, and email providers. We do not control and are not responsible for their availability, accuracy, performance, security, or legality. Outages, inaccuracies, or changes in those services may affect your experience and outcomes. Your use of third-party services may be governed by their own terms and privacy policies.</p>

        <h3>17. Automation, Caps & Pre-Authorized Categories</h3>
        <p>If you enable automated approvals, spend caps, recurring payments, allowlisted recipients, bridge polling, Android foreground wallet-approval flows, or any "always allow" / pre-authorized category in the Platform, you authorize the Platform to prepare, queue, poll for, or submit transactions via your connected wallet in accordance with your parameters. You are responsible for maintaining adequate balances, monitoring the automation, and disabling or revoking it when desired. We may implement idempotency or duplicate-protection mechanisms, but they cannot prevent all race conditions, retries, stale authorizations, wallet bugs, bridge failures, or double-submissions across networks, devices, agents, or wallets.</p>

        <h3>18. Safety Checks & Heuristics</h3>
        <p>Any safety, simulation, cap, allowlist, balance, slippage, or risk check surfaced by the Platform is heuristic and informational only. Such checks do not constitute a guarantee that an action is safe, that a token is legitimate, that liquidity is sufficient, or that an agent is non-malicious. You should conduct your own due diligence before approving any action and understand that heuristic checks can be incomplete, stale, or bypassed. We are not liable for losses arising from rug pulls, honeypots, scam tokens, exploits, prompt-injected agents, or any fraudulent activity that you authorize through the Platform, even if our safety checks failed to detect it.</p>
        <p><strong>18a. Smart Contract & On-Chain Risk.</strong> The Platform interacts with third-party blockchain networks, decentralized protocols, smart contracts, and routers (including but not limited to Jupiter Aggregator, Raydium, Orca, Meteora, and other on-chain venues that an agent may select). We do not develop, audit, or control these smart contracts. Smart contracts may contain bugs, vulnerabilities, or exploits that could result in partial or total loss of funds. You acknowledge that interacting with on-chain protocols carries inherent risk, and SolPulse is not liable for any losses caused by smart contract failures, exploits, hacks, or vulnerabilities in third-party protocols, regardless of whether the transaction was initiated manually or via agent automation.</p>
        <p><strong>Public & Permanent.</strong> Every transaction you submit through the Platform is broadcast to the relevant blockchain network and recorded on a public, immutable ledger. You acknowledge that your wallet address, counterparty addresses, transaction amounts, slippage tolerances, and timing metadata may be observed, indexed, copied, or exploited by any third party with access to the network, including searcher bots, MEV actors, block explorers, and analytics platforms. SolPulse cannot and does not guarantee the privacy, reversibility, or anonymity of any on-chain activity.</p>

        <h3>19. Taxes & Recordkeeping</h3>
        <p>You are solely responsible for all taxes, reporting, and recordkeeping related to your use of the Platform, including gains, losses, fees, and other taxable events. We do not provide tax advice. You should consult a qualified tax professional regarding your obligations.</p>

        <h3>20. Service Availability, Maintenance & Incidents</h3>
        <p>We may perform maintenance, upgrades, or changes that temporarily affect availability. We may also activate read-only or maintenance modes to preserve system integrity or comply with legal requirements. Status information may be communicated through in-app notices or external status pages. We are not liable for losses arising from downtime, maintenance windows, or incidents. Except as expressly agreed in writing, SolPulse has no obligation to provide support, bug fixes, updates, or customer service in connection with the Platform, and any assistance we do provide is on a best-effort, as-available basis.</p>

        <h3>21. Beta / Experimental Features</h3>
        <p>Certain features may be labeled beta or experimental. Such features may be incomplete, change without notice, or be withdrawn. They may have reduced reliability or performance. Your use of beta features is at your own risk and subject to these Terms.</p>

        <h3>22. Account Deletion, Data Export & Retention</h3>
        <p>Where provided, you may request deletion of any data we hold about you and export of certain data. Deletion requests may be subject to verification and limitations where retention is required by law, security, or dispute resolution. Additional details about retention periods and processing are described in our Privacy Policy.</p>

        <h3>23. Changes to the Platform</h3>
        <p>We may add, modify, or discontinue features, components, or access methods of the Platform at any time. Where changes materially affect any paid access, we will provide reasonable notice consistent with Section 4. We are not responsible for third-party withdrawals of service or feature changes outside our control.</p>

        <h3>24. Third-Party Links</h3>
        <p>The Platform may contain links to third-party websites or resources. We provide these links as a convenience and are not responsible for the content, products, or services on or available from those websites or resources. Accessing any third-party site is at your own risk and may be subject to separate terms and privacy policies established by those third parties.</p>

        <h3>25. Export Controls & Sanctions</h3>
        <p>You agree to comply with all applicable export control and economic sanctions laws and regulations, including those administered by the U.S. Department of the Treasury's Office of Foreign Assets Control (OFAC) and the U.S. Department of Commerce. You represent that you are not located in, under the control of, or a national or resident of any country or region subject to comprehensive sanctions, and that you are not identified on any government restricted party list. You will not use the Platform to transact with or benefit any such person, entity, country, or region.</p>

        <h3>26. Geographic Restrictions & Prohibited Jurisdictions</h3>
        <p>We may restrict access to the Platform where we believe it is necessary to comply with laws, regulations, or risk controls. We may employ geoblocking or other measures to prevent access from prohibited jurisdictions. You are responsible for ensuring that your use of the Platform is lawful in your location and for ceasing use if it becomes unlawful.</p>

        <h3>27. Force Majeure</h3>
        <p>We will not be liable for any delay or failure to perform resulting from causes beyond our reasonable control, including acts of God, natural disasters, war, terrorism, civil unrest, labor disputes, government actions, power or internet failures, failures of third-party service providers, or network/validator disruptions.</p>

        <h3>28. Assignment; No Agency</h3>
        <p>You may not assign or transfer any rights or obligations under these Terms without our prior written consent. We may assign these Terms without restriction. Nothing in these Terms shall be construed to create a partnership, joint venture, fiduciary, or agency relationship between you and SolPulse; neither party has authority to bind the other.</p>

        <h3>29. Severability; Entire Agreement; Waiver; Interpretation</h3>
        <p>If any provision of these Terms is held to be invalid or unenforceable, that provision will be enforced to the maximum extent permissible and the remaining provisions will remain in full force and effect. These Terms constitute the entire agreement between you and SolPulse regarding the Platform and supersede any prior or contemporaneous agreements on the same subject. No waiver of any provision shall be effective unless in writing and signed by the waiving party, and no waiver shall be deemed a waiver of any other provision or of the same provision on another occasion. Headings are for convenience only and do not affect interpretation.</p>
        <p><strong>No Third-Party Beneficiaries.</strong> These Terms are solely for the benefit of you and SolPulse. Nothing in these Terms, express or implied, is intended to or shall confer upon any other person or entity any legal or equitable right, benefit, or remedy of any nature.</p>

        <h3>30. Sanctions Screening</h3>
        <p>Access to or use of the Platform may be restricted or prohibited in certain jurisdictions. You represent and warrant that you are not located in, organized under the laws of, or ordinarily resident in any jurisdiction subject to comprehensive sanctions, and that you are not listed on any government sanctions or restricted party list. You agree that you will not use the Platform to benefit any sanctioned person or jurisdiction or for any unlawful purpose. We may implement geoblocking, sanctions screening, and other compliance measures and may suspend or terminate access where we believe it is necessary to comply with law.</p>

        <h3>31. No Offer; No Suitability Determination</h3>
        <p>All content and functionality on the Platform are provided for informational and operational purposes only and do not constitute an offer, solicitation, recommendation, or endorsement of any digital asset, strategy, agent, or course of action. We do not assess the suitability of any action, asset, or strategy for you, and we do not provide investment, legal, tax, or accounting advice. You are solely responsible for your decisions and should obtain independent professional advice tailored to your circumstances.</p>

        <h3>32. User-Directed Agents; No Discretion</h3>
        <p>Any AI agents, LLMs, MCP servers, automation, schedulers, or "bots" connected to the Platform operate strictly according to the parameters you configure and authorize. The Platform does not exercise discretionary authority over your account, funds, or strategy. SolPulse does not owe you a fiduciary duty. We do not act as your agent, advisor, or fiduciary. All automation is user-directed and parameter-driven. You may stop or revoke any agent at any time, subject to on-chain conditions and network availability. Enabling automation or pre-authorized categories authorizes the Platform to prepare or submit transactions via your connected wallet pursuant to your parameters; you remain responsible for monitoring positions, risk, and outcomes.</p>

        <h3>33. Protocol Changes, Forks, and Unsupported Assets</h3>
        <p>Blockchain networks and protocols may change, fork, experience re-organizations, fee spikes, congestion, or failures. We do not control any blockchain and make no guarantees regarding network security, functionality, or availability. We may determine, in our sole discretion, how to respond to protocol changes (including whether to support particular forks, airdrops, or tokens) and have no obligation to support any asset or distribution. Because Agentic is non-custodial, we do not relay, distribute, or hold airdrops, forked assets, or protocol distributions on your behalf. You acknowledge you are not entitled to any forked assets, airdrops, or protocol distributions via the Platform unless we explicitly state otherwise.</p>

        <h3>34. Third-Party Content, Data, and Links</h3>
        <p>The Platform may display or rely on third-party information and services, including pricing, market data, routing, wallets, RPC, analytics, messaging, and external websites. We do not guarantee the accuracy, completeness, timeliness, reliability, or availability of any third-party content or services. Links to third-party sites are provided for convenience only, and your use of them is at your own risk and subject to their terms and policies.</p>

        <h3>35. Security, Malicious Code, and Network Attacks</h3>
        <p>You are solely responsible for securing your devices and accounts. We do not warrant that the Platform or any files or data available through it are free of viruses, worms, trojans, logic bombs, or other harmful components, or that services will be immune to denial-of-service or similar attacks. We are not liable for losses arising from such events. Use reputable security software and follow best practices when interacting with digital assets, wallets, and downloads.</p>

        <h3>36. Availability; Internet, Devices & Support</h3>
        <p>The Platform operates over the internet and mobile networks and may be affected by factors outside our control, including connectivity, device or operating system versions, and app store policies. We do not guarantee continuous, uninterrupted access, and we have no obligation to provide device-level or operating system support. We may update, modify, or suspend functionality from time to time to maintain security and performance. Tutorials, videos, FAQs, and helpdesk materials describe Platform functionality only and do not contain personalized advice or recommendations.</p>

        <h3>37. Release of Claims</h3>
        <p>To the fullest extent permitted by law, you hereby release and forever discharge SolPulse and its owners, directors, officers, employees, agents, successors, and assigns from any and all claims, demands, damages, losses, costs, and expenses (including attorneys' fees) of every kind and nature, known or unknown, arising out of or in any way connected with: (a) your transaction activity or financial decisions; (b) the performance or non-performance of any agent, strategy, or automation; (c) any interaction with third-party protocols, smart contracts, or decentralized exchanges; (d) the loss, theft, or unauthorized access to your wallet, private keys, or digital assets; (e) any token you interacted with that turned out to be fraudulent, a rug pull, or otherwise worthless; or (f) any other use of the Platform. If applicable law does not allow the release of unknown claims, you waive the protections of any statute or doctrine that limits the scope of a release to known claims.</p>

        <h3>38. Acknowledgment</h3>
        <p>By using the Platform, you acknowledge that you have read, understood, and agree to all of these Terms. You confirm that you are not relying on any representation or warranty not expressly set out in these Terms. You understand that cryptocurrency activity is speculative, that you may lose all funds, and that Agentic is a software tool — not a financial institution, broker, exchange, or advisor.</p>
      </article>
    </section>
  `;
}

function homepageNav(activeRoute: AppRoute | null): string {
  return `
    <header class="homepage-nav" aria-label="Agentic navigation">
      <a class="homepage-brand" href="/" aria-label="Agentic home" ${activeRoute === '/' ? 'aria-current="page"' : ''}>
        ${agenticMark()}
        <span>Agentic</span>
      </a>
      <nav class="homepage-links" aria-label="Primary navigation">
        ${NAV_ITEMS.map((item) => navLink(item, activeRoute)).join('')}
      </nav>
    </header>
  `;
}

function navLink(item: NavItem, activeRoute: AppRoute | null): string {
  const active = item.route === activeRoute;
  const className = [
    item.pill ? 'nav-pill-link' : '',
    item.route === '/app' ? 'launch-app-link' : '',
    item.mobileHidden ? 'mobile-nav-hidden' : '',
    item.mobileLabel ? 'has-mobile-label' : '',
  ].filter(Boolean).join(' ');
  const label = item.mobileLabel
    ? `<span class="nav-label nav-label-full">${escapeHtml(item.label)}</span><span class="nav-label nav-label-mobile">${escapeHtml(item.mobileLabel)}</span>`
    : `<span class="nav-label">${escapeHtml(item.label)}</span>`;
  return `
    <a href="${escapeHtml(item.route)}" class="${className}" ${active ? 'aria-current="page"' : ''}>
      ${label}
    </a>
  `;
}

function heroSection(): string {
  return `
    <section id="top" class="homepage-hero" aria-labelledby="hero-title">
      <div class="hero-copy">
        <div class="chain-strip" aria-label="Network and signing layer">
          <span class="logo-chip solana-chip">${brandLogo('solana', 'logo-chip-icon')}<span>Solana</span></span>
          <span class="logo-chip" aria-label="Wallet Standard">${brandLogo('solana', 'logo-chip-icon')}<span class="chip-label chip-label-full">Wallet Standard</span><span class="chip-label chip-label-mobile" aria-hidden="true">Wallet Std</span></span>
          <span class="logo-chip" aria-label="Mobile Wallet Adapter">${brandLogo('solanaMobile', 'logo-chip-icon')}<span class="chip-label chip-label-full">Mobile Wallet Adapter</span><span class="chip-label chip-label-mobile" aria-hidden="true">MWA</span></span>
        </div>
        <p class="eyebrow mini">Wallet authority for agents</p>
        <h1 id="hero-title">
          <span>Let agents use your</span>
          <span>Solana wallet</span>
          <span>without giving</span>
          <span>them one.</span>
        </h1>
        <p class="hero-lede">
          <span>Agentic gives Claude, Codex, local MCP servers,</span>
          <span>and app runtimes a single approval path</span>
          <span>through the wallet you already trust.</span>
          <span>Agents prepare the action;</span>
          <span>your wallet remains the signer.</span>
        </p>
        <div class="hero-command-area">
          ${commandDeck()}
          <a class="button-link hero-app-link nav-pill-link launch-app-link mobile-redundant-nav" href="/app">Launch App</a>
          <a class="button-link hero-demo-link mobile-redundant-nav" href="/demo">Launch Demo</a>
        </div>
        ${agentRuntimeStrip()}
        ${heroWalletStrip()}
      </div>
      ${heroTerminalPreview()}
    </section>
  `;
}

function commandDeck(): string {
  const runtimePath = currentRuntimePath();
  const copyId = runtimeCommandCopyId('hero', runtimePath);
  const copied = state.recentCopyId === copyId;
  return `
    <div class="command-deck" aria-label="Runtime command deck">
      <div class="command-deck-options" aria-label="Choose runtime path">
        ${RUNTIME_PATHS.map(commandDeckOption).join('')}
      </div>
      <div class="command-readout ${copied ? 'copied' : ''}">
        ${commandDeckReadoutLine(runtimePath)}
        <span class="command-status-pill">${escapeHtml(runtimePath.badge)}</span>
        ${commandDeckAction(runtimePath, copyId, copied)}
      </div>
    </div>
  `;
}

function commandDeckReadoutLine(runtimePath: RuntimePath): string {
  if (runtimePath.actionKind === 'link') {
    return `
      <div class="command-readout-line link-readout">
        <span class="command-prompt" aria-hidden="true">→</span>
        <span class="readout-label">Download route</span>
        <code>${escapeHtml(runtimePath.href ?? runtimePath.command)}</code>
      </div>
    `;
  }

  return `
    <div class="command-readout-line">
      <span class="command-prompt" aria-hidden="true">$</span>
      <code>${escapeHtml(runtimePath.command)}</code>
      <span class="command-caret" aria-hidden="true"></span>
    </div>
  `;
}

function commandDeckOption(runtimePath: RuntimePath): string {
  const active = runtimePath.id === state.selectedRuntimePath;
  return `
    <button
      type="button"
      class="command-path ${active ? 'active' : ''}"
      data-runtime-path="${escapeHtml(runtimePath.id)}"
      aria-pressed="${active ? 'true' : 'false'}"
    >
      <span>${escapeHtml(runtimePath.eyebrow)}</span>
      <strong>${escapeHtml(runtimePath.label)}</strong>
      <small>${escapeHtml(runtimePath.detail)}</small>
    </button>
  `;
}

function commandDeckAction(runtimePath: RuntimePath, copyId: string, copied: boolean): string {
  if (runtimePath.actionKind === 'link') {
    return `
      <a class="command-deck-action" href="${escapeHtml(runtimePath.href ?? '/desktop')}">
        ${escapeHtml(runtimePath.actionLabel)}
      </a>
    `;
  }

  return `
    <button
      class="command-copy-button ${copied ? 'copied' : ''}"
      data-copy="${escapeHtml(runtimePath.command)}"
      data-copy-id="${escapeHtml(copyId)}"
      data-copy-name="${escapeHtml(runtimePath.copyName ?? runtimePath.label)}"
      title="Copy command: ${escapeHtml(runtimePath.command)}"
    >
      ${copied ? 'Copied' : escapeHtml(runtimePath.actionLabel)}
    </button>
  `;
}

function launchAppCard(title: string, detail: string): string {
  return `
    <article class="browser-app-card">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(detail)}</p>
    </article>
  `;
}

function docsSection(): string {
  return `
    <section id="docs" class="docs-section" aria-labelledby="docs-title">
      <div class="section-heading">
        <!-- Docs eyebrow intentionally hidden. -->
        <h2 id="docs-title">A local signing boundary for agent runtimes.</h2>
        <p>
          Render serves this website, but Agentic's bridge, CLI, and Desktop App run locally beside the user's wallet.
          Android users can use the hosted app in mobile browser surfaces that support Mobile Wallet Adapter. Agents
          can ask for signatures, swaps, transfers, receipts, and inbox approvals without receiving a seed phrase,
          keypair file, or server-side private key.
        </p>
      </div>
      <div class="docs-grid">
        ${docsCard('1. Launch the app', 'Use the hosted app and guided demo to see wallet discovery, connection, signing, and Mobile Wallet Adapter readiness.')}
        ${docsCard('2. Install a local runtime', 'Use the npm CLI, a standalone CLI binary, or the Desktop App when Codex, Claude, or an MCP client needs a persistent local bridge.')}
        ${docsCard('3. Let agents request approval', 'Claude, Codex, MCP clients, and framework adapters send bounded actions to the local bridge; the wallet still signs every request.')}
      </div>
    </section>
  `;
}

function docsCard(title: string, detail: string): string {
  return `
    <article class="docs-card">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(detail)}</p>
    </article>
  `;
}

function heroTerminalPreview(): string {
  const runtimePath = currentRuntimePath();
  const terminalState = terminalCommandState(runtimePath);
  return `
    <aside class="hero-terminal" aria-label="Agentic terminal preview">
      <div class="terminal-preview-window hero-terminal-window">
        <div class="terminal-preview-bar">
          <span></span>
          <span></span>
          <span></span>
          <strong>agentic</strong>
        </div>
        <div class="terminal-preview-body">
          ${heroTerminalLeadLine(runtimePath)}
          <p class="${terminalState.bridgeTone}">${escapeHtml(terminalState.bridgeLine)}</p>
          <p class="${terminalState.walletTone}">${escapeHtml(terminalState.walletLine)}</p>
          <p><span>agent</span> prepare swap SOL to USDC</p>
          <p><span>wallet</span> user approval required</p>
          <p class="ok"><span>result</span> no private key handed to agent</p>
        </div>
      </div>
      <div class="hero-proof-panel" aria-label="Authority model">
        ${heroProof('Agent requests', 'Intent, route, limits, and transaction bytes.')}
        ${heroProof('Wallet approves', state.address ? short(state.address) : 'Existing user wallet signs.')}
        ${heroProof('Adapter records', 'Receipt, policy context, bridge state, and audit artifacts.')}
      </div>
    </aside>
  `;
}

function heroTerminalLeadLine(runtimePath: RuntimePath): string {
  if (runtimePath.actionKind === 'link') {
    return `<p><span>route</span> ${escapeHtml(runtimePath.href ?? runtimePath.terminalCommand)}</p>`;
  }

  return `<p><span>$</span> ${escapeHtml(runtimePath.terminalCommand)}<i class="terminal-caret" aria-hidden="true"></i></p>`;
}

function heroProof(label: string, value: string): string {
  return `
    <div class="hero-proof">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function agentRuntimeStrip(): string {
  const runtimes: Array<{ name: string; logoId?: BrandLogoId }> = [
    { name: 'Claude', logoId: 'claude' },
    { name: 'Codex', logoId: 'codex' },
    { name: 'MCP' },
    { name: 'Vercel AI', logoId: 'vercel' },
    { name: 'Solana Agent Kit', logoId: 'solana' },
  ];
  return `
    <div class="integration-strip" aria-label="Agent runtimes">
      ${runtimes
        .map(
          (runtime) => `
            <span>
              ${runtime.logoId ? brandLogo(runtime.logoId, 'runtime-logo') : ''}
              <span>${escapeHtml(runtime.name)}</span>
            </span>
          `,
        )
        .join('')}
    </div>
  `;
}

function heroWalletStrip(): string {
  const wallets: Array<{ name: string; logoId: BrandLogoId }> = [
    { name: 'Phantom', logoId: 'phantom' },
    { name: 'Solflare', logoId: 'solflare' },
    { name: 'Backpack', logoId: 'backpack' },
    { name: 'Jupiter Mobile', logoId: 'jupiter' },
    { name: 'Seed Vault', logoId: 'solanaMobile' },
  ];
  return `
    <div class="wallet-chip-strip" aria-label="Supported wallet examples">
      ${wallets.map((wallet) => compactWalletChip(wallet.name, wallet.logoId)).join('')}
      <span class="wallet-chip standard-chip">
        ${brandLogo('solana', 'wallet-chip-icon')}
        <span>Wallet Standard / MWA</span>
      </span>
    </div>
  `;
}

function compactWalletChip(name: string, logoId: BrandLogoId): string {
  const wallet = discoveredWalletByName(name);
  return `
    <span class="wallet-chip ${wallet ? 'detected' : ''}">
      ${walletIcon(wallet, providerInitials(name), 'wallet-chip-icon', logoId)}
      <span>${escapeHtml(wallet?.name ?? name)}</span>
    </span>
  `;
}

function gapSection(): string {
  return `
    <section class="gap-section" aria-labelledby="gap-title">
      <div class="gap-copy">
        <p class="eyebrow mini">The gap</p>
        <h2 id="gap-title">Agents can plan Solana actions. Most stacks still ask for the wrong signer.</h2>
      </div>
      <div class="gap-body">
        <p>
          Read-only MCPs stop before approval. Server-key agents move custody into an environment variable.
          Agent wallets and vaults ask users to fund a separate signer. Product links hand the user off to
          someone else's flow.
        </p>
        <p>
          Solana Agent Wallet Adapter keeps the user's existing wallet as the signing boundary, while giving
          agents one request path across Wallet Standard, Mobile Wallet Adapter, iOS wallet links, MCP, Vercel AI,
          Solana Agent Kit, CLI, and the local bridge.
        </p>
        <div class="gap-proof-grid" aria-label="Differentiators">
          ${gapProof('Existing wallet', 'Phantom, Solflare, Backpack, Seed Vault, and compatible Solana wallets stay in control.')}
          ${gapProof('No private key handoff', 'Agents request signatures without receiving a seed phrase, keypair file, or env-var signer.')}
          ${gapProof('One adapter layer', 'The same wallet backend supports browser, mobile, MCP, framework, CLI, receipts, and approval inbox flows.')}
        </div>
      </div>
    </section>
  `;
}

function walletDirectorySection(): string {
  return `
    <section id="wallets" class="wallet-directory-section" aria-labelledby="wallet-directory-title">
      <div class="section-heading">
        <p class="eyebrow mini">Wallet directory</p>
        <h2 id="wallet-directory-title">Use the wallet users already picked.</h2>
        <p>
          Agentic targets Solana wallet authority through Wallet Standard, Mobile Wallet Adapter, Seed Vault,
          and compatible provider surfaces. Discovered wallets use their provider-supplied icons.
        </p>
      </div>
      <div class="wallet-directory-grid">
        ${walletDirectoryCard(
          'Phantom',
          'Browser and mobile approvals through the user-owned Phantom signer.',
          ['phantom'],
          'phantom',
        )}
        ${walletDirectoryCard(
          'Solflare',
          'Wallet Standard signing without moving custody into an agent runtime.',
          ['solflare'],
          'solflare',
        )}
        ${walletDirectoryCard(
          'Backpack',
          'Installed wallet approval for agent-prepared messages and transactions.',
          ['backpack'],
          'backpack',
        )}
        ${walletDirectoryCard(
          'Jupiter Mobile',
          'Mobile approval path for swap-aware wallet flows and prepared actions.',
          ['jupiter'],
          'jupiter',
        )}
        ${walletDirectoryCard(
          'Seed Vault',
          'Android hardware-backed custody through Mobile Wallet Adapter surfaces.',
          ['seed vault', 'seedvault'],
          'solanaMobile',
        )}
        ${walletDirectoryCard(
          'Wallet Standard / MWA',
          'One adapter surface for browser wallets, Android MWA, and wallet in-app browsers.',
          ['wallet standard', 'mobile wallet adapter', 'mwa'],
          'solana',
          true,
        )}
      </div>
      <div class="wallet-directory-action">
        <button data-start-action="discover" class="${state.wallets.length ? '' : 'primary'}" ${state.busy ? 'disabled' : ''}>
          ${state.wallets.length ? 'Refresh Wallet Directory' : 'Discover Wallets'}
        </button>
        <span>${state.wallets.length ? `${state.wallets.length} provider(s) discovered in this browser.` : 'Provider icons appear after discovery.'}</span>
      </div>
    </section>
  `;
}

function walletDirectoryCard(
  name: string,
  detail: string,
  aliases: string[],
  logoId: BrandLogoId,
  standard = false,
): string {
  const wallet = aliases.map(discoveredWalletByName).find((candidate): candidate is DiscoveredWallet => Boolean(candidate));
  const detected = Boolean(wallet);
  return `
    <article class="wallet-directory-card ${detected ? 'detected' : ''}">
      <div class="wallet-directory-head">
        ${walletIcon(wallet, providerInitials(name), 'wallet-directory-icon', logoId)}
        <div>
          <h3>${escapeHtml(wallet?.name ?? name)}</h3>
          <span>${detected ? 'Detected provider' : standard ? 'Adapter surface' : 'Supported path'}</span>
        </div>
      </div>
      <p>${escapeHtml(detail)}</p>
    </article>
  `;
}

function cliInstallSection(): string {
  return `
    <section id="cli" class="runtime-section cli-section" aria-labelledby="cli-title">
      <div class="section-heading runtime-heading">
        <!-- CLI eyebrow intentionally hidden. -->
        <h2 id="cli-title">Install the local approval CLI.</h2>
        <p>
          The public CLI path is npm first, with standalone binaries for users who prefer a direct download.
          The CLI starts the local bridge and wallet host; this website only copies commands or links releases.
        </p>
      </div>
      <div class="runtime-grid">
        <article class="runtime-card">
          <span class="runtime-kicker">npm global</span>
          <h3>Install once</h3>
          <p>Install the command globally, then run <code>solana-agent-wallet app</code> from any terminal.</p>
          ${runtimeCommandRow('Global install', NPM_GLOBAL_INSTALL_COMMAND, 'Copy command')}
        </article>
        <article class="runtime-card">
          <span class="runtime-kicker">npm exec</span>
          <h3>Run without installing</h3>
          <p>Use npm's one-shot execution path to start the terminal approval app.</p>
          ${runtimeCommandRow('One-shot app', NPM_EXEC_COMMAND, 'Copy command')}
        </article>
      </div>
      <div class="download-section">
        <div class="download-section-head">
          <h3>Standalone CLI binaries</h3>
          <a href="${RELEASE_PAGE_URL}" target="_blank" rel="noreferrer">View all releases</a>
        </div>
        <div class="download-grid">
          ${CLI_RELEASE_ASSETS.map(([label, asset]) => downloadCard(label, asset, 'CLI binary')).join('')}
        </div>
      </div>
    </section>
  `;
}

function desktopDownloadSection(): string {
  return `
    <section id="desktop" class="desktop-section" aria-labelledby="desktop-title">
      <div class="section-heading">
        <!-- Desktop App eyebrow intentionally hidden. -->
        <h2 id="desktop-title">Download the Agentic Desktop App.</h2>
        <p>
          The Desktop App is optional easy mode for the local bridge, approval inbox, logs, and diagnostics. Use it
          when you want app controls instead of terminal commands. Browser extension wallets still approve every
          signing request through the external wallet host.
        </p>
      </div>
      <div class="download-grid desktop-download-grid">
        ${DESKTOP_RELEASE_ASSETS.map(([label, asset]) => downloadCard(label, asset, 'Desktop installer')).join('')}
      </div>
      <p class="download-note">
        Release artifacts are attached to GitHub Releases. If a platform build is not available yet, use the CLI install path above.
      </p>
    </section>
  `;
}

function androidDownloadSection(): string {
  return `
    <section id="android" class="android-section" aria-labelledby="android-title">
      <div class="section-heading">
        <!-- Android eyebrow intentionally hidden. -->
        <h2 id="android-title">Install the Agentic Android app.</h2>
        <p>
          The Android build is a Trusted Web Activity for the Render-hosted Agentic site. It keeps the browser-based
          Solana Mobile Wallet Adapter path available without turning the app into a private-key custodian.
        </p>
      </div>
      <div class="download-section">
        <div class="download-section-head">
          <h3>Android release artifacts</h3>
          <a href="${RELEASE_PAGE_URL}" target="_blank" rel="noreferrer">View all releases</a>
        </div>
        <div class="download-grid android-download-grid">
          ${ANDROID_RELEASE_ASSETS.map(([label, asset]) => downloadCard(label, asset, label.includes('Bundle') ? 'Play release' : 'Android install')).join('')}
        </div>
      </div>
      <p class="download-note">
        Use the APK for direct install testing and the AAB for Play or managed release pipelines. Production trusted
        mode requires the deployed site to serve Digital Asset Links for the signing certificate.
      </p>
    </section>
  `;
}

function homepageDemoCtaSection(): string {
  return `
    <section class="homepage-demo-cta" aria-labelledby="homepage-demo-title">
      <div>
        <p class="eyebrow mini">Approval workspace</p>
        <h2 id="homepage-demo-title">Open the real wallet approval workspace.</h2>
        <p>
          Launch App opens the browser and mobile-web approval surface. The demo stays available when you want a guided
          preview before connecting a wallet.
        </p>
      </div>
      <div class="homepage-cta-actions">
        <a class="button-link nav-pill-link launch-app-link mobile-redundant-nav" href="/app">Launch App</a>
        <a class="button-link mobile-redundant-nav" href="/demo">Preview Demo</a>
      </div>
    </section>
  `;
}

function guidedDemoPage(): string {
  return `
    <section id="demo-guide" class="browser-app-section guided-demo-overview" aria-labelledby="guided-demo-title">
      <div class="section-heading">
        <p class="eyebrow mini">Guided demo</p>
        <h2 id="guided-demo-title">Try the approval flow before launching the full app.</h2>
        <p>
          This page keeps a short guide above the live demo workspace. Use the cards to jump into wallet signing,
          agent plan review, approval queues, recurring approvals, or artifacts without losing the interactive controls below.
        </p>
      </div>
      <div class="browser-app-grid demo-guide-grid">
        ${guidedDemoStepCard('wallet', 'Wallet signing', 'Connect a wallet and sign a bounded demo message without exposing keys.', 'Try signing')}
        ${guidedDemoStepCard('agent', 'Agent plan', 'Draft a structured approval plan, then sign the proof when connected.', 'Draft a plan')}
        ${guidedDemoStepCard('inbox', 'Approval Inbox', 'Preview prepared actions and receipts from the local bridge.', 'View inbox')}
        ${guidedDemoStepCard('schedule', 'Create Recurring', 'Create recurring approval requests that still require wallet review each time.', 'Create recurring')}
        ${guidedDemoStepCard('labs', 'Artifacts', 'Create wallet-signed audit artifacts for intent, policy, evidence, and verification.', 'Create artifact')}
      </div>
      <div class="browser-app-actions">
        <button data-start-action="discover" ${state.busy ? 'disabled' : ''}>
          ${state.wallets.length ? 'Refresh Wallets' : 'Discover Wallets'}
        </button>
        <button class="nav-pill-link" data-demo-tab="wallet" ${state.busy ? 'disabled' : ''}>Open live demo</button>
        <a class="button-link launch-app-link mobile-redundant-nav" href="/app">Launch full app</a>
        <a class="button-link mobile-redundant-nav" href="/docs">Read Docs</a>
      </div>
    </section>
  `;
}

function guidedDemoStepCard(tab: ActiveTab, title: string, detail: string, actionLabel: string): string {
  return `
    <article class="browser-app-card demo-step-card">
      <div>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(detail)}</p>
      </div>
      <button class="demo-step-action" data-demo-tab="${escapeHtml(tab)}">${escapeHtml(actionLabel)}</button>
    </article>
  `;
}

function mwaTestPage(): string {
  const bridgeAvailable = Boolean(agenticAndroidBridge()?.openMwaExample);
  return `
    <section id="mwa-test" class="browser-app-section" aria-labelledby="mwa-test-title">
      <div class="section-heading">
        <p class="eyebrow mini">Android MWA</p>
        <h2 id="mwa-test-title">Raw Mobile Wallet Adapter controls.</h2>
        <p>
          This tab is available only in Android builds with the example tab flag enabled. It opens the native MWA
          tester for wallet connect, SIWS, message signing, transaction signing, bridge polling, and reset smokes.
        </p>
      </div>
      <div class="browser-app-grid demo-guide-grid">
        ${launchAppCard('Native tester', 'Use the old Android MWA test surface without making it the app launcher.')}
        ${launchAppCard('Wallet handoff', 'Exercise Solana Mobile Wallet Adapter connect, reconnect, and signing paths.')}
        ${launchAppCard('Bridge smoke', 'Connect to the local Agentic bridge and resolve agent requests with a real wallet.')}
      </div>
      <div class="browser-app-actions">
        <button id="openAndroidMwaTest" class="nav-pill-link" ${bridgeAvailable ? '' : 'disabled'}>
          Open MWA
        </button>
        <a class="button-link" href="/app">Back to Launch App</a>
      </div>
      ${bridgeAvailable
        ? ''
        : `<p class="inline-status warning">MWA is only available inside the Android app build.</p>`}
    </section>
  `;
}

function homepageFooter(): string {
  return `
    <footer class="homepage-footer" aria-label="Agentic footer">
      <div>
        <span class="footer-brand">${agenticMark('mini-mark')} Agentic</span>
        <p>Render hosts the static website. CLI, Desktop App, bridge, and wallet approvals run locally.</p>
        <p class="footer-contact">
          <span>SolPulse LLC</span>
          <a href="mailto:support@solpulse.trade">support@solpulse.trade</a>
        </p>
      </div>
      <nav aria-label="Footer navigation">
        <a href="/docs">Docs</a>
        <a href="/cli">CLI</a>
        <a href="/desktop">Desktop App</a>
        <a href="/demo">Demo</a>
        <a class="launch-app-link footer-launch-app-link" href="/app">Launch App</a>
        <a href="${RELEASE_PAGE_URL}" target="_blank" rel="noreferrer">Releases</a>
        <a href="/terms">Terms</a>
        <a href="/privacy">Privacy</a>
      </nav>
    </footer>
  `;
}

function localDevelopmentSection(): string {
  return `
    <section id="local-development" class="local-dev-section" aria-labelledby="local-dev-title">
      <div class="section-heading">
        <p class="eyebrow mini">Local repo development</p>
        <h2 id="local-dev-title">Contributor commands stay separate from public install paths.</h2>
        <p>
          These commands are for developers running this monorepo locally. They are not required for public website visitors.
        </p>
      </div>
      <div class="runtime-grid">
        <article class="runtime-card">
          <span class="runtime-kicker">Launch App</span>
          <h3>Develop the hosted app</h3>
          ${runtimeCommandRow('Browser dev server', 'pnpm demo:browser', 'Copy command')}
        </article>
        <article class="runtime-card">
          <span class="runtime-kicker">Repo fallback</span>
          <h3>Run unreleased local runtimes</h3>
          ${runtimeCommandRow('Desktop App dev', 'pnpm desktop:dev', 'Copy command')}
          ${runtimeCommandRow('CLI from repo', 'pnpm cli -- app', 'Copy command')}
        </article>
      </div>
    </section>
  `;
}

function downloadCard(label: string, asset: string, kind: string): string {
  const url = `${RELEASE_BASE_URL}/${asset}`;
  return `
    <a class="download-card" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">
      <span>${escapeHtml(kind)}</span>
      <strong>${escapeHtml(label)}</strong>
      <code>${escapeHtml(asset)}</code>
    </a>
  `;
}

function runtimeCommandRow(label: string, command: string, actionLabel: string): string {
  const copyId = commandCopyId('runtime', label, command);
  const copied = state.recentCopyId === copyId;
  return `
    <div class="runtime-command-row ${copied ? 'copied' : ''}">
      <div>
        <span>${escapeHtml(label)}</span>
        <code>${escapeHtml(command)}</code>
      </div>
      <button
        class="${copied ? 'copied' : ''}"
        data-copy="${escapeHtml(command)}"
        data-copy-id="${escapeHtml(copyId)}"
        data-copy-name="${escapeHtml(label)}"
        title="Copy command: ${escapeHtml(command)}"
      >
        ${copied ? 'Copied' : escapeHtml(actionLabel)}
      </button>
    </div>
  `;
}

function appWorkspace(mode: 'app' | 'demo' = 'app'): string {
  const appModeClass = SHOW_DEV_CONTROLS ? 'dev-app' : 'public-app';
  const workspaceId = mode === 'demo' ? 'demo-workspace' : 'workspace';
  const titleId = mode === 'demo' ? 'demo-workspace-title' : 'workspace-title';
  const modeClass = mode === 'demo' ? 'demo-workspace-mode' : 'launch-workspace-mode';
  return `
    <section id="${workspaceId}" class="app-workspace-section ${appModeClass} ${modeClass}" aria-labelledby="${titleId}">
      <div class="workspace-intro">
        <div>
          ${mode === 'demo' ? '<p class="eyebrow mini">Interactive demo</p>' : '<!-- Launch App eyebrow intentionally hidden. -->'}
          <h2 id="${titleId}">${mode === 'demo' ? 'Live approval demo.' : 'Agentic approval workspace.'}</h2>
        </div>
        ${SHOW_DEV_CONTROLS ? systemSpine() : ''}
      </div>
      ${SHOW_DEV_CONTROLS ? missionStrip() : ''}
      ${SHOW_DEV_CONTROLS ? `<header class="app-header command-bar">
        <div class="brand-lockup">
          <span class="brand-mark">${agenticMark('mini-mark')}</span>
          <div>
            <p class="eyebrow mini">Solana Agent Wallet Adapter</p>
            <h1>Wallet approval workspace</h1>
          </div>
        </div>
        ${systemSpine()}
      </header>` : ''}

      <section class="workspace ${SHOW_DEV_CONTROLS ? 'dev-workspace' : 'public-workspace'}">
        ${walletRail()}
        <section class="panel main-panel">
          <div class="surface-topbar">
            <div>
              <h2>${surfaceTitle()}</h2>
            </div>
            <nav class="nav-cluster tabs workspace-tabs" aria-label="Workspace navigation">
              ${/*
                Wallet tab intentionally hidden across web, Android, and iOS app shells.
                tabButton('wallet', 'Wallet')
              */ ''}
              ${tabButton('agent', 'Agent Plan', 'Plan')}
              ${tabButton('inbox', 'Approval Inbox', 'Inbox')}
              ${tabButton('schedule', 'Create Recurring', 'Recur')}
              ${tabButton('labs', 'Artifacts')}
            </nav>
          </div>
          ${activePanel()}
        </section>
        ${SHOW_DEV_CONTROLS ? contextPanel() : requestContextDetails()}
      </section>
    </section>
  `;
}

function gapProof(title: string, detail: string): string {
  return `
    <article class="gap-proof">
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(detail)}</p>
    </article>
  `;
}

function agenticMark(extraClass = ''): string {
  const className = ['agentic-mark', extraClass].filter(Boolean).join(' ');
  return `
    <img class="${escapeHtml(className)}" src="${escapeHtml(AGENTIC_MARK_LOGO)}" alt="" aria-hidden="true" decoding="async" />
  `;
}

function brandLogo(logoId: BrandLogoId, className: string): string {
  return `
    <span class="${escapeHtml(className)} brand-logo" aria-hidden="true">
      <img src="${escapeHtml(BRAND_LOGOS[logoId])}" alt="" />
    </span>
  `;
}

function solanaMark(extraClass = ''): string {
  return `
    <svg class="solana-mark ${extraClass}" viewBox="0 0 398 312" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="solana-gradient" x1="360" y1="40" x2="40" y2="280" gradientUnits="userSpaceOnUse">
          <stop stop-color="#00ffa3" />
          <stop offset="1" stop-color="#dc1fff" />
        </linearGradient>
      </defs>
      <path fill="url(#solana-gradient)" d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7Z" />
      <path fill="url(#solana-gradient)" d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8Z" />
      <path fill="url(#solana-gradient)" d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7Z" />
    </svg>
  `;
}

function walletIcon(
  wallet: DiscoveredWallet | undefined,
  fallback: string,
  className: string,
  fallbackLogoId?: BrandLogoId,
): string {
  const iconSrc = wallet?.icon ?? (fallbackLogoId ? BRAND_LOGOS[fallbackLogoId] : undefined);
  if (iconSrc) {
    return `
      <span class="${escapeHtml(className)} wallet-provider-icon" aria-hidden="true">
        <img src="${escapeHtml(iconSrc)}" alt="" />
      </span>
    `;
  }
  return `<span class="${escapeHtml(className)} wallet-provider-fallback" aria-hidden="true">${escapeHtml(fallback)}</span>`;
}

function discoveredWalletByName(name: string): DiscoveredWallet | undefined {
  const normalized = name.toLowerCase();
  return state.wallets.find((wallet) => wallet.name.toLowerCase().includes(normalized));
}

function providerInitials(name: string): string {
  return name
    .split(/[\s/-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function walletLogoIdForName(name: string): BrandLogoId | undefined {
  const normalized = name.toLowerCase();
  if (normalized.includes('backpack')) return 'backpack';
  if (normalized.includes('phantom')) return 'phantom';
  if (normalized.includes('solflare')) return 'solflare';
  if (normalized.includes('jupiter')) return 'jupiter';
  return undefined;
}

function missionStrip(): string {
  const openApprovals = state.preparedActions.filter(
    (action) => !action.archived && !['approved', 'rejected'].includes(action.status),
  ).length;
  return `
    <section class="mission-strip">
      ${metric('Wallet', state.address ? short(state.address) : 'Not connected', state.address ? 'online' : '')}
      ${metric('Cluster', state.cluster, state.cluster === 'mainnet-beta' ? 'warn' : '')}
      ${metric('Bridge', state.bridgeActive ? 'Ready' : 'Offline', state.bridgeActive ? 'online' : '')}
      ${metric('Approvals', `${openApprovals} queued`, openApprovals > 0 ? 'warn' : '')}
    </section>
  `;
}

function systemSpine(): string {
  const openApprovals = state.preparedActions.filter(
    (action) => !action.archived && !['approved', 'rejected'].includes(action.status),
  ).length;
  return `
    <div class="system-spine" aria-label="System status">
      ${spineNode('Wallet', state.address ? short(state.address) : 'Connect wallet', state.address ? 'online' : '')}
      ${spineNode('Network', titleCaseCluster(state.cluster), state.cluster === 'mainnet-beta' ? 'warn' : '')}
      ${spineNode('Bridge', state.bridgeActive ? 'Ready' : 'Offline', state.bridgeActive ? 'online' : '')}
      ${spineNode('Queue', `${openApprovals}`, openApprovals > 0 ? 'warn' : '')}
    </div>
  `;
}

function spineNode(label: string, value: string, tone = ''): string {
  return `
    <div class="spine-node ${tone}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function metric(label: string, value: string, tone = ''): string {
  return `
    <div class="mission-metric ${tone}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function walletRail(): string {
  const showConnectionDetails = SHOW_DEV_CONTROLS && !state.address;
  const showPublicWalletPicker = !SHOW_DEV_CONTROLS && !state.address && !state.iosNativeEnvironment.isIosNative && state.wallets.length > 1;
  const showPublicIosPicker = !SHOW_DEV_CONTROLS && !state.address && state.iosNativeEnvironment.isIosNative;
  const wallet = walletIdentity();
  return `
    <aside class="panel custody-panel custody-module">
      <div class="rail-heading custody-heading">
        ${walletRailIcon(wallet)}
        <div>
          <p class="eyebrow mini">Signer</p>
          <h2>${escapeHtml(wallet.title)}</h2>
        </div>
      </div>

      <div class="connection-summary custody-card">
        <span class="status-dot ${state.address ? 'online' : ''}"></span>
        <div>
          <strong>${escapeHtml(wallet.summary)}</strong>
          <p>${escapeHtml(wallet.detail)}</p>
        </div>
      </div>

      ${SHOW_DEV_CONTROLS && state.address ? `<button id="disconnect" class="text-button" ${state.busy ? 'disabled' : ''}>Disconnect wallet</button>` : ''}
      ${SHOW_DEV_CONTROLS ? '' : publicWalletActions()}

      ${SHOW_DEV_CONTROLS ? `
      <details class="rail-details developer-settings" ${showConnectionDetails ? 'open' : ''}>
        <summary>Developer settings</summary>
        ${developerConnectionSettings()}
      </details>` : ''}

      ${showPublicWalletPicker ? `
      <details class="rail-details wallet-picker-details" open>
        <summary>Choose wallet</summary>
        <label class="field">
          <span>Selected wallet</span>
          <select id="walletSelect" ${state.busy ? 'disabled' : ''}>
            ${walletOptions()}
          </select>
        </label>
      </details>` : ''}

      ${showPublicIosPicker ? `
      <details class="rail-details wallet-picker-details" open>
        <summary>Choose iOS wallet</summary>
        <label class="field">
          <span>Selected wallet</span>
          <select id="iosWalletSelect" ${state.busy ? 'disabled' : ''}>
            ${iosWalletOptions()}
          </select>
        </label>
      </details>` : ''}

      ${SHOW_DEV_CONTROLS && state.address ? `
      <details class="rail-details bridge-details" ${state.bridgeActive ? 'open' : ''}>
        <summary>Bridge operations</summary>
        ${bridgeBox()}
      </details>` : ''}
      ${SHOW_DEV_CONTROLS && state.address ? `
      <details class="rail-details">
        <summary>Environment</summary>
        ${mobileWalletBox()}
      </details>` : ''}
    </aside>
  `;
}

function walletRailIcon(wallet: WalletIdentity): string {
  const iconSrc = wallet.logoId ? BRAND_LOGOS[wallet.logoId] : wallet.discoveredWallet?.icon;
  if (iconSrc) {
    return `
      <span class="rail-icon wallet-provider-icon" aria-hidden="true">
        <img src="${escapeHtml(iconSrc)}" alt="" />
      </span>
    `;
  }
  return `<span class="rail-icon" aria-hidden="true">${escapeHtml(wallet.icon)}</span>`;
}

function publicWalletActions(): string {
  const selectedProvider = discoveredSelectedWalletName();
  const iosNative = state.iosNativeEnvironment.isIosNative;
  if (state.address) {
    return `
      <div class="wallet-actions public-wallet-actions connected">
        <button id="disconnect" ${state.busy ? 'disabled' : ''}>Disconnect wallet</button>
      </div>
    `;
  }
  return `
    <div class="wallet-actions public-wallet-actions">
      <button data-start-action="discover" class="${state.wallets.length || iosNative ? '' : 'primary'}" ${state.busy ? 'disabled' : ''}>
        ${iosNative ? 'Refresh iOS' : state.wallets.length ? 'Refresh' : 'Discover'}
      </button>
      <button data-start-action="connect" class="${state.wallets.length || iosNative ? 'primary' : ''}" ${(!iosNative && (state.wallets.length === 0 || !selectedProvider)) || state.busy ? 'disabled' : ''} title="${!iosNative && !selectedProvider ? 'Discover and select a wallet provider first.' : ''}">
        Connect wallet
      </button>
    </div>
  `;
}

function developerConnectionSettings(): string {
  return `
    <label class="field">
      <span>Cluster</span>
      <select id="clusterSelect" ${state.busy || state.bridgeActive ? 'disabled' : ''}>
        ${CLUSTERS.map((cluster) => `<option value="${cluster}" ${cluster === state.cluster ? 'selected' : ''}>${cluster}</option>`).join('')}
      </select>
    </label>

    ${state.iosNativeEnvironment.isIosNative ? `
    <label class="field">
      <span>iOS wallet</span>
      <select id="iosWalletSelect" ${state.busy ? 'disabled' : ''}>
        ${iosWalletOptions()}
      </select>
    </label>` : `
    <label class="field">
      <span>Selected wallet</span>
      <select id="walletSelect" ${state.wallets.length === 0 || state.busy ? 'disabled' : ''}>
        ${walletOptions()}
      </select>
    </label>`}

    ${state.capabilities ? capabilityBlock(state.capabilities) : ''}
    ${state.iosNativeEnvironment.isIosNative ? mobileWalletBox() : ''}
  `;
}

function mobileWalletBox(): string {
  if (state.iosNativeEnvironment.isIosNative) {
    return `
      <div class="mobile-wallet-box ios-native-box">
        <h3>iOS Wallet Runtime</h3>
        <p>${escapeHtml(state.iosNativeStatus)}</p>
        <div class="capabilities compact-caps">
          <span>Capacitor iOS</span>
          <span>${escapeHtml(iosWalletLabel(state.selectedIosWalletId))}</span>
          <span>${state.iosAuthCacheCount} cached</span>
        </div>
        <div class="bridge-actions ios-state-actions">
          <button id="iosReconnectCached" ${state.busy ? 'disabled' : ''}>Reconnect cached</button>
          <button id="iosClearTransient" ${state.busy ? 'disabled' : ''}>Clear transient</button>
          <button id="iosFullReset" ${state.busy ? 'disabled' : ''}>Full reset</button>
          <button id="iosClearAllAccounts" ${state.busy ? 'disabled' : ''}>Clear all accounts</button>
        </div>
      </div>
    `;
  }
  return `
    <div class="mobile-wallet-box">
      <h3>Android MWA</h3>
      <p>${escapeHtml(mwaStatusText())}</p>
      <div class="capabilities compact-caps">
        <span>${state.mwaEnvironment.isAndroid ? 'Android' : 'Desktop'}</span>
        <span>${state.mwaEnvironment.supportsMwaMobileWeb ? 'MWA ready' : 'Browser wallet'}</span>
      </div>
    </div>
  `;
}

function bridgeBox(): string {
  const bridgeTone = state.bridgeActive ? 'online' : state.busy ? 'checking' : '';
  const bridgeStatus = state.bridgeActive ? 'Connected' : state.busy ? 'Checking' : 'Offline';
  return `
    <div class="bridge-box bridge-ops-card">
      <div class="bridge-ops-head">
        <div>
          <span>Local bridge</span>
          <h3>Bridge host</h3>
        </div>
        <strong class="${bridgeTone}">${escapeHtml(bridgeStatus)}</strong>
      </div>
      <div class="bridge-endpoint">
        <span>Endpoint</span>
        <code>${escapeHtml(compactEndpoint(state.bridgeUrl))}</code>
      </div>
      <div class="bridge-actions bridge-primary-actions">
        <button id="connectBridge" class="primary" ${!state.address || state.busy || state.bridgeActive ? 'disabled' : ''}>
          Connect bridge
        </button>
        <button id="disconnectBridge" ${!state.bridgeActive || state.busy ? 'disabled' : ''}>Disconnect</button>
      </div>
      <p class="bridge-ops-status">${escapeHtml(state.bridgeStatus)}</p>
      <div class="bridge-terminal-hint">
        <span>Terminal control</span>
        <code>${NPM_EXEC_COMMAND}</code>
        <button data-copy="${NPM_EXEC_COMMAND}" data-copy-name="CLI one-shot command" title="Copy terminal command">Copy</button>
      </div>
      <details class="bridge-advanced-settings">
        <summary>Advanced bridge settings</summary>
        <label class="field compact">
          <span>Bridge URL</span>
          <input id="bridgeUrl" value="${escapeHtml(state.bridgeUrl)}" ${state.busy || state.bridgeActive ? 'disabled' : ''} />
        </label>
        <label class="field compact">
          <span>Bridge token</span>
          <input id="bridgeToken" value="${escapeHtml(state.bridgeToken)}" ${state.busy || state.bridgeActive ? 'disabled' : ''} />
        </label>
      </details>
    </div>
  `;
}

function compactEndpoint(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.port ? `:${url.port}` : ''}`;
  } catch {
    return short(value);
  }
}

function guidedStartPanel(title: string, detail: string): string {
  const selectedProvider = discoveredSelectedWalletName();
  const iosNative = state.iosNativeEnvironment.isIosNative;
  const selectedIosWallet = iosWalletLabel(state.selectedIosWalletId);
  return `
    <section class="guided-start signature-stage stage-dormant">
      <div class="guided-start-copy">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(detail)}</p>
      </div>
      <div class="guided-path" aria-label="Wallet connection path">
        ${guidedStep('1', iosNative ? 'iOS paths' : 'Discover', iosNative ? `${state.iosWallets.length} wallet path(s) ready` : state.wallets.length ? `${state.wallets.length} provider(s) found` : 'Find installed Wallet Standard providers', iosNative || state.wallets.length > 0)}
        ${guidedStep('2', 'Select', iosNative ? selectedIosWallet : selectedProvider || (state.wallets.length ? 'Choose a discovered provider' : 'Choose a wallet provider'), iosNative ? Boolean(selectedIosWallet) : Boolean(selectedProvider))}
        ${guidedStep('3', 'Connect', 'Authorize this app in the wallet', Boolean(state.address))}
      </div>
      <div class="guided-actions">
        <button data-start-action="discover" class="${state.wallets.length || iosNative ? '' : 'primary'}" ${state.busy ? 'disabled' : ''}>${iosNative ? 'Refresh iOS state' : 'Discover wallets'}</button>
        <button data-start-action="connect" class="${state.wallets.length || iosNative ? 'primary' : ''}" ${(!iosNative && (state.wallets.length === 0 || !selectedProvider)) || state.busy ? 'disabled' : ''} title="${!iosNative && !selectedProvider ? 'Discover and select a wallet provider first.' : ''}">Connect wallet</button>
      </div>
      <p class="guided-note">Bridge review, recurring approvals, artifact creation, and transaction tools unlock after a wallet is connected.</p>
    </section>
  `;
}

function guidedStep(index: string, title: string, detail: string, complete: boolean): string {
  return `
    <div class="guided-step ${complete ? 'complete' : ''}">
      <span>${escapeHtml(index)}</span>
      <div>
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(detail)}</p>
      </div>
    </div>
  `;
}

function terminalCommandPanel(): string {
  const selectedRuntimePath = currentRuntimePath();
  const runtimePath = selectedRuntimePath.actionKind === 'copy' ? selectedRuntimePath : RUNTIME_PATHS[0]!;
  const terminalState = terminalCommandState(runtimePath);
  return `
    <section class="terminal-try-panel" aria-label="Terminal app quick start">
      <div class="terminal-try-copy">
        <span class="workbench-kicker">Try it now</span>
        <h2>Run the approval terminal</h2>
        <p>Copy one command into Terminal. The terminal controls the bridge and approval queue; your browser wallet still signs every request.</p>
        <div class="terminal-command-list">
          ${terminalCommandRow('One-shot CLI', NPM_EXEC_COMMAND, 'No install')}
          ${terminalCommandRow('Global install', NPM_GLOBAL_INSTALL_COMMAND, 'Install')}
          ${terminalCommandRow('Installed app', INSTALLED_APP_COMMAND, 'After install')}
        </div>
      </div>
      <div class="terminal-preview-window">
        <div class="terminal-preview-bar">
          <span></span>
          <span></span>
          <span></span>
          <strong>terminal</strong>
        </div>
        <div class="terminal-preview-body">
          <p><span>$</span> ${escapeHtml(runtimePath.terminalCommand)}<i class="terminal-caret" aria-hidden="true"></i></p>
          <p class="${terminalState.bridgeTone}">${escapeHtml(terminalState.bridgeLine)}</p>
          <p class="${terminalState.walletTone}">${escapeHtml(terminalState.walletLine)}</p>
          <p><span>sawa&gt;</span> /connect</p>
          <p><span>sawa&gt;</span> /inbox</p>
        </div>
      </div>
    </section>
  `;
}

function terminalCommandRow(label: string, command: string, badge: string): string {
  const copyId = commandCopyId('terminal', label, command);
  const copied = state.recentCopyId === copyId;
  return `
    <div class="terminal-command-row ${copied ? 'copied' : ''}">
      <div>
        <span>${escapeHtml(label)}</span>
        <code>${escapeHtml(command)}</code>
      </div>
      <strong>${escapeHtml(badge)}</strong>
      <button
        class="${copied ? 'copied' : ''}"
        data-copy="${escapeHtml(command)}"
        data-copy-id="${escapeHtml(copyId)}"
        data-copy-name="${escapeHtml(label)} command"
        title="Copy ${escapeHtml(label)} command"
      >
        ${copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  `;
}

function terminalCommandState(runtimePath = currentRuntimePath()): {
  bridgeLine: string;
  bridgeTone: string;
  walletLine: string;
  walletTone: string;
} {
  if (state.bridgeActive && state.address) {
    return {
      bridgeLine: 'Bridge connected',
      bridgeTone: 'ok',
      walletLine: `Wallet ${short(state.address)} ready`,
      walletTone: 'ok',
    };
  }
  if (state.address) {
    return {
      bridgeLine: 'Bridge offline, terminal app can start it',
      bridgeTone: 'warn',
      walletLine: `Wallet ${short(state.address)} connected in browser`,
      walletTone: 'ok',
    };
  }
  return {
    bridgeLine: runtimePath.bridgeLine,
    bridgeTone: 'warn',
    walletLine: runtimePath.walletLine,
    walletTone: '',
  };
}

function currentRuntimePath(): RuntimePath {
  return RUNTIME_PATHS.find((runtimePath) => runtimePath.id === state.selectedRuntimePath) ?? RUNTIME_PATHS[0]!;
}

function runtimePathById(id: string | undefined): RuntimePath | undefined {
  return RUNTIME_PATHS.find((runtimePath) => runtimePath.id === id);
}

function runtimeCommandCopyId(scope: string, runtimePath: RuntimePath): string {
  return commandCopyId(scope, runtimePath.label, runtimePath.command);
}

function commandCopyId(scope: string, label: string, command: string): string {
  return `${scope}:${label}:${command}`;
}

function markCopied(copyId: string): void {
  state.recentCopyId = copyId;
  if (copyResetTimer !== null) {
    window.clearTimeout(copyResetTimer);
  }
  copyResetTimer = window.setTimeout(() => {
    if (state.recentCopyId !== copyId) return;
    state.recentCopyId = '';
    copyResetTimer = null;
    render();
  }, 1600);
}

function signatureLifecycle(items: Array<[string, string, boolean]>): string {
  return `
    <div class="signature-lifecycle signature-trace" aria-label="Signature lifecycle">
      ${items
        .map(
          ([label, value, complete]) => `
            <div class="trace-node ${complete ? 'complete' : ''}">
              <span class="trace-dot"></span>
              <div>
                <strong>${escapeHtml(label)}</strong>
                <p>${escapeHtml(value)}</p>
              </div>
            </div>
          `,
        )
        .join('')}
    </div>
  `;
}

function signaturePlaceholder(title: string, detail: string): string {
  return `
    <div class="signature-placeholder">
      <span>${escapeHtml(title)}</span>
      <p>${escapeHtml(detail)}</p>
    </div>
  `;
}

function activePanel(): string {
  switch (state.activeTab) {
    case 'wallet':
      return walletFlowPanel();
    case 'agent':
      return agentPlanPanel();
    case 'inbox':
      return approvalInboxPanel();
    case 'schedule':
      return scheduledApprovalsPanel();
    case 'labs':
      return labsPanel();
  }
}

function walletFlowPanel(): string {
  if (!state.address) {
    return `
      ${guidedStartPanel('Wallet signing', 'Connect a browser wallet to open signing requests, approvals, and receipts.')}
      ${SHOW_DEV_CONTROLS ? terminalCommandPanel() : ''}
    `;
  }
  const signButtonClass = state.signature ? 'primary resolved' : 'primary';
  const signButtonLabel = state.signature ? 'Signed' : 'Sign message';
  const signButtonDisabled = state.signature || !state.address || state.busy ? 'disabled' : '';
  const walletStatus = state.signature
    ? 'Wallet signature captured. Receipt is ready for audit.'
    : state.transactionStatus || 'Ready for wallet approval.';
  return `
    <section class="approval-object signature-stage stage-wallet ${state.signature ? 'stage-complete' : 'stage-active'}">
      <div class="signature-object-head">
        <div>
          <h2>Message approval</h2>
          <p>Wallet-held key approval for a bounded agent message on ${escapeHtml(titleCaseCluster(state.cluster))}.</p>
        </div>
        <span class="signature-state ${state.signature ? 'complete' : 'active'}">${state.signature ? 'signed' : 'ready'}</span>
      </div>

      <div class="signature-capsule">
        <div class="capsule-main">
          <span>Request</span>
          <strong>${escapeHtml(DEMO_MESSAGE)}</strong>
          <p>Signer: ${escapeHtml(state.selectedWalletName || 'Connected wallet')} • ${escapeHtml(short(state.address))}</p>
        </div>
        <button id="signMessage" class="${signButtonClass}" ${signButtonDisabled}>${signButtonLabel}</button>
      </div>

      ${signatureLifecycle([
        ['Provider', state.wallets.length ? `${state.wallets.length} discovered` : 'Ready', true],
        ['Signer', short(state.address), true],
        ['Approval', state.signature ? 'Wallet signed' : 'Waiting for action', Boolean(state.signature)],
        ['Receipt', state.txid || state.txSignature ? 'Available' : 'Pending', Boolean(state.txid || state.txSignature)],
      ])}

      ${SHOW_DEV_CONTROLS ? `<details class="advanced-section" ${state.customTransactionBase64 || state.txSignature || state.txid ? 'open' : ''}>
        <summary>
          <span>Advanced transaction tools</span>
          <strong>${state.cluster === 'devnet' ? 'Devnet memo test' : 'Paste transaction bytes'}</strong>
        </summary>
        <div class="transaction-actions">
          <div class="transaction-action-row">
            <button id="createTx" ${!state.address || state.busy || state.cluster !== 'devnet' ? 'disabled' : ''}>Create demo transaction</button>
            <button id="signTx" ${!state.address || !state.customTransactionBase64 || state.busy ? 'disabled' : ''}>Sign transaction</button>
            <button id="sendTx" ${!canSignAndSend() ? 'disabled' : ''}>Sign and send</button>
          </div>
          <label class="field compact transaction-field">
            <span>Transaction base64</span>
            <textarea id="txInput" placeholder="Create a demo transaction or paste a transaction, base64 encoded" ${state.busy ? 'disabled' : ''}>${escapeHtml(state.customTransactionBase64)}</textarea>
          </label>
        </div>
      </details>` : ''}

      <div class="signature-floor">
        <div>
          <span>Status</span>
          <strong>${escapeHtml(walletStatus)}</strong>
        </div>
        ${SHOW_DEV_CONTROLS ? `<button id="airdrop" class="utility" ${!state.address || state.busy || state.cluster !== 'devnet' ? 'disabled' : ''}>
          Request devnet SOL
        </button>` : ''}
      </div>

      ${resultBlock()}
      ${SHOW_DEV_CONTROLS ? terminalCommandPanel() : ''}
      ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
    </section>
  `;
}

function agentPlanPanel(): string {
  const walletReady = Boolean(state.address);
  const queueable = state.agentPlan ? canQueueAgentPlan(state.agentPlan) : false;
  return `
    <section class="approval-object signature-stage stage-agent ${state.agentSignature ? 'stage-complete' : state.agentPlan ? 'stage-active' : 'stage-draft'}">
      <div class="signature-object-head">
        <div>
          <h2>Agent planner</h2>
          <p>Use keyless templates or BYOK AI to draft plans; wallet approval stays separate.</p>
        </div>
        <span class="signature-state ${state.agentSignature ? 'complete' : state.agentPlan ? 'active' : ''}">${state.agentSignature ? 'proof signed' : state.agentPlan ? 'plan ready' : 'draft'}</span>
      </div>

      ${agentPlannerWorkbench()}
      ${agentPathExplainer()}

      ${state.agentPlan ? agentPlanCard(state.agentPlan) : signaturePlaceholder('Plan details', 'Generate a plan to show route, risk, and approval constraints before signing.')}
      ${agentResultBlock()}
      ${state.agentPreparedActionId ? `<div class="notice">Queued prepared action: ${escapeHtml(state.agentPreparedActionId)}</div>` : ''}
      ${!walletReady ? '<div class="notice">You can draft plans without a wallet. Connect a wallet only when you are ready to sign an approval proof.</div>' : ''}
      ${state.agentPlan && !queueable ? '<div class="notice">This template creates a review/proof plan. Queueing is available for SOL transfers, SPL transfers, swaps, and recurring payments.</div>' : ''}
      ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
    </section>
  `;
}

function agentPlannerWorkbench(): string {
  const template = selectedTemplate();
  const notesRequired = templateRequiresUserNotes(template);
  const canUseAi = canGenerateAiPlanFromSettings();
  return `
    <div class="agent-planner-grid">
      <div class="intent-capsule intent-document-card planner-card ${state.agentPlan ? 'plan-linked' : 'draft'}">
        <div class="intent-document-head">
          <div>
            <span>Template planner</span>
            <h3>${escapeHtml(template.title)}</h3>
          </div>
          <strong>${escapeHtml(template.category)}</strong>
        </div>
        <div class="field compact planner-template-select">
          <span id="templatePickerLabel">Plan template</span>
          ${templatePicker(template)}
        </div>
        <p class="template-description">${escapeHtml(template.description)}</p>
        <div class="planner-fields">
          ${template.fields.map(templateFieldInput).join('')}
        </div>
        <label class="intent-document planner-prompt">
          <span>${notesRequired ? 'Custom request / notes' : 'User notes / instructions'}${notesRequired ? ' *' : ''}</span>
          <textarea id="agentPrompt" placeholder="${notesRequired ? 'Describe what you want prepared or reviewed.' : 'Optional context, reason, policy note, or instruction for this approval record.'}" ${state.busy ? 'disabled' : ''}>${escapeHtml(state.agentPrompt)}</textarea>
        </label>
        <div class="intent-policy-strip">
          <span>Approval rule</span>
          <p>Templates create one-off approval plans without the bridge. The inbox and recurring approvals require the local bridge.</p>
        </div>
        <div class="agent-actions signature-actions intent-document-actions">
          <button id="generatePlan" class="${state.agentPlan ? '' : 'primary'}" ${state.busy ? 'disabled' : ''}>Generate template plan</button>
          <button id="generateAiPlan" class="${canUseAi ? 'primary' : ''}" ${!canUseAi || state.busy ? 'disabled' : ''} title="${canUseAi ? 'Generate through your configured AI key.' : 'Add a hosted/session key or configure local bridge AI first.'}">Generate with AI</button>
          <button id="signAgentPlan" class="${state.agentPlan ? 'primary' : ''}" ${!state.address || !state.agentPlan || state.busy ? 'disabled' : ''} title="${!state.address ? 'Connect a wallet before signing.' : !state.agentPlan ? 'Generate a plan before signing approval.' : ''}">Sign approval</button>
          <button id="queueAgentPlan" class="utility" ${!state.address || !state.agentPlan || !state.bridgeActive || !canQueueAgentPlan(state.agentPlan) || state.busy ? 'disabled' : ''} title="${queuePlanTitle()}">Queue approval</button>
        </div>
      </div>
      ${aiSettingsPanel()}
    </div>
  `;
}

function aiSettingsPanel(): string {
  const configured = isAiConfiguredForCurrentMode();
  const open = configured && !isCompactMobileLayout() ? 'open' : '';
  return `
    <details class="ai-settings-panel" ${open}>
      <summary>
        <span>Connect AI Agent</span>
        <strong>${configured ? 'configured' : 'not configured'}</strong>
      </summary>
      ${aiSettingsCard()}
    </details>
  `;
}

function isCompactMobileLayout(): boolean {
  return window.matchMedia('(max-width: 700px)').matches;
}

function agentPathExplainer(): string {
  return `
    <aside class="agent-path-explainer" aria-label="Template and connected agent paths">
      <div>
        <span>Templates</span>
        <p>Pick an action, fill fields and notes, then generate a keyless approval record. No AI key, Claude, Codex, or MCP required.</p>
      </div>
      <div>
        <span>Connected agent</span>
        <p>Claude, Codex, MCP, or Solana Agent Kit can prepare richer requests through the local bridge. Your wallet still signs.</p>
      </div>
      <div>
        <span>Always true</span>
        <p>Agentic never receives a private key. Templates and agents both end in explicit wallet approval.</p>
      </div>
    </aside>
  `;
}

function templatePicker(template: AgentPlanTemplate): string {
  const selectedLabel = templatePickerLabel(template);
  return `
    <div class="template-picker" data-template-picker>
      <button
        id="templatePickerButton"
        class="template-picker-trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded="false"
        aria-labelledby="templatePickerLabel templatePickerValue"
        ${state.busy ? 'disabled' : ''}
      >
        <span class="template-picker-current">
          <span class="template-picker-category">${escapeHtml(titleCase(template.category))}</span>
          <strong id="templatePickerValue">${escapeHtml(template.title)}</strong>
        </span>
        <span class="template-picker-caret" aria-hidden="true"></span>
      </button>
      <div
        id="templatePickerMenu"
        class="template-picker-menu"
        role="listbox"
        aria-labelledby="templatePickerLabel"
        hidden
      >
        ${AGENT_PLAN_TEMPLATES.map((candidate) => {
          const selected = candidate.id === template.id;
          return `
            <button
              id="template-option-${escapeHtml(candidate.id)}"
              class="template-picker-option ${selected ? 'selected' : ''}"
              type="button"
              role="option"
              aria-selected="${selected ? 'true' : 'false'}"
              data-template-option="${escapeHtml(candidate.id)}"
              title="${escapeHtml(templatePickerLabel(candidate))}"
            >
              <span>${escapeHtml(titleCase(candidate.category))}</span>
              <strong>${escapeHtml(candidate.title)}</strong>
            </button>
          `;
        }).join('')}
      </div>
      <span class="template-picker-sr">${escapeHtml(selectedLabel)}</span>
    </div>
  `;
}

function templatePickerLabel(template: AgentPlanTemplate): string {
  return `${titleCase(template.category)} - ${template.title}`;
}

function templateFieldInput(fieldDef: AgentPlanTemplateField): string {
  const value = templateFieldValue(fieldDef.id);
  const disabled = state.busy ? 'disabled' : '';
  if (fieldDef.type === 'textarea' || fieldDef.id === 'policy') {
    return `
      <label class="field compact planner-field">
        <span>${escapeHtml(fieldDef.label)}</span>
        <textarea data-template-field="${escapeHtml(fieldDef.id)}" placeholder="${escapeHtml(fieldDef.placeholder ?? '')}" ${disabled}>${escapeHtml(value)}</textarea>
      </label>
    `;
  }
  if (fieldDef.type === 'select' && fieldDef.options?.length) {
    return `
      <label class="field compact planner-field">
        <span>${escapeHtml(fieldDef.label)}</span>
        <select data-template-field="${escapeHtml(fieldDef.id)}" ${disabled}>
          ${fieldDef.options.map((option) => `<option value="${escapeHtml(option)}" ${option === value ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}
        </select>
      </label>
    `;
  }
  return `
    <label class="field compact planner-field">
      <span>${escapeHtml(fieldDef.label)}</span>
      <input data-template-field="${escapeHtml(fieldDef.id)}" value="${escapeHtml(value)}" placeholder="${escapeHtml(fieldDef.placeholder ?? '')}" ${disabled} />
    </label>
  `;
}

function aiSettingsCard(): string {
  const status = state.aiStatus;
  const providerPreset = aiProviderPresetById(state.aiSettings.provider);
  const formatLabel = aiFormatLabel(state.aiSettings.apiFormat);
  const customProvider = providerPreset.id === 'custom-openai-compatible';
  const providerOptions = selectableAiProviderPresets();
  const selectedPresetModel = providerPreset.models.find((model) => model.id === state.aiSettings.model);
  const usingCustomModel = !selectedPresetModel;
  const routeLabel = aiRouteStatusLabel(status);
  const keyLabel = state.aiSettings.mode === 'bridge'
    ? 'Bridge session key'
    : state.aiSettings.mode === 'hosted'
      ? 'Hosted request key'
      : 'Browser session key';
  const securityCopy = state.aiSettings.mode === 'hosted'
    ? 'Hosted BYOK relays your key to the selected provider for this request only. Agentic does not store it.'
    : state.aiSettings.mode === 'bridge'
      ? 'The local bridge keeps the key in process memory and calls the provider from your machine.'
      : 'Browser session keys stay in this browser tab only and require a browser-compatible provider or gateway.';
  return `
    <aside class="ai-settings-card">
      <div>
        <span class="workbench-kicker">Connect AI Agent</span>
        <h3>AI key stays out of Agentic custody</h3>
        <p>${escapeHtml(securityCopy)}</p>
      </div>
      <label class="field compact">
        <span>AI path</span>
        <select id="aiMode" ${state.busy ? 'disabled' : ''}>
          <option value="hosted" ${state.aiSettings.mode === 'hosted' ? 'selected' : ''}>Hosted BYOK</option>
          <option value="bridge" ${state.aiSettings.mode === 'bridge' ? 'selected' : ''}>Local bridge</option>
          <option value="session" ${state.aiSettings.mode === 'session' ? 'selected' : ''}>Browser session only</option>
        </select>
      </label>
      <label class="field compact">
        <span>Provider preset</span>
        <select id="aiProvider" ${state.busy ? 'disabled' : ''}>
          ${providerOptions.map((preset) => `
            <option value="${escapeHtml(preset.id)}" ${preset.id === state.aiSettings.provider ? 'selected' : ''}>
              ${escapeHtml(preset.label)}
            </option>
          `).join('')}
        </select>
      </label>
      <label class="field compact">
        <span>Model</span>
        <select id="aiModelSelect" ${state.busy ? 'disabled' : ''}>
          ${providerPreset.models.map((model) => `
            <option value="${escapeHtml(model.id)}" ${model.id === state.aiSettings.model ? 'selected' : ''}>
              ${escapeHtml(model.label)}
            </option>
          `).join('')}
          <option value="${CUSTOM_AI_MODEL_VALUE}" ${usingCustomModel ? 'selected' : ''}>Custom model</option>
        </select>
      </label>
      ${usingCustomModel ? `
        <label class="field compact">
          <span>Custom model</span>
          <input id="aiModelCustom" value="${escapeHtml(state.aiSettings.model)}" placeholder="${escapeHtml(providerPreset.model)}" ${state.busy ? 'disabled' : ''} />
        </label>
      ` : ''}
      ${customProvider ? `
        <label class="field compact">
          <span>Gateway URL</span>
          <input id="aiBaseUrl" value="${escapeHtml(state.aiSettings.baseUrl)}" placeholder="${escapeHtml(providerPreset.baseUrl)}" ${state.busy ? 'disabled' : ''} />
        </label>
      ` : ''}
      <label class="field compact">
        <span>${escapeHtml(keyLabel)}</span>
        <input id="aiApiKey" type="password" value="${escapeHtml(state.aiSettings.apiKey)}" placeholder="Not saved by default" autocomplete="off" ${state.busy ? 'disabled' : ''} />
      </label>
      <div class="ai-actions">
        ${state.aiSettings.mode === 'bridge' ? `<button id="saveBridgeAiKey" ${!canSaveBridgeAiKey() ? 'disabled' : ''}>Set bridge key</button>` : ''}
        <button id="clearAiKey" ${!canClearAiKey() ? 'disabled' : ''}>Clear key</button>
        ${state.aiSettings.mode === 'bridge' ? `<button id="refreshAiStatus" ${state.busy ? 'disabled' : ''}>Refresh</button>` : ''}
      </div>
      <div class="ai-status-line">
        <span>AI route</span>
        <strong>${escapeHtml(routeLabel)}</strong>
      </div>
      <div class="ai-status-line">
        <span>Format</span>
        <strong>${escapeHtml(formatLabel)}</strong>
      </div>
      <p class="ai-security-note">No AI can sign, submit, or approve. It only drafts a structured plan for your wallet review.</p>
    </aside>
  `;
}

function canSaveBridgeAiKey(): boolean {
  return state.aiSettings.mode === 'bridge'
    && Boolean(state.aiSettings.apiKey.trim())
    && Boolean(state.aiSettings.model.trim())
    && aiProviderReadyForCurrentMode()
    && !state.busy;
}

function canClearAiKey(): boolean {
  return Boolean(state.aiSettings.apiKey.trim() || (state.aiSettings.mode === 'bridge' && state.aiStatus?.available));
}

function canGenerateAiPlanFromSettings(): boolean {
  const modelReady = Boolean(state.aiSettings.model.trim());
  if (state.aiSettings.mode === 'bridge') {
    return Boolean(state.aiStatus?.available && !state.busy);
  }
  return Boolean(state.aiSettings.apiKey.trim() && modelReady && aiProviderReadyForCurrentMode() && !state.busy);
}

function isAiConfiguredForCurrentMode(): boolean {
  const modelReady = Boolean(state.aiSettings.model.trim());
  if (state.aiSettings.mode === 'bridge') {
    return Boolean(state.aiStatus?.available);
  }
  return Boolean(state.aiSettings.apiKey.trim() && modelReady && aiProviderReadyForCurrentMode());
}

function aiProviderReadyForCurrentMode(): boolean {
  const providerPreset = aiProviderPresetById(state.aiSettings.provider);
  if (state.aiSettings.mode === 'hosted') {
    return providerPreset.id !== 'custom-openai-compatible';
  }
  return providerPreset.id !== 'custom-openai-compatible' || Boolean(state.aiSettings.baseUrl.trim());
}

function selectableAiProviderPresets(): typeof AI_PROVIDER_PRESETS {
  return state.aiSettings.mode === 'hosted'
    ? AI_PROVIDER_PRESETS.filter((preset) => preset.id !== 'custom-openai-compatible')
    : AI_PROVIDER_PRESETS;
}

function aiRouteStatusLabel(status: BridgeAiStatus | null): string {
  if (state.aiSettings.mode === 'hosted') {
    return state.aiSettings.apiKey.trim() ? `hosted - ${state.aiSettings.provider} - ${state.aiSettings.model || 'model configured'}` : 'hosted - key required';
  }
  if (state.aiSettings.mode === 'session') {
    return state.aiSettings.apiKey.trim() ? `browser - ${state.aiSettings.provider} - ${state.aiSettings.model || 'model configured'}` : 'browser - key required';
  }
  return status?.available
    ? `${status.source} - ${status.provider ?? status.apiFormat ?? 'AI'} - ${status.model ?? 'model configured'}`
    : 'bridge - not configured';
}

function ensureAiProviderAllowedForMode(): void {
  if (state.aiSettings.mode !== 'hosted' || state.aiSettings.provider !== 'custom-openai-compatible') {
    return;
  }
  const preset = aiProviderPresetById(DEFAULT_AI_PROVIDER_ID);
  state.aiSettings.provider = preset.id;
  state.aiSettings.apiFormat = preset.apiFormat;
  state.aiSettings.baseUrl = preset.baseUrl;
  state.aiSettings.model = preset.model;
}

function syncAiActionButtons(): void {
  const saveButton = document.querySelector<HTMLButtonElement>('#saveBridgeAiKey');
  const clearButton = document.querySelector<HTMLButtonElement>('#clearAiKey');
  const generateButton = document.querySelector<HTMLButtonElement>('#generateAiPlan');
  const canGenerateAi = canGenerateAiPlanFromSettings();

  if (saveButton) {
    saveButton.disabled = !canSaveBridgeAiKey();
  }
  if (clearButton) {
    clearButton.disabled = !canClearAiKey();
  }
  if (generateButton) {
    generateButton.disabled = !canGenerateAi;
    generateButton.classList.toggle('primary', canGenerateAi);
    generateButton.title = canGenerateAi
      ? 'Generate through your configured AI key.'
      : 'Add a hosted/session key or configure local bridge AI first.';
  }
}

function approvalInboxPanel(): string {
  if (!state.address) {
    return guidedStartPanel('Approval inbox', 'Connect a wallet before reviewing prepared actions from the local bridge.');
  }
  const actions = filteredPreparedActions();
  return `
    <section class="approval-object signature-stage stage-inbox stage-anchor ${state.preparedActions.length ? 'stage-active' : 'stage-draft'}">
      <div class="signature-object-head">
        <div>
          <h2>Approval inbox</h2>
          <p>Actions wait here until policy, intent, and wallet approval are all visible.</p>
        </div>
        <div class="inbox-toolbar signature-toolbar">
          <select id="inboxFilter">
            ${inboxFilterOption('all', 'All')}
            ${inboxFilterOption('ready', 'Ready')}
            ${inboxFilterOption('scheduled', 'Scheduled')}
            ${inboxFilterOption('approved', 'Approved')}
            ${inboxFilterOption('failed', 'Failed')}
            ${inboxFilterOption('rejected', 'Rejected')}
            ${inboxFilterOption('one-time', 'One-time')}
            ${inboxFilterOption('recurring', 'Recurring')}
          </select>
          <button id="refreshInbox" class="utility" ${!state.bridgeActive || state.busy ? 'disabled' : ''} title="${!state.bridgeActive ? 'Connect the bridge to refresh prepared approvals.' : ''}">Refresh</button>
        </div>
      </div>

      ${queueStatusLine(actions.length)}
      ${preparedActionsList(actions)}
      ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
    </section>
  `;
}

function scheduledApprovalsPanel(): string {
  if (!state.address) {
    return guidedStartPanel('Create recurring approval', 'Connect a wallet before creating recurring approval requests.');
  }
  return `
    <section class="approval-object signature-stage stage-schedule stage-anchor ${state.recurringPayments.length ? 'stage-active' : 'stage-draft'}">
      <div class="signature-object-head">
        <div>
          <h2>Create recurring approval</h2>
          <p>Define recurring requests. Each occurrence still lands in Approval Inbox for wallet review.</p>
        </div>
        <button id="refreshInbox" class="utility" ${!state.bridgeActive || state.busy ? 'disabled' : ''} title="${!state.bridgeActive ? 'Connect the bridge to refresh recurring approvals.' : ''}">Refresh</button>
      </div>

      ${scheduleStatusLine()}
      ${recurringComposer()}
      ${recurringList()}
      ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
    </section>
  `;
}

function labsPanel(): string {
  const lab = activeLab();
  const artifact = latestLabArtifact(lab.id);
  const signedArtifacts = state.labArtifacts;
  const complete = state.artifactView === 'signed' ? signedArtifacts.length > 0 : Boolean(artifact);
  const detail =
    state.artifactView === 'signed'
      ? `Review wallet-signed audit records saved on this device${state.bridgeActive ? ' and mirrored to the local bridge archive' : ''}.`
      : 'Create a signed record that binds request intent, policy interpretation, wallet identity, and local verification.';
  return `
    <section class="approval-object signature-stage stage-labs stage-anchor ${complete ? 'stage-complete' : 'stage-draft'}">
      <div class="signature-object-head artifact-workspace-head">
        <div>
          <h2>Artifacts</h2>
          <p>${escapeHtml(detail)}</p>
        </div>
        ${artifactWorkspaceTabs()}
      </div>

      ${state.artifactView === 'signed' ? signedArtifactsPanel() : createArtifactPanel()}
      ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
    </section>
  `;
}

function artifactWorkspaceTabs(): string {
  return `
    <div class="tabs compact-tabs artifact-view-tabs" role="tablist" aria-label="Artifact views">
      ${artifactViewButton('create', 'Create Artifact')}
      ${artifactViewButton('signed', 'Signed Artifacts')}
    </div>
  `;
}

function artifactViewButton(view: ArtifactView, label: string): string {
  const active = state.artifactView === view;
  return `
    <button
      data-artifact-view="${view}"
      class="${active ? 'active' : ''}"
      role="tab"
      aria-selected="${active ? 'true' : 'false'}"
      type="button"
    >
      ${escapeHtml(label)}
    </button>
  `;
}

function createArtifactPanel(): string {
  if (!state.address) {
    return guidedStartPanel('Create artifact', 'Connect a wallet before creating signed audit artifacts.');
  }
  const lab = activeLab();
  const artifact = latestLabArtifact(lab.id);
  return `
      <div class="lab-panel lab-workbench">
        <div class="artifact-create-status">
          <span class="signature-state">${escapeHtml(labIndexLabel())}</span>
        </div>
        ${labCommandMenu(lab)}
        <div class="lab-workbench-grid">
          <div class="lab-copy research-brief">
            <span class="workbench-kicker">Definition</span>
            <h3>${escapeHtml(lab.title.replace(/^\d+\.\s*/, ''))}</h3>
            <p>${escapeHtml(lab.description)}</p>
            <div class="capabilities compact-caps">
              <span>${escapeHtml(labKindLabel(lab.kind))}</span>
              <span>${artifact ? 'artifact ready' : 'awaiting signature'}</span>
            </div>
          </div>

          <label class="field agent-prompt lab-intent-document">
            <span>Agent intent</span>
            <textarea id="labInput" ${state.busy ? 'disabled' : ''}>${escapeHtml(labInput(lab.id))}</textarea>
          </label>
        </div>

        <div class="lab-actions lab-signature-action">
          <button id="createLabArtifact" class="primary" ${!state.address || state.busy ? 'disabled' : ''}>Create signed artifact</button>
          <span>The next wallet approval creates a locally verified audit artifact.</span>
        </div>

        ${artifact ? labArtifactCard(artifact) : labEmptyState()}
      </div>
  `;
}

function signedArtifactsPanel(): string {
  const artifacts = state.labArtifacts;
  return `
    <div class="lab-panel signed-artifacts-panel">
      <div class="inbox-toolbar signature-toolbar artifact-archive-toolbar">
        <span class="signature-state">${escapeHtml(`${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'}`)}</span>
        <button id="refreshLabArtifacts" class="utility" ${state.busy ? 'disabled' : ''}>Refresh</button>
      </div>
      ${artifactArchiveStatusLine()}
      ${artifacts.length ? signedArtifactList(artifacts) : signedArtifactsEmptyState()}
    </div>
  `;
}

function artifactArchiveStatusLine(): string {
  const bridge = state.bridgeActive
    ? state.health?.labArtifactStorePath
      ? `Bridge file: ${state.health.labArtifactStorePath}`
      : 'Bridge archive connected'
    : 'Bridge archive unavailable';
  return `
    <div class="artifact-archive-status">
      <span>${escapeHtml(state.labArchiveStatus)}</span>
      <strong>${escapeHtml(bridge)}</strong>
    </div>
  `;
}

function signedArtifactsEmptyState(): string {
  return `
    <div class="empty lab-empty-state">
      <span>No signed artifacts</span>
      <h3>Archive is empty</h3>
      <p>Use Create Artifact to add the first wallet-bound record.</p>
    </div>
  `;
}

function signedArtifactList(artifacts: LabArtifact[]): string {
  return `
    <div class="signed-artifact-list">
      ${artifacts.map((artifact) => signedArtifactRow(artifact)).join('')}
    </div>
  `;
}

function signedArtifactRow(artifact: LabArtifact): string {
  return `
    <article class="signed-artifact-row">
      <div class="signed-artifact-main">
        <div class="artifact-meta-line">
          <span class="status-pill ${artifact.verified ? 'tx-confirmed' : 'tx-pending'}">${artifact.verified ? 'verified' : 'signed'}</span>
          <span>${escapeHtml(labKindLabel(artifact.kind))}</span>
        </div>
        <h3>${escapeHtml(artifact.title)}</h3>
        <p>${escapeHtml(artifact.payload.thesis)}</p>
      </div>
      <div class="signed-artifact-facts">
        ${archiveFact('Created', formatDateTime(artifact.createdAt))}
        ${archiveFact('Wallet', short(artifact.walletAddress))}
        ${archiveFact('Cluster', titleCaseCluster(artifact.cluster))}
        ${archiveFact('Artifact', short(artifact.artifactHash))}
      </div>
      <div class="signed-artifact-actions">
        <button data-copy="${escapeHtml(stableJson(artifact))}" data-copy-name="Artifact JSON">Copy JSON</button>
        <button data-copy="${escapeHtml(artifact.signingMessage)}" data-copy-name="Signing payload">Copy Payload</button>
      </div>
      <details class="artifact-technical-details signed-artifact-details">
        <summary>
          <span>Full artifact</span>
          <strong>Creation details and evidence</strong>
        </summary>
        ${signedArtifactDetail(artifact)}
      </details>
    </article>
  `;
}

function archiveFact(label: string, value: string): string {
  return `
    <div>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function signedArtifactDetail(artifact: LabArtifact): string {
  return `
    <div class="artifact-detail-grid">
      ${archiveFact('Artifact type', artifact.title)}
      ${archiveFact('Kind', labKindLabel(artifact.kind))}
      ${archiveFact('Created', formatDateTime(artifact.createdAt))}
      ${archiveFact('Cluster', titleCaseCluster(artifact.cluster))}
      ${archiveFact('Wallet', artifact.walletAddress)}
      ${archiveFact('Artifact hash', artifact.artifactHash)}
    </div>
    <div class="artifact-intent-block">
      <span>Agent intent</span>
      <p>${escapeHtml(artifact.input)}</p>
    </div>
    <div class="artifact-evidence-row">
      ${artifactMetricCard(artifact, 'Decision')}
      ${artifactMetricCard(artifact, 'Custody')}
      ${artifactMetricCard(artifact, 'Settlement')}
    </div>
    <div class="artifact-evidence-list">
      ${artifact.payload.evidence.map((entry) => `
        <div class="${escapeHtml(entry.tone)}">
          <span>${escapeHtml(entry.title)}</span>
          <p>${escapeHtml(entry.detail)}</p>
          <code>${escapeHtml(short(entry.hash))}</code>
        </div>
      `).join('')}
    </div>
    <div class="hash-grid">
      ${hashTile('Pre-signature', artifact.preSignatureHash)}
      ${hashTile('Artifact', artifact.artifactHash)}
      ${hashTile('Signature', artifact.signature)}
      ${hashTile('Wallet', artifact.walletAddress)}
    </div>
  `;
}

function labCommandMenu(lab: LabDefinition): string {
  return `
    <label class="field compact lab-select-field">
      <span>Artifact type</span>
      <select id="labSelect" ${state.busy ? 'disabled' : ''}>
        ${LABS.map(
          (candidate) =>
            `<option value="${escapeHtml(candidate.id)}" ${candidate.id === lab.id ? 'selected' : ''}>${escapeHtml(candidate.title)}</option>`,
        ).join('')}
      </select>
    </label>
  `;
}

function labEmptyState(): string {
  return `
    <div class="empty lab-empty-state">
      <span>No artifact yet</span>
      <h3>Signed artifact required</h3>
      <p>The next wallet approval will bind the selected artifact type, request, wallet, cluster, and local verification result.</p>
    </div>
  `;
}

function contextPanel(): string {
  const latestLab = state.labArtifacts[0];
  const nextAction = state.busy
    ? 'Waiting on wallet response'
    : !state.address
      ? 'Connect a wallet'
      : state.activeTab === 'agent' && !state.agentPlan
        ? 'Generate an agent plan'
        : state.activeTab === 'inbox'
          ? 'Review queued approvals'
          : state.activeTab === 'schedule'
            ? 'Create recurring approval'
            : state.activeTab === 'labs' && state.artifactView === 'signed'
              ? 'Review signed artifacts'
              : state.activeTab === 'labs'
                ? 'Create an artifact'
                : 'Review current request';
  return `
    <aside class="panel context-panel evidence-panel">
      <div class="evidence-header">
        <h2>${state.address ? 'Wallet connected' : 'Wallet required'}</h2>
        <p>${escapeHtml(nextAction)}</p>
      </div>
      <div class="evidence-rail" aria-label="Approval evidence">
        ${evidenceStep('Intent', evidenceIntent(), evidenceTone('intent'))}
        ${evidenceStep('Policy', evidencePolicy(), evidenceTone('policy'))}
        ${evidenceStep('Wallet', evidenceWallet(), evidenceTone('wallet'))}
        ${evidenceStep('Receipt', evidenceReceipt(latestLab), evidenceTone('receipt'))}
      </div>
      <details class="evidence-details">
        <summary>Runtime details</summary>
        <div class="context-stack compact-context">
          ${contextRow('Wallet', state.address ? short(state.address) : 'Not connected', state.address ? 'good' : '')}
          ${contextRow('Cluster', titleCaseCluster(state.cluster), state.cluster === 'mainnet-beta' ? 'warn' : '')}
          ${contextRow('Bridge', state.bridgeActive ? 'Ready' : 'Disconnected', state.bridgeActive ? 'good' : '')}
          ${contextRow('MCP inbox', `${state.preparedActions.filter((action) => !action.archived).length} action(s)`, state.preparedActions.length ? 'warn' : '')}
          ${contextRow('Agent proof', state.agentSignature ? short(state.agentSignature) : 'Unsigned')}
          ${contextRow('Last tx', state.txid ? short(state.txid) : latestConfirmedTx())}
          ${contextRow('Latest lab', latestLab ? short(latestLab.artifactHash) : 'No artifact')}
        </div>
      </details>
      <div class="custody-manifest">
        <h3>Signing boundary</h3>
        <p>Agents can prepare intent, policy, simulation, receipts, and transaction bytes. A wallet approval is still required before signing.</p>
      </div>
    </aside>
  `;
}

function requestContextDetails(): string {
  const latestLab = state.labArtifacts[0];
  const openApprovals = state.preparedActions.filter((action) => !action.archived).length;
  const hasRequestContext =
    Boolean(state.address) ||
    openApprovals > 0 ||
    Boolean(state.agentPlan) ||
    Boolean(state.agentSignature) ||
    Boolean(state.signature) ||
    Boolean(state.txid) ||
    Boolean(latestLab);

  if (!hasRequestContext) return '';

  return `
    <details class="panel public-request-context evidence-details">
      <summary>Request context</summary>
      <div class="evidence-rail" aria-label="Approval evidence">
        ${evidenceStep('Intent', evidenceIntent(), evidenceTone('intent'))}
        ${evidenceStep('Policy', evidencePolicy(), evidenceTone('policy'))}
        ${evidenceStep('Wallet', evidenceWallet(), evidenceTone('wallet'))}
        ${evidenceStep('Receipt', evidenceReceipt(latestLab), evidenceTone('receipt'))}
      </div>
      <div class="custody-manifest compact-manifest">
        <h3>Signing boundary</h3>
        <p>Agents can prepare intent, policy, simulation, receipts, and transaction bytes. A wallet approval is still required before signing.</p>
      </div>
    </details>
  `;
}

function bind(): void {
  bindRouteLinks();
  bindTemplatePicker();

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    button.addEventListener('click', () => {
      state.activeTab = button.dataset.tab as ActiveTab;
      if (state.activeTab === 'labs') {
        state.artifactView = 'create';
      }
      state.error = '';
      render();
    });
  }

  document.querySelector<HTMLButtonElement>('#discover')?.addEventListener('click', runDiscover);
  document.querySelector<HTMLButtonElement>('#connect')?.addEventListener('click', runConnect);
  document.querySelector<HTMLButtonElement>('#disconnect')?.addEventListener('click', runDisconnect);
  document.querySelector<HTMLButtonElement>('#iosReconnectCached')?.addEventListener('click', runReconnectIosCached);
  document.querySelector<HTMLButtonElement>('#iosClearTransient')?.addEventListener('click', runClearIosTransient);
  document.querySelector<HTMLButtonElement>('#iosFullReset')?.addEventListener('click', runClearIosFullReset);
  document.querySelector<HTMLButtonElement>('#iosClearAllAccounts')?.addEventListener('click', runClearIosAllAccounts);
  document.querySelector<HTMLButtonElement>('#signMessage')?.addEventListener('click', runSignMessage);
  document.querySelector<HTMLButtonElement>('#airdrop')?.addEventListener('click', runAirdrop);
  document.querySelector<HTMLButtonElement>('#createTx')?.addEventListener('click', runCreateDemoTransaction);
  document.querySelector<HTMLButtonElement>('#signTx')?.addEventListener('click', runSignTransaction);
  document.querySelector<HTMLButtonElement>('#sendTx')?.addEventListener('click', runSignAndSendTransaction);
  document.querySelector<HTMLButtonElement>('#generatePlan')?.addEventListener('click', runGenerateAgentPlan);
  document.querySelector<HTMLButtonElement>('#generateAiPlan')?.addEventListener('click', runGenerateAiPlan);
  document.querySelector<HTMLButtonElement>('#signAgentPlan')?.addEventListener('click', runSignAgentPlan);
  document.querySelector<HTMLButtonElement>('#queueAgentPlan')?.addEventListener('click', runQueueAgentPlan);
  document.querySelector<HTMLButtonElement>('#saveBridgeAiKey')?.addEventListener('click', runSaveBridgeAiKey);
  document.querySelector<HTMLButtonElement>('#clearAiKey')?.addEventListener('click', runClearAiKey);
  document.querySelector<HTMLButtonElement>('#refreshAiStatus')?.addEventListener('click', runRefreshAiStatus);
  document.querySelector<HTMLButtonElement>('#connectBridge')?.addEventListener('click', runConnectBridge);
  document.querySelector<HTMLButtonElement>('#disconnectBridge')?.addEventListener('click', runDisconnectBridge);
  document.querySelector<HTMLButtonElement>('#refreshInbox')?.addEventListener('click', runRefreshInbox);
  document.querySelector<HTMLButtonElement>('#createRecurring')?.addEventListener('click', runCreateRecurring);
  document.querySelector<HTMLButtonElement>('#createLabArtifact')?.addEventListener('click', runCreateLabArtifact);
  document.querySelector<HTMLButtonElement>('#refreshLabArtifacts')?.addEventListener('click', runRefreshLabArtifacts);
  document.querySelector<HTMLButtonElement>('#openAndroidMwaTest')?.addEventListener('click', openAndroidMwaTest);

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-start-action]')) {
    button.addEventListener('click', () => {
      if (button.dataset.startAction === 'discover') {
        void runDiscover();
      }
      if (button.dataset.startAction === 'connect') {
        void runConnect();
      }
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-demo-tab]')) {
    button.addEventListener('click', () => {
      const tab = button.dataset.demoTab as ActiveTab | undefined;
      if (!tab) return;
      state.activeTab = tab;
      if (tab === 'labs') {
        state.artifactView = 'create';
      }
      state.error = '';
      render();
      window.requestAnimationFrame(() => {
        document.querySelector('#demo-workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  document.querySelector<HTMLSelectElement>('#clusterSelect')?.addEventListener('change', (event) => {
    const cluster = (event.currentTarget as HTMLSelectElement).value;
    if (!isCluster(cluster)) return;
    state.cluster = cluster;
    resetWalletConnection();
    state.error = '';
    savePersistedState();
    render();
  });

  document.querySelector<HTMLSelectElement>('#walletSelect')?.addEventListener('change', (event) => {
    state.selectedWalletName = (event.currentTarget as HTMLSelectElement).value;
    resetWalletConnection();
    state.error = '';
    savePersistedState();
    render();
  });

  document.querySelector<HTMLSelectElement>('#iosWalletSelect')?.addEventListener('change', (event) => {
    const walletId = (event.currentTarget as HTMLSelectElement).value;
    if (!isIosNativeWalletId(walletId)) return;
    state.selectedIosWalletId = walletId;
    state.selectedWalletName = iosWalletLabel(walletId);
    resetWalletConnection();
    state.error = '';
    savePersistedState();
    render();
  });

  document.querySelector<HTMLInputElement>('#bridgeUrl')?.addEventListener('input', (event) => {
    state.bridgeUrl = (event.currentTarget as HTMLInputElement).value.trim();
    savePersistedState();
  });

  document.querySelector<HTMLInputElement>('#bridgeToken')?.addEventListener('input', (event) => {
    state.bridgeToken = (event.currentTarget as HTMLInputElement).value.trim();
    savePersistedState();
  });

  document.querySelector<HTMLTextAreaElement>('#agentPrompt')?.addEventListener('input', (event) => {
    state.agentPrompt = (event.currentTarget as HTMLTextAreaElement).value;
    state.agentPlan = null;
    state.agentSignature = '';
    state.agentPreparedActionId = '';
  });

  for (const fieldInput of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-template-field]')) {
    fieldInput.addEventListener('input', () => {
      const fieldId = fieldInput.dataset.templateField;
      if (!fieldId) return;
      state.templateFields[fieldId] = fieldInput.value;
      state.agentPlan = null;
      state.agentSignature = '';
      state.agentPreparedActionId = '';
    });
    fieldInput.addEventListener('change', () => {
      const fieldId = fieldInput.dataset.templateField;
      if (!fieldId) return;
      state.templateFields[fieldId] = fieldInput.value;
    });
  }

  document.querySelector<HTMLSelectElement>('#aiMode')?.addEventListener('change', (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    state.aiSettings.mode = value === 'session' || value === 'hosted' ? value : 'bridge';
    ensureAiProviderAllowedForMode();
    render();
  });

  document.querySelector<HTMLSelectElement>('#aiProvider')?.addEventListener('change', (event) => {
    const preset = aiProviderPresetById((event.currentTarget as HTMLSelectElement).value);
    state.aiSettings.provider = preset.id;
    state.aiSettings.apiFormat = preset.apiFormat;
    state.aiSettings.baseUrl = preset.baseUrl;
    state.aiSettings.model = preset.model;
    render();
  });

  document.querySelector<HTMLInputElement>('#aiBaseUrl')?.addEventListener('input', (event) => {
    state.aiSettings.baseUrl = (event.currentTarget as HTMLInputElement).value.trim();
    syncAiActionButtons();
  });

  document.querySelector<HTMLSelectElement>('#aiModelSelect')?.addEventListener('change', (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    state.aiSettings.model = value === CUSTOM_AI_MODEL_VALUE ? '' : value;
    render();
  });

  document.querySelector<HTMLInputElement>('#aiModelCustom')?.addEventListener('input', (event) => {
    state.aiSettings.model = (event.currentTarget as HTMLInputElement).value.trim();
    syncAiActionButtons();
  });

  document.querySelector<HTMLInputElement>('#aiApiKey')?.addEventListener('input', (event) => {
    state.aiSettings.apiKey = (event.currentTarget as HTMLInputElement).value;
    syncAiActionButtons();
  });

  document.querySelector<HTMLTextAreaElement>('#labInput')?.addEventListener('input', (event) => {
    state.labInputs[state.activeLab] = (event.currentTarget as HTMLTextAreaElement).value;
  });

  document.querySelector<HTMLSelectElement>('#labSelect')?.addEventListener('change', (event) => {
    state.activeLab = (event.currentTarget as HTMLSelectElement).value;
    state.error = '';
    render();
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-artifact-view]')) {
    button.addEventListener('click', () => {
      const view = button.dataset.artifactView;
      if (view !== 'create' && view !== 'signed') return;
      state.artifactView = view;
      state.error = '';
      render();
    });
  }

  document.querySelector<HTMLTextAreaElement>('#txInput')?.addEventListener('input', (event) => {
    state.customTransactionBase64 = (event.currentTarget as HTMLTextAreaElement).value.trim();
    state.txSignature = '';
    state.txid = '';
  });

  document.querySelector<HTMLSelectElement>('#inboxFilter')?.addEventListener('change', (event) => {
    state.inboxFilter = (event.currentTarget as HTMLSelectElement).value as InboxFilter;
    render();
  });

  document.querySelector<HTMLSelectElement>('#recurringCadence')?.addEventListener('change', (event) => {
    state.recurringDraft = readRecurringDraft();
    state.recurringDraft.cadence = (event.currentTarget as HTMLSelectElement).value as RecurringCadence;
    render();
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action-op]')) {
    button.addEventListener('click', () => {
      const actionId = button.dataset.actionId;
      const op = button.dataset.actionOp;
      if (!actionId || !op) return;
      void runPreparedActionOp(actionId, op);
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-recurring-op]')) {
    button.addEventListener('click', () => {
      const recurringId = button.dataset.recurringId;
      const op = button.dataset.recurringOp;
      if (!recurringId || !op) return;
      void runRecurringOp(recurringId, op);
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-lab]')) {
    button.addEventListener('click', () => {
      state.activeLab = button.dataset.lab ?? LABS[0]!.id;
      state.error = '';
      render();
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-runtime-path]')) {
    button.addEventListener('click', () => {
      const runtimePath = runtimePathById(button.dataset.runtimePath);
      if (!runtimePath) return;
      state.selectedRuntimePath = runtimePath.id;
      state.recentCopyId = '';
      state.error = '';
      render();
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
    button.addEventListener('click', async () => {
      const value = button.dataset.copy ?? '';
      const label = button.dataset.copyName ?? 'Value';
      const copyId = button.dataset.copyId ?? commandCopyId('copy', label, value);
      try {
        await navigator.clipboard.writeText(value);
        markCopied(copyId);
        pushToast('success', `${label} copied`, value);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Clipboard permission was denied.';
        pushToast('error', 'Copy failed', message);
      }
      render();
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-toast-dismiss]')) {
    button.addEventListener('click', () => dismissToast(Number(button.dataset.toastDismiss)));
  }
}

function bindRouteLinks(): void {
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    link.addEventListener('click', (event) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const url = new URL(link.href);
      if (url.origin !== window.location.origin) return;

      const route = normalizePathname(url.pathname);
      if (!isAppRoute(route)) return;

      event.preventDefault();
      if (route === '/mwa-test' && SHOW_ANDROID_EXAMPLE_TAB && agenticAndroidBridge()?.openMwaExample) {
        openAndroidMwaTest();
        return;
      }
      navigateTo(route);
    });
  }
}

function bindTemplatePicker(): void {
  const picker = document.querySelector<HTMLElement>('[data-template-picker]');
  if (!picker) return;
  const trigger = picker.querySelector<HTMLButtonElement>('#templatePickerButton');
  const menu = picker.querySelector<HTMLElement>('#templatePickerMenu');
  const options = [...picker.querySelectorAll<HTMLButtonElement>('[data-template-option]')];
  if (!trigger || !menu || options.length === 0) return;

  const openPicker = (focusOption: 'selected' | 'first' | 'last' | false = false): void => {
    if (trigger.disabled) return;
    closeTemplatePickerInteractions();
    picker.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    menu.hidden = false;
    positionTemplatePickerMenu(trigger, menu);
    window.requestAnimationFrame(() => positionTemplatePickerMenu(trigger, menu));

    const selectedOption = options.find((option) => option.dataset.templateOption === state.selectedTemplateId) ?? options[0]!;
    const activeOption = focusOption === 'first'
      ? options[0]!
      : focusOption === 'last'
        ? options[options.length - 1]!
        : selectedOption;
    setActiveTemplateOption(options, activeOption, Boolean(focusOption));

    templatePickerController = new AbortController();
    const { signal } = templatePickerController;
    window.addEventListener('pointerdown', (event) => {
      if (event.target instanceof Node && picker.contains(event.target)) return;
      closePicker(false);
    }, { signal });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePicker(true);
      }
    }, { signal });
    window.addEventListener('resize', () => positionTemplatePickerMenu(trigger, menu), { signal });
    window.visualViewport?.addEventListener('resize', () => positionTemplatePickerMenu(trigger, menu), { signal });
  };

  const closePicker = (returnFocus: boolean): void => {
    picker.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
    menu.hidden = true;
    closeTemplatePickerInteractions();
    if (returnFocus) {
      trigger.focus({ preventScroll: true });
    }
  };

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    if (menu.hidden) {
      openPicker(false);
    } else {
      closePicker(false);
    }
  });

  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openPicker('selected');
      focusAdjacentTemplateOption(options, 1);
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      openPicker('selected');
      focusAdjacentTemplateOption(options, -1);
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPicker('selected');
    }
  });

  menu.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusAdjacentTemplateOption(options, 1);
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusAdjacentTemplateOption(options, -1);
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActiveTemplateOption(options, options[0]!, true);
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActiveTemplateOption(options, options[options.length - 1]!, true);
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const activeOption = document.activeElement instanceof HTMLButtonElement
        ? document.activeElement
        : options.find((option) => option.classList.contains('active')) ?? options[0]!;
      const templateId = activeOption.dataset.templateOption;
      if (!templateId) return;
      if (!selectAgentTemplate(templateId)) {
        closePicker(true);
      }
    }
  });

  for (const option of options) {
    option.addEventListener('click', () => {
      const templateId = option.dataset.templateOption;
      if (!templateId) return;
      if (!selectAgentTemplate(templateId)) {
        closePicker(true);
      }
    });
    option.addEventListener('pointermove', () => setActiveTemplateOption(options, option, false));
  }
}

function closeTemplatePickerInteractions(): void {
  templatePickerController?.abort();
  templatePickerController = null;
}

function selectAgentTemplate(templateId: string): boolean {
  const template = templateById(templateId);
  if (template.id === state.selectedTemplateId) {
    return false;
  }
  state.selectedTemplateId = template.id;
  state.templateFields = {
    ...defaultTemplateFieldValues(template),
    ...state.templateFields,
  };
  state.agentPlan = null;
  state.agentSignature = '';
  state.agentPreparedActionId = '';
  render();
  return true;
}

function positionTemplatePickerMenu(trigger: HTMLElement, menu: HTMLElement): void {
  const viewport = window.visualViewport;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportWidth = viewport?.width ?? window.innerWidth;
  const triggerRect = trigger.getBoundingClientRect();
  const safeTop = viewportTop + 10;
  const spaceAbove = Math.max(0, Math.floor(triggerRect.top - safeTop - 8));
  const maxHeight = Math.min(420, spaceAbove);
  menu.style.setProperty('--template-menu-max-height', `${maxHeight}px`);
  menu.style.setProperty('--template-menu-max-width', `${Math.max(220, Math.floor(viewportWidth - 20))}px`);
}

function setActiveTemplateOption(
  options: HTMLButtonElement[],
  activeOption: HTMLButtonElement,
  focus: boolean,
): void {
  for (const option of options) {
    const active = option === activeOption;
    option.classList.toggle('active', active);
    option.tabIndex = active ? 0 : -1;
  }
  if (focus) {
    activeOption.focus({ preventScroll: true });
  }
  activeOption.scrollIntoView({ block: 'nearest' });
}

function focusAdjacentTemplateOption(options: HTMLButtonElement[], direction: 1 | -1): void {
  const currentIndex = options.findIndex((option) => option === document.activeElement || option.classList.contains('active'));
  const nextIndex = currentIndex < 0
    ? 0
    : (currentIndex + direction + options.length) % options.length;
  setActiveTemplateOption(options, options[nextIndex]!, true);
}

async function runDiscover(): Promise<void> {
  await run('discover', async () => {
    if (state.iosNativeEnvironment.isIosNative) {
      state.iosWallets = listIosNativeWalletOptions();
      await refreshIosNativeCacheState();
      state.iosNativeStatus = `${state.iosWallets.length} iOS wallet path(s) available. Cached authorizations: ${state.iosAuthCacheCount}.`;
      savePersistedState();
      pushToast('success', 'iOS wallets ready', `${state.iosWallets.length} wallet path(s) available.`);
      return;
    }
    state.wallets = [...listAvailableWallets()];
    if (!state.wallets.some((wallet) => wallet.name === state.selectedWalletName)) {
      state.selectedWalletName = state.wallets[0]?.name ?? '';
    }
    if (state.wallets.length === 0) {
      throw new Error('No Wallet Standard Solana wallets are registered in this browser.');
    }
    savePersistedState();
    pushToast('success', 'Wallets discovered', `${state.wallets.length} provider(s) found.`);
  });
}

async function runConnect(): Promise<void> {
  await run('connect', async () => {
    if (state.iosNativeEnvironment.isIosNative) {
      walletBackend = new IosNativeWalletBackend({
        walletId: state.selectedIosWalletId,
        cluster: state.cluster,
        appUrl: window.location.origin,
        rpcUrl: activeRpcUrl(),
        logLevel: 'info',
      });
      client = new SolanaSigningClient({ backend: walletBackend });
      state.address = await client.getAddress();
      state.capabilities = await client.capabilities();
      state.selectedWalletName = iosWalletLabel(state.selectedIosWalletId);
      state.iosNativeStatus = `iOS ${state.selectedWalletName} connected on ${state.cluster}.`;
      state.transactionStatus = `iOS wallet connected on ${state.cluster}.`;
      await refreshIosNativeCacheState();
      if (state.bridgeActive) {
        await connectBridgeHost();
      }
      savePersistedState();
      pushToast('success', 'iOS wallet connected', short(state.address));
      return;
    }
    const selected = selectedWallet();
    walletBackend = new WalletStandardWebBackend({
      wallet: selected,
      cluster: state.cluster,
      rpcUrl: activeRpcUrl(),
    });
    client = new SolanaSigningClient({ backend: walletBackend });
    state.address = await client.getAddress();
    state.capabilities = await client.capabilities();
    state.transactionStatus = `Wallet connected on ${state.cluster}.`;
    if (state.bridgeActive) {
      await connectBridgeHost();
    }
    savePersistedState();
    pushToast('success', 'Wallet connected', short(state.address));
  });
}

async function runDisconnect(): Promise<void> {
  await run('connect', async () => {
    if (state.bridgeActive) {
      await disconnectBridgeHost().catch(() => undefined);
    }
    await disconnectWalletBackend().catch(() => undefined);
    resetWalletConnection();
    await refreshIosNativeCacheState();
    pushToast('success', 'Wallet disconnected', 'Local signing session cleared.');
  });
}

async function runReconnectIosCached(): Promise<void> {
  await run('connect', async () => {
    assertIosNativeRuntime();
    const restored = await restoreLatestIosNativeWallet({
      cluster: state.cluster,
      appUrl: window.location.origin,
      rpcUrl: activeRpcUrl(),
      logLevel: 'info',
    });
    if (!restored) {
      throw new Error('No cached iOS wallet authorization is available. Connect once first.');
    }
    walletBackend = restored.backend;
    client = new SolanaSigningClient({ backend: walletBackend });
    state.address = restored.address;
    state.selectedIosWalletId = restored.walletId;
    state.selectedWalletName = restored.walletName;
    state.capabilities = await client.capabilities();
    state.iosAuthCacheCount = restored.cacheCount;
    state.iosNativeStatus = `Restored cached ${restored.walletName} authorization on ${state.cluster}.`;
    if (state.bridgeActive) {
      await connectBridgeHost();
    }
    savePersistedState();
    pushToast('success', 'iOS cache restored', short(state.address));
  });
}

async function runClearIosTransient(): Promise<void> {
  await run('connect', async () => {
    assertIosNativeRuntime();
    await iosBackendOrNew().clearTransientState('browser_demo');
    state.iosNativeStatus = 'iOS transient callback state cleared. Auth cache retained.';
    pushToast('success', 'iOS transient state cleared', 'Cached authorizations were retained.');
  });
}

async function runClearIosFullReset(): Promise<void> {
  await run('connect', async () => {
    assertIosNativeRuntime();
    if (state.bridgeActive) {
      await disconnectBridgeHost().catch(() => undefined);
    }
    await iosBackendOrNew().clearStateFullReset('browser_demo');
    resetWalletConnection();
    await refreshIosNativeCacheState();
    state.iosNativeStatus = 'iOS wallet state reset. Connect again to authorize.';
    pushToast('success', 'iOS wallet reset', 'Latest authorization cleared.');
  });
}

async function runClearIosAllAccounts(): Promise<void> {
  await run('connect', async () => {
    assertIosNativeRuntime();
    if (state.bridgeActive) {
      await disconnectBridgeHost().catch(() => undefined);
    }
    await iosBackendOrNew().clearAllCachedAuthorizations();
    resetWalletConnection();
    await refreshIosNativeCacheState();
    state.iosNativeStatus = 'All cached iOS wallet authorizations cleared.';
    pushToast('success', 'iOS auth cache cleared', 'All cached accounts were removed.');
  });
}

async function runSignMessage(): Promise<void> {
  await run('sign', async () => {
    const signingClient = requireClient();
    const result = await signingClient.signMessage(DEMO_MESSAGE, signOptions('Command center message signature'));
    state.signature = result.signature;
    pushToast('success', 'Message signed', short(result.signature));
  });
}

async function runAirdrop(): Promise<void> {
  await run('transaction', async () => {
    if (state.cluster !== 'devnet') {
      throw new Error('Devnet SOL is available only when the cluster is devnet.');
    }
    const publicKey = publicKeyFromConnectedWallet();
    state.transactionStatus = 'Requesting 1 devnet SOL from the Solana faucet...';
    render();

    const connection = new Connection(defaultRpcUrl('devnet'), 'confirmed');
    const signature = await connection.requestAirdrop(publicKey, 1_000_000_000);
    await connection.confirmTransaction(signature, 'confirmed');

    state.transactionStatus = `Airdrop confirmed: ${short(signature)}. Create and sign a demo transaction now.`;
    pushToast('success', 'Devnet SOL requested', short(signature));
  });
}

async function runCreateDemoTransaction(): Promise<void> {
  await run('transaction', async () => {
    if (state.cluster !== 'devnet') {
      throw new Error('The built-in memo transaction is devnet-only.');
    }
    const feePayer = publicKeyFromConnectedWallet();
    const connection = new Connection(defaultRpcUrl('devnet'), 'confirmed');
    const balance = await connection.getBalance(feePayer, 'confirmed');
    if (balance === 0) {
      state.transactionStatus = 'This devnet account has 0 SOL. Request devnet SOL before signing the demo transaction.';
      throw new Error('Not enough devnet SOL for transaction fees. Click Request devnet SOL, then try again.');
    }

    const { blockhash } = await connection.getLatestBlockhash();
    const tx = new Transaction({
      feePayer,
      recentBlockhash: blockhash,
    }).add(
      new TransactionInstruction({
        keys: [{ pubkey: feePayer, isSigner: true, isWritable: false }],
        programId: MEMO_PROGRAM_ID,
        data: new TextEncoder().encode(DEMO_MEMO) as unknown as InstructionData,
      }),
    );

    state.customTransactionBase64 = encodeBase64(
      tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      }),
    );
    state.txSignature = '';
    state.txid = '';
    state.transactionStatus = 'Demo transaction created. Sign it without broadcasting, or sign and send it on devnet.';
    pushToast('success', 'Transaction created', 'Demo transaction ready.');
  });
}

async function runSignTransaction(): Promise<void> {
  await run('transaction', async () => {
    const signingClient = requireClient();
    state.transactionStatus = 'Opening wallet approval for transaction signature...';
    const result = await signingClient.signTransaction(
      state.customTransactionBase64,
      signOptions('Transaction signature request'),
    );
    state.txSignature = result.signature;
    state.txid = '';
    state.transactionStatus = 'Transaction signed by wallet. The signed transaction bytes were not broadcast.';
    pushToast('success', 'Transaction signed', 'Signed bytes returned.');
  });
}

async function runSignAndSendTransaction(): Promise<void> {
  await run('transaction', async () => {
    const signingClient = requireClient();
    if (!state.capabilities?.supports.signAndSendTransaction) {
      throw new Error('Selected wallet does not support sign and send.');
    }

    state.transactionStatus = `Opening wallet approval to sign and send on ${state.cluster}...`;
    const result = await signingClient.signAndSendTransaction(
      state.customTransactionBase64,
      signOptions('Transaction broadcast request'),
    );
    state.txid = result.txid ?? result.signature;
    state.txSignature = '';
    state.transactionStatus = 'Transaction sent. The transaction id is shown below.';
    pushToast('success', 'Transaction sent', short(state.txid));
  });
}

async function runGenerateAgentPlan(): Promise<void> {
  await run('sign', async () => {
    const template = selectedTemplate();
    const parameters = readTemplateFields(template);
    assertRequiredTemplateFields(template, parameters);
    const userNotes = state.agentPrompt.trim();
    assertRequiredUserNotes(template, userNotes);
    state.agentPlan = buildTemplatePlan(template, parameters, 'template', userNotes);
    state.agentSignature = '';
    state.agentPreparedActionId = '';
    pushToast('success', 'Template plan generated', `${template.title} is ready for review.`);
  });
}

async function runGenerateAiPlan(): Promise<void> {
  await run('ai', async () => {
    const template = selectedTemplate();
    const parameters = readTemplateFields(template);
    assertRequiredTemplateFields(template, parameters);
    const userNotes = state.agentPrompt.trim();
    assertRequiredUserNotes(template, userNotes);
    const request = {
      prompt: userNotes || template.description,
      userNotes,
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
    if (state.aiSettings.mode === 'bridge') {
      state.agentPlan = await bridgeRequest<AgentPlan>('/bridge/ai/generate-plan', {
        method: 'POST',
        body: JSON.stringify(request),
      });
    } else if (state.aiSettings.mode === 'hosted') {
      state.agentPlan = await generateHostedAiPlan(state.aiSettings, request);
    } else {
      state.agentPlan = await generateSessionAiPlan(state.aiSettings, request);
    }
    state.agentSignature = '';
    state.agentPreparedActionId = '';
    pushToast('success', 'AI plan generated', `${state.agentPlan.templateTitle} is ready for wallet review.`);
  });
}

async function runSignAgentPlan(): Promise<void> {
  await run('sign', async () => {
    const signingClient = requireClient();
    if (!state.agentPlan) {
      throw new Error('Generate an agent plan before signing.');
    }
    const message = [
      'Solana Agent Wallet Adapter agent approval',
      `Address: ${state.address}`,
      `Cluster: ${state.cluster}`,
      `Source: ${state.agentPlan.source}`,
      `Template: ${state.agentPlan.templateTitle}`,
      `Action: ${state.agentPlan.actionType}`,
      `Prepared by: ${planPreparedBy(state.agentPlan)}`,
      `Intent: ${state.agentPlan.intent}`,
      `Route: ${state.agentPlan.route}`,
      `Risk: ${state.agentPlan.risk}`,
      `Approval: ${state.agentPlan.approval}`,
      `Parameters: ${stableJson(state.agentPlan.parameters)}`,
      `User notes: ${state.agentPlan.userNotes || 'None'}`,
      `Safeguards: ${state.agentPlan.safeguards.join(' | ')}`,
      `Time: ${new Date().toISOString()}`,
    ].join('\n');
    const result = await signingClient.signMessage(message, signOptions('Agent plan approval proof'));
    state.agentSignature = result.signature;
    pushToast('success', 'Agent approval signed', short(result.signature));
  });
}

async function runQueueAgentPlan(): Promise<void> {
  await run('inbox', async () => {
    if (!state.agentPlan) {
      throw new Error('Generate an agent plan before queueing.');
    }
    const response = await queuePlanThroughBridge(state.agentPlan);
    state.agentPreparedActionId = response.id;
    state.activeTab = 'inbox';
    state.inboxFilter = 'ready';
    await refreshInboxData();
    pushToast('success', 'Prepared action queued', response.id);
  });
}

async function runSaveBridgeAiKey(): Promise<void> {
  await run('ai', async () => {
    await bridgeRequest('/bridge/ai/session-key', {
      method: 'POST',
      body: JSON.stringify({
        apiKey: state.aiSettings.apiKey,
        baseUrl: state.aiSettings.baseUrl,
        model: state.aiSettings.model,
        provider: state.aiSettings.provider,
        apiFormat: state.aiSettings.apiFormat,
      }),
    });
    state.aiSettings.apiKey = '';
    await refreshBridgeAiStatus(true);
    pushToast('success', 'Bridge AI key set', 'The key is held only in the local bridge process memory.');
  });
}

async function runClearAiKey(): Promise<void> {
  await run('ai', async () => {
    state.aiSettings.apiKey = '';
    if (state.aiSettings.mode === 'bridge') {
      await bridgeRequest('/bridge/ai/session-key', {
        method: 'POST',
        body: JSON.stringify({ clear: true }),
      }).catch(() => undefined);
      await refreshBridgeAiStatus(false);
    }
    pushToast('success', 'AI key cleared', aiClearMessage());
  });
}

async function runRefreshAiStatus(): Promise<void> {
  await run('ai', async () => {
    await refreshBridgeAiStatus(true);
    pushToast('success', 'AI status refreshed', state.aiStatus?.available ? 'Bridge AI is available.' : 'Bridge AI is not configured.');
  });
}

function aiClearMessage(): string {
  if (state.aiSettings.mode === 'hosted') {
    return 'Hosted BYOK key removed from this browser session.';
  }
  if (state.aiSettings.mode === 'session') {
    return 'Browser session key removed from this app.';
  }
  return 'Session key removed from this app and local bridge memory.';
}

async function runConnectBridge(): Promise<void> {
  await run('bridge', async () => {
    state.bridgeUrl = inputValue('#bridgeUrl') || state.bridgeUrl;
    state.bridgeToken = inputValue('#bridgeToken') || state.bridgeToken;
    await loadBridgeConfig(true);
    await connectBridgeHost();
    state.bridgeActive = true;
    state.bridgeStatus = 'Connected to local bridge. Waiting for agent requests.';
    startBridgePolling();
    await Promise.all([refreshInboxData(), refreshHealth(), refreshBalances().catch(() => undefined), syncLabArtifactsWithBridge()]);
    savePersistedState();
    pushToast('success', 'Bridge connected', bridgeHostLabel());
  });
}

async function runDisconnectBridge(): Promise<void> {
  await run('bridge', async () => {
    await disconnectBridgeHost();
    state.bridgeActive = false;
    state.bridgeStatus = 'Bridge disconnected.';
    stopBridgePolling();
    pushToast('success', 'Bridge disconnected', 'Local approval host stopped polling.');
  });
}

async function runRefreshInbox(): Promise<void> {
  await run('inbox', async () => {
    await Promise.all([refreshInboxData(), refreshHealth(), refreshBalances().catch(() => undefined), syncLabArtifactsWithBridge()]);
    pushToast('success', 'Inbox refreshed', `${state.preparedActions.length} action(s) loaded.`);
  });
}

async function runCreateRecurring(): Promise<void> {
  await run('inbox', async () => {
    state.recurringDraft = readRecurringDraft();
    const body = recurringBody(state.recurringDraft);
    await bridgeRequest('/bridge/recurring-payments', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    state.activeTab = 'schedule';
    await refreshInboxData();
    pushToast('success', 'Recurring approval created', `${body.amount} ${body.token}`);
  });
}

async function runPreparedActionOp(actionId: string, op: string): Promise<void> {
  if (op === 'copy') {
    const action = state.preparedActions.find((candidate) => candidate.id === actionId);
    if (action) {
      await navigator.clipboard.writeText(stableJson(action));
      pushToast('success', 'Receipt copied', actionId);
    }
    return;
  }

  await run('inbox', async () => {
    switch (op) {
      case 'execute':
        await bridgeRequest('/bridge/prepared-actions/execute', {
          method: 'POST',
          body: JSON.stringify({ actionId }),
        });
        pushToast('success', 'Wallet approval complete', actionId);
        break;
      case 'reject':
        await bridgeRequest('/bridge/prepared-actions/reject', {
          method: 'POST',
          body: JSON.stringify({ actionId, reason: 'Rejected in browser wallet UI.' }),
        });
        pushToast('success', 'Prepared action rejected', actionId);
        break;
      case 'archive':
        await bridgeRequest('/bridge/prepared-actions/archive', {
          method: 'POST',
          body: JSON.stringify({ actionId }),
        });
        pushToast('success', 'Prepared action archived', actionId);
        break;
      case 'delete':
        await bridgeRequest('/bridge/prepared-actions/delete', {
          method: 'POST',
          body: JSON.stringify({ actionId }),
        });
        pushToast('success', 'Prepared action deleted', actionId);
        break;
      default:
        throw new Error(`Unknown action operation: ${op}`);
    }
    await refreshInboxData();
  });
}

async function runRecurringOp(recurringId: string, op: string): Promise<void> {
  await run('inbox', async () => {
    const path =
      op === 'pause'
        ? '/bridge/recurring-payments/pause'
        : op === 'resume'
          ? '/bridge/recurring-payments/resume'
          : op === 'delete'
            ? '/bridge/recurring-payments/delete'
            : '';
    if (!path) {
      throw new Error(`Unknown recurring operation: ${op}`);
    }
    await bridgeRequest(path, {
      method: 'POST',
      body: JSON.stringify({ recurringId }),
    });
    await refreshInboxData();
    pushToast('success', `Recurring ${op}`, recurringId);
  });
}

async function runCreateLabArtifact(): Promise<void> {
  await run('lab', async () => {
    const signingClient = requireClient();
    const lab = activeLab();
    const input = labInput(lab.id).trim() || lab.defaultInput;
    const createdAt = new Date().toISOString();
    const payload = await labPayload(lab.id, input, createdAt);
    const id = newId(lab.id.slice(0, 3).replace(/[^a-z]/g, '') || 'lab');
    const unsigned = {
      version: 'labs-ui-v1',
      id,
      labId: lab.id,
      kind: lab.kind,
      createdAt,
      walletAddress: state.address,
      cluster: state.cluster,
      title: lab.title,
      input,
      payload,
    };
    const preSignatureHash = await sha256(stableJson(unsigned));
    const signingMessage = [
      'Solana Agent Wallet Adapter',
      `Lab: ${lab.title}`,
      `Artifact: ${id}`,
      `Wallet: ${state.address}`,
      `Cluster: ${state.cluster}`,
      `Hash: ${preSignatureHash}`,
    ].join('\n');
    const result = await signingClient.signMessage(signingMessage, signOptions(`${lab.title} artifact`));
    const verified = verifyMessageSignature(signingMessage, result.signature);
    const artifactBase = {
      ...unsigned,
      preSignatureHash,
      signingMessage,
      signature: result.signature,
      verified,
    };
    const artifact: LabArtifact = {
      ...artifactBase,
      artifactHash: await sha256(stableJson(artifactBase)),
    };
    const savedToBridge = await archiveLabArtifact(artifact);
    pushToast(
      'success',
      `${lab.title} signed`,
      savedToBridge ? 'Saved locally and to the bridge archive.' : 'Saved to the local device archive.',
    );
  });
}

async function runRefreshLabArtifacts(): Promise<void> {
  await run('lab', async () => {
    await hydrateLabArtifactArchive();
    if (state.bridgeActive) {
      await syncLabArtifactsWithBridge();
    }
    pushToast('success', 'Artifacts refreshed', `${state.labArtifacts.length} artifact(s) loaded.`);
  });
}

async function run(stepName: StepName, action: () => Promise<void>): Promise<void> {
  state.error = '';
  state.busy = true;
  state.steps[stepName] = 'active';
  render();
  try {
    await action();
    state.steps[stepName] = 'done';
  } catch (err) {
    state.steps[stepName] = 'error';
    state.error = redactSecrets(err instanceof Error ? err.message : String(err));
    pushToast('error', 'Action failed', state.error);
  } finally {
    state.busy = false;
    render();
  }
}

async function archiveLabArtifact(artifact: LabArtifact): Promise<boolean> {
  state.labArtifacts = mergeLabArtifacts([artifact], state.labArtifacts);
  await saveLabArtifacts();
  if (!state.bridgeActive) {
    return false;
  }
  try {
    await saveBridgeLabArtifact(artifact);
    return true;
  } catch (err) {
    state.bridgeStatus = `Artifact bridge archive failed: ${err instanceof Error ? err.message : String(err)}`;
    return false;
  }
}

async function syncLabArtifactsWithBridge(): Promise<void> {
  if (!state.bridgeActive) return;
  try {
    const remote = await loadBridgeLabArtifacts();
    const local = state.labArtifacts;
    const remoteIds = new Set(remote.map((artifact) => artifact.id));
    const missingRemote = local.filter((artifact) => !remoteIds.has(artifact.id));
    for (const artifact of missingRemote) {
      await saveBridgeLabArtifact(artifact);
    }
    state.labArtifacts = mergeLabArtifacts(remote, local);
    await saveLabArtifacts();
    state.labArchiveStatus = 'Browser archive synced with bridge.';
  } catch (err) {
    state.bridgeStatus = `Artifact bridge archive unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function loadBridgeLabArtifacts(): Promise<LabArtifact[]> {
  const response = await bridgeRequest<{ artifacts?: unknown[] }>('/bridge/lab-artifacts');
  return mergeLabArtifacts(Array.isArray(response.artifacts) ? response.artifacts.filter(isLabArtifact) : []);
}

async function saveBridgeLabArtifact(artifact: LabArtifact): Promise<void> {
  await bridgeRequest('/bridge/lab-artifacts', {
    method: 'POST',
    body: JSON.stringify({ artifact }),
  });
}

async function refreshInboxData(): Promise<void> {
  const [actionsResponse, recurringResponse, receiptsResponse, txResponse] = await Promise.all([
    bridgeRequest<{ materialized?: PreparedAction[]; actions?: PreparedAction[] }>('/bridge/prepared-actions'),
    bridgeRequest<{ recurringPayments?: RecurringPayment[] }>('/bridge/recurring-payments'),
    bridgeRequest<{ receipts?: ActionReceipt[] }>('/bridge/receipts'),
    bridgeRequest<{ updates?: unknown[]; actions?: PreparedAction[] }>('/bridge/prepared-actions/tx-status').catch(() => null),
  ]);
  state.materializedActions = actionsResponse.materialized ?? [];
  state.preparedActions = txResponse?.actions ?? actionsResponse.actions ?? [];
  state.recurringPayments = recurringResponse.recurringPayments ?? [];
  state.receipts = receiptsResponse.receipts ?? [];
}

async function refreshHealth(): Promise<void> {
  state.health = await bridgeRequest<BridgeHealth>('/bridge/health');
}

async function refreshBalances(): Promise<void> {
  state.balances = await bridgeRequest<BalanceView>('/bridge/action/balances');
}

async function loadBridgeConfig(strict: boolean): Promise<void> {
  try {
    const config = await bridgeRequest<{ cluster: Cluster; rpcUrl: string }>('/bridge/config');
    if (!isCluster(config.cluster) || !config.rpcUrl) {
      throw new Error('Local bridge returned an invalid runtime config.');
    }
    state.cluster = config.cluster;
    state.bridgeRpcUrl = config.rpcUrl;
    savePersistedState();
  } catch (err) {
    state.bridgeRpcUrl = '';
    if (strict) {
      throw err;
    }
  }
}

async function connectBridgeHost(): Promise<void> {
  if (!state.address || !state.capabilities) {
    throw new Error('Connect a wallet before connecting the bridge.');
  }
  await bridgeRequest('/bridge/connect', {
    method: 'POST',
    body: JSON.stringify({
      address: state.address,
      capabilities: state.capabilities,
    }),
  });
  await bridgeTrace('browser.bridge.connected', {
    address: state.address,
    cluster: state.cluster,
    rpcHost: state.bridgeRpcUrl ? bridgeHostLabel() : null,
  });
}

async function disconnectBridgeHost(): Promise<void> {
  await bridgeRequest('/bridge/disconnect', { method: 'POST' }).catch(() => undefined);
}

function startBridgePolling(): void {
  stopBridgePolling();
  bridgePollTimer = window.setInterval(() => {
    void pollBridge();
  }, 1000);
  void pollBridge();
}

function stopBridgePolling(): void {
  if (bridgePollTimer !== null) {
    window.clearInterval(bridgePollTimer);
    bridgePollTimer = null;
  }
}

async function pollBridge(): Promise<void> {
  if (!state.bridgeActive || !client || bridgeRequestBusy) {
    return;
  }
  try {
    const response = await bridgeRequest<{ request: SigningRequest | null }>('/bridge/next');
    if (response.request) {
      bridgeRequestBusy = true;
      await handleBridgeSigningRequest(response.request);
      return;
    }
    const now = Date.now();
    if ((state.activeTab === 'inbox' || state.activeTab === 'schedule') && now - lastPassiveInboxRefresh > 5000) {
      lastPassiveInboxRefresh = now;
      await refreshInboxData().catch(() => undefined);
      render();
    }
  } catch (err) {
    state.bridgeStatus = err instanceof Error ? err.message : String(err);
    render();
  } finally {
    bridgeRequestBusy = false;
  }
}

async function handleBridgeSigningRequest(request: SigningRequest): Promise<void> {
  const signingClient = requireClient();
  state.bridgeStatus = `Opening wallet for ${request.kind}: ${request.display?.summary ?? request.id}`;
  await bridgeTrace('browser.approval.start', {
    requestId: request.id,
    kind: request.kind,
    cluster: request.cluster,
    summary: request.display?.summary,
  });
  render();

  try {
    let result: SigningResult;
    switch (request.kind) {
      case 'sign_message':
        result = await signingClient.signMessage(request.payload.data, requestSignOptions(request));
        break;
      case 'sign_transaction':
        result = await signingClient.signTransaction(request.payload.data, requestSignOptions(request));
        break;
      case 'sign_and_send_transaction':
        result = await signingClient.signAndSendTransaction(request.payload.data, requestSignOptions(request));
        break;
    }

    await bridgeRequest('/bridge/resolve', {
      method: 'POST',
      body: JSON.stringify({
        requestId: request.id,
        signature: result.signature,
        ...(result.txid !== undefined && { txid: result.txid }),
      }),
    });
    state.bridgeStatus = `Approved ${request.kind}: ${short(result.txid ?? result.signature)}`;
    await bridgeTrace('browser.approval.success', {
      requestId: request.id,
      kind: request.kind,
      signature: result.signature,
      txid: result.txid,
    });
    pushToast('success', 'Bridge request approved', short(result.txid ?? result.signature));
  } catch (err) {
    const error = toProtocolErrorPayload(err);
    await bridgeRequest('/bridge/reject', {
      method: 'POST',
      body: JSON.stringify({ requestId: request.id, error }),
    }).catch(() => undefined);
    state.bridgeStatus = `Rejected ${request.kind}: ${error.message}`;
    await bridgeTrace('browser.approval.error', {
      requestId: request.id,
      kind: request.kind,
      code: error.code,
      message: error.message,
    });
    pushToast('error', 'Bridge request failed', error.message);
  } finally {
    await refreshInboxData().catch(() => undefined);
    render();
  }
}

async function bridgeTrace(event: string, payload: Record<string, unknown>): Promise<void> {
  if (!state.bridgeToken) return;
  await bridgeRequest('/bridge/trace', {
    method: 'POST',
    body: JSON.stringify({ event, payload }),
  }).catch(() => undefined);
}

async function refreshBridgeAiStatus(strict: boolean): Promise<void> {
  try {
    state.aiStatus = await bridgeRequest<BridgeAiStatus>('/bridge/ai/status');
  } catch (err) {
    state.aiStatus = null;
    if (strict) {
      throw err;
    }
  }
}

function selectedTemplate(): AgentPlanTemplate {
  return templateById(state.selectedTemplateId);
}

function readTemplateFields(template = selectedTemplate()): Record<string, string> {
  const current = { ...defaultTemplateFieldValues(template), ...state.templateFields };
  for (const input of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-template-field]')) {
    const fieldId = input.dataset.templateField;
    if (fieldId) {
      current[fieldId] = input.value;
    }
  }
  state.templateFields = current;
  return current;
}

function templateFieldValue(fieldId: string): string {
  const template = selectedTemplate();
  return state.templateFields[fieldId] ?? defaultTemplateFieldValues(template)[fieldId] ?? '';
}

function assertRequiredTemplateFields(template: AgentPlanTemplate, parameters: Record<string, string>): void {
  const missing = template.fields
    .filter((fieldDef) => fieldDef.required && !parameters[fieldDef.id]?.trim())
    .map((fieldDef) => fieldDef.label);
  if (missing.length > 0) {
    throw new Error(`Complete required planner fields: ${missing.join(', ')}.`);
  }
}

function templateRequiresUserNotes(template: AgentPlanTemplate): boolean {
  return template.id === 'custom-request';
}

function assertRequiredUserNotes(template: AgentPlanTemplate, userNotes: string): void {
  if (templateRequiresUserNotes(template) && !userNotes.trim()) {
    throw new Error('Describe the custom request before generating this plan.');
  }
}

function canQueueAgentPlan(plan: AgentPlan): boolean {
  return ['transfer_sol', 'transfer_spl', 'swap', 'recurring_payment'].includes(plan.actionType);
}

function queuePlanTitle(): string {
  if (!state.address) return 'Connect a wallet before queueing.';
  if (!state.bridgeActive) return 'Templates can be signed directly. Connect the local bridge only to queue approvals into the inbox.';
  if (!state.agentPlan) return 'Generate a plan before queueing.';
  if (!canQueueAgentPlan(state.agentPlan)) return 'Queueing is available for transfer, swap, and recurring payment templates.';
  return 'Queue this plan in the local bridge approval inbox.';
}

async function queuePlanThroughBridge(plan: AgentPlan): Promise<{ id: string }> {
  const note = plan.intent.slice(0, 500);
  switch (plan.actionType) {
    case 'transfer_sol': {
      const response = await bridgeRequest<{ preparedAction: PreparedAction }>('/bridge/action/prepare-transfer-sol', {
        method: 'POST',
        body: JSON.stringify({
          recipient: requiredPlanParam(plan, 'recipient'),
          amountSol: requiredPlanParam(plan, 'amount'),
          note,
        }),
      });
      return { id: response.preparedAction.id };
    }
    case 'transfer_spl': {
      const response = await bridgeRequest<{ preparedAction: PreparedAction }>('/bridge/action/prepare-transfer-spl', {
        method: 'POST',
        body: JSON.stringify({
          token: requiredPlanParam(plan, 'token'),
          recipient: requiredPlanParam(plan, 'recipient'),
          amount: requiredPlanParam(plan, 'amount'),
          note,
        }),
      });
      return { id: response.preparedAction.id };
    }
    case 'swap': {
      const slippageBps = Number(plan.parameters.slippageBps || '50');
      const response = await bridgeRequest<{ preparedAction: PreparedAction }>('/bridge/action/prepare-swap', {
        method: 'POST',
        body: JSON.stringify({
          inputToken: plan.parameters.inputToken || 'SOL',
          outputToken: plan.parameters.outputToken || 'USDC',
          amount: requiredPlanParam(plan, 'amount'),
          slippageBps: Number.isFinite(slippageBps) ? slippageBps : 50,
          note,
        }),
      });
      return { id: response.preparedAction.id };
    }
    case 'recurring_payment': {
      const response = await bridgeRequest<{ recurringPayment?: { id: string }; payment?: { id: string } }>('/bridge/recurring-payments', {
        method: 'POST',
        body: JSON.stringify({
          token: requiredPlanParam(plan, 'token'),
          recipient: requiredPlanParam(plan, 'recipient'),
          amount: requiredPlanParam(plan, 'amount'),
          ...recurringSchedulePayload(plan),
          note,
        }),
      });
      return { id: response.recurringPayment?.id ?? response.payment?.id ?? 'recurring-payment' };
    }
    default:
      throw new Error('This plan type creates a review/proof only and cannot be queued as a bridge action yet.');
  }
}

function recurringSchedulePayload(plan: AgentPlan): {
  cadence: RecurringCadence;
  dayOfWeek?: number;
  dayOfMonth?: number;
  intervalDays?: number;
  intervalHours?: number;
  intervalMinutes?: number;
  localTime?: string;
  startAt?: string;
} {
  const cadence = parseRecurringCadence(plan.parameters.cadence);
  const localTime = plan.parameters.localTime?.trim() || '09:00';
  switch (cadence) {
    case 'weekly':
      return {
        cadence,
        dayOfWeek: planIntegerParam(plan, 'dayOfWeek', 1, 0, 6),
        localTime,
      };
    case 'monthly':
      return {
        cadence,
        dayOfMonth: planIntegerParam(plan, 'dayOfMonth', 1, 1, 31),
        localTime,
      };
    case 'interval_days':
      return {
        cadence,
        intervalDays: planIntegerParam(plan, 'intervalDays', 7, 1, 365),
        startAt: plan.parameters.startAt?.trim() || nextScheduleStartIso(),
      };
    case 'interval_hours':
      return {
        cadence,
        intervalHours: planIntegerParam(plan, 'intervalHours', 24, 1, 8760),
        startAt: plan.parameters.startAt?.trim() || nextScheduleStartIso(),
      };
    case 'interval_minutes':
      return {
        cadence,
        intervalMinutes: planIntegerParam(plan, 'intervalMinutes', 60, 1, 525600),
        startAt: plan.parameters.startAt?.trim() || nextScheduleStartIso(),
      };
  }
}

function parseRecurringCadence(value: string | undefined): RecurringCadence {
  const normalized = value?.trim();
  if (
    normalized === 'weekly' ||
    normalized === 'monthly' ||
    normalized === 'interval_days' ||
    normalized === 'interval_hours' ||
    normalized === 'interval_minutes'
  ) {
    return normalized;
  }
  return 'weekly';
}

function planIntegerParam(plan: AgentPlan, id: string, fallback: number, min: number, max: number): number {
  const parsed = Number(plan.parameters[id]);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

function nextScheduleStartIso(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

function requiredPlanParam(plan: AgentPlan, id: string): string {
  const value = plan.parameters[id]?.trim();
  if (!value) {
    throw new Error(`Plan is missing ${templateFieldLabel(templateById(state.selectedTemplateId), id)}.`);
  }
  return value;
}

async function bridgeRequest<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  if (!state.bridgeToken) {
    throw new Error('Bridge token is required.');
  }
  const url = new URL(path, bridgeBaseUrl());
  const headers = new Headers(init?.headers);
  headers.set('x-agent-wallet-token', state.bridgeToken);
  if (init?.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(url, {
    ...init,
    headers,
  });
  const payload = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const error = extractBridgeError(payload);
    if (response.status === 401) {
      throw new Error('Wrong bridge token. Use the token printed by the bridge process.');
    }
    throw new Error(error);
  }
  return payload as T;
}

function selectedWallet(): DiscoveredWallet {
  const wallet = state.wallets.find((candidate) => candidate.name === state.selectedWalletName);
  if (!wallet) {
    throw new Error('Select a wallet first.');
  }
  return wallet;
}

async function restoreIosNativeSession(): Promise<void> {
  const restored = await restoreLatestIosNativeWallet({
    cluster: state.cluster,
    appUrl: window.location.origin,
    rpcUrl: activeRpcUrl(),
    logLevel: 'info',
  });
  if (!restored) {
    state.iosNativeStatus = 'No cached iOS authorization found.';
    return;
  }
  walletBackend = restored.backend;
  client = new SolanaSigningClient({ backend: walletBackend });
  state.address = restored.address;
  state.selectedIosWalletId = restored.walletId;
  state.selectedWalletName = restored.walletName;
  state.capabilities = await client.capabilities();
  state.iosAuthCacheCount = restored.cacheCount;
  state.iosNativeStatus = `Restored cached ${restored.walletName} authorization on ${state.cluster}.`;
}

async function refreshIosNativeCacheState(): Promise<void> {
  if (!state.iosNativeEnvironment.isIos) {
    return;
  }
  const summary = await iosNativeCacheSummary().catch(() => ({ count: 0 }));
  state.iosAuthCacheCount = summary.count;
}

function iosBackendOrNew(): IosNativeMaintenanceBackend {
  const candidate = walletBackend as Partial<IosNativeMaintenanceBackend> | null;
  if (
    candidate?.clearTransientState &&
    candidate.clearStateFullReset &&
    candidate.clearAllCachedAuthorizations
  ) {
    return candidate as IosNativeMaintenanceBackend;
  }
  return new IosNativeWalletBackend({
    walletId: state.selectedIosWalletId,
    cluster: state.cluster,
    appUrl: window.location.origin,
    rpcUrl: activeRpcUrl(),
    logLevel: 'info',
  });
}

async function disconnectWalletBackend(): Promise<void> {
  const disconnectable = walletBackend as (WalletBackend & { disconnect?: () => Promise<void> }) | null;
  await disconnectable?.disconnect?.();
}

function assertIosNativeRuntime(): void {
  if (!state.iosNativeEnvironment.isIosNative) {
    throw new Error('iOS native wallet controls are available only inside the Capacitor iOS app.');
  }
}

function requireClient(): SolanaSigningClient {
  if (!client) {
    throw new Error('Connect a wallet before requesting a signature.');
  }
  return client;
}

function canSignAndSend(): boolean {
  return Boolean(
    state.address &&
      state.customTransactionBase64 &&
      !state.busy &&
      state.capabilities?.supports.signAndSendTransaction,
  );
}

function publicKeyFromConnectedWallet(): PublicKey {
  try {
    return new PublicKey(state.address);
  } catch {
    throw new Error('Connected wallet address is not a valid Solana public key.');
  }
}

function resetWalletConnection(): void {
  client = null;
  walletBackend = null;
  state.activeTab = defaultWorkspaceTab;
  state.address = '';
  state.signature = '';
  state.txSignature = '';
  state.txid = '';
  state.customTransactionBase64 = '';
  state.transactionStatus = '';
  state.agentPlan = null;
  state.agentSignature = '';
  state.agentPreparedActionId = '';
  state.capabilities = null;
  state.bridgeActive = false;
  state.bridgeStatus = 'Bridge idle.';
  stopBridgePolling();
  state.steps.connect = 'idle';
  state.steps.sign = 'idle';
  state.steps.transaction = 'idle';
  state.steps.bridge = 'idle';
}

function discoveredSelectedWalletName(): string {
  return state.wallets.some((wallet) => wallet.name === state.selectedWalletName) ? state.selectedWalletName : '';
}

interface WalletIdentity {
  icon: string;
  title: string;
  summary: string;
  detail: string;
  logoId?: BrandLogoId;
  discoveredWallet?: DiscoveredWallet;
}

function walletIdentity(): WalletIdentity {
  const liveSelectedName = discoveredSelectedWalletName();
  const providerCount = state.wallets.length;
  if (state.address) {
    const name = liveSelectedName || state.selectedWalletName || 'Connected wallet';
    return {
      icon: providerInitials(name),
      logoId: walletLogoIdForName(name),
      discoveredWallet: discoveredWalletByName(name),
      title: name,
      summary: short(state.address),
      detail: `${titleCaseCluster(state.cluster)} signer`,
    };
  }
  if (state.iosNativeEnvironment.isIosNative) {
    const name = iosWalletLabel(state.selectedIosWalletId);
    return {
      icon: providerInitials(name),
      logoId: walletLogoIdForName(name),
      title: 'iOS wallet standby',
      summary: name,
      detail: state.iosAuthCacheCount > 0 ? `${state.iosAuthCacheCount} cached authorization(s)` : 'Encrypted links and WalletConnect ready',
    };
  }
  if (providerCount > 0 && liveSelectedName) {
    return {
      icon: providerInitials(liveSelectedName),
      logoId: walletLogoIdForName(liveSelectedName),
      discoveredWallet: discoveredWalletByName(liveSelectedName),
      title: 'Wallet standby',
      summary: liveSelectedName,
      detail: `${providerCount} provider(s) discovered`,
    };
  }
  return {
    icon: 'SA',
    title: 'Wallet standby',
    summary: 'No signer connected',
    detail: providerCount > 0 ? `${providerCount} provider(s) discovered` : 'No providers discovered',
  };
}

function walletOptions(): string {
  if (state.wallets.length === 0) {
    return '<option value="">No wallets discovered</option>';
  }
  return state.wallets
    .map(
      (wallet) =>
        `<option value="${escapeHtml(wallet.name)}" ${wallet.name === state.selectedWalletName ? 'selected' : ''}>${escapeHtml(wallet.name)}</option>`,
    )
    .join('');
}

function iosWalletOptions(): string {
  return state.iosWallets
    .map(
      (wallet) =>
        `<option value="${escapeHtml(wallet.id)}" ${wallet.id === state.selectedIosWalletId ? 'selected' : ''}>${escapeHtml(wallet.name)} - ${escapeHtml(wallet.detail)}</option>`,
    )
    .join('');
}

function iosWalletLabel(walletId: IosNativeWalletId): string {
  return state.iosWallets.find((wallet) => wallet.id === walletId)?.name ?? walletId;
}

function isIosNativeWalletId(value: string): value is IosNativeWalletId {
  return state.iosWallets.some((wallet) => wallet.id === value);
}

function capabilityBlock(capabilities: AdapterCapabilities): string {
  const support = capabilities.supports;
  return `
    <div class="capabilities">
      <span>${escapeHtml(capabilities.backend)}</span>
      <span>${capabilities.cluster.map(titleCaseCluster).join(', ')}</span>
      <span>message ${support.signMessage ? 'yes' : 'no'}</span>
      <span>transaction ${support.signTransaction ? 'yes' : 'no'}</span>
      <span>send ${support.signAndSendTransaction ? 'yes' : 'no'}</span>
    </div>
  `;
}

function capabilitySummary(capabilities: AdapterCapabilities): string {
  const supported = [
    capabilities.supports.signMessage ? 'message' : '',
    capabilities.supports.signTransaction ? 'transaction' : '',
    capabilities.supports.signAndSendTransaction ? 'send' : '',
  ].filter(Boolean);
  return supported.length ? `${capabilities.backend}: ${supported.join(', ')}` : capabilities.backend;
}

function tabButton(tab: ActiveTab, label: string, mobileLabel?: string): string {
  const locked = !state.address && tab !== 'wallet' && tab !== 'agent' && tab !== 'labs';
  const className = [
    state.activeTab === tab ? 'active' : '',
    mobileLabel ? 'has-mobile-label' : '',
  ].filter(Boolean).join(' ');
  const content = mobileLabel
    ? `<span class="nav-label nav-label-full">${escapeHtml(label)}</span><span class="nav-label nav-label-mobile">${escapeHtml(mobileLabel)}</span>`
    : `<span class="nav-label">${escapeHtml(label)}</span>`;
  return `<button data-tab="${tab}" class="${className}" aria-label="${escapeHtml(label)}" ${locked ? 'disabled title="Connect a wallet to unlock this workspace."' : ''}>${content}</button>`;
}

function step(name: StepName, title: string, detail: string): string {
  return `
    <li class="${state.steps[name]}">
      <span class="step-dot"></span>
      <div>
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(detail)}</p>
      </div>
    </li>
  `;
}

function transactionStepDetail(): string {
  if (state.txid) return short(state.txid);
  if (state.txSignature) return short(state.txSignature);
  if (state.customTransactionBase64) return `Ready to sign: ${short(state.customTransactionBase64)}`;
  return state.cluster === 'devnet' ? 'Create or paste a base64 transaction to test' : 'Paste a base64 transaction to test';
}

function resultBlock(): string {
  const rows = [
    state.address ? ['Address', state.address] : null,
    state.signature ? ['Message signature', state.signature] : null,
    state.customTransactionBase64 && !state.txSignature
      ? ['Generated transaction', state.customTransactionBase64]
      : null,
    state.txSignature ? ['Signed transaction', state.txSignature] : null,
    state.txid ? ['Transaction id', state.txid] : null,
  ].filter(Boolean) as Array<[string, string]>;

  if (rows.length === 0) {
    return '<div class="empty">Results appear here after wallet approval.</div>';
  }

  return `
    <div class="results">
      ${rows
        .map(
          ([label, value]) => `
            <div class="result-row">
              <span>${escapeHtml(label)}</span>
              <code>${escapeHtml(value)}</code>
              <button data-copy="${escapeHtml(value)}">Copy</button>
            </div>
          `,
        )
        .join('')}
    </div>
  `;
}

function agentPlanCard(plan: AgentPlan): string {
  return `
    <article class="plan-card proof-preview">
      <div>
        <span class="workbench-kicker">${escapeHtml(plan.source === 'ai' ? 'AI-drafted plan' : 'Keyless template plan')}</span>
        <h3>${escapeHtml(plan.intent)}</h3>
      </div>
      <div class="pill-row">
        <span class="status-pill neutral">${escapeHtml(titleCase(plan.category))}</span>
        <span class="status-pill neutral">${escapeHtml(plan.actionType.replace(/_/g, ' '))}</span>
        <span class="status-pill ${canQueueAgentPlan(plan) ? 'tx-confirmed' : 'tx-pending'}">${canQueueAgentPlan(plan) ? 'queueable' : 'proof only'}</span>
      </div>
      <dl class="proof-grid plan-review-grid">
        ${reviewSummaryRows(plan).map(([label, value]) => definitionRow(label, value)).join('')}
      </dl>
      <dl class="proof-grid">
        ${definitionRow('Route', plan.route)}
        ${definitionRow('Risk', plan.risk)}
        ${definitionRow('Approval', plan.approval)}
      </dl>
      ${plan.userNotes ? `
        <dl class="proof-grid plan-notes-grid">
          ${definitionRow('User notes', plan.userNotes)}
        </dl>
      ` : ''}
      ${plan.fields.length ? `
        <dl class="proof-grid plan-field-grid">
          ${plan.fields.map((entry) => definitionRow(entry.label, entry.value)).join('')}
        </dl>
      ` : ''}
      <div class="plan-safeguards">
        <span>Safeguards</span>
        <ul>
          ${plan.safeguards.slice(0, 6).map((safeguard) => `<li>${escapeHtml(safeguard)}</li>`).join('')}
        </ul>
      </div>
    </article>
  `;
}

function reviewSummaryRows(plan: AgentPlan): Array<[string, string]> {
  return [
    ['Prepared by', planPreparedBy(plan)],
    ['Source', planSourceLabel(plan)],
    ['Wallet', state.address ? short(state.address) : 'Connect wallet to sign'],
    ['Network', titleCaseCluster(state.cluster)],
    ['Template', plan.templateTitle],
    ['Action', plan.actionType.replace(/_/g, ' ')],
  ];
}

function planPreparedBy(plan: AgentPlan): string {
  return plan.source === 'ai' ? 'AI draft reviewed in Agentic' : 'You in Agentic';
}

function planSourceLabel(plan: AgentPlan): string {
  return plan.source === 'ai' ? 'Bring-your-own-key AI draft' : 'Keyless template, no AI';
}

function agentResultBlock(): string {
  if (!state.agentSignature) {
    return '<div class="empty">Agent approval signature appears here after wallet approval.</div>';
  }
  return `
    <div class="results">
      <div class="result-row">
        <span>Agent approval signature</span>
        <code>${escapeHtml(state.agentSignature)}</code>
        <button data-copy="${escapeHtml(state.agentSignature)}">Copy</button>
      </div>
    </div>
  `;
}

function queueStatusLine(visibleCount: number): string {
  const total = state.preparedActions.filter((action) => !action.archived).length;
  const bridge = state.bridgeActive ? 'Bridge connected' : 'Bridge unavailable';
  const filter = queueFilterLabel(state.inboxFilter);
  return `
    <div class="queue-status">
      <span>${escapeHtml(bridge)}</span>
      <strong>${visibleCount} awaiting review</strong>
      <span>${total} in queue</span>
      <span>${escapeHtml(filter)}</span>
    </div>
  `;
}

function scheduleStatusLine(): string {
  const active = state.recurringPayments.filter((payment) => payment.status === 'active').length;
  const total = state.recurringPayments.length;
  const bridge = state.bridgeActive ? 'Bridge connected' : 'Bridge unavailable';
  return `
    <div class="queue-status">
      <span>${escapeHtml(bridge)}</span>
      <strong>${active} active recurring approval${active === 1 ? '' : 's'}</strong>
      <span>${total} saved</span>
      <span>Each run still needs wallet approval</span>
    </div>
  `;
}

function preparedActionsList(actions = filteredPreparedActions()): string {
  if (!state.bridgeActive) {
    return queueEmptyState('bridge');
  }
  if (actions.length === 0) {
    return queueEmptyState('clear');
  }
  return `
    <div class="inbox-list">
      ${actions.map(preparedActionCard).join('')}
    </div>
  `;
}

function queueEmptyState(kind: 'bridge' | 'clear'): string {
  const bridgeMissing = kind === 'bridge';
  const title = bridgeMissing ? 'Approval queue unavailable' : 'No approvals waiting';
  const detail = bridgeMissing
    ? 'Start the local bridge to review prepared payment, swap, and recurring actions.'
    : emptyInboxText();
  const chip = bridgeMissing ? 'Bridge required' : 'Queue clear';
  return `
    <div class="empty queue-empty queue-empty-state">
      <div>
        <span>${escapeHtml(chip)}</span>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(detail)}</p>
      </div>
    </div>
  `;
}

function preparedActionCard(action: PreparedAction): string {
  const executable = ['ready', 'overdue', 'failed'].includes(action.status);
  return `
    <article class="inbox-item approval-ticket ${action.status}">
      <div class="ticket-status-rail ${statusTone(action.status)}"></div>
      <div class="ticket-body">
        <div class="pill-row">
          <span class="status-pill ${statusTone(action.status)}">${escapeHtml(action.status)}</span>
          <span class="status-pill neutral">${escapeHtml(action.kind.replace('_', ' '))}</span>
          ${action.recurringId ? '<span class="status-pill neutral">recurring</span>' : ''}
          ${action.txStatus ? `<span class="status-pill ${txTone(action.txStatus)}">tx ${escapeHtml(action.txStatus)}</span>` : ''}
        </div>
        <h3>${escapeHtml(action.summary)}</h3>
        ${action.note ? `<p class="action-note">${escapeHtml(action.note)}</p>` : ''}
        ${actionPreview(action)}
        <p>${escapeHtml(action.kind)} on ${escapeHtml(action.cluster)} - due ${formatDateTime(action.dueAt)}</p>
        ${action.error ? `<p class="error-text">${escapeHtml(action.error)}</p>` : ''}
        ${action.txError ? `<p class="error-text">${escapeHtml(action.txError)}</p>` : ''}
        ${action.txid ? txBlock(action.txid, action.cluster) : ''}
      </div>
      <div class="inbox-actions">
        <button data-action-op="execute" data-action-id="${action.id}" class="primary" ${!state.bridgeActive || state.busy || !executable ? 'disabled' : ''}>Approve</button>
        <button data-action-op="reject" data-action-id="${action.id}" ${state.busy || ['approved', 'rejected'].includes(action.status) ? 'disabled' : ''}>Reject</button>
        <button data-action-op="copy" data-action-id="${action.id}">Copy receipt</button>
        <button data-action-op="archive" data-action-id="${action.id}" ${state.busy ? 'disabled' : ''}>Archive</button>
        <button data-action-op="delete" data-action-id="${action.id}" ${state.busy ? 'disabled' : ''}>Delete</button>
      </div>
    </article>
  `;
}

function actionPreview(action: PreparedAction): string {
  const rows: Array<[string, string]> = [
    ['Wallet', short(action.walletAddress)],
    ['Recipient', stringParam(action, 'recipient') ? short(stringParam(action, 'recipient')) : 'n/a'],
    ['Amount', amountLabel(action)],
    ['Token', tokenLabel(action)],
    ['Caps', 'Checked before wallet opens'],
    ['Fee', 'Estimated by wallet at approval'],
  ];
  return `
    <dl class="action-preview">
      ${rows.map(([label, value]) => definitionRow(label, value)).join('')}
    </dl>
  `;
}

function recurringComposer(): string {
  const draft = state.recurringDraft;
  const recipient = draft.recipient ? short(draft.recipient) : 'Recipient required';
  const limit = draft.maxOccurrences ? `${draft.maxOccurrences} occurrence${draft.maxOccurrences === '1' ? '' : 's'}` : 'Manual review every time';
  const createDisabled = !state.bridgeActive || state.busy;
  return `
    <div class="recurring-panel recurring-contract">
      <div class="contract-head">
        <div>
          <span>Recurring setup</span>
          <h3>Create recurring approval</h3>
          <p class="recurring-help">Define the recurring request. Each occurrence still requires wallet approval.</p>
        </div>
        <strong>${escapeHtml(recurringCadenceLabel(draft.cadence))}</strong>
      </div>
      <dl class="contract-summary">
        ${definitionRow('Asset', `${draft.amount || 'Amount'} ${draft.token || 'Token'}`)}
        ${definitionRow('Recipient', recipient)}
        ${definitionRow('Cadence', recurringDraftScheduleLabel(draft))}
        ${definitionRow('Limit', limit)}
      </dl>
      <div class="contract-section">
        <div>
          <span>Payment terms</span>
          <p>What the prepared action will request from the wallet.</p>
        </div>
        <div class="recurring-grid">
          ${fieldInput('recurringToken', 'Token', draft.token)}
          ${fieldInput('recurringAmount', 'Amount', draft.amount)}
          ${fieldInput('recurringRecipient', 'Recipient', draft.recipient)}
        </div>
      </div>
      <div class="contract-section">
        <div>
          <span>Schedule terms</span>
          <p>When new approval items should appear for review.</p>
        </div>
        <div class="recurring-grid schedule-grid">
          <label class="field compact">
            <span>Cadence</span>
            <select id="recurringCadence">
              ${cadenceOption('weekly', 'Weekly')}
              ${cadenceOption('monthly', 'Monthly')}
              ${cadenceOption('interval_days', 'Interval days')}
              ${cadenceOption('interval_hours', 'Interval hours')}
              ${cadenceOption('interval_minutes', 'Interval minutes')}
            </select>
          </label>
          ${recurringScheduleFields(draft)}
        </div>
      </div>
      <label class="field compact approval-memo">
        <span>Approval memo</span>
        <input id="recurringNote" value="${escapeHtml(draft.note)}" placeholder="Reason shown in the approval inbox" />
      </label>
      <div class="recurring-form-actions contract-actions">
        <button id="createRecurring" class="primary" ${createDisabled ? 'disabled' : ''}>Create recurring approval</button>
        ${createDisabled ? '<span class="contract-helper">Bridge required before creating recurring approvals.</span>' : '<span class="contract-helper">Recurring approvals create reviewable inbox items.</span>'}
      </div>
    </div>
  `;
}

function recurringList(): string {
  if (!state.bridgeActive || state.recurringPayments.length === 0) {
    return '';
  }
  return `
    <div class="recurring-list">
      ${state.recurringPayments.map(recurringCard).join('')}
    </div>
  `;
}

function recurringCard(payment: RecurringPayment): string {
  return `
    <article class="recurring-item">
      <div>
        <div class="pill-row">
          <span class="status-pill ${payment.status === 'active' ? 'tx-confirmed' : 'neutral'}">${escapeHtml(payment.status)}</span>
          <span class="status-pill neutral">${escapeHtml(payment.cadence)}</span>
          <span class="recurring-count">${payment.occurrencesCreated ?? 0}${payment.maxOccurrences ? ` of ${payment.maxOccurrences}` : ''}</span>
        </div>
        <h3>${escapeHtml(payment.amount)} ${escapeHtml(payment.token)} to ${escapeHtml(short(payment.recipient))}</h3>
        <p>${escapeHtml(scheduleLabel(payment))}</p>
        ${payment.note ? `<p class="action-note">${escapeHtml(payment.note)}</p>` : ''}
      </div>
      <div class="recurring-actions">
        <button data-recurring-op="pause" data-recurring-id="${payment.id}" ${payment.status !== 'active' || state.busy ? 'disabled' : ''}>Pause</button>
        <button data-recurring-op="resume" data-recurring-id="${payment.id}" ${payment.status !== 'paused' || state.busy ? 'disabled' : ''}>Resume</button>
        <button data-recurring-op="delete" data-recurring-id="${payment.id}" ${state.busy ? 'disabled' : ''}>Delete</button>
      </div>
    </article>
  `;
}

function labArtifactCard(artifact: LabArtifact): string {
  return `
    <article class="lab-artifact artifact-summary-card">
      <div class="artifact-summary-head">
        <div class="artifact-meta-line">
          <span class="status-pill ${artifact.verified ? 'tx-confirmed' : 'tx-pending'}">${artifact.verified ? 'verified' : 'signed'}</span>
          <span>${escapeHtml(labKindLabel(artifact.kind))}</span>
        </div>
        <span>${escapeHtml(formatDateTime(artifact.createdAt))}</span>
      </div>
      <h3>${escapeHtml(artifact.title)}</h3>
      <p class="lab-thesis">${escapeHtml(artifact.payload.thesis)}</p>
      <div class="artifact-evidence-row">
        ${artifactMetricCard(artifact, 'Decision')}
        ${artifactMetricCard(artifact, 'Custody')}
        ${artifactMetricCard(artifact, 'Settlement')}
      </div>
      <details class="artifact-technical-details">
        <summary>
          <span>Technical evidence</span>
          <strong>Hashes and signing payload</strong>
        </summary>
        <div class="hash-grid">
          ${hashTile('Pre-signature', artifact.preSignatureHash)}
          ${hashTile('Artifact', artifact.artifactHash)}
          ${hashTile('Signature', artifact.signature)}
          ${hashTile('Wallet', artifact.walletAddress)}
        </div>
        <div class="results compact-results">
          <div class="result-row">
            <span>Signing message</span>
            <code>${escapeHtml(artifact.signingMessage)}</code>
            <button data-copy="${escapeHtml(artifact.signingMessage)}">Copy</button>
          </div>
        </div>
      </details>
    </article>
  `;
}

function artifactMetricCard(artifact: LabArtifact, label: string): string {
  const metricItem = artifact.payload.metrics.find((candidate) => candidate.label.toLowerCase() === label.toLowerCase());
  const value = metricItem?.value ?? 'Recorded';
  const tone = metricItem?.tone ?? 'neutral';
  return `
    <div class="${tone}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function labHistory(): string {
  if (state.labArtifacts.length === 0) {
    return '';
  }
  return `
    <div class="lab-history">
      <h3>Recent artifacts</h3>
      ${state.labArtifacts.slice(0, 5).map(
        (artifact) => `
          <article>
            <strong>${escapeHtml(artifact.title)}</strong>
            <span>${escapeHtml(formatDateTime(artifact.createdAt))}</span>
            <button data-copy="${escapeHtml(stableJson(artifact))}">Copy JSON</button>
          </article>
        `,
      ).join('')}
    </div>
  `;
}

function filteredPreparedActions(): PreparedAction[] {
  const actions = state.preparedActions.filter((action) => !action.archived);
  switch (state.inboxFilter) {
    case 'one-time':
      return actions.filter((action) => !action.recurringId);
    case 'recurring':
      return actions.filter((action) => Boolean(action.recurringId));
    case 'ready':
      return actions.filter((action) => action.status === 'ready' || action.status === 'overdue');
    case 'scheduled':
      return actions.filter((action) => action.status === 'scheduled');
    case 'approved':
      return actions.filter((action) => action.status === 'approved');
    case 'failed':
      return actions.filter((action) => action.status === 'failed' || action.status === 'blocked');
    case 'rejected':
      return actions.filter((action) => action.status === 'rejected');
    case 'all':
      return actions;
  }
}

function inboxFilterOption(value: InboxFilter, label: string): string {
  return `<option value="${value}" ${state.inboxFilter === value ? 'selected' : ''}>${escapeHtml(label)}</option>`;
}

function queueFilterLabel(filter: InboxFilter): string {
  switch (filter) {
    case 'ready':
      return 'Showing ready approvals';
    case 'scheduled':
      return 'Showing scheduled items';
    case 'approved':
      return 'Showing approved approvals';
    case 'failed':
      return 'Showing needs attention';
    case 'rejected':
      return 'Showing rejected approvals';
    case 'one-time':
      return 'Showing one-time approvals';
    case 'recurring':
      return 'Showing recurring approvals';
    case 'all':
      return 'Showing all';
  }
}

function cadenceOption(value: RecurringCadence, label: string): string {
  return `<option value="${value}" ${state.recurringDraft.cadence === value ? 'selected' : ''}>${escapeHtml(label)}</option>`;
}

function recurringCadenceLabel(cadence: RecurringCadence): string {
  switch (cadence) {
    case 'weekly':
      return 'Weekly';
    case 'monthly':
      return 'Monthly';
    case 'interval_days':
      return 'Every few days';
    case 'interval_hours':
      return 'Hourly interval';
    case 'interval_minutes':
      return 'Minute interval';
  }
}

function recurringDraftScheduleLabel(draft: RecurringDraft): string {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (draft.cadence === 'weekly') {
    return `${days[Number(draft.dayOfWeek)] ?? 'Selected day'} at ${draft.localTime || '09:00'}`;
  }
  if (draft.cadence === 'monthly') {
    return `Day ${draft.dayOfMonth || '1'} at ${draft.localTime || '09:00'}`;
  }
  if (draft.cadence === 'interval_hours') {
    return `Every ${draft.intervalHours || '1'} hour(s)`;
  }
  if (draft.cadence === 'interval_minutes') {
    return `Every ${draft.intervalMinutes || '60'} minute(s)`;
  }
  return `Every ${draft.intervalDays || '1'} day(s)`;
}

function recurringScheduleFields(draft: RecurringDraft): string {
  const max = fieldInput('recurringMaxOccurrences', 'Max occurrences', draft.maxOccurrences, 'empty for indefinite');
  if (draft.cadence === 'weekly') {
    return `
      <label class="field compact">
        <span>Day</span>
        <select id="recurringDayOfWeek">
          ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
            .map((day, index) => `<option value="${index}" ${draft.dayOfWeek === String(index) ? 'selected' : ''}>${day}</option>`)
            .join('')}
        </select>
      </label>
      ${fieldInput('recurringLocalTime', 'Local time', draft.localTime, '09:00')}
      ${max}
    `;
  }
  if (draft.cadence === 'monthly') {
    return `
      ${fieldInput('recurringDayOfMonth', 'Day of month', draft.dayOfMonth, '1-31')}
      ${fieldInput('recurringLocalTime', 'Local time', draft.localTime, '09:00')}
      ${max}
    `;
  }
  if (draft.cadence === 'interval_hours') {
    return `
      ${fieldInput('recurringIntervalHours', 'Every hours', draft.intervalHours, '1')}
      ${fieldInput('recurringStartAt', 'Start at', draft.startAt, '', 'datetime-local')}
      ${max}
    `;
  }
  if (draft.cadence === 'interval_minutes') {
    return `
      ${fieldInput('recurringIntervalMinutes', 'Every minutes', draft.intervalMinutes, '60')}
      ${fieldInput('recurringStartAt', 'Start at', draft.startAt, '', 'datetime-local')}
      ${max}
    `;
  }
  return `
    ${fieldInput('recurringIntervalDays', 'Every days', draft.intervalDays, '1')}
    ${fieldInput('recurringStartAt', 'Start at', draft.startAt, '', 'datetime-local')}
    ${max}
  `;
}

function fieldInput(id: string, label: string, value: string, placeholder = '', type = 'text'): string {
  return `
    <label class="field compact">
      <span>${escapeHtml(label)}</span>
      <input id="${id}" type="${type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" />
    </label>
  `;
}

function evidenceStep(
  title: string,
  copy: { status: string; detail: string; meta?: string },
  tone: 'good' | 'active' | 'warn' | 'idle',
): string {
  return `
    <article class="evidence-step ${tone}">
      <div class="evidence-indicator"><span></span></div>
      <div>
        <div class="evidence-title">
          <strong>${escapeHtml(title)}</strong>
          <span>${escapeHtml(copy.status)}</span>
        </div>
        <p>${escapeHtml(copy.detail)}</p>
        ${copy.meta ? `<small>${escapeHtml(copy.meta)}</small>` : ''}
      </div>
    </article>
  `;
}

function evidenceIntent(): { status: string; detail: string; meta?: string } {
  if (state.activeTab === 'wallet') {
    return {
      status: state.signature ? 'Signed' : 'Ready',
      detail: state.signature ? 'Message approval returned a wallet signature.' : DEMO_MESSAGE,
      meta: state.signature ? short(state.signature) : `${titleCaseCluster(state.cluster)} message request`,
    };
  }
  if (state.agentPlan) {
    return {
      status: 'Prepared',
      detail: state.agentPlan.intent,
      meta: 'Agent plan is ready for wallet review.',
    };
  }
  if (state.signature) {
    return {
      status: 'Signed',
      detail: 'Message intent was approved by the connected wallet.',
      meta: short(state.signature),
    };
  }
  if (state.customTransactionBase64) {
    return {
      status: 'Transaction ready',
      detail: 'Transaction bytes are staged for wallet approval.',
      meta: short(state.customTransactionBase64),
    };
  }
  if (state.activeTab === 'inbox') {
    const count = state.preparedActions.filter((action) => !action.archived).length;
    return {
      status: count ? 'Queued' : 'Empty',
      detail: count ? `${count} prepared action(s) are ready for review.` : 'No prepared actions are currently waiting.',
      meta: state.bridgeActive ? 'Bridge queue connected' : 'Bridge offline',
    };
  }
  if (state.activeTab === 'schedule') {
    const activeSchedules = state.recurringPayments.filter((payment) => payment.status === 'active').length;
    return {
      status: activeSchedules ? 'Recurring' : 'Draft',
      detail: activeSchedules
        ? `${activeSchedules} recurring approval${activeSchedules === 1 ? '' : 's'} active.`
        : 'Create a recurring approval for future wallet review.',
        meta: state.bridgeActive ? 'Bridge recurring engine connected' : 'Bridge offline',
    };
  }
  if (state.activeTab === 'labs') {
    if (state.artifactView === 'signed') {
      return {
        status: state.labArtifacts.length ? 'Archived' : 'Empty',
        detail: state.labArtifacts.length
          ? `${state.labArtifacts.length} signed audit artifact(s) are available for review.`
          : 'No signed audit artifacts have been created yet.',
        meta: state.labArtifacts[0] ? short(state.labArtifacts[0].artifactHash) : undefined,
      };
    }
    const lab = activeLab();
    return {
      status: 'Artifact',
      detail: lab.defaultInput,
      meta: lab.title,
    };
  }
  return {
    status: state.address ? 'Ready' : 'Waiting',
    detail: state.address ? 'Select a workflow to prepare intent.' : 'Connect a wallet before intent can be reviewed.',
  };
}

function evidencePolicy(): { status: string; detail: string; meta?: string } {
  const openApprovals = state.preparedActions.filter((action) => !action.archived).length;
  if (state.activeTab === 'wallet') {
    return {
      status: state.cluster === 'mainnet-beta' ? 'Mainnet caution' : 'Local policy',
      detail:
        state.cluster === 'mainnet-beta'
          ? 'Only explicit wallet approval can produce a signature on mainnet.'
          : 'Wallet Standard approval gates every message and transaction request.',
      meta: state.capabilities ? capabilitySummary(state.capabilities) : undefined,
    };
  }
  if (state.activeTab === 'agent') {
    return {
      status: state.agentPlan ? 'Plan scoped' : 'Draft',
      detail: state.agentPlan?.risk ?? 'Generate a plan to expose route and risk before signing.',
      meta: state.bridgeActive ? 'Can queue prepared action' : 'Bridge queue unavailable',
    };
  }
  if (state.activeTab === 'schedule') {
    return {
      status: state.bridgeActive ? 'Recurring ready' : 'Bridge required',
      detail: 'Recurring approvals create reviewable inbox items, not automatic signatures.',
      meta: state.recurringPayments.length ? `${state.recurringPayments.length} recurring approval(s)` : undefined,
    };
  }
  if (state.activeTab === 'labs') {
    if (state.artifactView === 'signed') {
      return {
        status: state.bridgeActive ? 'Bridge mirrored' : 'Local archive',
        detail: state.labArchiveStatus,
        meta: state.health?.labArtifactStorePath ?? (state.bridgeActive ? 'Bridge archive connected' : 'Browser durable storage'),
      };
    }
    return {
      status: 'Local verification',
      detail: 'Audit artifacts bind payload hash, wallet, cluster, and signature for review.',
      meta: state.labArtifacts.length ? `${state.labArtifacts.length} artifact(s)` : 'No artifacts yet',
    };
  }
  if (openApprovals > 0) {
    return {
      status: 'Queued',
      detail: `${openApprovals} prepared action(s) are waiting for review.`,
      meta: state.bridgeActive ? 'Local bridge policy is active.' : 'Bridge is offline.',
    };
  }
  if (state.bridgeActive) {
    return {
      status: 'Active',
      detail: 'Local bridge is connected and ready to enforce prepared-action policy.',
      meta: bridgeHostLabel(),
    };
  }
  return {
    status: state.cluster === 'mainnet-beta' ? 'Caution' : 'Idle',
    detail:
      state.cluster === 'mainnet-beta'
        ? 'Mainnet requests require explicit wallet approval and visible receipts.'
        : 'Policy checks activate when the local bridge is connected.',
  };
}

function evidenceWallet(): { status: string; detail: string; meta?: string } {
  if (state.address) {
    return {
      status: 'Connected',
      detail: state.selectedWalletName || 'Browser wallet signer is connected.',
      meta: short(state.address),
    };
  }
  return {
    status: 'Not connected',
    detail: 'The app cannot sign or approve until a user wallet is connected.',
    meta: bridgeModeLabel(),
  };
}

function evidenceReceipt(latestLab: LabArtifact | undefined): { status: string; detail: string; meta?: string } {
  if (state.activeTab === 'wallet' && state.signature) {
    return {
      status: 'Message proof',
      detail: 'The wallet signature is ready to copy or verify downstream.',
      meta: short(state.signature),
    };
  }
  if (state.activeTab === 'agent' && state.agentSignature) {
    return {
      status: 'Approval proof',
      detail: 'The signed agent plan proof is available for audit.',
      meta: short(state.agentSignature),
    };
  }
  if (state.txid) {
    return {
      status: 'Broadcast',
      detail: 'A transaction id is available for external verification.',
      meta: short(state.txid),
    };
  }
  if (state.txSignature) {
    return {
      status: 'Signed bytes',
      detail: 'The wallet returned signed transaction bytes without broadcasting.',
      meta: short(state.txSignature),
    };
  }
  if (state.agentSignature) {
    return {
      status: 'Proof signed',
      detail: 'The agent approval proof is available for copy or audit.',
      meta: short(state.agentSignature),
    };
  }
  if (state.receipts.length > 0) {
    return {
      status: 'Receipt ready',
      detail: `${state.receipts.length} local receipt(s) are available from the bridge.`,
      meta: state.receipts[0]?.actionId,
    };
  }
  if (state.activeTab === 'labs' && latestLab) {
    return {
      status: 'Artifact',
      detail: 'A signed audit artifact is available for review.',
      meta: short(latestLab.artifactHash),
    };
  }
  return {
    status: 'Pending',
    detail:
      state.activeTab === 'inbox' || state.activeTab === 'schedule'
        ? 'Receipts appear after an approval is approved, rejected, or archived.'
        : 'Receipts appear after wallet approval or signed artifact creation.',
  };
}

function evidenceTone(kind: 'intent' | 'policy' | 'wallet' | 'receipt'): 'good' | 'active' | 'warn' | 'idle' {
  switch (kind) {
    case 'intent':
      return state.agentPlan || state.signature || state.customTransactionBase64 ? 'good' : state.address ? 'active' : 'idle';
    case 'policy':
      if (state.preparedActions.length || state.bridgeActive) return 'good';
      return state.cluster === 'mainnet-beta' ? 'warn' : 'idle';
    case 'wallet':
      return state.address ? 'good' : 'idle';
    case 'receipt':
      return state.txid || state.txSignature || state.agentSignature || state.receipts.length || state.labArtifacts.length
        ? 'good'
        : 'idle';
  }
}

function trustChain(): string {
  const hasReceipt = Boolean(state.txid || state.txSignature || state.agentSignature || state.receipts.length || state.labArtifacts.length);
  return `
    <div class="trust-chain" aria-label="Approval trust chain">
      ${trustNode('Intent', Boolean(state.agentPlan || state.signature || state.customTransactionBase64), state.activeTab === 'agent')}
      ${trustNode('Policy', Boolean(state.bridgeActive || state.preparedActions.length), state.activeTab === 'inbox' || state.activeTab === 'schedule')}
      ${trustNode('Wallet', Boolean(state.address), state.busy)}
      ${trustNode('Receipt', hasReceipt, false)}
    </div>
  `;
}

function trustNode(label: string, complete: boolean, active: boolean): string {
  return `
    <div class="trust-node ${complete ? 'complete' : ''} ${active ? 'active' : ''}">
      <span></span>
      <strong>${escapeHtml(label)}</strong>
    </div>
  `;
}

function contextRow(label: string, value: string, tone = ''): string {
  return `
    <div class="context-row ${tone}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function txBlock(txid: string, cluster: Cluster): string {
  const url = explorerUrl(txid, cluster);
  return `
    <div class="tx-block">
      <code>${escapeHtml(txid)}</code>
      <a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Explorer</a>
      <button data-copy="${escapeHtml(txid)}">Copy</button>
    </div>
  `;
}

function hashTile(label: string, value: string): string {
  return `
    <div>
      <span>${escapeHtml(label)}</span>
      <code>${escapeHtml(short(value))}</code>
    </div>
  `;
}

function definitionRow(label: string, value: string): string {
  return `
    <div>
      <dt>${escapeHtml(label)}</dt>
      <dd>${escapeHtml(value)}</dd>
    </div>
  `;
}

function surfaceEyebrow(): string {
  switch (state.activeTab) {
    case 'wallet':
      return 'Direct signing';
    case 'agent':
      return 'Intent review';
    case 'inbox':
      return 'Approval inbox';
    case 'schedule':
      return 'Recurring approvals';
    case 'labs':
      return state.artifactView === 'signed' ? 'Artifact archive' : 'Artifact creation';
  }
}

function surfaceTitle(): string {
  switch (state.activeTab) {
    case 'wallet':
      return 'Wallet signing';
    case 'agent':
      return 'Agent Plan';
    case 'inbox':
      return 'Approval Inbox';
    case 'schedule':
      return 'Create Recurring';
    case 'labs':
      return 'Artifacts';
  }
}

function emptyInboxText(): string {
  if (state.inboxFilter === 'one-time') {
    return 'No one-time actions. Ask the MCP agent to prepare a payment or swap.';
  }
  if (state.inboxFilter === 'recurring') {
    return 'No recurring actions yet. Create a recurring approval above.';
  }
  return 'No prepared actions yet. Ask the MCP agent to prepare a payment, swap, or recurring payment.';
}

function amountLabel(action: PreparedAction): string {
  if (typeof action.params.amountSol === 'string') return `${action.params.amountSol} SOL`;
  if (typeof action.params.amount === 'string') return action.params.amount;
  return 'n/a';
}

function tokenLabel(action: PreparedAction): string {
  if (action.kind === 'transfer_sol') return 'SOL';
  if (typeof action.params.token === 'string') return action.params.token;
  if (typeof action.params.inputToken === 'string' && typeof action.params.outputToken === 'string') {
    return `${action.params.inputToken} to ${action.params.outputToken}`;
  }
  return 'n/a';
}

function stringParam(action: PreparedAction, key: string): string {
  const value = action.params[key];
  return typeof value === 'string' ? value : '';
}

function scheduleLabel(payment: RecurringPayment): string {
  const count = payment.maxOccurrences
    ? `, ${payment.occurrencesCreated ?? 0} of ${payment.maxOccurrences} created`
    : ', indefinite';
  if (payment.cadence === 'weekly') {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return `Weekly on ${days[payment.dayOfWeek ?? -1] ?? 'unknown day'} at ${payment.localTime ?? '?'}${count}.`;
  }
  if (payment.cadence === 'monthly') {
    return `Monthly on day ${payment.dayOfMonth ?? '?'} at ${payment.localTime ?? '?'}${count}.`;
  }
  if (payment.cadence === 'interval_hours') {
    return `Every ${payment.intervalHours ?? '?'} hour(s) starting ${formatDateTime(payment.startAt ?? '')}${count}.`;
  }
  if (payment.cadence === 'interval_minutes') {
    return `Every ${payment.intervalMinutes ?? '?'} minute(s) starting ${formatDateTime(payment.startAt ?? '')}${count}.`;
  }
  return `Every ${payment.intervalDays ?? '?'} day(s) starting ${formatDateTime(payment.startAt ?? '')}${count}.`;
}

function statusTone(status: PreparedActionStatus): string {
  if (status === 'approved' || status === 'ready' || status === 'overdue') return 'tx-confirmed';
  if (status === 'approval_pending' || status === 'scheduled') return 'tx-pending';
  if (status === 'failed' || status === 'blocked' || status === 'rejected') return 'tx-failed';
  return 'neutral';
}

function txTone(status: PreparedActionTxStatus): string {
  if (status === 'confirmed') return 'tx-confirmed';
  if (status === 'failed') return 'tx-failed';
  return 'tx-pending';
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function bridgeModeLabel(): string {
  if (state.iosNativeEnvironment.isIosNative) return 'iOS native wallet ready';
  if (state.mwaEnvironment.supportsMwaMobileWeb) return 'Android MWA ready';
  if (state.mwaEnvironment.supportsIosWalletStandardFallback) return 'iOS wallet browser';
  return 'Desktop browser wallet';
}

function mwaStatusText(): string {
  const result = state.mwaRegistration;
  if (!result) {
    return state.mwaEnvironment.supportsMwaMobileWeb
      ? 'Android Chrome can register Mobile Wallet Adapter.'
      : 'MWA unavailable here. Browser Wallet Standard providers still work when injected.';
  }
  if (result.registered) {
    return 'Registered. Android Chrome users can select Mobile Wallet Adapter.';
  }
  switch (result.skippedReason) {
    case 'already_registered':
      return 'Already registered. Android MWA remains available if this browser supports it.';
    case 'not_browser':
      return 'Skipped outside browser. Desktop wallets still work.';
    case 'registration_failed':
      return 'Registration failed. Desktop browser wallets still work.';
    case 'unsupported_environment':
      return result.environment.supportsIosWalletStandardFallback
        ? 'MWA is Android-only. On iOS, open this page inside a wallet in-app browser or use a wallet Safari extension.'
        : result.environment.isAndroid
          ? 'Android detected, but MWA mobile web requires Chrome or a Chrome PWA.'
          : 'MWA unavailable here. Browser Wallet Standard providers still work when injected.';
    default:
      return 'Desktop browser mode. Android MWA appears only on Android Chrome or PWA.';
  }
}

function latestConfirmedTx(): string {
  const tx = state.preparedActions.find((action) => action.txid)?.txid;
  return tx ? short(tx) : 'None';
}

function latestLabArtifact(labId: string): LabArtifact | null {
  return state.labArtifacts.find((artifact) => artifact.labId === labId) ?? null;
}

function activeLab(): LabDefinition {
  return LABS.find((lab) => lab.id === state.activeLab) ?? LABS[0]!;
}

function labInput(labId: string): string {
  return state.labInputs[labId] ?? LABS.find((lab) => lab.id === labId)?.defaultInput ?? '';
}

function labIndexLabel(): string {
  const index = LABS.findIndex((lab) => lab.id === state.activeLab);
  return index >= 0 ? `lab ${index + 1} of ${LABS.length}` : 'lab';
}

async function labPayload(labId: string, input: string, createdAt: string): Promise<LabPayload> {
  const unsafe = /\bunlimited\b|seed phrase|private key|unknown custody/i.test(input);
  const status: LabPayload['status'] = unsafe ? 'blocked' : /unknown|authority|insurance|override/i.test(input) ? 'warn' : 'approved';
  const baseEvidence: Array<[string, string, 'good' | 'warn' | 'danger' | 'neutral']> = [
    ['Request', input, unsafe ? 'danger' : 'neutral'],
    ['Wallet gate', 'Final transaction signing remains a separate wallet approval.', 'good'],
    ['Replay guard', `Artifact time ${createdAt} binds this record to one review moment.`, 'good'],
  ];
  const evidence = await Promise.all(
    baseEvidence.map(async ([title, detail, tone]) => ({
      title,
      detail,
      tone,
      hash: await sha256(stableJson({ title, detail, tone })),
    })),
  );
  return {
    status,
    thesis: labThesis(labId, status),
    nextSignatureGate:
      status === 'blocked'
        ? 'Future matching requests should warn before wallet approval and require a fresh explicit signature.'
        : 'Only sign settlement if the future transaction preview matches this signed envelope.',
    metrics: [
      { label: 'Decision', value: status, tone: status === 'blocked' ? 'danger' : status === 'warn' ? 'warn' : 'good' },
      { label: 'Custody', value: 'user wallet', tone: 'good' },
      { label: 'Settlement', value: 'future gated', tone: 'neutral' },
    ],
    evidence,
  };
}

function labThesis(labId: string, status: LabPayload['status']): string {
  const lab = LABS.find((candidate) => candidate.id === labId);
  if (!lab) return 'Signed agent artifact created.';
  if (status === 'blocked') {
    return 'The request becomes a refusal fingerprint without exposing private wallet data.';
  }
  if (status === 'warn') {
    return 'The request is reviewable, but the next wallet signature must prove semantic and policy alignment.';
  }
  return lab.description;
}

function readRecurringDraft(): RecurringDraft {
  return {
    token: inputValue('#recurringToken') || state.recurringDraft.token,
    recipient: inputValue('#recurringRecipient') || state.recurringDraft.recipient,
    amount: inputValue('#recurringAmount') || state.recurringDraft.amount,
    cadence: (inputValue('#recurringCadence') || state.recurringDraft.cadence) as RecurringCadence,
    localTime: inputValue('#recurringLocalTime') || state.recurringDraft.localTime,
    dayOfWeek: inputValue('#recurringDayOfWeek') || state.recurringDraft.dayOfWeek,
    dayOfMonth: inputValue('#recurringDayOfMonth') || state.recurringDraft.dayOfMonth,
    intervalDays: inputValue('#recurringIntervalDays') || state.recurringDraft.intervalDays,
    intervalHours: inputValue('#recurringIntervalHours') || state.recurringDraft.intervalHours,
    intervalMinutes: inputValue('#recurringIntervalMinutes') || state.recurringDraft.intervalMinutes,
    startAt: inputValue('#recurringStartAt') || state.recurringDraft.startAt,
    maxOccurrences: inputValue('#recurringMaxOccurrences') || state.recurringDraft.maxOccurrences,
    note: inputValue('#recurringNote') || state.recurringDraft.note,
  };
}

function recurringBody(draft: RecurringDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {
    token: draft.token,
    recipient: draft.recipient,
    amount: draft.amount,
    cadence: draft.cadence,
  };
  if (draft.note) body.note = draft.note;
  const maxOccurrences = Number(draft.maxOccurrences);
  if (Number.isInteger(maxOccurrences) && maxOccurrences > 0) {
    body.maxOccurrences = maxOccurrences;
  }
  if (draft.cadence === 'weekly') {
    body.dayOfWeek = Number(draft.dayOfWeek);
    body.localTime = draft.localTime;
  } else if (draft.cadence === 'monthly') {
    body.dayOfMonth = Number(draft.dayOfMonth);
    body.localTime = draft.localTime;
  } else if (draft.cadence === 'interval_hours') {
    body.intervalHours = Number(draft.intervalHours);
    body.startAt = localDateTimeToIso(draft.startAt);
  } else if (draft.cadence === 'interval_minutes') {
    body.intervalMinutes = Number(draft.intervalMinutes);
    body.startAt = localDateTimeToIso(draft.startAt);
  } else {
    body.intervalDays = Number(draft.intervalDays);
    body.startAt = localDateTimeToIso(draft.startAt);
  }
  return body;
}

function defaultRecurringDraft(): RecurringDraft {
  return {
    token: 'SOL',
    recipient: '',
    amount: '0.01',
    cadence: 'weekly',
    localTime: '09:00',
    dayOfWeek: '1',
    dayOfMonth: '1',
    intervalDays: '1',
    intervalHours: '24',
    intervalMinutes: '60',
    startAt: localDateTime(new Date(Date.now() + 60_000)),
    maxOccurrences: '',
    note: '',
  };
}

function defaultLabInputs(): Record<string, string> {
  return Object.fromEntries(LABS.map((lab) => [lab.id, lab.defaultInput]));
}

function requestSignOptions(request: SigningRequest): { cluster: Cluster; summary?: string } {
  if (request.display?.summary !== undefined) {
    return { cluster: request.cluster, summary: request.display.summary };
  }
  return { cluster: request.cluster };
}

function signOptions(summary: string): { cluster: Cluster; summary: string } {
  return { cluster: state.cluster, summary };
}

function activeRpcUrl(): string {
  return state.bridgeRpcUrl || defaultRpcUrl(state.cluster);
}

function defaultRpcUrl(cluster: Cluster): string {
  switch (cluster) {
    case 'mainnet-beta':
      return 'https://api.mainnet-beta.solana.com';
    case 'devnet':
      return 'https://api.devnet.solana.com';
    case 'testnet':
      return 'https://api.testnet.solana.com';
    case 'localnet':
      return 'http://127.0.0.1:8899';
  }
}

function bridgeBaseUrl(): string {
  return state.bridgeUrl.endsWith('/') ? state.bridgeUrl : `${state.bridgeUrl}/`;
}

function bridgeHostLabel(): string {
  try {
    return new URL(state.bridgeUrl).host;
  } catch {
    return state.bridgeUrl;
  }
}

function titleCaseCluster(cluster: Cluster): string {
  return cluster === 'mainnet-beta' ? 'Mainnet-Beta' : cluster[0]!.toUpperCase() + cluster.slice(1);
}

function labKindLabel(kind: string): string {
  return kind
    .split('_')
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');
}

function explorerUrl(txid: string, cluster: Cluster): string {
  const clusterParam = cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`;
  return `https://solscan.io/tx/${txid}${clusterParam}`;
}

function resolveDevControls(): boolean {
  const viteEnv = (import.meta as ImportMeta & {
    env?: {
      DEV?: boolean;
      VITE_AGENTIC_DEV_CONTROLS?: string;
    };
  }).env;
  const explicit = String(viteEnv?.VITE_AGENTIC_DEV_CONTROLS ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(explicit)) return true;
  if (['0', 'false', 'no', 'off'].includes(explicit)) return false;
  if (viteEnv?.DEV) return true;

  const hostname = globalThis.location?.hostname ?? '';
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function defaultAiMode(): AiSettings['mode'] {
  return isLocalBrowserOrigin() ? 'bridge' : 'hosted';
}

function isLocalBrowserOrigin(): boolean {
  const hostname = globalThis.location?.hostname ?? '';
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '';
}

function resolveAndroidExampleTab(): boolean {
  const viteEnv = (import.meta as ImportMeta & {
    env?: {
      VITE_AGENTIC_ANDROID_SHOW_EXAMPLE_TAB?: string;
    };
  }).env;
  const explicit = String(viteEnv?.VITE_AGENTIC_ANDROID_SHOW_EXAMPLE_TAB ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(explicit);
}

function agenticAndroidBridge(): AgenticAndroidBridge | undefined {
  return (globalThis as typeof globalThis & { AgenticAndroid?: AgenticAndroidBridge }).AgenticAndroid;
}

function openAndroidMwaTest(): void {
  const bridge = agenticAndroidBridge();
  if (!bridge?.openMwaExample) {
    pushToast('error', 'MWA unavailable', 'Open this tab inside an Android build with the MWA tab enabled.');
    return;
  }
  bridge.openMwaExample();
}

function isCluster(value: string): value is Cluster {
  return value === 'mainnet-beta' || value === 'devnet' || value === 'testnet' || value === 'localnet';
}

function isPersistedIosWalletId(value: string): value is IosNativeWalletId {
  return value === 'phantom' || value === 'solflare' || value === 'backpack' || value === 'jupiter';
}

function inputValue(selector: string): string {
  const input = document.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(selector);
  return input?.value.trim() ?? '';
}

function localDateTimeToIso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Start time must be a valid local date and time.');
  }
  return date.toISOString();
}

function localDateTime(date: Date): string {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value || 'n/a';
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function toProtocolErrorPayload(err: unknown): ProtocolErrorPayload {
  if (err instanceof ProtocolError) {
    return err.toPayload();
  }
  return {
    code: 'wallet_unreachable',
    message: err instanceof Error ? err.message : 'Wallet request failed.',
    recoverable: true,
  };
}

function extractBridgeError(payload: unknown): string {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === 'string') return redactSecrets(error);
    if (error && typeof error === 'object' && 'message' in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string') return redactSecrets(message);
    }
    return redactSecrets(stableJson(error));
  }
  return redactSecrets(stableJson(payload));
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) {
        sorted[key] = sortJson(entry);
      }
    }
    return sorted;
  }
  return value;
}

function verifyMessageSignature(message: string, signature: string): boolean {
  try {
    return nacl.sign.detached.verify(
      new TextEncoder().encode(message),
      bs58.decode(signature),
      publicKeyFromConnectedWallet().toBytes(),
    );
  } catch {
    return false;
  }
}

function newId(prefix: string): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}`;
}

function toastStack(): string {
  if (state.toasts.length === 0) return '';
  return `
    <div class="toast-stack" aria-live="polite">
      ${state.toasts
        .map(
          (toast) => `
            <div class="toast ${toast.kind}">
              <span class="toast-icon" aria-hidden="true">${checkIcon()}</span>
              <div>
                <strong>${escapeHtml(toast.title)}</strong>
                <p>${escapeHtml(toast.message)}</p>
              </div>
              <button data-toast-dismiss="${toast.id}" aria-label="Dismiss notification">x</button>
            </div>
          `,
        )
        .join('')}
    </div>
  `;
}

function pushToast(kind: ToastKind, title: string, message: string): void {
  const toast: Toast = { id: nextToastId, kind, title, message };
  nextToastId += 1;
  state.toasts = [toast, ...state.toasts].slice(0, 2);
  window.setTimeout(() => {
    dismissToast(toast.id);
  }, 4000);
}

function dismissToast(id: number): void {
  const next = state.toasts.filter((toast) => toast.id !== id);
  if (next.length === state.toasts.length) return;
  state.toasts = next;
  render();
}

function checkIcon(): string {
  return '<svg viewBox="0 0 24 24" focusable="false"><path d="M9.4 16.6 5.8 13l1.4-1.4 2.2 2.2 7.4-7.4L18.2 8 9.4 16.6Z"></path></svg>';
}

function short(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function loadPersistedState(): PersistedState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      ...(typeof parsed.selectedWalletName === 'string' && { selectedWalletName: parsed.selectedWalletName }),
      ...(typeof parsed.selectedIosWalletId === 'string' &&
        isPersistedIosWalletId(parsed.selectedIosWalletId) && { selectedIosWalletId: parsed.selectedIosWalletId }),
      ...(typeof parsed.cluster === 'string' && isCluster(parsed.cluster) && { cluster: parsed.cluster }),
      ...(typeof parsed.bridgeUrl === 'string' && { bridgeUrl: parsed.bridgeUrl }),
      ...(typeof parsed.bridgeToken === 'string' && { bridgeToken: parsed.bridgeToken }),
    };
  } catch {
    return {};
  }
}

function savePersistedState(): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        selectedWalletName: state.selectedWalletName,
        selectedIosWalletId: state.selectedIosWalletId,
        cluster: state.cluster,
        bridgeUrl: state.bridgeUrl,
        bridgeToken: state.bridgeToken,
      }),
    );
  } catch {
    // Best-effort browser persistence.
  }
}

function loadLabArtifacts(): LabArtifact[] {
  try {
    const raw = window.localStorage.getItem(LAB_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? mergeLabArtifacts(parsed.filter(isLabArtifact)) : [];
  } catch {
    return [];
  }
}

async function hydrateLabArtifactArchive(): Promise<void> {
  const legacy = loadLabArtifacts();
  const indexed = await loadIndexedLabArtifacts().catch(() => []);
  state.labArtifacts = mergeLabArtifacts(state.labArtifacts, legacy, indexed);
  await requestPersistentLabArtifactStorage();
  await saveLabArtifacts();
}

async function saveLabArtifacts(): Promise<void> {
  state.labArtifacts = mergeLabArtifacts(state.labArtifacts);
  await saveIndexedLabArtifacts(state.labArtifacts).catch(() => undefined);
  try {
    window.localStorage.setItem(LAB_STORAGE_KEY, JSON.stringify(state.labArtifacts));
  } catch {
    // Best-effort browser persistence.
  }
}

function mergeLabArtifacts(...artifactGroups: unknown[][]): LabArtifact[] {
  const byId = new Map<string, LabArtifact>();
  for (const artifacts of artifactGroups) {
    for (const artifact of artifacts) {
      if (!isLabArtifact(artifact)) continue;
      const current = byId.get(artifact.id);
      if (!current || artifact.createdAt.localeCompare(current.createdAt) >= 0) {
        byId.set(artifact.id, artifact);
      }
    }
  }
  return [...byId.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function isLabArtifact(value: unknown): value is LabArtifact {
  if (!value || typeof value !== 'object') return false;
  const artifact = value as Partial<LabArtifact>;
  return (
    typeof artifact.id === 'string' &&
    typeof artifact.labId === 'string' &&
    typeof artifact.title === 'string' &&
    typeof artifact.kind === 'string' &&
    typeof artifact.createdAt === 'string' &&
    typeof artifact.walletAddress === 'string' &&
    isCluster(artifact.cluster ?? '') &&
    typeof artifact.input === 'string' &&
    typeof artifact.preSignatureHash === 'string' &&
    typeof artifact.signingMessage === 'string' &&
    typeof artifact.signature === 'string' &&
    typeof artifact.verified === 'boolean' &&
    typeof artifact.artifactHash === 'string' &&
    isLabPayload(artifact.payload)
  );
}

function isLabPayload(value: unknown): value is LabPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<LabPayload>;
  return (
    (payload.status === 'approved' || payload.status === 'blocked' || payload.status === 'warn' || payload.status === 'observed') &&
    typeof payload.thesis === 'string' &&
    typeof payload.nextSignatureGate === 'string' &&
    Array.isArray(payload.metrics) &&
    Array.isArray(payload.evidence)
  );
}

async function requestPersistentLabArtifactStorage(): Promise<void> {
  try {
    if (!navigator.storage?.persist) {
      state.labArchiveStatus = 'Browser archive ready.';
      return;
    }
    const alreadyPersistent = await navigator.storage.persisted?.();
    if (alreadyPersistent) {
      state.labArchiveStatus = 'Persistent browser archive ready.';
      return;
    }
    const granted = await navigator.storage.persist();
    state.labArchiveStatus = granted ? 'Persistent browser archive ready.' : 'Browser archive ready.';
  } catch {
    state.labArchiveStatus = 'Browser archive ready.';
  }
}

async function loadIndexedLabArtifacts(): Promise<LabArtifact[]> {
  const db = await openLabArchiveDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(LAB_ARCHIVE_STORE_NAME, 'readonly');
    const store = transaction.objectStore(LAB_ARCHIVE_STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => resolve(mergeLabArtifacts((request.result as unknown[]).filter(isLabArtifact)));
    request.onerror = () => reject(request.error ?? new Error('Unable to load lab artifact archive.'));
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => {
      db.close();
      reject(transaction.error ?? new Error('Unable to load lab artifact archive.'));
    };
  });
}

async function saveIndexedLabArtifacts(artifacts: LabArtifact[]): Promise<void> {
  const db = await openLabArchiveDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(LAB_ARCHIVE_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(LAB_ARCHIVE_STORE_NAME);
    for (const artifact of mergeLabArtifacts(artifacts)) {
      store.put(artifact);
    }
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error ?? new Error('Unable to save lab artifact archive.'));
    };
  });
}

function openLabArchiveDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('IndexedDB is unavailable.'));
      return;
    }
    const request = window.indexedDB.open(LAB_ARCHIVE_DB_NAME, LAB_ARCHIVE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LAB_ARCHIVE_STORE_NAME)) {
        const store = db.createObjectStore(LAB_ARCHIVE_STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open lab artifact archive.'));
  });
}
