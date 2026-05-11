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
  EVIDENCE_RECEIPT_KINDS,
  parseApprovalListResponse,
  parseAuditEventRecord,
  parseApprovalRequestRecord,
  parseAuthNonceResponse,
  parseCompletedListResponse,
  parsePlanDraftRecord,
  parsePlanListResponse,
  parseRecurringListResponse,
  parseRecurringOccurrenceRecord,
  parseRecurringScheduleRecord,
  parseSessionResponse,
  formatOccurrenceStatus,
  formatScheduleStatus,
  lifetimeSpendEstimate,
  previewUpcoming,
  type AiGuardrailReport,
  type ApprovalRequestRecord as WorkflowApprovalRequestRecord,
  type AuditEventRecord as WorkflowAuditEventRecord,
  type AuthNonceResponse as WorkflowAuthNonceResponse,
  type CadenceFields,
  type CompletedRecord as WorkflowCompletedRecord,
  type EvidenceReceiptKind,
  type LifetimeSpend,
  type PlanDraftRecord as WorkflowPlanDraftRecord,
  type RecurringOccurrenceRecord as WorkflowRecurringOccurrenceRecord,
  type RecurringScheduleRecord as WorkflowRecurringScheduleRecord,
  type SessionResponse as WorkflowSessionResponse,
  type StatusLabel,
  type TransactionFinalizationRecord as WorkflowTransactionFinalizationRecord,
  workflowDecisionProofMessage,
  workflowFinalizationProofMessage,
} from '@solana-agent-wallet-adapter/workflow';
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
import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';

import {
  AndroidNativeWalletBackend,
  androidNativeCacheSummary,
  detectAndroidNativeEnvironment,
  restoreLatestAndroidNativeWallet,
  type AndroidNativeEnvironment,
  type AndroidNativeRestoreResult,
} from './androidNative.js';
import {
  initializeAnalytics,
  trackCliCommandCopy,
  trackDownloadClick,
  trackGenerateAiPlan,
  trackGenerateTemplatePlan,
  trackNavClick,
  trackPageView,
  trackWalletConnectClick,
  trackWalletConnectSuccess,
} from './analytics.js';
import {
  hostedByokCloudSessionBlockReason,
  shouldAutoSignOutCloudSession,
} from './cloudSessionPolicy.js';
import {
  AI_PROVIDER_PRESETS,
  AGENT_PLAN_TEMPLATES,
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  DEFAULT_AI_PROVIDER_ID,
  aiDiagnosticsFromError,
  aiFormatLabel,
  aiProviderPresetById,
  aiRouteDiagnosticForSettings,
  buildTemplatePlan,
  confirmHostedAiPlanner,
  defaultTemplateFieldValues,
  generateHostedAiPlan,
  generateSessionAiPlan,
  redactSecrets,
  templateById,
  templateFieldLabel,
  type AgentPlan,
  type AgentPlanTemplate,
  type AgentPlanTemplateField,
  type AiDiagnosticEntry,
  type AiSettings,
  type BridgeAiStatus,
} from './planner.js';
import {
  browserWalletPickerOptions,
  browserWalletRestoreName,
  createBrowserWalletSession,
  hasDiscoveredBrowserWalletSelection,
  isPersistedBrowserWalletSession,
  reconcileBrowserWalletSelection,
  visibleBrowserWallets,
  type BrowserWalletSession,
} from './walletSelection.js';
import './styles.css';

type StepState = 'idle' | 'active' | 'done' | 'error';
type StepName = 'discover' | 'connect' | 'sign' | 'transaction' | 'bridge' | 'inbox' | 'lab' | 'ai';
type ActiveTab = 'overview' | 'wallet' | 'agent' | 'generated' | 'inbox' | 'completed' | 'schedule' | 'labs';
type CommandCenterView = 'center' | 'ai' | 'storage';
type CommandCenterIconId = 'wallet' | 'approvals' | 'recurring' | 'proofs';
type ArtifactView = 'create' | 'signed';
type OneTimePlanView = 'create' | 'review';
type RecurringView = 'create' | 'active';
type ToastKind = 'success' | 'error' | 'pending';
type GeneratedPlanStatus = 'draft' | 'signed' | 'queued' | 'archived' | 'failed';
type RuntimePathId = 'exec' | 'install' | 'desktop';
type AppRoute = (typeof ROUTE_PATHS)[number];
type InboxFilter = 'all' | 'ready' | 'scheduled' | 'attention' | 'one-time' | 'recurring';
type CompletedPlanFilter = 'all' | 'one-time' | 'recurring' | 'proofs' | 'receipts';
type ArtifactFilter = 'all' | 'verified' | 'warnings' | 'blocked';
type AppListPageKey = 'review' | 'inbox' | 'recurring' | 'receiptArchive';
type TemplateOutcome = 'queueable' | 'proof' | 'audit';
type TemplateOutcomeFilter = TemplateOutcome | 'all';
type AiPlannerConfirmationStatus = 'untested' | 'confirmed' | 'failed';
type RecurringPresetId = 'scheduled-transfer' | 'subscription';
type InlineReceiptKind = 'intent' | 'rejection' | 'policy' | 'review';
type AuditRecordType = 'plan' | 'approval' | 'completed' | 'evidence';
type PreparedActionKind = 'transfer_sol' | 'transfer_spl' | 'swap' | 'manual_review' | 'read_only' | 'custom_transaction' | 'custom';
type GuidedDemoScenarioId = 'transfer' | 'swap' | 'dca' | 'payouts';
type GuidedDemoStage = 'request' | 'prepared' | 'queued' | 'receipt';
type GuidedDemoDecision = 'pending' | 'approved' | 'denied';
type FirstRunStepId = 'wallet' | 'plan' | 'review' | 'decision' | 'receipt';
type FirstRunActionId =
  | 'discover-wallets'
  | 'connect-wallet'
  | 'open-ai-setup'
  | 'open-create-plan'
  | 'open-review'
  | 'open-inbox'
  | 'open-completed'
  | 'cloud-sign-in';
type PreparedActionStatus =
  | 'scheduled'
  | 'ready'
  | 'overdue'
  | 'approval_pending'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'blocked'
  | 'failed'
  | 'expired';
type PreparedActionTxStatus = 'pending' | 'confirmed' | 'failed';
type RecurringCadence = 'weekly' | 'monthly' | 'interval_days' | 'interval_hours' | 'interval_minutes';
type InstructionData = ConstructorParameters<typeof TransactionInstruction>[0]['data'];
type IosNativeWalletId = 'phantom' | 'solflare' | 'backpack' | 'jupiter';
type WorkflowModePreference = 'auto' | 'local-bridge';
type ActiveWorkflowMode = 'agentic-cloud' | 'browser-workflow' | 'local-bridge';
type WorkflowRecordSource = 'cloud' | 'browser' | 'local-bridge';
type CloudSessionStatus = 'unknown' | 'signed-out' | 'signed-in' | 'unavailable';
type CloudSessionLogoutReason = 'wallet-disconnected' | 'wallet-changed' | 'wallet-mismatch' | 'startup';
type QueueWorkflowResult = { id: string; mode: ActiveWorkflowMode; planRecordId?: string };

interface SelectPickerOption {
  value: string;
  label: string;
  meta?: string;
  detail?: string;
  logoId?: BrandLogoId;
  disabled?: boolean;
  hiddenFromMenu?: boolean;
  title?: string;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

interface JsonObject {
  [key: string]: JsonValue;
}

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
  isDebugBuild?: () => boolean;
  mwaRequest?: (requestId: string, method: string, payloadJson: string) => void;
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
const BRIDGE_TOKEN_SESSION_KEY = 'agentic-local-bridge-token';
const GENERATED_PLANS_STORAGE_KEY = 'solana-agent-wallet-generated-plans-v1';
const BROWSER_WORKFLOW_STORAGE_KEY = 'solana-agent-wallet-browser-workflow-v1';
const GENERATED_PLANS_LIMIT = 100;
const TX_CONFIRMATION_POLL_TIMEOUT_MS = 30_000;
const TX_CONFIRMATION_POLL_INTERVAL_MS = 1_500;
const TX_RETRY_MAX_ATTEMPTS = 2;
const TX_RETRY_DELAY_MS = 2_500;
const LAB_STORAGE_KEY = 'solana-agent-wallet-lab-artifacts-v1';
const LAB_ARCHIVE_DB_NAME = 'solana-agent-wallet-lab-artifacts';
const LAB_ARCHIVE_DB_VERSION = 1;
const LAB_ARCHIVE_STORE_NAME = 'artifacts';
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const KNOWN_BROWSER_TOKENS: Record<string, { symbol: string; mint: string; decimals: number }> = {
  SOL: { symbol: 'SOL', mint: WSOL_MINT, decimals: 9 },
  WSOL: { symbol: 'SOL', mint: WSOL_MINT, decimals: 9 },
  USDC: { symbol: 'USDC', mint: USDC_MINT, decimals: 6 },
};
const EXECUTABLE_BROWSER_ACTION_KINDS = new Set<PreparedActionKind>([
  'transfer_sol',
  'transfer_spl',
  'swap',
  'custom_transaction',
]);
const RELEASE_BASE_URL =
  'https://github.com/mstevens843/solana-agent-wallet-adapter/releases/latest/download';
const RELEASE_PAGE_URL =
  'https://github.com/mstevens843/solana-agent-wallet-adapter/releases/latest';
const NPM_GLOBAL_INSTALL_COMMAND = 'npm install -g @solana-agent-wallet-adapter/cli';
const NPM_EXEC_COMMAND = 'npm exec @solana-agent-wallet-adapter/cli -- app';
const INSTALLED_APP_COMMAND = 'solana-agent-wallet app';
const BROWSER_SESSION_DEFAULT_PROVIDER_ID = 'openrouter';
const OPENAI_BROWSER_SESSION_DISABLED_REASON =
  'OpenAI cannot be called directly from Browser Session. Use Hosted BYOK or Local bridge for OpenAI.';
const HOSTED_CUSTOM_PROVIDER_DISABLED_REASON =
  'Hosted BYOK supports preset providers only. Use Local bridge or Browser Session for custom gateways.';
const ANDROID_HOSTED_BYOK_DISABLED_REASON =
  'Hosted BYOK needs the hosted web app API. The Android app is a bundled local shell; use Browser Session or Local bridge.';
const BROWSER_AI_LIMITATIONS = [
  'Provider may block direct browser calls.',
  'Key lives only in the current browser runtime.',
  'Browser AI cannot run background jobs after the tab closes.',
];
const CUSTOM_AI_MODEL_VALUE = '__custom__';
const ROUTE_PATHS = ['/', '/docs', '/app', '/cli', '/desktop', '/android', '/demo', '/mwa-test', '/privacy', '/terms'] as const;
const ROUTE_PATH_SET = new Set<string>(ROUTE_PATHS);
const SHOW_DEV_CONTROLS = resolveDevControls();
const IS_ANDROID_APP = resolveAndroidAppSurface();
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
  | 'agentRouter'
  | 'backpack'
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'jupiter'
  | 'phantom'
  | 'solana'
  | 'solanaMobile'
  | 'solflare'
  | 'vercel';

const BRAND_LOGOS: Record<BrandLogoId, string> = {
  agentRouter: new URL('./assets/logos/agent-router.svg', import.meta.url).href,
  backpack: new URL('./assets/logos/backpack.svg', import.meta.url).href,
  claude: new URL('./assets/logos/claude.svg', import.meta.url).href,
  codex: new URL('./assets/logos/codex.svg', import.meta.url).href,
  gemini: new URL('./assets/logos/gemini.svg', import.meta.url).href,
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
  linkHref?: string;
  linkLabel?: string;
}

interface AiPlannerConfirmationState {
  status: AiPlannerConfirmationStatus;
  key: string;
  message: string;
  checkedAt: string;
}

interface CloudSessionState {
  status: CloudSessionStatus;
  walletAddress: string;
  expiresAt: string;
  error: string;
}

type CloudSessionResponse = WorkflowSessionResponse;
type CloudAuthNonceResponse = WorkflowAuthNonceResponse;
type CloudWorkspaceDeleteIntentResponse = CloudAuthNonceResponse;
type CloudPlanDraftRecord = WorkflowPlanDraftRecord;
type CloudApprovalRequestRecord = WorkflowApprovalRequestRecord;
type CloudCompletedRecord = WorkflowCompletedRecord;
type CloudTransactionFinalizationRecord = WorkflowTransactionFinalizationRecord;

interface CloudWorkspaceDeleteCounts {
  plans?: number;
  approvals?: number;
  transactionFinalizations?: number;
  recurringSchedules?: number;
  recurringOccurrences?: number;
  recurringNotificationDeliveries?: number;
  evidenceReceipts?: number;
  completedRecords?: number;
  auditEvents?: number;
  nonces?: number;
  sessions?: number;
  users?: number;
}

interface CloudWorkspaceDeleteResponse {
  ok: boolean;
  signedOut: boolean;
  deleted: CloudWorkspaceDeleteCounts;
}

interface GeneratedPlanRecord {
  id: string;
  plan: AgentPlan;
  createdAt: string;
  updatedAt: string;
  source: AgentPlan['source'];
  templateId: string;
  templateTitle: string;
  prompt: string;
  walletAddress: string;
  cluster: Cluster;
  status: GeneratedPlanStatus;
  signature?: string;
  preparedActionId?: string;
  error?: string;
  failureLabel?: string;
  workflowSource?: WorkflowRecordSource;
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
  decisionProofParams?: Record<string, unknown>;
  dueAt: string;
  createdAt: string;
  updatedAt: string;
  activeRequestId?: string;
  txid?: string;
  txStatus?: PreparedActionTxStatus;
  confirmationStatus?: string;
  finalizationId?: string;
  finalizationStatus?: string;
  transactionHash?: string;
  messageHash?: string;
  quoteHash?: string;
  simulationHash?: string;
  finalization?: CloudTransactionFinalizationRecord;
  confirmedAt?: string;
  txError?: string;
  error?: string;
  note?: string;
  planDraftId?: string;
  recurringId?: string;
  occurrenceKey?: string;
  archived?: boolean;
  workflowSource?: WorkflowRecordSource;
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
  expiresAt?: string;
  notifications?: {
    inApp?: boolean;
    webhookUrl?: string;
  };
  lifetimeSpend?: LifetimeSpend;
  nextRuns?: string[];
  note?: string;
  createdAt: string;
  updatedAt: string;
  nextDueAt?: string;
  workflowSource?: WorkflowRecordSource;
}

interface RecurringOccurrenceHistoryItem extends WorkflowRecurringOccurrenceRecord {
  statusLabel?: StatusLabel;
  approval?: {
    id: string;
    status: string;
    decidedAt?: string;
    txid?: string;
    txStatus?: string;
    explorerUrl?: string;
  };
  completed?: {
    id: string;
    status: string;
    completedAt: string;
    txid?: string;
    explorerUrl?: string;
  };
}

interface RecurringOccurrenceHistoryState {
  occurrences: RecurringOccurrenceHistoryItem[];
  nextCursor?: string;
  loadedAt?: string;
  error?: string;
}

interface RecurringNotificationDelivery {
  id: string;
  type: string;
  scheduleId: string;
  occurrenceId: string;
  status: 'pending' | 'delivered' | 'failed' | 'abandoned';
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  deliveredAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface RecurringNotificationStatusState {
  enabled: boolean;
  webhookUrl?: string;
  lastDelivery?: RecurringNotificationDelivery;
  deliveries: RecurringNotificationDelivery[];
  loadedAt?: string;
  error?: string;
}

interface RecurringWebhookSecretReveal {
  scheduleId: string;
  secret: string;
  createdAt: string;
}

interface ActionReceipt {
  actionId: string;
  status: PreparedActionStatus;
  txStatus?: PreparedActionTxStatus;
  txid?: string;
  explorerUrl?: string;
  proofSignature?: string;
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

interface BrowserTransactionExecution {
  txid: string;
  txStatus: PreparedActionTxStatus;
  explorerUrl: string;
  result?: Record<string, unknown>;
}

interface TransactionToastContext {
  toastId: number;
  actionId?: string;
  cluster: Cluster;
}

interface BrowserLatestBlockhash {
  blockhash: string;
  lastValidBlockHeight?: number;
}

interface BrowserSendTransactionResponse {
  txid?: string;
  signature?: string;
}

interface BrowserSignatureStatusResponse {
  txStatus?: string;
  confirmationStatus?: string;
  error?: string;
}

interface BrowserTokenMetadata {
  symbol: string;
  mint: PublicKey;
  mintText: string;
  decimals: number;
  tokenProgramId: PublicKey;
}

interface BrowserWorkflowState {
  preparedActions: PreparedAction[];
  recurringPayments: RecurringPayment[];
  receipts: ActionReceipt[];
}

interface CompletedPlanRecord {
  id: string;
  kind: 'one-time' | 'recurring';
  status: string;
  tone: string;
  title: string;
  summary: string;
  completedAt: string;
  createdAt: string;
  walletAddress: string;
  cluster: Cluster;
  amount?: string;
  token?: string;
  recipient?: string;
  signature?: string;
  txid?: string;
  explorerUrl?: string;
  generatedPlanId?: string;
  actionId?: string;
  recurringId?: string;
  occurrenceKey?: string;
  copyPayload: string;
  trustBundlePayload?: string;
  detailRows: Array<[string, string]>;
  workflowSource?: WorkflowRecordSource;
  decisionProofVerified?: boolean;
  decisionProofMessage?: string;
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
  category: 'receipt' | 'advanced';
  summary: string;
  whatThisProves: string;
  recommendedUse: string;
  fields?: LabFieldDefinition[];
}

interface LabFieldDefinition {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'select';
  required: boolean;
  placeholder?: string;
  options?: string[];
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
  metadata?: JsonObject;
  cloudReceiptId?: string;
  bridgeArchived?: boolean;
}

interface LabPayload {
  status: 'approved' | 'blocked' | 'warn' | 'observed';
  thesis: string;
  nextSignatureGate: string;
  metrics: Array<{ label: string; value: string; tone: 'good' | 'warn' | 'danger' | 'neutral' }>;
  evidence: Array<{ title: string; detail: string; tone: 'good' | 'warn' | 'danger' | 'neutral'; hash: string }>;
  receiptType?: string;
  summary?: string;
  verdict?: string;
  effect?: string;
  whatThisProves?: string;
  recommendedUse?: string;
  fieldValues?: Record<string, string>;
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
  expiresAt: string;
  webhookUrl: string;
  note: string;
}

interface RecurringPreset {
  id: RecurringPresetId;
  title: string;
  badge: string;
  description: string;
  draft: Partial<RecurringDraft>;
}

interface GuidedDemoScenario {
  id: GuidedDemoScenarioId;
  eyebrow: string;
  title: string;
  prompt: string;
  detail: string;
  planTitle: string;
  route: string;
  risk: string;
  approvalBoundary: string;
  receiptType: string;
  receiptSummary: string;
  constraints: string[];
  facts: Array<{ label: string; value: string }>;
}

interface GuidedDemoState {
  selectedScenarioId: GuidedDemoScenarioId;
  stage: GuidedDemoStage;
  decision: GuidedDemoDecision;
  receiptId: string;
  receiptCreatedAt: string;
  receiptJson: string;
  signedReceipt: string;
}

interface FirstRunStep {
  id: FirstRunStepId;
  label: string;
  detail: string;
  complete: boolean;
  active: boolean;
}

interface FirstRunAction {
  id: FirstRunActionId;
  label: string;
  detail: string;
  disabled?: boolean;
}

interface PersistedState {
  selectedWalletName?: string;
  browserWalletSession?: BrowserWalletSession;
  selectedIosWalletId?: IosNativeWalletId;
  workflowModePreference?: WorkflowModePreference;
  cluster?: Cluster;
  bridgeUrl?: string;
  aiMode?: AiSettings['mode'];
  aiProvider?: AiSettings['provider'];
  aiApiFormat?: AiSettings['apiFormat'];
  aiBaseUrl?: string;
  aiModel?: string;
}

interface DemoState {
  activeTab: ActiveTab;
  commandCenterView: CommandCenterView;
  oneTimePlanView: OneTimePlanView;
  recurringView: RecurringView;
  artifactView: ArtifactView;
  completedPlanFilter: CompletedPlanFilter;
  selectedRuntimePath: RuntimePathId;
  recentCopyId: string;
  guidedDemo: GuidedDemoState;
  inboxFilter: InboxFilter;
  listPages: Record<AppListPageKey, number>;
  workflowModePreference: WorkflowModePreference;
  cloudSession: CloudSessionState;
  cloudWorkspaceDeleteModalOpen: boolean;
  wallets: DiscoveredWallet[];
  selectedWalletName: string;
  browserWalletPickerOpen: boolean;
  browserWalletSession?: BrowserWalletSession;
  androidNativeEnvironment: AndroidNativeEnvironment;
  androidAuthCacheCount: number;
  androidNativeStatus: string;
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
  templateOutcomeFilter: TemplateOutcomeFilter;
  templateFields: Record<string, string>;
  templateFieldErrors: Record<string, string>;
  agentPlan: AgentPlan | null;
  agentSignature: string;
  agentPreparedActionId: string;
  generatedPlans: GeneratedPlanRecord[];
  selectedGeneratedPlanId: string;
  generatedPlanAuditId: string;
  showArchivedGeneratedPlans: boolean;
  workspaceStoragePanelOpen: boolean | null;
  aiSettings: AiSettings;
  aiSettingsPanelOpen: boolean | null;
  aiStatus: BridgeAiStatus | null;
  aiDiagnostics: AiDiagnosticEntry[];
  aiPlannerConfirmation: AiPlannerConfirmationState;
  toasts: Toast[];
  capabilities: AdapterCapabilities | null;
  error: string;
  busy: boolean;
  activeOperation: 'generate-template-plan' | 'generate-ai-plan' | 'confirm-ai-planner' | null;
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
  cloudCompletedPlans: CompletedPlanRecord[];
  cloudLastSync: string;
  lastCompletedFocusId: string;
  recurringDraft: RecurringDraft;
  recurringPreset: RecurringPresetId;
  recurringErrors: Record<string, string>;
  recurringOccurrenceHistory: Record<string, RecurringOccurrenceHistoryState>;
  recurringNotificationStatus: Record<string, RecurringNotificationStatusState>;
  recurringWebhookSecretOnce: RecurringWebhookSecretReveal | null;
  mwaEnvironment: MwaEnvironment;
  mwaRegistration: RegisterAgentMobileWalletAdapterResult | null;
  activeLab: string;
  labInputs: Record<string, string>;
  labFieldValues: Record<string, Record<string, string>>;
  labFieldErrors: Record<string, string>;
  labArtifacts: LabArtifact[];
  labArchiveStatus: string;
  cloudEvidenceStatus: string;
  cloudEvidenceLastSyncAt: number;
  artifactFilter: ArtifactFilter;
  artifactTypeFilter: string;
  artifactSearch: string;
  auditOpen: Record<string, boolean>;
  auditActivity: Record<string, AuditActivityState>;
  steps: Record<StepName, StepState>;
}

interface AuditActivityState {
  status: 'idle' | 'loading' | 'loaded' | 'error';
  events: WorkflowAuditEventRecord[];
  error?: string;
  loadedAt?: string;
}

const RECEIPT_LABS: LabDefinition[] = [
  {
    id: 'intent-receipt',
    title: 'Intent',
    kind: 'intent_receipt',
    category: 'receipt',
    defaultInput: '',
    description: 'Sign the requested action and the constraints that must stay true before any wallet approval.',
    summary: 'A wallet-signed proof of what you intended to review or do.',
    whatThisProves: 'The action, limits, and review context existed before any transaction approval.',
    recommendedUse: 'Use it before approval when you want a record of the exact request and constraints.',
    fields: [
      {
        id: 'request',
        label: 'Requested action',
        type: 'textarea',
        required: true,
        placeholder: 'Swap 0.05 SOL to USDC, send 10 USDC, review this Blink, etc.',
      },
      {
        id: 'constraints',
        label: 'Required constraints',
        type: 'textarea',
        required: true,
        placeholder: 'Max slippage, allowed programs, recipient, deadline, no authority grants, or other caps.',
      },
      {
        id: 'context',
        label: 'Context / source',
        type: 'text',
        required: false,
        placeholder: 'Optional app, agent, ticket, or reason.',
      },
    ],
  },
  {
    id: 'policy-receipt',
    title: 'Approval Decision',
    kind: 'policy_receipt',
    category: 'receipt',
    defaultInput: '',
    description: 'Sign that a wallet rule or personal policy was checked for this request.',
    summary: 'A wallet-signed proof that a policy check happened.',
    whatThisProves: 'The user had a stated rule and checked the request against it before taking action.',
    recommendedUse: 'Use it for spend caps, slippage rules, recipient checks, custody rules, or allowed actions.',
    fields: [
      {
        id: 'policy',
        label: 'Policy checked',
        type: 'textarea',
        required: true,
        placeholder: 'Never sign unlimited approvals. Swaps must stay below 100 bps slippage. No private key sharing.',
      },
      {
        id: 'request',
        label: 'Request being checked',
        type: 'textarea',
        required: true,
        placeholder: 'Describe the agent request, transaction preview, or approval proposal.',
      },
      {
        id: 'result',
        label: 'Policy result',
        type: 'select',
        required: true,
        options: ['Recorded', 'Pass', 'Warning', 'Blocked'],
      },
    ],
  },
  {
    id: 'risk-receipt',
    title: 'Risk Review',
    kind: 'risk_review_receipt',
    category: 'receipt',
    defaultInput: '',
    description: 'Sign the risks reviewed before a wallet decision.',
    summary: 'A wallet-signed proof that specific risks were reviewed.',
    whatThisProves: 'Specific risks were reviewed before a later approval, rejection, or support/audit discussion.',
    recommendedUse: 'Use it before swaps, transfers, new protocols, links, or any route that needs review.',
    fields: [
      {
        id: 'request',
        label: 'Request reviewed',
        type: 'textarea',
        required: true,
        placeholder: 'Describe the payment, swap, app interaction, link, or agent action.',
      },
      {
        id: 'risks',
        label: 'Risks checked',
        type: 'textarea',
        required: true,
        placeholder: 'Unknown programs, authority changes, slippage, route drift, fees, recipient, simulation result.',
      },
      {
        id: 'verdict',
        label: 'Risk verdict',
        type: 'select',
        required: true,
        options: ['Recorded', 'Warning', 'Blocked'],
      },
    ],
  },
  {
    id: 'rejection-receipt',
    title: 'Rejection',
    kind: 'rejection_receipt',
    category: 'receipt',
    defaultInput: '',
    description: 'Sign why a request was refused without exposing private wallet data.',
    summary: 'A wallet-signed proof that you rejected a request.',
    whatThisProves: 'The user intentionally rejected a request for a stated reason at a specific time.',
    recommendedUse: 'Use it to document unsafe agent requests, policy violations, support disputes, or blocked approvals.',
    fields: [
      {
        id: 'request',
        label: 'Rejected request',
        type: 'textarea',
        required: true,
        placeholder: 'Describe what the agent, site, or transaction asked for.',
      },
      {
        id: 'reason',
        label: 'Reason for rejection',
        type: 'textarea',
        required: true,
        placeholder: 'Unlimited approval, unknown custody, wrong recipient, route mismatch, private key request, etc.',
      },
      {
        id: 'policy',
        label: 'Policy triggered',
        type: 'text',
        required: false,
        placeholder: 'Optional rule or policy this violated.',
      },
    ],
  },
  {
    id: 'tool-trace-receipt',
    title: 'Tool Trace',
    kind: 'tool_trace_receipt',
    category: 'receipt',
    defaultInput: '',
    description: 'Sign which tools, data, or checks an agent used before asking for wallet approval.',
    summary: 'A wallet-signed record of the tool/data trail behind a request.',
    whatThisProves: 'The listed tools, data, and result summary were part of the review context.',
    recommendedUse: 'Use it when an agent gathered quotes, simulations, balances, policy checks, or portfolio data.',
    fields: [
      {
        id: 'task',
        label: 'Agent task',
        type: 'textarea',
        required: true,
        placeholder: 'What the agent was asked to prepare or review.',
      },
      {
        id: 'tools',
        label: 'Tools / data used',
        type: 'textarea',
        required: true,
        placeholder: 'Quote API, simulation, balance read, policy diff, portfolio read, transaction decoder, etc.',
      },
      {
        id: 'result',
        label: 'Result summary',
        type: 'textarea',
        required: false,
        placeholder: 'Optional short conclusion from the tools.',
      },
    ],
  },
];

const ADVANCED_EVIDENCE_LABS: LabDefinition[] = [
  {
    id: 'flight',
    title: 'Flight Recorder',
    kind: 'agent_flight_recorder',
    category: 'advanced',
    defaultInput:
      'Swap 0.05 SOL to USDC only if simulation shows no new authority grants and the route stays within 50 bps slippage.',
    description: "Bind the agent's stated intent, plan, tool trace, and risk interpretation to the wallet signature.",
    summary: 'Experimental record that binds agent intent, plan, tool trace, and risk interpretation.',
    whatThisProves: 'The stated intent and risk interpretation were signed at a specific review moment.',
    recommendedUse: 'Use only when testing advanced evidence concepts or demos.',
  },
  {
    id: 'auction',
    title: 'Intent Auctions',
    kind: 'signed_intent_auction',
    category: 'advanced',
    defaultInput: 'Ask three quote agents for the best SOL to USDC route and select only offers matching my caps.',
    description: 'Sign demand once, then let competing agents attach auditable offers without gaining custody.',
    summary: 'Experimental record for comparing offers against a signed demand.',
    whatThisProves: 'The demand and caps existed before attached offers were reviewed.',
    recommendedUse: 'Use only when testing agent-market or quote-auction concepts.',
  },
  {
    id: 'cosigner',
    title: 'Risk Co-Signers',
    kind: 'risk_cosigner_market',
    category: 'advanced',
    defaultInput: 'Review this swap request for unknown programs, authority deltas, route drift, and hidden approvals.',
    description: 'Collect multiple agent reviews before the wallet opens for the final settlement signature.',
    summary: 'Experimental record for multiple agent risk reviews.',
    whatThisProves: 'A risk-review request was signed before final wallet approval.',
    recommendedUse: 'Use only when testing multi-agent risk review concepts.',
  },
  {
    id: 'rejection',
    title: 'Rejection Intelligence',
    kind: 'rejection_fingerprint',
    category: 'advanced',
    defaultInput: 'Reject any request that mentions unlimited approvals, private keys, or unknown custody delegation.',
    description: 'Turn a rejection into a reusable local safety fingerprint.',
    summary: 'Experimental local safety fingerprint for refused requests.',
    whatThisProves: 'A refusal pattern was signed as local evidence.',
    recommendedUse: 'Prefer Rejection Receipt for normal public use.',
  },
  {
    id: 'semantic',
    title: 'Semantic Firewall',
    kind: 'semantic_firewall',
    category: 'advanced',
    defaultInput: 'Allow SOL to USDC swap semantics only when touched programs and authority changes match the explanation.',
    description: 'Compare what the agent says with what the eventual transaction does.',
    summary: 'Experimental comparison between agent explanation and transaction semantics.',
    whatThisProves: 'A semantic policy was signed before comparing against a later transaction.',
    recommendedUse: 'Use only when testing transaction-explanation matching.',
  },
  {
    id: 'nonaction',
    title: 'Proof of Non-Action',
    kind: 'signed_non_action',
    category: 'advanced',
    defaultInput: 'Do nothing unless SOL drops below the signed threshold and liquidity remains above the floor.',
    description: 'Prove the agent checked conditions and intentionally avoided a wallet action.',
    summary: 'Experimental record that a checked condition did not trigger action.',
    whatThisProves: 'The agent/user intentionally avoided a wallet action under stated conditions.',
    recommendedUse: 'Use only when testing non-action or restraint proofs.',
  },
  {
    id: 'reputation',
    title: 'Agent Reputation',
    kind: 'agent_reputation',
    category: 'advanced',
    defaultInput: 'Score the agent based on signed successes, rejections, warnings, and restraint proofs.',
    description: 'Make behavior portable across apps through wallet-signed outcome records.',
    summary: 'Experimental reputation record for agent behavior across apps.',
    whatThisProves: 'A reputation score or outcome summary was signed by the wallet.',
    recommendedUse: 'Use only when testing agent reputation concepts.',
  },
  {
    id: 'blinks',
    title: 'Agent-Reviewed Links',
    kind: 'agent_reviewed_blink',
    category: 'advanced',
    defaultInput: 'Review this Blink claim, summarize cost and authority deltas, and attach the signed interpretation.',
    description: 'Carry agent interpretation beside a Solana Action before wallet settlement.',
    summary: 'Experimental signed interpretation for Solana Actions or links.',
    whatThisProves: 'The wallet signed an interpretation of a link or action before settlement.',
    recommendedUse: 'Prefer Risk Review Receipt for normal link review.',
  },
  {
    id: 'capsule',
    title: 'Intent Time Capsules',
    kind: 'intent_time_capsule',
    category: 'advanced',
    defaultInput: 'Seal an intent that can open later only if price, route, deadline, and slippage all match.',
    description: 'Sign future permission without allowing arbitrary future execution.',
    summary: 'Experimental time-boxed intent envelope.',
    whatThisProves: 'The user signed a future intent envelope with stated conditions.',
    recommendedUse: 'Use only when testing delayed intent concepts.',
  },
  {
    id: 'delegation',
    title: 'Sub-Agent Delegation',
    kind: 'sub_agent_delegation',
    category: 'advanced',
    defaultInput: 'Delegate quote, risk, tax tag, and final explanation slices to specialist agents.',
    description: 'Let agents hire specialists while every responsibility slice remains signed and auditable.',
    summary: 'Experimental record for delegated agent responsibility slices.',
    whatThisProves: 'A delegation scope was signed before specialists acted.',
    recommendedUse: 'Use only when testing sub-agent coordination.',
  },
  {
    id: 'outcome',
    title: 'Outcome Signatures',
    kind: 'outcome_signature',
    category: 'advanced',
    defaultInput: 'Authorize only the acceptable end state: minimum USDC output, no authority grants, and capped fees.',
    description: 'Give agents path freedom while the wallet signs the acceptable result envelope.',
    summary: 'Experimental result-envelope signature.',
    whatThisProves: 'The acceptable outcome was signed before route selection or execution.',
    recommendedUse: 'Use only when testing outcome-constrained agents.',
  },
  {
    id: 'insurance',
    title: 'Request Insurance',
    kind: 'request_insurance',
    category: 'advanced',
    defaultInput: 'Quote coverage for route mismatch, simulation divergence, and known exploit classes.',
    description: 'Show deterministic risk-transfer terms beside the signing request.',
    summary: 'Experimental risk-transfer terms attached to an approval request.',
    whatThisProves: 'Insurance or coverage terms were signed as context.',
    recommendedUse: 'Use only when testing insurance-style request metadata.',
  },
  {
    id: 'constitution',
    title: 'Personal Constitution',
    kind: 'personal_constitution',
    category: 'advanced',
    defaultInput: 'My wallet never signs unlimited approvals, mainnet-first tests, or swaps above 100 bps slippage.',
    description: 'Diff each request against a portable wallet-signed personal policy.',
    summary: 'Experimental portable wallet policy.',
    whatThisProves: 'A personal wallet policy existed before request review.',
    recommendedUse: 'Prefer Policy Receipt for normal public use.',
  },
  {
    id: 'receipts',
    title: 'Tool Receipts',
    kind: 'tool_receipts',
    category: 'advanced',
    defaultInput: 'Attach hashes for portfolio read, quote, simulation, policy diff, and final explanation tools.',
    description: 'Prove which tools and data the agent actually used before requesting approval.',
    summary: 'Experimental tool-hash receipt.',
    whatThisProves: 'Tool hashes and data references were signed as review context.',
    recommendedUse: 'Prefer Tool Trace Receipt for normal public use.',
  },
  {
    id: 'apprentice',
    title: 'Apprenticeship Mode',
    kind: 'apprenticeship_mode',
    category: 'advanced',
    defaultInput: 'Run five training scenarios and score the agent before granting live signing authority.',
    description: 'Require signed predictions and scorecards before an agent graduates to production signing.',
    summary: 'Experimental agent training scorecard.',
    whatThisProves: 'Training scenarios or scorecards were signed before production use.',
    recommendedUse: 'Use only when testing agent evaluation workflows.',
  },
];

const LABS: LabDefinition[] = [...RECEIPT_LABS, ...ADVANCED_EVIDENCE_LABS];

const persisted = loadPersistedState();
const launchParams = readLaunchParams();
clearSensitiveLaunchParams();
const initialCluster = SHOW_DEV_CONTROLS ? (persisted.cluster ?? 'mainnet-beta') : 'mainnet-beta';
const initialTemplate = templateById('swap');
const defaultWorkspaceTab: ActiveTab = 'overview';
const initialAiSettings = persistedAiSettings(persisted);
const initialBrowserWorkflow = loadBrowserWorkflowState();
const RECURRING_TOKEN_OPTIONS = ['SOL', 'USDC', 'PYUSD'];

const RECURRING_PRESETS: RecurringPreset[] = [
  {
    id: 'scheduled-transfer',
    title: 'Scheduled transfer',
    badge: 'Payment',
    description: 'Send the same token amount to one recipient on a repeat schedule. Each due item still needs approval.',
    draft: {
      token: 'SOL',
      amount: '0.01',
      cadence: 'weekly',
      note: 'Repeat scheduled transfer',
    },
  },
  {
    id: 'subscription',
    title: 'Subscription / allowance',
    badge: 'Allowance',
    description: 'Create a capped recurring payment without granting unlimited authority.',
    draft: {
      token: 'USDC',
      amount: '5',
      cadence: 'monthly',
      note: 'Repeat user-approved payment',
    },
  },
];

const GUIDED_DEMO_SCENARIOS: ReadonlyArray<GuidedDemoScenario> = [
  {
    id: 'transfer',
    eyebrow: 'One-time transfer',
    title: '0.2 SOL transfer',
    prompt: 'Prepare a 0.2 SOL transfer. Don\'t send until I approve.',
    detail: 'The agent prepares the payment terms, but the wallet still owns the final approve or deny step.',
    planTitle: 'Prepared SOL transfer for wallet review',
    route: 'New Request -> Needs Approval',
    risk: 'Confirm the recipient, amount, cluster, and network fee before approving the final wallet request.',
    approvalBoundary: 'No transaction is signed or submitted until you approve it from the wallet review step.',
    receiptType: 'one_time_transfer_receipt',
    receiptSummary: 'A bounded SOL transfer was prepared and reviewed before wallet approval.',
    constraints: [
      'Amount is capped at 0.2 SOL.',
      'Recipient must match the final wallet review.',
      'No recurring allowance or delegated signer is created.',
      'User approval is required before any send.',
    ],
    facts: [
      { label: 'Action', value: 'Send SOL' },
      { label: 'Amount', value: '0.2 SOL max' },
      { label: 'Custody', value: 'User wallet' },
    ],
  },
  {
    id: 'swap',
    eyebrow: 'Swap review',
    title: 'SOL to USDC swap',
    prompt: 'Swap SOL to USDC if slippage stays under 1%.',
    detail: 'The agent turns a plain-English swap into a route, limits, and wallet approval boundary.',
    planTitle: 'Prepared Jupiter-style swap review',
    route: 'New Request -> Needs Approval',
    risk: 'Review price impact, route programs, minimum output, and final quote before approving.',
    approvalBoundary: 'The agent can prepare route context, but only the wallet can approve the swap signature.',
    receiptType: 'swap_review_receipt',
    receiptSummary: 'A swap request was constrained by a 1% slippage cap before review.',
    constraints: [
      'Maximum slippage is 100 bps.',
      'Final wallet quote must show the actual minimum output.',
      'Unexpected authority grants should be rejected.',
      'Route changes require a fresh wallet review.',
    ],
    facts: [
      { label: 'Route', value: 'SOL -> USDC' },
      { label: 'Limit', value: '1% slippage' },
      { label: 'Signer', value: 'Wallet only' },
    ],
  },
  {
    id: 'dca',
    eyebrow: 'Repeat payment',
    title: 'Weekly capped DCA',
    prompt: 'Create a weekly DCA plan with a max spend cap. Each run waits for my approval.',
    detail: 'The agent prepares the repeat payment; every due payment still returns for approve or deny.',
    planTitle: 'Prepared weekly DCA schedule',
    route: 'Repeat Payments -> Needs Approval payment',
    risk: 'Repeat payments should keep a clear max spend, cadence, token pair, and manual review rule.',
    approvalBoundary:
      'The schedule only prepares future requests. Each occurrence still requires wallet approval before funds move.',
    receiptType: 'recurring_schedule_receipt',
    receiptSummary: 'A weekly DCA schedule was prepared with a spend cap and manual approval on each run.',
    constraints: [
      'Weekly cadence only.',
      'Spend cap must be visible before schedule creation.',
      'Each future run still needs explicit approval.',
      'Every due payment appears in Needs Approval.',
      'User can pause, resume, or delete the schedule.',
    ],
    facts: [
      { label: 'Cadence', value: 'Weekly' },
      { label: 'Limit', value: 'Capped spend' },
      { label: 'Review', value: 'Every run' },
    ],
  },
  {
    id: 'payouts',
    eyebrow: 'Team payouts',
    title: 'Contributor queue',
    prompt: 'Queue contributor payouts for wallet review. Let me approve each payout individually.',
    detail: 'The agent prepares the payout queue, but each recipient payment stays individually reviewable.',
    planTitle: 'Prepared contributor payout queue',
    route: 'New Request -> Needs Approval batch',
    risk: 'Check every recipient, memo, token, and payout amount before approving individual requests.',
    approvalBoundary:
      'The agent can prepare the payout list; each payout still needs wallet approval before sending.',
    receiptType: 'payout_queue_receipt',
    receiptSummary: 'Contributor payouts were queued for individual wallet review instead of auto-sending.',
    constraints: [
      'Each recipient needs a visible payout line.',
      'No unlimited token approval is requested.',
      'Each payout can be approved or denied individually.',
      'Receipts stay attached to the approval decision.',
    ],
    facts: [
      { label: 'Workload', value: 'Batch queue' },
      { label: 'Control', value: 'Per payout' },
      { label: 'Record', value: 'Receipt kept' },
    ],
  },
];

function defaultGuidedDemoState(scenarioId: GuidedDemoScenarioId = 'transfer'): GuidedDemoState {
  return {
    selectedScenarioId: scenarioId,
    stage: 'request',
    decision: 'pending',
    receiptId: '',
    receiptCreatedAt: '',
    receiptJson: '',
    signedReceipt: '',
  };
}

const state: DemoState = {
  activeTab: defaultWorkspaceTab,
  commandCenterView: 'center',
  oneTimePlanView: 'create',
  recurringView: 'create',
  artifactView: 'create',
  completedPlanFilter: 'all',
  selectedRuntimePath: 'exec',
  recentCopyId: '',
  guidedDemo: defaultGuidedDemoState(),
  inboxFilter: 'all',
  listPages: {
    review: 1,
    inbox: 1,
    recurring: 1,
    receiptArchive: 1,
  },
  workflowModePreference: persisted.workflowModePreference ?? 'auto',
  cloudSession: {
    status: 'unknown',
    walletAddress: '',
    expiresAt: '',
    error: '',
  },
  cloudWorkspaceDeleteModalOpen: false,
  wallets: [],
  selectedWalletName: persisted.browserWalletSession?.cluster === initialCluster ? persisted.browserWalletSession.walletName : '',
  browserWalletPickerOpen: false,
  browserWalletSession: persisted.browserWalletSession,
  androidNativeEnvironment: detectAndroidNativeEnvironment(),
  androidAuthCacheCount: 0,
  androidNativeStatus: 'Android native MWA idle.',
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
  templateOutcomeFilter: 'queueable',
  templateFields: defaultTemplateFieldValues(initialTemplate),
  templateFieldErrors: {},
  agentPlan: null,
  agentSignature: '',
  agentPreparedActionId: '',
  generatedPlans: [],
  selectedGeneratedPlanId: '',
  generatedPlanAuditId: '',
  showArchivedGeneratedPlans: false,
  workspaceStoragePanelOpen: null,
  aiSettings: {
    ...initialAiSettings,
    apiKey: '',
  },
  aiSettingsPanelOpen: null,
  aiStatus: null,
  aiDiagnostics: [],
  aiPlannerConfirmation: {
    status: 'untested',
    key: '',
    message: '',
    checkedAt: '',
  },
  toasts: [],
  capabilities: null,
  error: '',
  busy: false,
  activeOperation: null,
  cluster: initialCluster,
  bridgeUrl: launchParams.bridgeUrl ?? persisted.bridgeUrl ?? DEFAULT_BRIDGE_URL,
  bridgeToken: launchParams.bridgeToken ?? sessionBridgeToken() ?? DEFAULT_BRIDGE_TOKEN,
  bridgeActive: false,
  bridgeStatus: 'Bridge idle.',
  bridgeRpcUrl: '',
  health: null,
  balances: null,
  preparedActions: initialBrowserWorkflow.preparedActions,
  materializedActions: initialBrowserWorkflow.preparedActions,
  recurringPayments: initialBrowserWorkflow.recurringPayments,
  receipts: initialBrowserWorkflow.receipts,
  cloudCompletedPlans: [],
  cloudLastSync: '',
  lastCompletedFocusId: '',
  recurringDraft: defaultRecurringDraft(),
  recurringPreset: 'scheduled-transfer',
  recurringErrors: {},
  recurringOccurrenceHistory: {},
  recurringNotificationStatus: {},
  recurringWebhookSecretOnce: null,
  mwaEnvironment: detectMwaEnvironment(),
  mwaRegistration: null,
  activeLab: LABS[0]!.id,
  labInputs: defaultLabInputs(),
  labFieldValues: defaultLabFieldValues(),
  labFieldErrors: {},
  labArtifacts: loadLabArtifacts(),
  labArchiveStatus: 'Browser archive loading.',
  cloudEvidenceStatus: 'Cloud evidence archive: sign in to also store receipts in Agentic Cloud.',
  cloudEvidenceLastSyncAt: 0,
  artifactFilter: 'all',
  artifactTypeFilter: 'all',
  artifactSearch: '',
  auditOpen: {},
  auditActivity: {},
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
let artifactPickerController: AbortController | null = null;
let selectPickerController: AbortController | null = null;

const appRoot = document.querySelector<HTMLDivElement>('#app');

void startApp();

async function startApp(): Promise<void> {
  try {
    if (!appRoot) {
      throw new Error('Missing #app');
    }
    initializeAnalytics();
    normalizeInitialRoute();
    hydrateGeneratedPlansForStartup();
    render();
    window.addEventListener('popstate', () => render());
    window.addEventListener('keydown', handleGlobalKeydown);
    await bootstrap();
  } catch (err) {
    renderStartupFailure(err);
  }
}

function handleGlobalKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && state.cloudWorkspaceDeleteModalOpen) {
    event.preventDefault();
    closeCloudWorkspaceDeleteModal();
    return;
  }
  if (event.key === 'Escape' && state.generatedPlanAuditId) {
    event.preventDefault();
    closeGeneratedPlanAuditModal();
  }
}

function hydrateGeneratedPlansForStartup(): void {
  try {
    const plans = loadGeneratedPlans();
    state.generatedPlans = plans;
    state.selectedGeneratedPlanId = plans.find((record) => record.status !== 'archived')?.id ?? plans[0]?.id ?? '';
  } catch (err) {
    state.generatedPlans = [];
    state.selectedGeneratedPlanId = '';
    console.warn('Generated plan storage could not be loaded.', err);
  }
}

function renderStartupFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const escaped = escapeHtml(message || 'Unknown startup error.');
  const target = appRoot ?? document.body;
  target.innerHTML = `
    <section data-agentic-startup-failure style="
      min-height: 100vh;
      box-sizing: border-box;
      display: grid;
      place-items: center;
      padding: 24px;
      background: #020504;
      color: #eef8f2;
      font-family: Space Grotesk, Inter, system-ui, sans-serif;
    ">
      <div style="
        max-width: 620px;
        border: 1px solid rgba(94, 231, 158, 0.35);
        border-radius: 12px;
        background: rgba(9, 18, 15, 0.94);
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.42);
        padding: 22px;
      ">
        <p style="
          margin: 0 0 8px;
          color: #8bcdaa;
          font-size: 0.75rem;
          font-weight: 900;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        ">Agentic startup failed</p>
        <h1 style="margin: 0 0 10px; font-size: 1.35rem; line-height: 1.2;">Refresh loaded the shell, but the app could not start.</h1>
        <p style="margin: 0; color: rgba(218, 229, 224, 0.84); line-height: 1.5;">${escaped}</p>
      </div>
    </section>
  `;
  console.error('Agentic startup failed.', err);
}

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
  state.androidNativeEnvironment = detectAndroidNativeEnvironment();
  if (state.androidNativeEnvironment.isAndroidNative && state.cluster === 'localnet') {
    state.cluster = 'devnet';
    savePersistedState();
  }
  await refreshAndroidNativeCacheState();
  if (state.androidNativeEnvironment.isAndroidNative) {
    await restoreAndroidNativeSession();
  }
  state.iosNativeEnvironment = detectIosNativeEnvironment();
  await refreshIosNativeCacheState();
  if (state.iosNativeEnvironment.isIosNative) {
    await restoreIosNativeSession();
  }
  if (!state.androidNativeEnvironment.isAndroidNative && !state.iosNativeEnvironment.isIosNative) {
    await restoreBrowserWalletSession();
  }
  await refreshCloudSession(false);
  await signOutCloudSessionForWalletBoundary('startup');
  await hydrateLabArtifactArchive();
  if (cloudSessionMatchesWallet()) {
    await refreshCloudWorkspaceData().catch(() => undefined);
  }
  if (shouldProbeBridgeOnStartup()) {
    await loadBridgeConfig(false);
    if (state.aiSettings.mode === 'bridge') {
      await refreshBridgeAiStatus(false);
    }
  }
  render();
}

function render(): void {
  if (!appRoot) return;
  const route = currentRoute();
  applyRouteTitle(route);
  trackPageView(route ?? normalizePathname(window.location.pathname), document.title);
  closeTemplatePickerInteractions();
  closeArtifactPickerInteractions();
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

  if (normalizedPath === '/dos') {
    window.history.replaceState({}, '', '/docs');
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
  const platformClass = state.iosNativeEnvironment.isIosNative
    ? 'ios-native-shell'
    : state.androidNativeEnvironment.bridgeAvailable
      ? 'android-shell'
      : '';
  return `
    <section class="shell homepage-shell ${routeClass} ${platformClass}">
      ${toastStack()}
      ${homepageNav(activeRoute)}
      ${content}
      ${cloudWorkspaceDeleteModal()}
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
  return guidedDemoWalkthroughPage();
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
          <li>AI provider keys you choose to enter. Browser session keys stay in the current browser runtime, bridge keys are intended to stay in local bridge process memory unless you configure otherwise, and Hosted BYOK keys are relayed through the same-origin Agentic server only for the current draft request and are not stored by Agentic.</li>
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
        <p>We use Google Analytics 4 on the public marketing site and hosted app when a measurement ID is configured. Google Analytics may collect or process page views, route changes, download clicks, navigation clicks, wallet-connect events, planner button clicks, device/browser information, approximate location, and related identifiers according to Google&apos;s terms and settings. We do not send wallet addresses, signatures, transaction IDs, AI prompts, AI keys, bridge tokens, or raw user-entered planner values to Google Analytics, and we do not use Google Analytics to sell personal information or for cross-context behavioral advertising.</p>

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
        <p>Depending on your jurisdiction, you may have the right to request access to your personal information, request deletion of your personal data, or opt out of email communications. Signed-in Agentic Cloud users can also delete wallet-scoped Cloud Workspace Data from the Connect Cloud Storage tab after signing a wallet ownership confirmation. To exercise broader rights, email us at support@solpulse.trade. We will remove your personal data within 30 days of a verified request, except where retention is required by law (e.g., compliance logs).</p>

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
          <li><strong>Google Analytics 4 data, when enabled:</strong> retained according to the configured Google Analytics property retention settings and applicable Google controls.</li>
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
          <li><strong>Google Analytics 4</strong> — aggregated usage measurement for product and reliability analysis when configured, subject to Google Analytics configuration and applicable consent requirements.</li>
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
          <li>Optional AI planner features only prepare plans or explanations; they do not make a transaction safe, signed, submitted, profitable, reversible, or suitable for you</li>
          <li>You remain solely responsible for what you sign, including approvals issued by automation or pre-authorized categories you enabled</li>
        </ul>

        <p><strong>3b. What Agentic Does Not Do.</strong> Agentic does <strong>not</strong>:</p>
        <ul>
          <li>Custody, hold, or escrow your digital assets</li>
          <li>Generate, store, or recover seed phrases or private keys</li>
          <li>Auto-approve transactions on your behalf</li>
          <li>Call AI providers without your chosen AI path. Hosted BYOK relays only the draft request you submit; browser session, local bridge, and external agent clients call providers under their own configuration and provider policies</li>
          <li>Match, settle, or take the other side of any trade</li>
          <li>Operate an order book, an exchange, or a liquidity pool</li>
        </ul>

        <p><strong>3c. Bring-Your-Own AI Keys.</strong> If you paste or configure an AI provider key, base URL, model name, prompt, template, or plan parameter in Agentic, you are instructing the selected AI path to contact that provider. Hosted BYOK sends the key and draft request through the same-origin Agentic server for that request only; browser session and local bridge paths use your browser or local runtime. You are responsible for the provider you choose, its terms, its privacy practices, its billing, and the content you send to it. SolPulse does not guarantee that provider responses are accurate, secure, compliant, or fit for any purpose. Never enter a wallet seed phrase, private key, recovery phrase, or unrestricted credential into any AI prompt, MCP server, bridge, or support request.</p>

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
    <header class="homepage-nav" aria-label="Agentic navigation" ${activeRoute === '/app' ? 'data-layout="app-nav"' : ''}>
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
          can ask for signatures, swaps, transfers, receipts, and approval requests without receiving a seed phrase,
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
        ${heroProof('Adapter records', 'Receipt, policy context, bridge state, and evidence receipts.')}
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
    { name: 'Gemini', logoId: 'gemini' },
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
        <h2 id="gap-title">
          <span>Solana lacked a universal agent-to-wallet approval layer.</span>
        </h2>
        <p class="gap-risks">
          Private keys inside agents are unsafe.<br>
          Funded agent wallets fragment users.<br>
          Single-wallet flows do not scale.
        </p>
        <p class="gap-accent">Agentic is the multi-wallet approval layer.</p>
        <p class="gap-close">Agents prepare.<br><strong>Your wallet signs.</strong></p>
      </div>
      <div class="gap-body">
        <div class="gap-proof-grid" aria-label="Current signing models">
          ${gapProof('Private-key MCP', 'SOLANA_PRIVATE_KEY=... makes the agent or server the signer.', 'Custody')}
          ${gapProof('Phantom MCP', 'Creates a new dedicated agent wallet, then asks the user to fund it.', 'Separate signer')}
          ${gapProof('Read-only / link MCP', 'Can quote or hand off to a product page, but has no reusable signing backend.', 'No generic signing')}
        </div>
        <p class="gap-answer">
          Agentic routes each request to the user's existing Solana wallet: Phantom, Solflare, Backpack,
          Seed Vault, Wallet Standard, MWA, and iOS wallet links. The agent gets the approved result,
          never the key.
        </p>
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
        <button data-start-action="discover" class="primary" ${state.busy ? 'disabled' : ''}>
          Discover Wallets
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
          The Desktop App is optional easy mode for the local bridge, Needs Approval queue, logs, and diagnostics. Use it
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

function guidedDemoWalkthroughPage(): string {
  const scenario = selectedGuidedDemoScenario();
  return `
    <section id="demo-guide" class="guided-demo-page" aria-labelledby="guided-demo-title">
      <div class="guided-demo-hero">
        <div class="guided-demo-hero-copy">
          <p class="eyebrow mini">Guided demo</p>
          <h1 id="guided-demo-title">The agent prepares. You approve.</h1>
          <p>
            Pick a practical Solana request and watch Agentic turn it into a bounded wallet review. This demo
            simulates the approval flow, does not move funds, and never asks you to start the local bridge.
          </p>
        </div>
        <div class="guided-demo-trust-grid" aria-label="Demo safety model">
          ${guidedDemoTrustItem('No key handoff', 'The agent never receives your seed phrase, private key, or unlimited signer.')}
          ${guidedDemoTrustItem('Explicit approval', 'Prepared actions wait until the wallet owner approves or denies them.')}
          ${guidedDemoTrustItem('Receipt trail', 'Every demo decision ends with a receipt you can inspect or copy.')}
        </div>
      </div>

      <div class="guided-demo-shell">
        <aside class="guided-demo-scenarios" aria-label="Choose a demo scenario">
          <div>
            <p class="eyebrow mini">Use cases</p>
            <h2>Start with a real request.</h2>
            <p>These are the approval moments Agentic is built for: the agent drafts, the wallet decides.</p>
          </div>
          <div class="guided-demo-scenario-list">
            ${GUIDED_DEMO_SCENARIOS.map((candidate) => guidedDemoScenarioCard(candidate)).join('')}
          </div>
        </aside>

        <section class="guided-demo-runner" aria-label="Simulated approval walkthrough">
          ${guidedDemoStepRail()}
          <div class="guided-demo-runner-body">
            ${guidedDemoRequestCard(scenario)}
            ${guidedDemoPreparedPlan(scenario)}
            ${guidedDemoReviewCard(scenario)}
            ${guidedDemoReceiptCard(scenario)}
          </div>
          ${guidedDemoActions()}
        </section>
      </div>

      <div class="guided-demo-footer-cta">
        <div>
          <span>Ready for the real workspace?</span>
          <strong>Create requests, connect optional AI, review approvals, and save signed proofs in /app.</strong>
        </div>
        <a class="button-link launch-app-link mobile-redundant-nav" href="/app">Launch full app</a>
        <a class="button-link mobile-redundant-nav" href="/docs">Read docs</a>
      </div>
    </section>
  `;
}

function guidedDemoTrustItem(title: string, detail: string): string {
  return `
    <article class="guided-demo-trust-item">
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(detail)}</p>
    </article>
  `;
}

function guidedDemoScenarioCard(scenario: GuidedDemoScenario): string {
  const active = scenario.id === state.guidedDemo.selectedScenarioId;
  return `
    <button
      class="guided-demo-scenario-card ${active ? 'active' : ''}"
      data-demo-scenario="${escapeHtml(scenario.id)}"
      aria-pressed="${active ? 'true' : 'false'}"
      ${state.busy ? 'disabled' : ''}
    >
      <span>${escapeHtml(scenario.eyebrow)}</span>
      <strong>${escapeHtml(scenario.title)}</strong>
      <em>${escapeHtml(scenario.prompt)}</em>
    </button>
  `;
}

function guidedDemoStepRail(): string {
  const receiptComplete = state.guidedDemo.stage === 'receipt';
  const steps = [
    { id: 'request', label: 'Request', detail: 'Choose a use case' },
    { id: 'prepared', label: 'Prepared plan', detail: 'Agent drafts limits' },
    { id: 'queued', label: 'Wallet review', detail: 'Approve or deny' },
    {
      id: 'receipt',
      label: receiptComplete ? 'Demo complete' : 'Receipt',
      detail: receiptComplete ? 'Receipt ready' : 'Decision recorded',
    },
  ] satisfies Array<{ id: GuidedDemoStage; label: string; detail: string }>;
  const activeIndex = guidedDemoStageIndex(state.guidedDemo.stage);
  return `
    <div class="guided-demo-step-rail" aria-label="Demo progress">
      ${steps
        .map((step, index) => {
          const complete = index < activeIndex || state.guidedDemo.stage === 'receipt';
          const active = index === activeIndex && state.guidedDemo.stage !== 'receipt';
          return `
            <div class="guided-demo-step ${complete ? 'complete' : ''} ${active ? 'active' : ''}">
              <span>${index + 1}</span>
              <div>
                <strong>${escapeHtml(step.label)}</strong>
                <p>${escapeHtml(step.detail)}</p>
              </div>
            </div>
          `;
        })
        .join('')}
    </div>
  `;
}

function guidedDemoRequestCard(scenario: GuidedDemoScenario): string {
  return `
    <article class="guided-demo-request-card">
      <div>
        <span>User request</span>
        <p>${escapeHtml(scenario.prompt)}</p>
      </div>
      <strong>Simulation only</strong>
    </article>
  `;
}

function guidedDemoPreparedPlan(scenario: GuidedDemoScenario): string {
  if (!guidedDemoAtLeast('prepared')) {
    return `
      <article class="guided-demo-placeholder">
        <span>Next</span>
        <h3>Prepare the request</h3>
        <p>Click Prepare request to see the structured plan the agent would hand back for wallet review.</p>
      </article>
    `;
  }
  return `
    <article class="guided-demo-plan-card">
      <div class="guided-demo-card-heading">
        <span>Prepared plan</span>
        <h3>${escapeHtml(scenario.planTitle)}</h3>
        <p>${escapeHtml(scenario.detail)}</p>
      </div>
      <div class="guided-demo-fact-grid">
        ${scenario.facts.map((fact) => guidedDemoFact(fact.label, fact.value)).join('')}
      </div>
      <div class="guided-demo-constraint-list">
        <span>Approval constraints</span>
        <ul>
          ${scenario.constraints.map((constraint) => `<li>${escapeHtml(constraint)}</li>`).join('')}
        </ul>
      </div>
      <div class="guided-demo-risk-note">
        <span>Risk check</span>
        <p>${escapeHtml(scenario.risk)}</p>
      </div>
    </article>
  `;
}

function guidedDemoReviewCard(scenario: GuidedDemoScenario): string {
  if (!guidedDemoAtLeast('queued')) return '';
  const receiptReady = state.guidedDemo.stage === 'receipt';
  const approved = state.guidedDemo.decision === 'approved';
  const status = receiptReady ? (approved ? 'Approved' : 'Denied') : 'Waiting for you';
  return `
    <article class="guided-demo-review-card ${receiptReady ? state.guidedDemo.decision : ''}">
      <div class="guided-demo-card-heading">
        <span>Wallet review</span>
        <h3>${escapeHtml(status)}</h3>
        <p>${escapeHtml(scenario.approvalBoundary)}</p>
      </div>
      <div class="guided-demo-review-route">
        ${guidedDemoFact('Route', scenario.route)}
        ${guidedDemoFact('Signer', state.address ? short(state.address) : 'Demo wallet')}
        ${guidedDemoFact('Result', receiptReady ? status : 'Pending decision')}
      </div>
    </article>
  `;
}

function guidedDemoReceiptCard(scenario: GuidedDemoScenario): string {
  if (state.guidedDemo.stage !== 'receipt') return '';
  const signed = Boolean(state.guidedDemo.signedReceipt);
  const approved = state.guidedDemo.decision === 'approved';
  const decisionCopy = approved ? 'You approved the simulated wallet review.' : 'You denied the simulated wallet review.';
  return `
    <article class="guided-demo-receipt-card ${state.guidedDemo.decision}">
      <div class="guided-demo-card-heading">
        <span>${escapeHtml(approved ? 'Approval receipt' : 'Denial receipt')}</span>
        <h3>${escapeHtml(scenario.receiptSummary)}</h3>
        <p>This is demo output only. It shows the record a real approval flow would preserve for review.</p>
      </div>
      <div class="guided-demo-human-summary">
        <span>Human-readable summary</span>
        <p>${escapeHtml(`${decisionCopy} ${scenario.receiptSummary} No funds moved in this demo.`)}</p>
      </div>
      <div class="guided-demo-review-route">
        ${guidedDemoFact('Receipt', state.guidedDemo.receiptId || 'demo')}
        ${guidedDemoFact('Created', formatDateTime(state.guidedDemo.receiptCreatedAt))}
        ${guidedDemoFact('Signature', signed ? short(state.guidedDemo.signedReceipt) : 'Optional')}
      </div>
      <details class="guided-demo-json">
        <summary>Technical receipt JSON</summary>
        <pre>${escapeHtml(state.guidedDemo.receiptJson)}</pre>
      </details>
    </article>
  `;
}

function guidedDemoFact(label: string, value: string): string {
  return `
    <div class="guided-demo-fact">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function guidedDemoActions(): string {
  const demo = state.guidedDemo;
  const disabled = state.busy ? 'disabled' : '';
  if (demo.stage === 'request') {
    return `
      <div class="guided-demo-actions">
        <button class="primary" data-demo-action="prepare" ${disabled}>Prepare request</button>
      </div>
    `;
  }
  if (demo.stage === 'prepared') {
    return `
      <div class="guided-demo-actions">
        <button class="primary" data-demo-action="queue" ${disabled}>Move to wallet review</button>
        <button data-demo-action="reset" ${disabled}>Reset demo</button>
      </div>
    `;
  }
  if (demo.stage === 'queued') {
    return `
      <div class="guided-demo-actions">
        <button class="primary" data-demo-action="approve" ${disabled}>Approve simulation</button>
        <button data-demo-action="deny" ${disabled}>Deny simulation</button>
        <button data-demo-action="reset" ${disabled}>Reset demo</button>
      </div>
    `;
  }
  return `
    <div class="guided-demo-actions receipt-actions">
      <button
        data-copy="${escapeHtml(demo.receiptJson)}"
        data-copy-name="Demo receipt JSON"
        data-copy-toast="Demo receipt copied"
        data-copy-message="Receipt JSON is on your clipboard."
        ${demo.receiptJson ? '' : 'disabled'}
      >Copy receipt</button>
      ${
        state.address
          ? `<button data-demo-action="sign-receipt" ${disabled || demo.signedReceipt ? 'disabled' : ''}>${demo.signedReceipt ? 'Receipt signed' : 'Sign demo receipt'}</button>`
          : '<span class="guided-demo-action-note">Real wallet signing happens in the full app. This demo never moves funds.</span>'
      }
      <button data-demo-action="reset" ${disabled}>Reset demo</button>
      <a class="button-link launch-app-link mobile-redundant-nav" href="/app">Try in full app</a>
    </div>
  `;
}

function selectedGuidedDemoScenario(): GuidedDemoScenario {
  return guidedDemoScenarioById(state.guidedDemo.selectedScenarioId);
}

function guidedDemoScenarioById(scenarioId: string | undefined): GuidedDemoScenario {
  return GUIDED_DEMO_SCENARIOS.find((scenario) => scenario.id === scenarioId) ?? GUIDED_DEMO_SCENARIOS[0]!;
}

function guidedDemoStageIndex(stage: GuidedDemoStage): number {
  switch (stage) {
    case 'request':
      return 0;
    case 'prepared':
      return 1;
    case 'queued':
      return 2;
    case 'receipt':
      return 3;
  }
}

function guidedDemoAtLeast(stage: GuidedDemoStage): boolean {
  return guidedDemoStageIndex(state.guidedDemo.stage) >= guidedDemoStageIndex(stage);
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
        <p>Render serves the web app and hosted BYOK AI proxy. CLI, Desktop App, local bridge, and wallet approvals run on your device.</p>
        <p class="footer-contact">
          <span>SolPulse LLC</span>
          <a href="mailto:support@solpulse.trade">support@solpulse.trade</a>
        </p>
      </div>
      <nav aria-label="Footer navigation">
        <a href="/docs">Docs</a>
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
    <a
      class="download-card"
      href="${escapeHtml(url)}"
      target="_blank"
      rel="noreferrer"
      data-download-kind="${escapeHtml(kind)}"
      data-download-platform="${escapeHtml(label)}"
      data-download-asset="${escapeHtml(asset)}"
    >
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
    <section id="${workspaceId}" class="app-workspace-section ${appModeClass} ${modeClass}" aria-labelledby="${titleId}" data-layout="app-root">
      <div class="workspace-intro" data-layout="app-intro">
        <div>
          ${mode === 'demo' ? '<p class="eyebrow mini">Interactive demo</p>' : '<!-- Launch App eyebrow intentionally hidden. -->'}
          <h2 id="${titleId}">${mode === 'demo' ? 'Live approval demo.' : 'Agentic approval workspace.'}</h2>
          ${mode === 'demo' ? '' : '<p>Draft with AI or templates, review the wallet action, approve through your signer, and keep proof.</p>'}
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

      <section class="workspace ${SHOW_DEV_CONTROLS ? 'dev-workspace' : 'public-workspace'}" data-layout="app-shell">
        ${walletRail()}
        <section class="panel main-panel" data-layout="app-main">
          <div class="surface-topbar" data-layout="app-tabs-row">
            <div>
              <h2>${surfaceTitle()}</h2>
            </div>
            <nav class="nav-cluster tabs workspace-tabs" aria-label="Workspace navigation" data-layout="app-tabs">
              ${/*
                Wallet tab intentionally hidden across web, Android, and iOS app shells.
                tabButton('wallet', 'Wallet')
              */ ''}
              ${tabButton('overview', 'Home')}
              ${tabButton('agent', 'New Request', 'New')}
              ${tabButton('schedule', 'Repeat Payments', 'Repeats')}
              ${tabButton('inbox', 'Needs Approval', 'Approve')}
              ${tabButton('completed', 'Done')}
              ${tabButton('labs', 'Save Proof', 'Proof')}
            </nav>
          </div>
          <div data-layout="active-panel">${activePanel()}</div>
        </section>
        ${SHOW_DEV_CONTROLS ? contextPanel() : requestContextDetails()}
      </section>
    </section>
  `;
}

function trustLayerPanel(): string {
  const mode = activeWorkflowMode();
  const items: Array<[string, string]> = [
    ['No key custody', 'Wallet keeps private keys'],
    ['No unlimited signer', 'Every action has a boundary'],
    ['AI drafts only', 'Wallet decides approve or deny'],
    [mode === 'agentic-cloud' ? 'Cloud receipts' : 'Local receipts', 'Saved proofs stay available'],
  ];
  return `
    <section class="trust-layer-panel" aria-label="Agentic trust boundary" data-layout="trust-strip">
      ${items.map(([label, detail]) => `
        <div>
          <strong>${escapeHtml(label)}</strong>
          <span>${escapeHtml(detail)}</span>
        </div>
      `).join('')}
    </section>
  `;
}

function firstRunActionBand(): string {
  const steps = firstRunSteps();
  const complete = firstRunComplete(steps);
  const action = firstRunNextAction();
  const showAction = action.id !== 'discover-wallets' && action.id !== 'connect-wallet';
  const currentStep = steps.find((step) => step.active) ?? steps[steps.length - 1]!;
  const title = complete ? 'Proof saved' : `Next: ${action.label}`;
  const detail = complete
    ? 'Your latest approval proof or receipt is saved in Done.'
    : action.detail;
  return `
    <section class="first-run-band workflow-status-band ${complete ? 'complete compact' : 'compact'} ${showAction ? '' : 'no-action'}" aria-label="First-time approval flow" data-layout="workflow-status">
      <div class="first-run-copy">
        <span>Approval loop</span>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(detail)}</p>
        <small>Workspace: ${escapeHtml(activeWorkflowLabel())}</small>
      </div>
      <div class="first-run-progress" role="list" aria-label="First-time progress">
        ${steps.map((stepItem, index) => firstRunStepItem(stepItem, index, currentStep.id)).join('')}
      </div>
      ${showAction ? `<div class="first-run-actions">
        <button
          type="button"
          class="primary"
          data-first-run-action="${escapeHtml(action.id)}"
          ${action.disabled ? 'disabled' : ''}
          title="${escapeHtml(action.detail)}"
        >
          ${escapeHtml(action.label)}
        </button>
      </div>` : ''}
    </section>
  `;
}

function sectionTitleLine(title: string, detail: string): string {
  return `
    <div class="section-title-line">
      <h2>${escapeHtml(title)}</h2>
      <p><span aria-hidden="true">-</span> ${escapeHtml(detail)}</p>
    </div>
  `;
}

function firstRunStepItem(stepItem: FirstRunStep, index: number, currentStepId: FirstRunStepId): string {
  const status = stepItem.complete ? 'complete' : stepItem.id === currentStepId ? 'active' : 'idle';
  return `
    <div
      class="first-run-step ${status}"
      data-first-run-step="${escapeHtml(stepItem.id)}"
      role="listitem"
      aria-current="${stepItem.id === currentStepId ? 'step' : 'false'}"
      title="${escapeHtml(stepItem.detail)}"
    >
      <span>${index + 1}</span>
      <strong>${escapeHtml(stepItem.label)}</strong>
      <p>${escapeHtml(stepItem.detail)}</p>
    </div>
  `;
}

function firstRunSteps(): FirstRunStep[] {
  const signals = firstRunSignals();
  const currentStepId = firstRunCurrentStepId(signals);
  const steps: Array<Omit<FirstRunStep, 'active'>> = [
    {
      id: 'wallet',
      label: 'Connect',
      detail: signals.hasWallet ? shortFirstRunWallet(state.address) : 'Use your wallet signer.',
      complete: signals.hasWallet,
    },
    {
      id: 'plan',
      label: 'Create',
      detail: signals.hasPlan ? 'Plan saved for review.' : 'Draft from template.',
      complete: signals.hasPlan,
    },
    {
      id: 'review',
      label: 'Review',
      detail: signals.hasReview ? 'Wallet action is visible.' : 'Check route and limits.',
      complete: signals.hasReview,
    },
    {
      id: 'decision',
      label: 'Decide',
      detail: signals.hasReceipt ? 'Decision recorded.' : signals.activeApprovalCount ? 'Waiting for approval.' : 'Send for approval.',
      complete: signals.hasReceipt,
    },
    {
      id: 'receipt',
      label: 'Receipt',
      detail: signals.hasReceipt ? 'Saved in Done.' : 'Saved after decision.',
      complete: signals.hasReceipt,
    },
  ];
  return steps.map((stepItem) => ({
    ...stepItem,
    active: stepItem.id === currentStepId,
  }));
}

function firstRunSignals(): {
  hasWallet: boolean;
  hasPlan: boolean;
  hasReview: boolean;
  hasReceipt: boolean;
  activeApprovalCount: number;
} {
  const oneTimePlans = generatedPlansForPanel(true).filter((record) => record.status !== 'archived');
  const selected = selectedGeneratedPlan();
  const activeApprovalCount = activeWorkflowPreparedActions().filter((action) => !action.archived && isActionInboxActive(action)).length;
  const completedCount = completedPlanRecords().length;
  const hasMovedPlan = oneTimePlans.some(hasGeneratedPlanMovedPastReview);
  const hasReview = Boolean(
    completedCount > 0 ||
      activeApprovalCount > 0 ||
      hasMovedPlan ||
      (selected && isOneTimeGeneratedPlan(selected) && state.oneTimePlanView === 'review'),
  );
  return {
    hasWallet: Boolean(state.address),
    hasPlan: Boolean(state.agentPlan || oneTimePlans.length > 0 || completedCount > 0 || activeApprovalCount > 0),
    hasReview,
    hasReceipt: completedCount > 0,
    activeApprovalCount,
  };
}

function firstRunCurrentStepId(signals = firstRunSignals()): FirstRunStepId {
  if (!signals.hasWallet) return 'wallet';
  if (!signals.hasPlan) return 'plan';
  if (signals.activeApprovalCount > 0 && !signals.hasReceipt) return 'decision';
  if (!signals.hasReview || !signals.hasReceipt) return 'review';
  return 'receipt';
}

function firstRunComplete(steps = firstRunSteps()): boolean {
  return steps.every((stepItem) => stepItem.complete);
}

function firstRunNextAction(): FirstRunAction {
  const signals = firstRunSignals();
  if (!signals.hasWallet) {
    const nativeWallet = state.androidNativeEnvironment.isAndroidNative || state.iosNativeEnvironment.isIosNative;
    const selectedProvider = discoveredSelectedWalletName();
    if (nativeWallet || (state.wallets.length > 0 && selectedProvider)) {
      return {
        id: 'connect-wallet',
        label: 'Connect wallet',
        detail: 'Authorize Agentic in your wallet. This grants no spending authority.',
      };
    }
    return {
      id: 'discover-wallets',
      label: 'Discover wallets',
      detail: 'Find Solana wallet providers in this browser.',
    };
  }
  if (!signals.hasPlan) {
    return {
      id: 'open-create-plan',
      label: 'New Request',
      detail: 'Use the default template path. AI setup is optional.',
    };
  }
  if (signals.activeApprovalCount > 0 && !signals.hasReceipt) {
    return {
      id: 'open-inbox',
      label: 'Needs Approval',
      detail: 'Approve or deny the queued request from your wallet.',
    };
  }
  if (!signals.hasReceipt) {
    return {
      id: 'open-review',
      label: 'Check',
      detail: 'Check action, route, limits, and destination before approval.',
    };
  }
  return {
    id: 'open-completed',
    label: 'Open Done',
    detail: 'Review saved receipts and decision proofs.',
  };
}

function firstRunSecondaryAction(primaryId: FirstRunActionId): FirstRunAction | null {
  if (
    state.address &&
    primaryId !== 'cloud-sign-in' &&
    state.cloudSession.status === 'signed-out' &&
    !cloudSessionMatchesWallet()
  ) {
    return {
      id: 'cloud-sign-in',
      label: 'Sign in to Cloud',
      detail: 'Optional sync for plans, approvals, repeat payments, and proofs.',
    };
  }
  return null;
}

function gapProof(title: string, detail: string, stamp: string): string {
  return `
    <article class="gap-proof">
      <div class="gap-proof-header">
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(stamp)}</span>
      </div>
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
    (action) => !isTerminalPreparedAction(action),
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
    (action) => !isTerminalPreparedAction(action),
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
  const showPublicWalletPicker =
    !SHOW_DEV_CONTROLS &&
    !state.address &&
    !state.androidNativeEnvironment.isAndroidNative &&
    !state.iosNativeEnvironment.isIosNative &&
    state.wallets.length > 0;
  const showPublicIosPicker = !SHOW_DEV_CONTROLS && !state.address && state.iosNativeEnvironment.isIosNative;
  const wallet = walletIdentity();
  return `
    <aside class="panel custody-panel custody-module" data-layout="app-rail">
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

      ${showPublicWalletPicker ? `
      <details class="rail-details wallet-picker-details" open>
        <summary>Wallet choices</summary>
        <label class="field">
          <span>Selected wallet</span>
          ${selectPicker({
            id: 'walletSelect',
            value: state.selectedWalletName,
            options: walletSelectOptions(),
            disabled: state.wallets.length === 0 || state.busy,
            open: state.browserWalletPickerOpen,
          })}
        </label>
      </details>` : ''}

      ${publicWalletActions()}

      ${showPublicIosPicker ? `
      <details class="rail-details wallet-picker-details" open>
        <summary>Choose iOS wallet</summary>
        <label class="field">
          <span>Selected wallet</span>
          ${selectPicker({
            id: 'iosWalletSelect',
            value: state.selectedIosWalletId,
            options: iosWalletSelectOptions(),
            disabled: state.busy,
          })}
        </label>
      </details>` : ''}

      <div class="rail-primary-stack">
        ${cloudWorkspaceCard()}
        ${aiSettingsPanel('rail')}
      </div>
      ${SHOW_DEV_CONTROLS ? '' : `
        <details class="rail-details rail-advanced-details">
          <summary>Advanced local setup</summary>
          ${publicBridgeStatusCard()}
        </details>
      `}

      ${SHOW_DEV_CONTROLS ? `
      <details class="rail-details developer-settings" ${showConnectionDetails ? 'open' : ''}>
        <summary>Developer settings</summary>
        ${developerConnectionSettings()}
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

function cloudWorkspaceCard(): string {
  const mode = activeWorkflowMode();
  const signedIn = state.cloudSession.status === 'signed-in';
  const matched = cloudSessionMatchesWallet();
  const mismatch = cloudSessionWalletMismatch();
  const unavailable = state.cloudSession.status === 'unavailable';
  const noWalletCloudAction = firstRunNextAction();
  const status = unavailable
    ? 'Saved locally'
    : signedIn
      ? matched
        ? 'Signed in'
        : 'Wallet mismatch'
      : 'Signed out';
  const detail = unavailable
    ? 'Plans, approvals, and proofs stay on this device. No localhost required.'
    : signedIn
      ? matched
        ? 'One-time drafts, approvals, and done work sync through Agentic Cloud.'
        : `Signed in as ${short(state.cloudSession.walletAddress)}. Connect that wallet to use cloud workflow.`
      : 'Signed-out workflow data is saved on this device.';
  const summaryDetail = unavailable
    ? 'Saved on this device - no localhost required'
    : signedIn
      ? matched
        ? 'Cloud workspace connected'
        : `Signed in as ${short(state.cloudSession.walletAddress)}`
      : 'Browser-local workflow storage';
  const open = state.workspaceStoragePanelOpen === true ? 'open' : '';
  return `
    <details class="workspace-storage-panel ${escapeHtml(mode)} ${signedIn ? 'signed-in' : ''}" data-layout="workspace-storage-panel" aria-label="Workspace storage status" ${open}>
      <summary>
        <span class="workspace-storage-summary-copy">
          <span>Workspace storage</span>
          <em>${escapeHtml(summaryDetail)}</em>
        </span>
        <strong>${escapeHtml(status)}</strong>
      </summary>
      <section class="rail-cloud-card ${escapeHtml(mode)} ${signedIn ? 'signed-in' : ''}" aria-label="Workspace storage details">
        <p>${escapeHtml(detail)}</p>
        <div class="rail-cloud-facts">
          <span>Active <strong>${escapeHtml(activeWorkflowLabel())}</strong></span>
          ${matched ? `<span>Wallet <strong>${escapeHtml(short(state.cloudSession.walletAddress))}</strong></span>` : ''}
          ${state.cloudLastSync && matched ? `<span>Synced <strong>${escapeHtml(formatDateTime(state.cloudLastSync))}</strong></span>` : ''}
        </div>
        <div class="rail-cloud-actions">
          ${signedIn ? `
            <button id="cloudLogout" class="utility" ${state.busy ? 'disabled' : ''}>Sign out</button>
          ` : !state.address ? `
            <button
              type="button"
              class="rail-cloud-button"
              data-first-run-action="${escapeHtml(noWalletCloudAction.id)}"
              ${state.busy ? 'disabled' : ''}
              title="Connect a wallet before signing in to Agentic Cloud."
            >
              Connect wallet to sign in
            </button>
          ` : unavailable ? `
            <button class="rail-cloud-button" disabled title="Cloud APIs are unavailable from this host.">Cloud unavailable</button>
          ` : `
            <button id="cloudSignIn" class="rail-cloud-button" ${state.busy ? 'disabled' : ''} title="Sign in with a wallet ownership proof.">Sign in</button>
          `}
        </div>
        ${mismatch ? '<p class="rail-cloud-warning">Cloud sessions prove wallet ownership only. They do not grant spending authority.</p>' : ''}
        ${!signedIn && !state.address ? '<p class="rail-cloud-warning">Cloud sign-in uses your wallet as identity only. It does not grant spending authority.</p>' : ''}
      </section>
    </details>
  `;
}

function publicBridgeStatusCard(): string {
  const connected = state.bridgeActive;
  const localMode = activeWorkflowMode() === 'local-bridge';
  const tone = localMode ? 'online' : connected ? 'connected' : state.busy ? 'checking' : 'offline';
  const status = localMode ? 'Active' : connected ? 'Connected' : state.busy ? 'Checking' : 'Offline';
  const detail = connected
    ? localMode
      ? 'Private local mode owns new workflow actions on this device.'
      : 'Local connector is available. Use it only when you want local-only workflow storage.'
    : 'Optional. Start the local connector only when you want private local workflow storage.';
  return `
    <section class="rail-bridge-card ${tone}" aria-label="Private local mode status">
      <div class="rail-bridge-head">
        <span>Local connector</span>
        <strong>${escapeHtml(status)}</strong>
      </div>
      <p>${escapeHtml(detail)}</p>
      ${connected ? `
        <div class="rail-bridge-facts">
          <span>Endpoint <strong>${escapeHtml(compactEndpoint(state.bridgeUrl))}</strong></span>
          <span>Wallet <strong>${escapeHtml(state.address ? short(state.address) : 'Not connected')}</strong></span>
        </div>
        <div class="rail-bridge-actions">
          ${localMode
            ? `<button type="button" data-workflow-mode="auto" ${state.busy ? 'disabled' : ''}>Use cloud or browser</button>`
            : `<button type="button" class="utility" data-workflow-mode="local-bridge" ${!state.address || state.busy ? 'disabled' : ''}>Use private local mode</button>`}
        </div>
      ` : `
        <div class="rail-bridge-actions">
          <button type="button" class="utility" data-bridge-action="connect" ${!state.address || state.busy ? 'disabled' : ''}>Check local bridge</button>
          ${optionalPrivateLocalModeDetails()}
        </div>
      `}
    </section>
  `;
}

function optionalPrivateLocalModeDetails(): string {
  return `
    <details class="bridge-setup-details optional-local-runtime">
      <summary>Use private local mode</summary>
      <div class="local-runtime-guide rail-runtime-guide optional-runtime-guide">
        <div class="local-runtime-guide-head">
          <span>Optional on this computer</span>
          <strong>${escapeHtml(compactEndpoint(state.bridgeUrl))}</strong>
        </div>
        <p>Use the local runtime only when you want workflow storage to stay on this machine. The normal web app can use Agentic Cloud or saved-on-device workflow without localhost.</p>
        <ol class="local-runtime-steps">
          <li>Run the one-shot command in Terminal.</li>
          <li>Connect the same wallet in the local browser tab.</li>
          <li>Return here and check the local bridge.</li>
        </ol>
        <div class="bridge-command-row primary-runtime-command">
          <code>${escapeHtml(NPM_EXEC_COMMAND)}</code>
          <button type="button" data-copy="${escapeHtml(NPM_EXEC_COMMAND)}" data-copy-name="local runtime command">Copy</button>
        </div>
      </div>
    </details>
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
  const androidNative = state.androidNativeEnvironment.isAndroidNative;
  const iosNative = state.iosNativeEnvironment.isIosNative;
  const nativeWallet = androidNative || iosNative;
  if (state.address) {
    return `
      <div class="wallet-actions public-wallet-actions connected">
        <button id="disconnect" ${state.busy ? 'disabled' : ''}>Disconnect wallet</button>
      </div>
    `;
  }
  if (nativeWallet) {
    return `
      <div class="wallet-actions public-wallet-actions native-wallet-actions">
        <button data-start-action="connect" class="primary wallet-connect-cta" ${state.busy ? 'disabled' : ''}>
          ${walletButtonIcon()}
          <span>Connect wallet</span>
        </button>
      </div>
    `;
  }
  return `
    <div class="wallet-actions public-wallet-actions">
      <button data-start-action="discover" class="primary" ${state.busy ? 'disabled' : ''}>
        Discover
      </button>
      <button data-start-action="connect" class="${state.wallets.length ? 'primary' : ''}" ${(state.wallets.length === 0 || !selectedProvider) || state.busy ? 'disabled' : ''} title="${!selectedProvider ? 'Discover and select a wallet provider first.' : ''}">
        Connect wallet
      </button>
    </div>
  `;
}

function walletButtonIcon(): string {
  return `
    <svg class="wallet-button-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M19 7h-1V6.5A2.5 2.5 0 0 0 15.5 4H5.75A3.75 3.75 0 0 0 2 7.75v8.5A3.75 3.75 0 0 0 5.75 20H19a3 3 0 0 0 3-3v-7a3 3 0 0 0-3-3Zm-3-1a.5.5 0 0 1 .5.5V7H5.75a1.25 1.25 0 0 1 0-2.5h9.75ZM20 17a1 1 0 0 1-1 1H5.75A1.75 1.75 0 0 1 4 16.25V8.76c.52.16 1.08.24 1.75.24H19a1 1 0 0 1 1 1v7Zm-4.5-4.5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z"></path>
    </svg>
  `;
}

function developerConnectionSettings(): string {
  const androidNative = state.androidNativeEnvironment.isAndroidNative;
  return `
    <label class="field">
      <span>Cluster</span>
      ${selectPicker({
        id: 'clusterSelect',
        value: state.cluster,
        options: CLUSTERS.map((cluster) => ({
          value: cluster,
          label: cluster,
          meta: 'Network',
          disabled: androidNative && cluster === 'localnet',
          detail: androidNative && cluster === 'localnet' ? 'Unavailable in Android native mode.' : titleCaseCluster(cluster),
        })),
        disabled: state.busy || state.bridgeActive,
      })}
    </label>

    ${androidNative ? '' : state.iosNativeEnvironment.isIosNative ? `
    <label class="field">
      <span>iOS wallet</span>
      ${selectPicker({
        id: 'iosWalletSelect',
        value: state.selectedIosWalletId,
        options: iosWalletSelectOptions(),
        disabled: state.busy,
      })}
    </label>` : `
    <label class="field">
      <span>Selected wallet</span>
      ${selectPicker({
        id: 'walletSelect',
        value: state.selectedWalletName,
        options: walletSelectOptions(),
        disabled: state.wallets.length === 0 || state.busy,
      })}
    </label>`}

    ${state.capabilities ? capabilityBlock(state.capabilities) : ''}
    ${androidNative || state.iosNativeEnvironment.isIosNative ? mobileWalletBox() : ''}
  `;
}

function mobileWalletBox(): string {
  if (state.androidNativeEnvironment.isAndroidNative) {
    return `
      <div class="mobile-wallet-box android-native-box">
        <h3>Android Native MWA</h3>
        <p>${escapeHtml(state.androidNativeStatus)}</p>
        <div class="capabilities compact-caps">
          <span>Android app</span>
          <span>MWA picker</span>
          <span>${state.androidAuthCacheCount} cached</span>
        </div>
        <div class="bridge-actions ios-state-actions">
          <button id="androidReconnectCached" ${state.busy ? 'disabled' : ''}>Reconnect cached</button>
          <button id="androidClearTransient" ${state.busy ? 'disabled' : ''}>Clear transient</button>
          <button id="androidFullReset" ${state.busy ? 'disabled' : ''}>Full reset</button>
          <button id="androidClearAllAccounts" ${state.busy ? 'disabled' : ''}>Clear all accounts</button>
        </div>
      </div>
    `;
  }
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
  const localMode = activeWorkflowMode() === 'local-bridge';
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
        ${state.bridgeActive ? '' : `
          <button id="connectBridge" class="primary" ${!state.address || state.busy ? 'disabled' : ''}>
            Check local bridge
          </button>
        `}
        ${state.bridgeActive
          ? localMode
            ? `<button data-workflow-mode="auto" ${state.busy ? 'disabled' : ''}>Use cloud/browser</button>`
            : `<button data-workflow-mode="local-bridge" class="utility" ${state.busy ? 'disabled' : ''}>Use private local mode</button>`
          : ''}
        <button id="disconnectBridge" ${!state.bridgeActive || state.busy ? 'disabled' : ''}>Disconnect</button>
      </div>
      <p class="bridge-ops-status">${escapeHtml(state.bridgeStatus)}</p>
      <div class="bridge-terminal-hint">
        <span>Start local runtime</span>
        <code>${NPM_EXEC_COMMAND}</code>
        <button data-copy="${NPM_EXEC_COMMAND}" data-copy-name="CLI one-shot command" title="Copy terminal command">Copy</button>
        <p>Run this in Terminal and keep that window open. Pressing Ctrl+C stops the bridge.</p>
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
  const androidNative = state.androidNativeEnvironment.isAndroidNative;
  const iosNative = state.iosNativeEnvironment.isIosNative;
  const nativeWallet = androidNative || iosNative;
  const selectedIosWallet = iosWalletLabel(state.selectedIosWalletId);
  return `
    <section class="guided-start signature-stage stage-dormant">
      <div class="guided-start-copy">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(detail)}</p>
      </div>
      <div class="guided-path" aria-label="Wallet connection path">
        ${guidedStep('1', androidNative ? 'Discover' : iosNative ? 'iOS paths' : 'Discover', androidNative ? 'Open the Android MWA wallet picker' : iosNative ? `${state.iosWallets.length} wallet path(s) ready` : state.wallets.length ? `${state.wallets.length} provider(s) found` : 'Find installed Wallet Standard providers', nativeWallet || state.wallets.length > 0)}
        ${guidedStep('2', 'Select', androidNative ? 'Choose from the MWA picker' : iosNative ? selectedIosWallet : selectedProvider || (state.wallets.length ? 'Choose a discovered provider' : 'Choose a wallet provider'), androidNative || (iosNative ? Boolean(selectedIosWallet) : Boolean(selectedProvider)))}
        ${guidedStep('3', 'Connect', 'Authorize this app in the wallet', Boolean(state.address))}
      </div>
      <div class="guided-actions">
        ${nativeWallet ? `
        <button data-start-action="connect" class="primary wallet-connect-cta" ${state.busy ? 'disabled' : ''}>
          ${walletButtonIcon()}
          <span>Connect wallet</span>
        </button>` : `
        <button data-start-action="discover" class="primary" ${state.busy ? 'disabled' : ''}>Discover wallets</button>
        <button data-start-action="connect" class="${state.wallets.length ? 'primary' : ''}" ${(state.wallets.length === 0 || !selectedProvider) || state.busy ? 'disabled' : ''} title="${!selectedProvider ? 'Discover and select a wallet provider first.' : ''}">Connect wallet</button>`}
      </div>
      <p class="guided-note">Needs Approval, repeat payments, saved proofs, and transaction tools unlock after a wallet is connected.</p>
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

function templateOutcome(template: AgentPlanTemplate): TemplateOutcome {
  if (template.actionType === 'read_only') return 'audit';
  if (templateCanQueue(template)) return 'queueable';
  return 'proof';
}

function templateCanQueue(template: AgentPlanTemplate): boolean {
  return ['transfer_sol', 'transfer_spl', 'swap', 'recurring_payment'].includes(template.actionType);
}

function planOutcome(plan: AgentPlan): TemplateOutcome {
  if (plan.actionType === 'read_only') return 'audit';
  if (canQueueAgentPlan(plan)) return 'queueable';
  return 'proof';
}

function outcomeLabel(outcome: TemplateOutcome): string {
  switch (outcome) {
    case 'queueable':
      return 'Can request wallet approval';
    case 'proof':
      return 'Proof only';
    case 'audit':
      return 'Evidence only';
  }
}

function outcomeShortLabel(outcome: TemplateOutcome): string {
  switch (outcome) {
    case 'queueable':
      return 'Approval-ready';
    case 'proof':
      return 'Proof only';
    case 'audit':
      return 'Evidence only';
  }
}

function outcomeDetailForTemplate(template: AgentPlanTemplate): string {
  const outcome = templateOutcome(template);
  if (template.actionType === 'recurring_payment') {
    return 'This creates a repeat payment. Each due payment appears in Needs Approval for approve or deny.';
  }
  switch (outcome) {
    case 'queueable':
      return 'This draft can request a wallet approval. Signed-in users use Agentic Cloud; signed-out workflow stays on this device.';
    case 'proof':
      return 'This can be signed as review evidence, but it cannot be queued as a transaction.';
    case 'audit':
      return 'This records context or analysis only. It does not queue a wallet action.';
  }
}

function outcomeDetailForPlan(plan: AgentPlan): string {
  const outcome = planOutcome(plan);
  if (plan.actionType === 'recurring_payment') {
    return 'Queueing creates a repeat payment rule. Future payments still require approval.';
  }
  switch (outcome) {
    case 'queueable':
      return 'Send this plan for approval when you want a wallet decision.';
    case 'proof':
      return 'This plan is for review evidence. Sign a review proof if you want an audit record.';
    case 'audit':
      return 'This plan records read-only context or audit notes. It does not move funds.';
  }
}

function outcomeClass(outcome: TemplateOutcome): string {
  return `outcome-${outcome}`;
}

function queueActionLabelForPlan(plan: AgentPlan): string {
  return plan.actionType === 'recurring_payment' ? 'Create repeat payment' : 'Send for approval';
}

function templatesForOutcomeFilter(filter = state.templateOutcomeFilter): AgentPlanTemplate[] {
  const templates = oneTimePlanTemplates();
  if (filter === 'all') return templates;
  return templates.filter((template) => templateOutcome(template) === filter);
}

function firstTemplateForOutcomeFilter(filter: TemplateOutcomeFilter): AgentPlanTemplate {
  return templatesForOutcomeFilter(filter)[0] ?? oneTimePlanTemplates()[0] ?? AGENT_PLAN_TEMPLATES[0]!;
}

function oneTimePlanTemplates(): AgentPlanTemplate[] {
  return AGENT_PLAN_TEMPLATES.filter((template) => template.actionType !== 'recurring_payment');
}

function activePanel(): string {
  switch (state.activeTab) {
    case 'overview':
      return commandCenterPanel();
    case 'wallet':
      return walletFlowPanel();
    case 'agent':
      return agentPlanPanel();
    case 'generated':
      state.activeTab = 'agent';
      state.oneTimePlanView = 'review';
      return agentPlanPanel();
    case 'inbox':
      return approvalInboxPanel();
    case 'completed':
      return completedPlansPanel();
    case 'schedule':
      return scheduledApprovalsPanel();
    case 'labs':
      return labsPanel();
  }
}

function commandCenterPanel(): string {
  return `
    <div class="command-shell">
      <div class="command-subtab-row" role="tablist" aria-label="Home sections">
        ${commandCenterSubtab('center', 'Center', 'Command overview')}
        ${commandCenterSubtab('ai', 'Connect AI', 'Agent setup')}
        ${commandCenterSubtab('storage', 'Connect Cloud Storage', 'Device and cloud workspace')}
      </div>
      ${state.commandCenterView === 'ai'
        ? commandCenterAiPanel()
        : state.commandCenterView === 'storage'
          ? commandCenterStoragePanel()
          : commandCenterOverviewPanel()}
    </div>
  `;
}

function commandCenterSubtab(view: CommandCenterView, label: string, detail: string): string {
  const active = state.commandCenterView === view;
  return `
    <button
      type="button"
      class="${active ? 'active' : ''}"
      data-command-center-view="${escapeHtml(view)}"
      role="tab"
      aria-selected="${active ? 'true' : 'false'}"
    >
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(detail)}</span>
    </button>
  `;
}

function commandCenterOverviewPanel(): string {
  const openApprovals = activeWorkflowPreparedActions().filter((action) => !action.archived && isActionInboxActive(action));
  const recurringActive = activeWorkflowRecurringPayments().filter((payment) => payment.status === 'active' && !isRecurringPaymentCompleted(payment));
  const completed = completedPlanRecords();
  const latestProof = state.labArtifacts[0];
  const latestHistory = completed[0];
  const proofLabel = latestProof
    ? `${latestProof.title || receiptLabelForKind(latestProof.kind)} - ${short(latestProof.artifactHash)}`
    : latestHistory
      ? `${latestHistory.status} - ${short(latestHistory.actionId ?? latestHistory.signature ?? latestHistory.id)}`
      : 'No proof yet';
  return `
    <div class="command-overview-stack">
      ${SHOW_DEV_CONTROLS ? '' : firstRunActionBand()}
      ${SHOW_DEV_CONTROLS ? '' : trustLayerPanel()}
      <section class="approval-object signature-stage stage-overview stage-anchor ${openApprovals.length ? 'stage-active' : 'stage-draft'}">
        <div class="signature-object-head command-center-head">
          ${sectionTitleLine('Approval workspace', 'Draft, review, approve, and prove agent actions from one controlled workspace.')}
          <div class="command-center-actions">
            <button type="button" class="primary" data-one-time-view="create">New Request</button>
            <button type="button" class="utility" data-tab="labs">Sign Proof</button>
          </div>
        </div>

        <div class="command-loop" aria-label="Agentic approval loop">
          ${commandLoopStep('Draft', 'AI or templates prepare a bounded request.', Boolean(state.agentPlan) || state.generatedPlans.length > 0)}
          ${commandLoopStep('Check', 'Check amount, route, recipient, risk, and rule.', state.generatedPlans.some(isGeneratedPlanActiveInReview))}
          ${commandLoopStep('Approve', 'Wallet signs only the visible decision.', openApprovals.length > 0)}
          ${commandLoopStep('Prove', 'Saved proofs stay attached to Done.', completed.length > 0 || state.labArtifacts.length > 0)}
        </div>

        <div class="command-center-grid">
          ${commandCenterWalletCard()}
          ${commandCenterCard('Approvals', `${openApprovals.length} pending`, approvalsCardDetail(openApprovals), openApprovals.length ? 'warn' : 'idle', 'open-inbox', openApprovals.length ? 'Review' : 'Open', 'approvals')}
          ${commandCenterCard('Repeat Payments', `${recurringActive.length} active`, recurringActive[0] ? scheduleLabel(recurringActive[0]) : 'No active repeat payments', recurringActive.length ? 'good' : 'idle', 'open-recurring', 'Open', 'recurring')}
          ${commandCenterCard('Save Proof', proofLabel, latestProof ? formatDateTime(latestProof.createdAt) : latestHistory ? formatDateTime(latestHistory.completedAt) : 'Save a proof or complete an approval', latestProof || latestHistory ? 'good' : 'idle', 'open-proofs', latestProof || latestHistory ? 'View' : 'Save', 'proofs')}
        </div>
      </section>
    </div>
  `;
}

function approvalsCardDetail(openApprovals: PreparedAction[]): string {
  const next = openApprovals[0];
  if (!next) return 'No approvals waiting';
  const recipient = recipientParam(next);
  const recipientShort = recipient ? short(recipient) : '';
  let base: string;
  if (next.kind === 'transfer_sol') {
    const amount = stringParam(next, 'amountSol') || stringParam(next, 'amount');
    const amountText = amount ? `${amount} SOL` : 'SOL';
    base = recipientShort ? `Send ${amountText} to ${recipientShort}` : `Send ${amountText}`;
  } else if (next.kind === 'transfer_spl') {
    const amount = stringParam(next, 'amount');
    const token = stringParam(next, 'token') || 'token';
    const tokenText = looksLikeMintAddress(token) ? tokenDisplayLabel(token) : token;
    const amountText = amount ? `${amount} ${tokenText}` : tokenText;
    base = recipientShort ? `Send ${amountText} to ${recipientShort}` : `Send ${amountText}`;
  } else if (next.kind === 'swap') {
    const input = stringParam(next, 'inputToken') || 'input';
    const output = stringParam(next, 'outputToken') || 'output';
    const amount = stringParam(next, 'amount') || stringParam(next, 'amountIn');
    const inputLabel = looksLikeMintAddress(input) ? tokenDisplayLabel(input) : input;
    const outputLabel = looksLikeMintAddress(output) ? tokenDisplayLabel(output) : output;
    base = amount ? `Swap ${amount} ${inputLabel} to ${outputLabel}` : `Swap ${inputLabel} to ${outputLabel}`;
  } else {
    base = preparedActionCardTitle(next);
  }
  const extra = openApprovals.length - 1;
  return extra > 0 ? `${base} (+${extra} more)` : base;
}

function commandCenterAiPanel(): string {
  const configured = isAiConfiguredForCurrentMode();
  const confirmed = isAiPlannerConfirmedForCurrentSettings();
  return `
    <div class="command-detail-stack command-ai-panel">
      <section class="approval-object signature-stage command-page-card">
        <div class="signature-object-head command-center-head">
          ${sectionTitleLine('Connect AI', 'Set up the agent route, provider, model, and connection boundary. Workflow actions still require explicit review.')}
          <div class="command-center-actions">
            <button type="button" class="primary" data-one-time-view="create">New Request</button>
          </div>
        </div>

        <div class="command-route-grid" aria-label="AI route capabilities">
          ${commandAiRouteCard(
            'hosted',
            'Hosted BYOK',
            'Connect a preset provider key through Agentic for AI agent requests.',
            'Cloud AI connection',
          )}
          ${commandAiRouteCard(
            'bridge',
            'Local Bridge AI',
            'Connect the local runtime so AI agent requests can use this machine.',
            'Local AI connection',
          )}
          ${commandAiRouteCard(
            'session',
            IS_ANDROID_APP ? 'Android Session' : 'Browser Session',
            `Connect a temporary key in ${IS_ANDROID_APP ? 'this app runtime' : 'this tab'} without saving it to Agentic.`,
            'Session AI connection',
          )}
        </div>

        ${state.aiSettings.mode === 'bridge' ? commandBridgePrereqPanel() : ''}

        ${commandAiWorkflowEducation()}

        <div class="command-ai-boundary">
          <strong>${configured ? confirmed ? 'Planner confirmed' : 'Planner configured' : 'Templates work without AI'}</strong>
          <span>No AI route can approve, submit, sign, move funds, or change workflow authority.</span>
        </div>

        ${aiSettingsCard('planner')}
      </section>
    </div>
  `;
}

function commandBridgePrereqPanel(): string {
  return `
    <div class="command-bridge-prereq command-bridge-prereq-compact">
      <div class="command-bridge-prereq-head">
        <div>
          <span class="accent-note">Install once or use CLI</span>
          <strong>Local bridge required on this computer</strong>
          <p>Start the local runtime, connect the same wallet in the tab it opens, then check the bridge here.</p>
        </div>
        <strong class="command-bridge-endpoint">${escapeHtml(compactEndpoint(state.bridgeUrl))}</strong>
      </div>
      <div class="bridge-command-row primary-runtime-command">
        <code>${escapeHtml(NPM_EXEC_COMMAND)}</code>
        <button type="button" data-copy="${escapeHtml(NPM_EXEC_COMMAND)}" data-copy-name="local runtime command">Copy</button>
      </div>
      <details class="command-bridge-details">
        <summary>Setup details and Desktop App</summary>
        <div class="command-bridge-detail-body">
          <ol class="local-runtime-steps">
            <li>Copy and run the one-shot command in Terminal.</li>
            <li>Connect your wallet in the browser tab it opens.</li>
            <li>Come back here and check the local bridge.</li>
          </ol>
          <span class="local-runtime-alt-label">Install CLI globally</span>
          <div class="bridge-command-row">
            <code>${escapeHtml(NPM_GLOBAL_INSTALL_COMMAND)}</code>
            <button type="button" data-copy="${escapeHtml(NPM_GLOBAL_INSTALL_COMMAND)}" data-copy-name="CLI install command">Copy</button>
          </div>
          <span class="local-runtime-alt-label">Run installed CLI</span>
          <div class="bridge-command-row">
            <code>${escapeHtml(INSTALLED_APP_COMMAND)}</code>
            <button type="button" data-copy="${escapeHtml(INSTALLED_APP_COMMAND)}" data-copy-name="installed CLI command">Copy</button>
          </div>
          <a class="button-link local-runtime-desktop-link" href="/desktop">Desktop App downloads</a>
        </div>
      </details>
    </div>
  `;
}

function commandAiWorkflowEducation(): string {
  return `
    <section class="command-ai-education" aria-label="AI workflow capabilities">
      <div class="command-ai-principle">
        <span>Benefits of connecting AI</span>
        <strong>Workflow-first. Wallet-approved. AI-optional.</strong>
        <p>AI changes the drafting and intelligence layer. It does not change who approves, signs, submits, or owns authority.</p>
      </div>
      <div class="command-ai-info-grid">
        ${commandAiInfoCard(
          'No AI / Templates',
          'Manual setup',
          'User fills the fields; the app creates a structured plan, sends work for approval, schedules repeat payments, and saves proofs.',
          'Best for deterministic actions where the user already knows the exact fields.',
        )}
        ${commandAiInfoCard(
          'Hosted BYOK',
          'Natural-language setup',
          'User brings a provider key; Agentic calls AI to translate messy intent into a structured workflow plan.',
          'More capable at understanding intent, not more powerful over approval.',
        )}
        ${commandAiInfoCard(
          IS_ANDROID_APP ? 'Android Session AI' : 'Browser Session AI',
          'Session drafting',
          `AI drafts inside ${IS_ANDROID_APP ? 'this app runtime' : 'this browser session'}, then the plan enters the same normalized workflow pipeline.`,
          'Useful for temporary keys, but subject to provider and session limits.',
        )}
        ${commandAiInfoCard(
          'Local Bridge',
          'Private local mode',
          'AI and workflow storage can run through the local runtime when the user wants private machine-local control.',
          'Still ends at explicit wallet approval and local signing.',
        )}
      </div>
    </section>
  `;
}

function commandAiInfoCard(title: string, badge: string, detail: string, foot: string): string {
  return `
    <article class="command-ai-info-card">
      <span>${escapeHtml(badge)}</span>
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(detail)}</p>
      <em>${escapeHtml(foot)}</em>
    </article>
  `;
}

function commandAiRouteCard(mode: AiSettings['mode'], title: string, detail: string, meta: string): string {
  const active = state.aiSettings.mode === mode;
  const disabledReason = aiModeDisabledReason(mode);
  return `
    <article class="command-route-card ${active ? 'active' : ''}">
      <div>
        <span>${escapeHtml(meta)}</span>
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(detail)}</p>
      </div>
      <button
        type="button"
        class="${active ? 'primary' : 'utility'}"
        data-ai-mode-choice="${escapeHtml(mode)}"
        ${disabledReason || state.busy ? 'disabled' : ''}
        ${disabledReason ? `title="${escapeHtml(disabledReason)}"` : ''}
      >
        ${active ? 'Selected' : 'Use route'}
      </button>
    </article>
  `;
}

function commandCenterStoragePanel(): string {
  const signedIn = state.cloudSession.status === 'signed-in' && cloudSessionMatchesWallet();
  const unavailable = state.cloudSession.status === 'unavailable';
  const headerAction = !state.address
    ? ''
    : unavailable
      ? `<button type="button" class="utility" disabled>Cloud unavailable</button>`
      : signedIn
        ? `<button type="button" class="utility" disabled>Cloud connected</button>`
        : `<button type="button" class="primary" data-cloud-action="sign-in" ${state.busy ? 'disabled' : ''}>Connect Cloud Storage</button>`;
  return `
    <div class="command-detail-stack command-storage-panel">
      <section class="approval-object signature-stage command-page-card">
        <div class="signature-object-head command-center-head">
          ${sectionTitleLine('Connect Cloud Storage', 'Choose browser-local storage or sign in to Agentic Cloud. No localhost required.')}
          <div class="command-center-actions" ${headerAction ? '' : 'hidden'}>
            ${headerAction}
          </div>
        </div>

        <div class="command-storage-grid" aria-label="Workspace storage modes">
          ${commandStorageDeviceCard()}
          ${commandStorageCloudCard()}
        </div>

        ${commandCloudStorageEducation()}

        <div class="command-storage-note">
          <strong>Wallet safety</strong>
          <span>Cloud sign-in uses your wallet as identity only. It does not grant spending authority.</span>
          <span>Signed-out plans, approvals, and proofs stay on this device. No localhost is required.</span>
        </div>

        ${commandCloudStorageDangerZone()}
      </section>
    </div>
  `;
}

function commandStorageDeviceCard(): string {
  const active = activeWorkflowMode() === 'browser-workflow';
  const signedIn = state.cloudSession.status === 'signed-in';
  return `
    <article class="command-storage-card ${active ? 'active' : ''}">
      <div class="command-storage-card-head">
        <span>Saved on device</span>
        <strong>${active ? 'Active' : 'Available'}</strong>
      </div>
      <p>Plans, approvals, repeat payments, and proofs stay on this device. No localhost required.</p>
      <div class="command-storage-facts">
        <span>Saved on this device</span>
        <span>No localhost</span>
      </div>
      <div class="command-storage-actions">
        ${signedIn
          ? `<button type="button" class="utility" data-cloud-action="sign-out" ${state.busy ? 'disabled' : ''}>Sign out to use device</button>`
          : active
            ? `<button type="button" class="utility" disabled>Active</button>`
            : `<button type="button" class="utility" data-workflow-mode="auto" ${state.busy ? 'disabled' : ''}>Use browser storage</button>`}
      </div>
    </article>
  `;
}

function commandCloudStorageEducation(): string {
  return `
    <section class="command-ai-education command-cloud-education" aria-label="Cloud storage benefits">
      <div class="command-ai-principle">
        <span>Benefits of connecting Cloud Storage</span>
        <strong>Durable workflow state without wallet custody.</strong>
        <p>Storage controls where unsigned plans, approvals, done work, repeat payments, and proofs live. AI setup stays in Connect AI.</p>
      </div>
      <div class="command-ai-info-grid">
        ${commandAiInfoCard(
          'Cloud Needs Approval',
          'Cross-session review',
          'Save drafts and due approval items to wallet-scoped cloud approval storage instead of only this browser.',
          'The wallet still signs every decision proof or supported transaction.',
        )}
        ${commandAiInfoCard(
          'Repeat Payment Scheduler',
          'Background workflow',
          'Cloud repeat payments can create due approval items, track payment history, pause/resume, expiry, and spend caps.',
          'AI can draft terms, but Cloud stores and schedules the workflow.',
        )}
        ${commandAiInfoCard(
          'Done + Saved Proofs',
          'Persistent audit trail',
          'Done work, saved proofs, risk metadata, and audit events survive refreshes and device changes.',
          'Receipt records are wallet-scoped and do not grant signing authority.',
        )}
        ${commandAiInfoCard(
          'No Key Custody',
          'Identity only',
          'Cloud sign-in proves wallet ownership for sync. It must not store seed phrases, private keys, delegated signers, or AI provider keys.',
          'Cloud makes the workflow durable; it cannot move funds by itself.',
        )}
      </div>
    </section>
  `;
}

function commandCloudStorageDangerZone(): string {
  if (state.cloudSession.status !== 'signed-in') return '';
  const matched = cloudSessionMatchesWallet();
  const reason = matched
    ? 'Permanently delete this wallet\'s Agentic Cloud drafts, approvals, repeat payments, proofs, done work, and app audit events.'
    : `Connect ${short(state.cloudSession.walletAddress)} to delete this cloud workspace.`;
  return `
    <div class="command-storage-danger-zone">
      <div>
        <span>Danger zone</span>
        <strong>Delete Cloud Workspace Data</strong>
        <p>${escapeHtml(reason)} Saved-on-device data and on-chain history remain unchanged.</p>
      </div>
      <button
        type="button"
        class="utility danger"
        data-cloud-action="delete-workspace"
        ${!matched || state.busy ? 'disabled' : ''}
        title="${escapeHtml(matched ? 'Requires a wallet signature before deletion.' : reason)}"
      >
        Delete Cloud Workspace Data
      </button>
    </div>
  `;
}

function commandStorageCloudCard(): string {
  const active = activeWorkflowMode() === 'agentic-cloud';
  const signedIn = state.cloudSession.status === 'signed-in';
  const unavailable = state.cloudSession.status === 'unavailable';
  const matched = cloudSessionMatchesWallet();
  const selectedProvider = discoveredSelectedWalletName();
  const hasDiscoveredWallet = state.wallets.length > 0 && Boolean(selectedProvider);
  const status = unavailable
    ? 'Unavailable'
    : active
      ? 'Active'
      : signedIn
        ? matched ? 'Signed in' : 'Wallet mismatch'
        : 'Signed out';
  const detail = signedIn && !matched
    ? `Signed in as ${short(state.cloudSession.walletAddress)}. Connect that wallet to use cloud workflow.`
    : 'Optional sync for one-time drafts, approvals, repeat payments, proofs, and done work.';
  return `
    <article class="command-storage-card ${active ? 'active' : ''}">
      <div class="command-storage-card-head">
        <span>Agentic Cloud</span>
        <strong>${escapeHtml(status)}</strong>
      </div>
      <p>${escapeHtml(detail)}</p>
      <div class="command-storage-facts">
        <span>Wallet identity only</span>
        <span>No spending authority</span>
      </div>
      <div class="command-storage-actions">
        ${!state.address
          ? `
            <button
              type="button"
              class="primary command-storage-discover"
              data-first-run-action="discover-wallets"
              ${state.busy ? 'disabled' : ''}
            >
              Discover
            </button>
            <button
              type="button"
              class="${hasDiscoveredWallet ? 'primary' : 'utility'} command-storage-connect"
              data-first-run-action="connect-wallet"
              ${hasDiscoveredWallet && !state.busy ? '' : 'disabled'}
              title="${hasDiscoveredWallet ? 'Connect the selected wallet provider.' : 'Discover and select a wallet provider first.'}"
            >
              Connect wallet
            </button>
          `
          : unavailable
            ? `<button type="button" class="utility" disabled>Cloud unavailable</button>`
            : signedIn
              ? `<button type="button" class="utility" data-cloud-action="sign-out" ${state.busy ? 'disabled' : ''}>Sign out</button>`
              : `<button type="button" class="primary" data-cloud-action="sign-in" ${state.busy ? 'disabled' : ''}>Sign in</button>`}
      </div>
    </article>
  `;
}

function commandCenterWalletCard(): string {
  if (state.address) {
    return commandCenterCard('Wallet', 'Connected', short(state.address), 'good', 'open-create-plan', 'Open', 'wallet');
  }
  const nativeWallet = state.androidNativeEnvironment.isAndroidNative || state.iosNativeEnvironment.isIosNative;
  if (nativeWallet) {
    return `
      <article class="command-center-card command-wallet-card warn">
        ${commandCenterCardLabel('Wallet', 'wallet')}
        <strong>Connect wallet</strong>
        <p>No signing authority granted</p>
        <div class="command-wallet-actions single">
          <button type="button" class="primary command-wallet-connect" data-first-run-action="connect-wallet" ${state.busy ? 'disabled' : ''}>
            Connect wallet
          </button>
        </div>
      </article>
    `;
  }
  const selectedProvider = discoveredSelectedWalletName();
  const hasDiscoveredWallet = state.wallets.length > 0 && Boolean(selectedProvider);
  const detail = hasDiscoveredWallet
    ? `${state.wallets.length} provider${state.wallets.length === 1 ? '' : 's'} discovered - ${selectedProvider}`
    : state.wallets.length
      ? `${state.wallets.length} provider${state.wallets.length === 1 ? '' : 's'} discovered - choose a wallet`
    : 'No signing authority granted';
  return `
    <article class="command-center-card command-wallet-card warn">
      ${commandCenterCardLabel('Wallet', 'wallet')}
      <strong>Connect wallet</strong>
      <p>${escapeHtml(detail)}</p>
      <div class="command-wallet-actions">
        <button
          type="button"
          class="utility command-wallet-discover ${state.wallets.length ? '' : 'primary'}"
          data-first-run-action="discover-wallets"
          ${state.busy ? 'disabled' : ''}
        >
          Discover
        </button>
        <button
          type="button"
          class="${hasDiscoveredWallet ? 'primary' : 'utility'} command-wallet-connect"
          data-first-run-action="connect-wallet"
          ${hasDiscoveredWallet && !state.busy ? '' : 'disabled'}
          title="${hasDiscoveredWallet ? 'Connect the selected wallet provider.' : 'Discover and select a wallet provider first.'}"
        >
          Connect
        </button>
      </div>
    </article>
  `;
}

function commandLoopStep(label: string, detail: string, complete: boolean): string {
  return `
    <div class="${complete ? 'complete' : ''}">
      <span>${escapeHtml(label)}</span>
      <p>${escapeHtml(detail)}</p>
    </div>
  `;
}

function commandCenterCard(
  label: string,
  value: string,
  detail: string,
  tone: string,
  action: FirstRunActionId | 'open-recurring' | 'open-proofs',
  buttonLabel = 'Open',
  icon?: CommandCenterIconId,
): string {
  const disabled = action === 'connect-wallet'
    ? !state.address && state.wallets.length === 0 && !state.androidNativeEnvironment.isAndroidNative && !state.iosNativeEnvironment.isIosNative
    : false;
  const targetTab = action === 'open-recurring'
    ? 'schedule'
    : action === 'open-proofs'
      ? 'labs'
      : '';
  return `
    <article class="command-center-card ${escapeHtml(tone)}">
      ${commandCenterCardLabel(label, icon)}
      <strong>${escapeHtml(value)}</strong>
      <p>${escapeHtml(detail)}</p>
      ${targetTab
        ? `<button type="button" class="utility" data-tab="${escapeHtml(targetTab)}" ${action === 'open-recurring' ? 'data-recurring-view="active"' : ''}>${escapeHtml(buttonLabel)}</button>`
        : `<button type="button" class="utility" data-first-run-action="${escapeHtml(action)}" ${disabled ? 'disabled' : ''}>${escapeHtml(buttonLabel)}</button>`}
    </article>
  `;
}

function commandCenterCardLabel(label: string, icon?: CommandCenterIconId): string {
  return `
    <span class="command-center-card-label">
      ${icon ? commandCenterIcon(icon) : ''}
      <span>${escapeHtml(label)}</span>
    </span>
  `;
}

function commandCenterIcon(icon: CommandCenterIconId): string {
  const paths: Record<CommandCenterIconId, string> = {
    wallet: '<path d="M4.75 7.75h13.5a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h11.5" /><path d="M15.75 12.25h4.5v3.25h-4.5a1.63 1.63 0 0 1 0-3.25Z" /><path d="M7 5.75 15.5 4" />',
    approvals: '<path d="M8.75 5.75h6.5" /><path d="M9.25 4.25h5.5a1 1 0 0 1 1 1v1.5h-7.5v-1.5a1 1 0 0 1 1-1Z" /><path d="M7 6.75H5.75a2 2 0 0 0-2 2v9.5a2 2 0 0 0 2 2h12.5a2 2 0 0 0 2-2v-9.5a2 2 0 0 0-2-2H17" /><path d="m8 14 2.35 2.35L16 10.75" />',
    recurring: '<path d="M17.25 7.25h-7.5a4 4 0 0 0-3.63 2.31" /><path d="m14.75 4.75 2.5 2.5-2.5 2.5" /><path d="M6.75 16.75h7.5a4 4 0 0 0 3.63-2.31" /><path d="m9.25 19.25-2.5-2.5 2.5-2.5" />',
    proofs: '<path d="M7.25 3.75h6.9l3.6 3.6v10.9a2 2 0 0 1-2 2h-8.5a2 2 0 0 1-2-2V5.75a2 2 0 0 1 2-2Z" /><path d="M14 3.95V7.5h3.55" /><path d="m8.5 13.85 2.15 2.15 4.85-5" />',
  };
  return `
    <svg class="command-center-card-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      ${paths[icon]}
    </svg>
  `;
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
  const reviewCount = generatedPlansForPanel(true).filter(isGeneratedPlanActiveInReview).length;
  const headerTitle = state.oneTimePlanView === 'review' ? 'Check request' : 'New Request';
  const headerDetail = state.oneTimePlanView === 'review'
    ? 'Saved one-time drafts. Send executable work to Needs Approval for a wallet decision.'
    : 'Create a one-time payment or swap. Nothing is sent until you approve it.';
  const statusMarker = state.oneTimePlanView === 'review'
    ? `<span class="signature-state accent-note ${state.agentSignature ? 'complete' : state.agentPlan ? 'active' : ''}">${reviewCount} plan${reviewCount === 1 ? '' : 's'}</span>`
    : '';
  return `
    <section class="approval-object signature-stage stage-agent ${state.agentSignature ? 'stage-complete' : state.agentPlan ? 'stage-active' : 'stage-draft'}">
      <div class="signature-object-head">
        ${sectionTitleLine(headerTitle, headerDetail)}
        ${statusMarker}
      </div>

      ${oneTimePlanTabs()}
      ${state.oneTimePlanView === 'review' ? generatedPlansPanel(true) : oneTimeCreatePlanPanel()}
      ${state.oneTimePlanView === 'create' && state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
    </section>
  `;
}

function oneTimePlanTabs(): string {
  return `
    <div class="one-time-plan-control-row">
      <div class="tabs compact-tabs one-time-plan-tabs" role="tablist" aria-label="One-time plan steps">
        ${oneTimePlanViewButton('create', 'Start')}
        ${oneTimePlanViewButton('review', 'Check')}
      </div>
      ${state.oneTimePlanView === 'create' ? templateOutcomeControls('header') : ''}
    </div>
  `;
}

function oneTimePlanViewButton(view: OneTimePlanView, label: string): string {
  const active = state.oneTimePlanView === view;
  return `
    <button
      data-one-time-view="${view}"
      class="${active ? 'active' : ''}"
      role="tab"
      aria-selected="${active ? 'true' : 'false'}"
      type="button"
      ${state.busy ? 'disabled' : ''}
    >
      ${escapeHtml(label)}
    </button>
  `;
}

function oneTimeCreatePlanPanel(): string {
  const walletReady = Boolean(state.address);
  const hasOneTimePlans = generatedPlansForPanel(true).length > 0;
  return `
    <div class="one-time-create-panel">
      ${agentPlannerWorkbench()}

      ${draftFlowHint(hasOneTimePlans, walletReady)}
    </div>
  `;
}

function draftFlowHint(hasOneTimePlans: boolean, walletReady: boolean): string {
  const reviewCopy = hasOneTimePlans ? 'Check already has saved drafts.' : 'New drafts move to Check.';
  const walletCopy = walletReady ? 'Wallet is ready when you send work for approval.' : 'Wallet is optional until approval or proof signing.';
  return `
    <div class="draft-flow-hint">
      <span class="accent-note">Draft flow</span>
      <p class="accent-note">${escapeHtml(reviewCopy)} Drafts save to Check; send for approval only when ready. ${escapeHtml(walletCopy)}</p>
    </div>
  `;
}

function draftReadyPanel(plan: AgentPlan): string {
  const outcome = planOutcome(plan);
  const queueable = canQueueGuardedPlan(plan);
  return `
    <section class="draft-ready-panel ${escapeHtml(outcomeClass(outcome))}">
      <div>
        <span class="workbench-kicker">Plan ready</span>
        <h3>${escapeHtml(outcomeLabel(outcome))}</h3>
        <p>${escapeHtml(outcomeDetailForPlan(plan))}</p>
      </div>
      ${planGuardrailStrip(plan)}
      <div class="draft-ready-actions">
        <button
          id="queueAgentPlan"
          class="${queueable ? 'primary' : 'utility'}"
          ${!state.address || !queueable || state.busy ? 'disabled' : ''}
          title="${escapeHtml(queuePlanTitle())}"
        >
          ${escapeHtml(queueActionLabelForPlan(plan))}
        </button>
        <button
          data-one-time-view="review"
          class="utility"
          ${state.busy ? 'disabled' : ''}
        >
          Check
        </button>
        <button
          id="signAgentPlan"
          class="utility"
          ${!state.address || state.busy ? 'disabled' : ''}
          title="${!state.address ? 'Connect a wallet before signing review evidence.' : 'Creates audit evidence only. It does not queue, approve, or submit a transaction.'}"
        >
          Sign review proof
        </button>
      </div>
    </section>
  `;
}

function generatedPlansPanel(embedded = false): string {
  const allPlans = generatedPlansForPanel(embedded);
  const visiblePlans = visibleGeneratedPlans(embedded);
  const paginatedPlans = paginateList(visiblePlans, 'review');
  const archivedCount = allPlans.filter((record) => record.status === 'archived').length;
  const activeCount = allPlans.filter(isGeneratedPlanActiveInReview).length;
  const movedCount = allPlans.filter(hasGeneratedPlanMovedPastReview).length;
  const selectedAuditRecord = generatedPlanById(state.generatedPlanAuditId);
  const auditRecord = selectedAuditRecord && (!embedded || isOneTimeGeneratedPlan(selectedAuditRecord))
    ? selectedAuditRecord
    : undefined;
  const toolbar = `
        <div class="generated-plans-toolbar signature-toolbar">
          <span class="signature-state micro-emphasis">${escapeHtml(`${activeCount} active`)}</span>
          <button
            data-one-time-view="create"
            class="utility"
            ${state.busy ? 'disabled' : ''}
          >
            Create another draft
          </button>
          <button
            id="toggleArchivedGeneratedPlans"
            class="utility"
            ${archivedCount === 0 ? 'disabled' : ''}
          >
            ${state.showArchivedGeneratedPlans ? 'Hide archived' : `Show archived (${archivedCount})`}
          </button>
        </div>
  `;
  const content = `
      ${embedded
        ? `<div class="generated-plans-toolbar-row">${toolbar}</div>`
        : `<div class="signature-object-head">
        ${sectionTitleLine('Check request', 'Saved one-time drafts. Send executable work to Needs Approval for a wallet decision.')}
        ${toolbar}
      </div>
      `}

      ${generatedPlanStatusLine(allPlans.length, visiblePlans.length, archivedCount, movedCount)}
      ${
        visiblePlans.length
          ? `
            <div class="${embedded ? 'review-plan-list' : 'generated-plan-grid'}" aria-label="Check request drafts" data-layout="${embedded ? 'review-plan-list' : 'generated-plan-grid'}">
              ${paginatedPlans.items.map((record) => generatedPlanCard(record)).join('')}
            </div>
            ${listPagination('review', paginatedPlans, 'Check drafts')}
          `
          : generatedPlansEmptyState(embedded)
      }
      ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
  `;
  if (embedded) {
    return `
      <div class="one-time-review-panel stage-generated stage-anchor ${allPlans.length ? 'stage-active' : 'stage-draft'}">
        ${content}
      </div>
      ${auditRecord ? generatedPlanAuditModal(auditRecord) : ''}
    `;
  }
  return `
    <section class="approval-object signature-stage stage-generated stage-anchor ${allPlans.length ? 'stage-active' : 'stage-draft'}">
      ${content}
    </section>
    ${auditRecord ? generatedPlanAuditModal(auditRecord) : ''}
  `;
}

function generatedPlanStatusLine(totalCount: number, visibleCount: number, archivedCount: number, movedCount: number): string {
  return `
    <div class="queue-status generated-plan-status">
      <span>${escapeHtml(`${totalCount} plan${totalCount === 1 ? '' : 's'} saved`)}</span>
      <strong class="accent-note">${visibleCount} in check</strong>
      <span>${movedCount} moved forward</span>
      <span>${archivedCount} archived</span>
      <span>Newest first</span>
    </div>
  `;
}

function generatedPlanCard(record: GeneratedPlanRecord): string {
  const plan = record.plan;
  const queueable = canQueueGeneratedPlan(record);
  const archived = record.status === 'archived';
  const signDisabled = !state.address || state.busy || archived ? 'disabled' : '';
  const queueDisabled = !state.address || !queueable || state.busy || archived ? 'disabled' : '';
  const selected = state.selectedGeneratedPlanId === record.id;
  const actionHint = generatedPlanActionHint(record);
  const guardrailBlocked = planGuardrailVerdict(plan) === 'block';
  const reviewSummary = generatedPlanReviewSummary(record);
  const metaHint = generatedPlanMetaHint(record, guardrailBlocked);
  return `
    <article class="generated-plan-card review-plan-card ${selected ? 'selected' : ''} ${archived ? 'archived' : ''}" data-layout="review-plan-card">
      <div class="review-plan-card-head">
        <div class="review-plan-title-block">
          <div class="review-plan-meta">
            <span class="status-pill ${generatedPlanStatusTone(record)}">${escapeHtml(generatedPlanStatusLabel(record))}</span>
            <span>${escapeHtml(record.source === 'ai' ? 'AI draft' : 'Template draft')}</span>
            ${generatedPlanFailurePill(record)}
            <span>${escapeHtml(formatDateTime(record.createdAt))}</span>
            ${metaHint ? `<span class="review-plan-meta-pill">${escapeHtml(metaHint)}</span>` : ''}
          </div>
          <h3>${escapeHtml(generatedPlanReviewTitle(record))}</h3>
          ${reviewSummary ? `<p>${escapeHtml(reviewSummary)}</p>` : ''}
        </div>
        ${generatedPlanHeroValue(record)}
        <div class="review-plan-actions">
          ${queueable ? `
            <button
              class="review-action-inbox"
              data-generated-plan-action="queue"
              data-generated-plan-id="${escapeHtml(record.id)}"
              ${queueDisabled}
              title="${escapeHtml(generatedQueuePlanTitle(record))}"
            >
              ${escapeHtml(queueActionLabelForPlan(plan))}
            </button>
          ` : ''}
          <button
            class="review-action-proof"
            data-generated-plan-action="sign-proof"
            data-generated-plan-id="${escapeHtml(record.id)}"
            ${signDisabled}
            title="${escapeHtml(signProofTitle(record))}"
          >
            Sign proof
          </button>
        </div>
      </div>

      ${generatedPlanReviewSummaryGrid(record)}
      ${generatedPlanUserNote(plan)}
      ${record.error ? `<p class="error-text">${escapeHtml(record.error)}</p>` : ''}
      ${guardrailBlocked ? actionHint : ''}

      <div class="review-plan-footer-row">
        <details class="generated-plan-inline-details review-plan-details">
          <summary>Details</summary>
          <div class="review-plan-details-body">
            <dl class="review-detail-list">
              ${reviewPlanDetailRows(record).map(([label, value]) => reviewPlanDetailRow(label, value)).join('')}
            </dl>
            ${planGuardrailStrip(plan)}
            ${generatedPlanCompactExtras(plan)}
            ${generatedPlanOutcomeStrip(record)}
            ${generatedPlanDetailActions(record)}
          </div>
        </details>
        <button
          class="utility danger review-delete-mini"
          data-generated-plan-action="delete"
          data-generated-plan-id="${escapeHtml(record.id)}"
          ${state.busy ? 'disabled' : ''}
        >
          Delete
        </button>
      </div>
    </article>
  `;
}

function generatedPlanReviewTitle(record: GeneratedPlanRecord): string {
  return record.plan.templateTitle || record.plan.intent;
}

function generatedPlanFailurePill(record: GeneratedPlanRecord): string {
  if (record.status !== 'failed' && !record.error && !record.failureLabel) return '';
  const label = record.failureLabel ||
    (record.plan.actionType === 'swap'
      ? 'Swap failed - try again'
      : record.plan.actionType === 'transfer_sol' || record.plan.actionType === 'transfer_spl'
        ? 'Send failed - try again'
        : 'Action failed - try again');
  return `<span class="status-pill tx-failed">${escapeHtml(label)}</span>`;
}

function generatedPlanReviewSummary(record: GeneratedPlanRecord): string {
  const plan = record.plan;
  if (plan.actionType === 'swap') {
    return '';
  }
  if (plan.actionType === 'manual_review') {
    return 'Prepare the request, expose the route and policy checks, then require a separate wallet approval before signing.';
  }
  if (plan.actionType === 'transfer_sol' || plan.actionType === 'transfer_spl' || plan.actionType === 'recurring_payment') {
    const recipient = planParameter(plan, ['recipient', 'recipientAddress', 'settlementWallet']);
    const recipientCopy = recipient ? ` to ${short(recipient)}` : '';
    return `${planAmountSummary(plan)}${recipientCopy}.`;
  }
  return compactSentence(plan.route || plan.intent);
}

function generatedPlanHeroValue(record: GeneratedPlanRecord): string {
  const plan = record.plan;
  const metric = reviewPlanMetric(plan);
  return `
    <div class="review-plan-value" title="${escapeHtml(`${metric.primary} ${metric.secondary}`.trim())}">
      <strong>${escapeHtml(metric.primary)}</strong>
      ${metric.secondary ? `<span>${escapeHtml(metric.secondary)}</span>` : ''}
    </div>
  `;
}

function reviewPlanMetric(plan: AgentPlan): { primary: string; secondary: string } {
  if (plan.actionType === 'swap') {
    const amount = planParameter(plan, ['amount', 'inputAmount', 'plannedAmount']) || 'Amount';
    const input = plan.parameters.inputToken || planParameter(plan, ['token']) || 'Input';
    const output = plan.parameters.outputToken || 'Output';
    const slippage = plan.parameters.slippageBps ? `${slippageBpsToPercentInput(plan.parameters.slippageBps)} max` : '';
    return {
      primary: `${amount} ${input}`,
      secondary: `${input} -> ${output}${slippage ? ` · ${slippage}` : ''}`,
    };
  }
  if (plan.actionType === 'transfer_sol' || plan.actionType === 'transfer_spl' || plan.actionType === 'recurring_payment') {
    return {
      primary: planAmountSummary(plan),
      secondary: planRecipientOrRoute(plan),
    };
  }
  if (plan.actionType === 'manual_review') {
    const amount = planAmountSummary(plan);
    return {
      primary: amount === 'n/a' ? 'Review proof' : amount,
      secondary: compactSentence(plan.templateTitle || 'Manual review', 56),
    };
  }
  return {
    primary: plan.actionType === 'read_only' ? 'Evidence only' : compactRiskLabel(plan.risk),
    secondary: compactSentence(plan.templateTitle || plan.actionType.replace(/_/g, ' '), 56),
  };
}

function generatedPlanReviewSummaryGrid(record: GeneratedPlanRecord): string {
  const plan = record.plan;
  const rows: WalletActionSummaryRow[] = [
    {
      label: 'Wallet',
      value: record.walletAddress || 'No wallet yet',
      tone: 'wallet',
      copyValue: record.walletAddress,
      copyName: 'Wallet address',
    },
    { label: plan.actionType === 'swap' ? 'Slippage' : 'Amount', value: plan.actionType === 'swap' ? planSlippageSummary(plan) : planAmountSummary(plan), tone: 'amount' },
    { label: 'Route', value: planRecipientOrRoute(plan) },
    { label: 'Risk', value: compactRiskLabel(plan.risk) },
  ];
  return `
    <section class="review-plan-summary" aria-label="Review summary">
      <dl class="review-plan-summary-grid">
        ${rows.map(walletActionSummaryRow).join('')}
      </dl>
    </section>
  `;
}

function generatedPlanUserNote(plan: AgentPlan): string {
  const note = plan.userNotes?.trim();
  if (!note) return '';
  return `
    <section class="review-plan-user-note" aria-label="User note" title="${escapeHtml(note)}">
      <span>Note</span>
      <p>${escapeHtml(note)}</p>
    </section>
  `;
}

function reviewPlanDetailRows(record: GeneratedPlanRecord): Array<[string, string]> {
  const plan = record.plan;
  return [
    ['Intent', compactSentence(plan.intent)],
    ['Template', plan.templateTitle],
    ['Network', titleCaseCluster(record.cluster)],
    ['Action', plan.actionType.replace(/_/g, ' ')],
    ['Route', compactSentence(plan.route)],
    ['Rule', compactSentence(plan.approval)],
    ['Effect', compactSentence(generatedPlanEffectLabel(record))],
  ];
}

function reviewPlanDetailRow(label: string, value: string): string {
  return `
    <div title="${escapeHtml(value)}">
      <dt>${escapeHtml(label)}</dt>
      <dd>${escapeHtml(value)}</dd>
    </div>
  `;
}

function compactRiskLabel(value: string): string {
  if (/high/i.test(value)) return 'High';
  if (/medium/i.test(value)) return 'Medium';
  if (/low/i.test(value)) return 'Low';
  return compactSentence(value);
}

function compactSentence(value: string, maxLength = 132): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

function planSlippageSummary(plan: AgentPlan): string {
  const slippage = plan.parameters.slippageBps;
  return slippage ? `${slippageBpsToPercentInput(slippage)} max` : 'Default';
}

function generatedPlanCompactExtras(plan: AgentPlan): string {
  const rows: Array<[string, string]> = [];
  if (plan.fields.length) {
    rows.push(['Fields', plan.fields.map((field) => `${field.label}: ${field.value}`).join('; ')]);
  }
  if (plan.safeguards.length) {
    rows.push(['Safeguards', plan.safeguards.join(' ')]);
  }
  if (!rows.length) return '';
  return `
    <dl class="review-detail-list compact-extra">
      ${rows.map(([label, value]) => reviewPlanDetailRow(label, compactSentence(value, 180))).join('')}
    </dl>
  `;
}

function generatedPlanDetailActions(record: GeneratedPlanRecord): string {
  const archived = record.status === 'archived';
  return `
    <div class="generated-plan-card-actions review-plan-detail-actions">
      <button
        data-generated-plan-action="reuse"
        data-generated-plan-id="${escapeHtml(record.id)}"
        ${state.busy ? 'disabled' : ''}
      >
        Use as starting point
      </button>
      <button
        class="utility"
        data-generated-plan-action="view"
        data-generated-plan-id="${escapeHtml(record.id)}"
      >
        Full details
      </button>
      <button
        class="utility"
        data-generated-plan-action="${archived ? 'restore' : 'archive'}"
        data-generated-plan-id="${escapeHtml(record.id)}"
        ${state.busy ? 'disabled' : ''}
      >
        ${archived ? 'Restore' : 'Archive'}
      </button>
    </div>
  `;
}

function generatedPlanMetaHint(record: GeneratedPlanRecord, guardrailBlocked: boolean): string {
  if (record.status === 'archived' || guardrailBlocked || state.address) return '';
  return 'Connect wallet to continue';
}

function generatedPlanInlineDetailsContent(plan: AgentPlan): string {
  return `
    ${plan.userNotes ? `
      <section>
        <span>User notes</span>
        <p>${escapeHtml(plan.userNotes)}</p>
      </section>
    ` : ''}
    ${plan.fields.length ? `
      <section>
        <span>Fields</span>
        <ul>${plan.fields.map((field) => `<li>${escapeHtml(`${field.label}: ${field.value}`)}</li>`).join('')}</ul>
      </section>
    ` : ''}
    ${plan.safeguards.length ? `
      <section>
        <span>Safeguards</span>
        <ul>${plan.safeguards.map((safeguard) => `<li>${escapeHtml(safeguard)}</li>`).join('')}</ul>
      </section>
    ` : ''}
  `;
}

function generatedPlanDecisionRows(plan: AgentPlan): Array<[string, string]> {
  const policyCap = plan.fields.find((field) => /policy|cap|limit/i.test(field.label) && field.value.trim().length > 0);
  return [
    ['Risk', plan.risk],
    ['Approval', plan.approval],
    policyCap ? [policyCap.label, policyCap.value] : ['Route', plan.route],
  ];
}

function generatedPlanDecisionItem(label: string, value: string): string {
  return `
    <div title="${escapeHtml(value)}">
      <span>${escapeHtml(label)}</span>
      <p>${escapeHtml(value)}</p>
    </div>
  `;
}

type WalletActionSummaryRow = {
  label: string;
  value: string;
  tone?: 'amount' | 'effect' | 'wallet';
  copyName?: string;
  copyValue?: string;
};

function generatedPlanWalletActionSummary(record: GeneratedPlanRecord): string {
  const rows: WalletActionSummaryRow[] = [
    { label: 'Wallet', value: record.walletAddress || 'No wallet at creation', tone: 'wallet' },
    { label: 'Amount', value: planAmountSummary(record.plan), tone: 'amount' },
    { label: 'Route or recipient', value: planRecipientOrRoute(record.plan) },
  ];
  return `
    <section class="wallet-action-summary" aria-label="Wallet action summary">
      <dl class="wallet-action-grid">
        ${rows.map(walletActionSummaryRow).join('')}
      </dl>
    </section>
  `;
}

function walletActionSummaryRow(row: WalletActionSummaryRow): string {
  return `
    <div class="${row.tone ? `wallet-action-${row.tone}` : ''}" title="${escapeHtml(row.value)}">
      <dt>${escapeHtml(row.label)}</dt>
      <dd class="${row.copyValue ? 'has-copy' : ''}">
        <span class="wallet-action-value">${escapeHtml(row.value)}</span>
        ${row.copyValue ? `
          <button
            type="button"
            class="wallet-action-copy"
            data-copy="${escapeHtml(row.copyValue)}"
            data-copy-name="${escapeHtml(row.copyName ?? row.label)}"
          >
            Copy
          </button>
        ` : ''}
      </dd>
    </div>
  `;
}

function planGuardrailStrip(plan: AgentPlan): string {
  const report = planGuardrailReport(plan);
  if (!report) return '';
  const tone = report.verdict === 'block' ? 'block' : report.verdict === 'warn' ? 'warn' : 'pass';
  const label = report.verdict === 'block'
    ? 'Blocked'
    : report.verdict === 'warn'
      ? 'Warnings'
      : 'Passed';
  return `
    <section class="plan-guardrail-strip ${tone}" aria-label="Plan guardrails">
      <div>
        <span>Guardrails</span>
        <strong>${escapeHtml(label)}</strong>
      </div>
      <p>${escapeHtml(report.summary)}</p>
      <dl>
        ${definitionRow('Final step', finalizationRequirementLabel(report.finalizationRequirement))}
        ${definitionRow(report.constraintHash ? 'Constraint hash' : 'Constraint fingerprint', report.constraintHash ?? report.constraintFingerprint)}
      </dl>
    </section>
  `;
}

function finalizationRequirementLabel(value: string): string {
  switch (value) {
    case 'transaction_preview':
      return 'Refresh quote, simulate, wallet approve, receipt';
    case 'wallet_decision_proof':
      return 'Wallet decision proof';
    case 'none':
      return 'No wallet action';
    default:
      return value.replace(/_/g, ' ');
  }
}

function walletActionLabelForPlan(plan: AgentPlan): string {
  switch (plan.actionType) {
    case 'transfer_sol':
      return 'SOL transfer';
    case 'transfer_spl':
      return 'SPL token transfer';
    case 'swap':
      return 'Swap review';
    case 'recurring_payment':
      return 'Repeat payment';
    case 'read_only':
      return 'Read-only review';
    case 'manual_review':
      return 'Review proof';
    default:
      return plan.actionType.replace(/_/g, ' ');
  }
}

function planAmountSummary(plan: AgentPlan): string {
  if (plan.actionType === 'swap') {
    const input = plan.parameters.inputToken || planParameter(plan, ['token']) || 'Input token';
    const output = plan.parameters.outputToken || 'Output token';
    const amount = planParameter(plan, ['amount', 'inputAmount', 'plannedAmount']) || 'Amount';
    return `${amount} ${input} -> ${output}`;
  }
  const amount = planParameter(plan, ['amountSol', 'amount', 'plannedAmount', 'maxAmount']) || 'n/a';
  const token = planParameter(plan, ['token', 'inputToken']) || (plan.actionType === 'transfer_sol' ? 'SOL' : '');
  return token ? `${amount} ${token}` : amount;
}

function planRecipientOrRoute(plan: AgentPlan): string {
  const recipient = planParameter(plan, ['recipient', 'recipientAddress', 'settlementWallet']);
  if (recipient) return recipient;
  if (plan.actionType === 'swap') {
    return `${plan.parameters.inputToken || 'input'} -> ${plan.parameters.outputToken || 'output'}`;
  }
  return plan.route;
}

function generatedPlanDestinationLabel(record: GeneratedPlanRecord): string {
  if (record.preparedActionId) {
    return workflowSourceLabel(record.workflowSource);
  }
  return activeWorkflowLabel();
}

function workflowSourceLabel(source: WorkflowRecordSource | undefined): string {
  switch (source) {
    case 'cloud':
      return 'Agentic Cloud workspace';
    case 'local-bridge':
      return 'Private local mode';
    case 'browser':
      return 'Saved on this device';
    default:
      return activeWorkflowLabel();
  }
}

function generatedPlanEffectLabel(record: GeneratedPlanRecord): string {
  const plan = record.plan;
  const report = planGuardrailReport(plan);
  if (report?.verdict === 'block') {
    return 'Blocked by guardrails. Recreate or edit the plan before sending for approval.';
  }
  if (!canQueueAgentPlan(plan)) {
    return 'Signs review evidence only. No approval, transaction, or funds movement.';
  }
  if (plan.actionType === 'recurring_payment') {
    return 'Creates a repeat payment. Each payment still needs wallet review.';
  }
  const source = record.workflowSource ?? (activeWorkflowMode() === 'agentic-cloud' ? 'cloud' : activeWorkflowMode() === 'local-bridge' ? 'local-bridge' : 'browser');
  if (source === 'local-bridge') {
    return 'Creates a local approval request. The wallet still approves the final request.';
  }
  if (source === 'cloud') {
    return 'Creates a cloud approval request. A later wallet proof records approve or deny.';
  }
  return 'Creates a saved-on-device approval request. A later wallet proof records approve or deny.';
}

function generatedPlanFact(label: string, value: string): string {
  return `
    <div title="${escapeHtml(value)}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function generatedPlanInlineDetails(plan: AgentPlan, detailsCount: number): string {
  if (detailsCount === 0) return '';
  return `
    <details class="generated-plan-inline-details">
      <summary>${escapeHtml(`${detailsCount} review details`)}</summary>
      <div>
        ${plan.userNotes ? generatedPlanMiniSection('User notes', [plan.userNotes]) : ''}
        ${plan.fields.length ? generatedPlanMiniSection('Fields', plan.fields.map((field) => `${field.label}: ${field.value}`)) : ''}
        ${plan.safeguards.length ? generatedPlanMiniSection('Safeguards', plan.safeguards) : ''}
      </div>
    </details>
  `;
}

function generatedPlanMiniSection(label: string, values: string[]): string {
  return `
    <section>
      <span>${escapeHtml(label)}</span>
      <ul>
        ${values.map((value) => `<li>${escapeHtml(value)}</li>`).join('')}
      </ul>
    </section>
  `;
}

function generatedPlanOutcomeStrip(record: GeneratedPlanRecord): string {
  if (!record.signature && !record.preparedActionId) return '';
  return `
    <div class="generated-plan-outcomes">
      ${record.signature ? `<span title="${escapeHtml(record.signature)}">Proof ${escapeHtml(short(record.signature))}</span>` : ''}
      ${record.preparedActionId ? `<span title="${escapeHtml(record.preparedActionId)}">Approval ${escapeHtml(short(record.preparedActionId))}</span>` : ''}
    </div>
  `;
}

function generatedPlanActionHint(record: GeneratedPlanRecord): string {
  if (record.status === 'archived') return '';
  const report = planGuardrailReport(record.plan);
  if (report?.verdict === 'block') {
    return `<p class="generated-plan-action-helper danger">${escapeHtml(report.summary)}</p>`;
  }
  if (!state.address) {
    return '<p class="generated-plan-action-helper">Connect a wallet to sign a review proof or send this plan for approval.</p>';
  }
  const mode = activeWorkflowMode();
  if (canQueueAgentPlan(record.plan) && mode === 'agentic-cloud') {
    return '<p class="generated-plan-action-helper">Signed in: this will use Agentic Cloud and still require wallet approval.</p>';
  }
  if (canQueueAgentPlan(record.plan) && mode === 'browser-workflow') {
    return '<p class="generated-plan-action-helper">Signed out: this will use saved-on-device storage in this browser.</p>';
  }
  if (!canQueueAgentPlan(record.plan)) {
    return '<p class="generated-plan-action-helper">Review-only plan: sign a proof to complete it. It will not need approval.</p>';
  }
  return '';
}

function bridgeRequiredNotice(message: string): string {
  if (state.bridgeActive) return '';
  return `
    <div class="bridge-required-notice">
      <p>${escapeHtml(message)}</p>
      <div class="bridge-required-actions">
        <button type="button" class="utility" data-bridge-action="connect" ${!state.address || state.busy ? 'disabled' : ''}>Check local bridge</button>
        ${bridgeSetupDetails('inline-bridge-setup', true)}
      </div>
    </div>
  `;
}

function bridgeSetupDetails(extraClass = '', open = false): string {
  return `
    <details class="bridge-setup-details ${escapeHtml(extraClass)}" ${open ? 'open' : ''}>
      <summary>Start local runtime</summary>
      <div class="bridge-setup-card">
        ${localRuntimeGuide('setup-popover')}
      </div>
    </details>
  `;
}

function localRuntimeGuide(extraClass = ''): string {
  return `
    <div class="local-runtime-guide ${escapeHtml(extraClass)}">
      <div class="local-runtime-guide-head">
        <span>Required on this computer</span>
        <strong>${escapeHtml(compactEndpoint(state.bridgeUrl))}</strong>
      </div>
      <p>This website cannot start the approval bridge directly. Start the local runtime, keep that terminal window open, then return here and click Check local bridge.</p>
      <ol class="local-runtime-steps">
        <li>Copy and run the one-shot command in Terminal.</li>
        <li>Connect your wallet in the browser tab it opens.</li>
        <li>Come back here and check the local bridge.</li>
      </ol>
      <span class="local-runtime-command-label">Install once or use CLI</span>
      <div class="bridge-command-row primary-runtime-command">
        <code>${escapeHtml(NPM_EXEC_COMMAND)}</code>
        <button type="button" data-copy="${escapeHtml(NPM_EXEC_COMMAND)}" data-copy-name="local runtime command">Copy</button>
      </div>
      <details class="local-runtime-alt">
        <summary>Install CLI once or use Desktop App</summary>
        <div class="local-runtime-alt-body">
          <span class="local-runtime-alt-label">Install CLI globally</span>
          <div class="bridge-command-row">
            <code>${escapeHtml(NPM_GLOBAL_INSTALL_COMMAND)}</code>
            <button type="button" data-copy="${escapeHtml(NPM_GLOBAL_INSTALL_COMMAND)}" data-copy-name="CLI install command">Copy</button>
          </div>
          <span class="local-runtime-alt-label">Run installed CLI</span>
          <div class="bridge-command-row">
            <code>${escapeHtml(INSTALLED_APP_COMMAND)}</code>
            <button type="button" data-copy="${escapeHtml(INSTALLED_APP_COMMAND)}" data-copy-name="installed CLI command">Copy</button>
          </div>
          <a class="button-link local-runtime-desktop-link" href="/desktop">Desktop App downloads</a>
        </div>
      </details>
    </div>
  `;
}

function cloudWorkspaceDeleteModal(): string {
  if (!state.cloudWorkspaceDeleteModalOpen) return '';
  const wallet = state.cloudSession.status === 'signed-in'
    ? short(state.cloudSession.walletAddress)
    : 'this wallet';
  return `
    <div class="generated-plan-modal-backdrop cloud-delete-modal-backdrop" role="presentation">
      <section class="generated-plan-modal cloud-delete-modal" role="dialog" aria-modal="true" aria-labelledby="cloud-delete-title">
        <div class="generated-plan-modal-head">
          <div>
            <span class="workbench-kicker">Cloud workspace deletion</span>
            <h2 id="cloud-delete-title">Delete Cloud Workspace Data?</h2>
            <p>This permanently removes the Agentic Cloud workspace for ${escapeHtml(wallet)}.</p>
          </div>
          <button class="utility" data-cloud-delete-cancel aria-label="Close cloud deletion confirmation">Close</button>
        </div>
        <div class="cloud-delete-warning">
          <strong>Requires wallet signature</strong>
          <p>Cloud drafts, approval items, repeat payments, proofs, done work, finalization records, and app audit events for this wallet will be deleted. Saved-on-device data and on-chain history are not deleted.</p>
        </div>
        <div class="generated-plan-modal-actions cloud-delete-actions">
          <button type="button" class="utility" data-cloud-delete-cancel ${state.busy ? 'disabled' : ''}>Cancel</button>
          <button type="button" class="utility danger" data-cloud-delete-confirm ${state.busy ? 'disabled' : ''}>Sign and delete cloud data</button>
        </div>
      </section>
    </div>
  `;
}

function generatedPlanAuditModal(record: GeneratedPlanRecord): string {
  const plan = record.plan;
  const queueable = canQueueGeneratedPlan(record);
  return `
    <div class="generated-plan-modal-backdrop" role="presentation">
      <section class="generated-plan-modal" role="dialog" aria-modal="true" aria-labelledby="generated-plan-audit-title">
        <div class="generated-plan-modal-head">
          <div>
            <span class="workbench-kicker">${escapeHtml(record.source === 'ai' ? 'AI plan details' : 'Template plan details')}</span>
            <h2 id="generated-plan-audit-title">${escapeHtml(plan.intent)}</h2>
            <p>${escapeHtml(generatedPlanMeta(record))}</p>
          </div>
          <button class="utility" data-generated-plan-modal-close aria-label="Close plan details">Close</button>
        </div>
        <div class="generated-plan-modal-actions">
          <button
            data-generated-plan-action="reuse"
            data-generated-plan-id="${escapeHtml(record.id)}"
            ${state.busy ? 'disabled' : ''}
          >
            Use as starting point
          </button>
          <button
            class="utility"
            data-generated-plan-action="sign-proof"
            data-generated-plan-id="${escapeHtml(record.id)}"
            ${!state.address || state.busy || record.status === 'archived' ? 'disabled' : ''}
            title="${escapeHtml(signProofTitle(record))}"
          >
            Sign review proof
          </button>
          <button
            class="${queueable ? 'primary' : 'utility'}"
            data-generated-plan-action="queue"
            data-generated-plan-id="${escapeHtml(record.id)}"
            ${!state.address || !queueable || state.busy || record.status === 'archived' ? 'disabled' : ''}
            title="${escapeHtml(generatedQueuePlanTitle(record))}"
          >
            ${escapeHtml(queueActionLabelForPlan(plan))}
          </button>
        </div>
        <div class="generated-plan-audit-body">
          <section class="generated-plan-audit-section">
            <div class="generated-plan-audit-section-head">
              <h3>Decision</h3>
              <span class="status-pill ${generatedPlanStatusTone(record)}">${escapeHtml(generatedPlanStatusLabel(record))}</span>
            </div>
            <dl class="generated-plan-audit-grid">
              ${generatedPlanAuditRow('Route', plan.route)}
              ${generatedPlanAuditRow('Risk', plan.risk)}
              ${generatedPlanAuditRow('Approval', plan.approval)}
            </dl>
            ${generatedPlanWalletActionSummary(record)}
            ${planGuardrailStrip(plan)}
          </section>
          <section class="generated-plan-audit-section">
            <div class="generated-plan-audit-section-head">
              <h3>Plan facts</h3>
            </div>
            <dl class="generated-plan-audit-grid compact">
              ${reviewSummaryRows(plan).map(([label, value]) => generatedPlanAuditRow(label, value)).join('')}
              ${generatedPlanAuditRow('Created', formatDateTime(record.createdAt))}
              ${generatedPlanAuditRow('Updated', formatDateTime(record.updatedAt))}
              ${generatedPlanAuditRow('Outcome', outcomeLabel(planOutcome(plan)))}
            </dl>
          </section>
          ${plan.userNotes ? generatedPlanAuditTextSection('User notes', plan.userNotes) : ''}
          ${plan.fields.length ? generatedPlanAuditListSection('Fields', plan.fields.map((field) => `${field.label}: ${field.value}`)) : ''}
          ${plan.safeguards.length ? generatedPlanAuditListSection('Safeguards', plan.safeguards) : ''}
          ${generatedPlanResultBlock(record)}
        </div>
      </section>
    </div>
  `;
}

function generatedPlanAuditRow(label: string, value: string): string {
  return `
    <div>
      <dt>${escapeHtml(label)}</dt>
      <dd>${escapeHtml(value)}</dd>
    </div>
  `;
}

function generatedPlanAuditTextSection(label: string, value: string): string {
  return `
    <section class="generated-plan-audit-section">
      <div class="generated-plan-audit-section-head">
        <h3>${escapeHtml(label)}</h3>
      </div>
      <p>${escapeHtml(value)}</p>
    </section>
  `;
}

function generatedPlanAuditListSection(label: string, values: string[]): string {
  return `
    <section class="generated-plan-audit-section">
      <div class="generated-plan-audit-section-head">
        <h3>${escapeHtml(label)}</h3>
      </div>
      <ul>
        ${values.map((value) => `<li>${escapeHtml(value)}</li>`).join('')}
      </ul>
    </section>
  `;
}

function generatedPlanResultBlock(record: GeneratedPlanRecord): string {
  if (!record.signature && !record.preparedActionId) {
    return '<div class="empty">Review proof signatures and queued approval ids appear here after action.</div>';
  }
  return `
    <div class="results generated-plan-results">
      ${record.signature ? `
        <div class="result-row">
          <span>Review proof</span>
          <code>${escapeHtml(record.signature)}</code>
          <button data-copy="${escapeHtml(record.signature)}" data-copy-name="Review proof">Copy</button>
        </div>
      ` : ''}
      ${record.preparedActionId ? `
        <div class="result-row">
          <span>Approval request / repeat payment</span>
          <code>${escapeHtml(record.preparedActionId)}</code>
          <button data-copy="${escapeHtml(record.preparedActionId)}" data-copy-name="Queued approval id">Copy</button>
        </div>
      ` : ''}
    </div>
  `;
}

function generatedPlansEmptyState(oneTimeOnly = false): string {
  const records = generatedPlansForPanel(oneTimeOnly);
  const activeCount = records.filter(isGeneratedPlanActiveInReview).length;
  const movedCount = records.filter(hasGeneratedPlanMovedPastReview).length;
  const archivedCount = records.filter((record) => record.status === 'archived').length;
  const detail = records.length === 0
    ? 'Create a draft first. It stays here for checking, then moves to Needs Approval or Done.'
    : activeCount === 0 && movedCount > 0
      ? 'All active drafts have moved forward. Open Needs Approval for queued work or Done for signed proofs and receipts.'
      : archivedCount > 0
        ? 'Archived plans are hidden. Show archived to inspect or restore them.'
        : 'Create another draft or check Needs Approval and Done for work that already moved forward.';
  return signaturePlaceholder('No plans visible', detail);
}

function agentPlannerWorkbench(): string {
  const template = selectedTemplate();
  const notesRequired = templateRequiresUserNotes(template);
  const canUseAi = canGenerateAiPlanFromSettings();
  const aiDisabledReason = aiGenerateDisabledReason();
  const templateGenerating = state.activeOperation === 'generate-template-plan';
  const aiGenerating = state.activeOperation === 'generate-ai-plan';
  const outcome = templateOutcome(template);
  const notesLabel = notesRequired
    ? 'Custom request / notes'
    : canUseAi
      ? 'Notes / AI instructions'
      : 'Notes for review record';
  const notesPlaceholder = notesRequired
    ? 'Describe what you want prepared or reviewed.'
    : canUseAi
      ? 'Optional context, reason, policy note, or AI instruction for this plan.'
      : 'Optional context, reason, or policy note saved with this plan.';
  return `
    <div class="agent-planner-grid planner-single-column">
      <div class="intent-capsule intent-document-card planner-card ${state.agentPlan ? 'plan-linked' : 'draft'}">
        <div class="intent-document-head">
          <div>
            <h3 class="plan-method-title">
              <span>${escapeHtml(template.title)}</span>
              <small>${escapeHtml(outcomeDetailForTemplate(template))}</small>
            </h3>
          </div>
          <strong class="template-outcome-badge ${escapeHtml(outcomeClass(outcome))}">${escapeHtml(outcomeShortLabel(outcome))}</strong>
        </div>
        <div class="planner-template-block">
          <div class="field compact planner-template-select">
            <span id="templatePickerLabel">Plan template</span>
            ${templatePicker(template)}
          </div>
          <p class="template-description">${escapeHtml(template.description)}</p>
        </div>
        <div class="planner-form-body">
          <div class="planner-fields">
            ${template.fields.map(templateFieldInput).join('')}
          </div>
          <label class="intent-document planner-prompt">
            <span>${notesLabel}${notesRequired ? ' *' : ''}</span>
            <textarea id="agentPrompt" placeholder="${escapeHtml(notesPlaceholder)}" ${state.busy ? 'disabled' : ''}>${escapeHtml(state.agentPrompt)}</textarea>
            ${fieldError('__notes')}
          </label>
          <div class="agent-actions signature-actions intent-document-actions">
            <button id="generatePlan" class="primary" ${state.busy ? 'disabled' : ''}>${templateGenerating ? `${buttonSpinner()}Drafting...` : 'Draft from template'}</button>
            <button id="generateAiPlan" class="${canUseAi ? 'primary' : ''}" ${!canUseAi || state.busy ? 'disabled' : ''} title="${escapeHtml(canUseAi ? 'Draft through your configured AI planner.' : aiDisabledReason)}">${aiGenerating ? `${buttonSpinner()}Drafting...` : 'Draft with AI'}</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function templateOutcomeControls(placement: 'header' | 'inline' = 'inline'): string {
  const filters: Array<[TemplateOutcomeFilter, string]> = [
    ['queueable', 'Can request approval'],
    ['proof', 'Proof only'],
    ['audit', 'Evidence only'],
    ['all', 'All'],
  ];
  const buttons = filters.map(([filter, label]) => `
    <button
      type="button"
      data-template-filter="${escapeHtml(filter)}"
      class="${state.templateOutcomeFilter === filter ? 'active' : ''}"
      ${state.busy ? 'disabled' : ''}
    >
      ${escapeHtml(label)}
    </button>
  `).join('');
  if (placement === 'header') {
    return `
      <div class="one-time-method-control" role="group" aria-label="Template outcome filter">
        <span class="one-time-method-label">
          <strong>Plan method</strong>
          <em class="accent-note">What this draft can do</em>
        </span>
        <div class="template-filter-row one-time-method-filter">
          ${buttons}
        </div>
      </div>
    `;
  }
  return `
    <div class="template-filter-row" role="group" aria-label="Template outcome filter">
      ${buttons}
    </div>
  `;
}

function templateOutcomeSummary(template: AgentPlanTemplate): string {
  const outcome = templateOutcome(template);
  return `
    <div class="template-outcome-summary ${escapeHtml(outcomeClass(outcome))}">
      <strong>${escapeHtml(outcomeLabel(outcome))}</strong>
      <p>${escapeHtml(outcomeDetailForTemplate(template))}</p>
    </div>
  `;
}

function aiSettingsPanel(location: 'rail' | 'planner' = 'planner'): string {
  const configured = isAiConfiguredForCurrentMode();
  const confirmed = isAiPlannerConfirmedForCurrentSettings();
  const shouldOpen = state.aiSettingsPanelOpen === true;
  const open = shouldOpen ? 'open' : '';
  const readinessLabel = aiReadinessLabel(state.aiStatus);
  const summaryDetail = location === 'rail'
    ? configured
      ? `${readinessLabel} - ${aiConfirmationLabel()}`
      : 'Plan drafting optional'
    : configured
      ? `${readinessLabel} - ${aiConfirmationLabel()}`
      : 'Optional AI planner; templates work without it.';
  return `
    <details class="ai-settings-panel ${configured ? 'configured' : 'optional'} ${location === 'rail' ? 'rail-ai-settings' : ''}" data-layout="ai-setup-panel" ${open}>
      <summary>
        <span class="ai-summary-copy">
          <span>AI drafting</span>
          <em>${escapeHtml(summaryDetail)}</em>
        </span>
        <strong>${confirmed ? 'confirmed' : configured ? 'configured' : 'not configured'}</strong>
      </summary>
      ${aiSettingsCard(location)}
    </details>
  `;
}

function agentPathExplainer(): string {
  return `
    <aside class="agent-route-strip" aria-label="One-time plan route">
      ${agentRouteStep('1', 'Draft', 'Template or AI prepares a bounded request.')}
      ${agentRouteStep('2', 'Check', 'Check limits, risk, route, and approval rule.')}
      ${agentRouteStep('3', 'Approve', 'Send queueable work for approval or sign proof only.')}
      ${agentRouteStep('4', 'Prove', 'Receipts and proofs stay in Done.')}
    </aside>
  `;
}

function agentRouteStep(index: string, title: string, detail: string): string {
  return `
    <div>
      <span>${escapeHtml(index)}</span>
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(detail)}</p>
    </div>
  `;
}

function templatePicker(template: AgentPlanTemplate): string {
  const selectedLabel = templatePickerLabel(template);
  const visibleTemplates = templatesForOutcomeFilter();
  const groups: Array<[TemplateOutcome, string]> = [
    ['queueable', 'Can request wallet approval'],
    ['proof', 'Proof only'],
    ['audit', 'Evidence only'],
  ];
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
        ${groups.map(([outcome, heading]) => {
          const groupTemplates = visibleTemplates.filter((candidate) => templateOutcome(candidate) === outcome);
          if (groupTemplates.length === 0) return '';
          return `
            <div class="template-picker-group" role="presentation">
              <span>${escapeHtml(heading)}</span>
              ${groupTemplates.map((candidate) => templatePickerOption(candidate, template)).join('')}
            </div>
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

function templatePickerOption(candidate: AgentPlanTemplate, selectedTemplate: AgentPlanTemplate): string {
  const selected = candidate.id === selectedTemplate.id;
  const outcome = templateOutcome(candidate);
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
      <span>${escapeHtml(titleCase(candidate.category))} / ${escapeHtml(outcomeShortLabel(outcome))}</span>
      <strong>${escapeHtml(candidate.title)}</strong>
      <em>${escapeHtml(candidate.description)}</em>
    </button>
  `;
}

function templateFieldInput(fieldDef: AgentPlanTemplateField): string {
  const value = templateFieldValue(fieldDef.id);
  const disabled = state.busy ? 'disabled' : '';
  const label = `${fieldDef.label}${fieldDef.required ? ' *' : ''}`;
  const error = fieldError(fieldDef.id);
  if (fieldDef.id === 'slippageBps') {
    return slippageFieldInput(fieldDef, value, label, error);
  }
  if (isTokenSelectField(fieldDef)) {
    return tokenFieldInput(fieldDef, value, label, error);
  }
  if (fieldDef.type === 'textarea' || fieldDef.id === 'policy') {
    return `
      <label class="field compact planner-field ${state.templateFieldErrors[fieldDef.id] ? 'field-error' : ''}">
        <span>${escapeHtml(label)}</span>
        <textarea data-template-field="${escapeHtml(fieldDef.id)}" placeholder="${escapeHtml(fieldDef.placeholder ?? '')}" ${disabled}>${escapeHtml(value)}</textarea>
        ${error}
      </label>
    `;
  }
  if (fieldDef.type === 'select' && fieldDef.options?.length) {
    return `
      <label class="field compact planner-field ${state.templateFieldErrors[fieldDef.id] ? 'field-error' : ''}">
        <span>${escapeHtml(label)}</span>
        ${selectPicker({
          value,
          options: fieldDef.options.map((option) => ({
            value: option,
            label: option,
            meta: fieldDef.label,
          })),
          attrs: { 'data-template-field': fieldDef.id },
          disabled: state.busy,
        })}
        ${error}
      </label>
    `;
  }
  return `
    <label class="field compact planner-field ${state.templateFieldErrors[fieldDef.id] ? 'field-error' : ''}">
      <span>${escapeHtml(label)}</span>
      <input data-template-field="${escapeHtml(fieldDef.id)}" value="${escapeHtml(value)}" placeholder="${escapeHtml(fieldDef.placeholder ?? '')}" ${disabled} />
      ${error}
    </label>
  `;
}

function slippageFieldInput(fieldDef: AgentPlanTemplateField, value: string, label: string, error: string): string {
  return `
    <label class="field compact planner-field ${state.templateFieldErrors[fieldDef.id] ? 'field-error' : ''}">
      <span>${escapeHtml(label)}</span>
      <input
        data-template-slippage-field="${escapeHtml(fieldDef.id)}"
        value="${escapeHtml(slippageBpsToPercentInput(value))}"
        placeholder="${escapeHtml(fieldDef.placeholder ?? '0.5%')}"
        inputmode="decimal"
        ${state.busy ? 'disabled' : ''}
      />
      ${error}
    </label>
  `;
}

function slippageBpsToPercentInput(value: string): string {
  const bps = Number(value);
  if (!Number.isFinite(bps) || bps <= 0) return value;
  const percent = bps / 100;
  const formatted = Number.isInteger(percent)
    ? String(percent)
    : percent.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return `${formatted}%`;
}

function slippagePercentInputToBps(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const normalized = trimmed.toLowerCase().replace(/\s+/g, '');
  const parsed = Number(normalized.replace(/%|bps/g, ''));
  if (!Number.isFinite(parsed) || parsed < 0) return trimmed;
  const bps = normalized.includes('bps') ? parsed : parsed * 100;
  return Number.isInteger(bps)
    ? String(bps)
    : bps.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function isTokenSelectField(fieldDef: AgentPlanTemplateField): boolean {
  return fieldDef.type === 'select' &&
    ['token', 'inputToken', 'outputToken'].includes(fieldDef.id) &&
    Boolean(fieldDef.options?.length);
}

function tokenFieldInput(fieldDef: AgentPlanTemplateField, value: string, label: string, error: string): string {
  const options = fieldDef.options ?? [];
  const presetMode = options.includes(value);
  const customValue = presetMode ? '' : value;
  const disabled = state.busy;
  return `
    <div class="field compact planner-field token-choice-field ${state.templateFieldErrors[fieldDef.id] ? 'field-error' : ''}">
      <span class="token-choice-head">
        <span>${escapeHtml(label)}</span>
        <span class="token-choice-mode" role="group" aria-label="${escapeHtml(`${fieldDef.label} input mode`)}">
          <button
            type="button"
            data-token-field-mode="preset"
            data-token-field-id="${escapeHtml(fieldDef.id)}"
            class="${presetMode ? 'active' : ''}"
            ${disabled ? 'disabled' : ''}
          >
            List
          </button>
          <button
            type="button"
            data-token-field-mode="custom"
            data-token-field-id="${escapeHtml(fieldDef.id)}"
            class="${presetMode ? '' : 'active'}"
            ${disabled ? 'disabled' : ''}
          >
            Mint
          </button>
        </span>
      </span>
      ${presetMode ? selectPicker({
        value,
        options: options.map((option) => ({
          value: option,
          label: option,
          meta: fieldDef.label,
        })),
        attrs: { 'data-template-field': fieldDef.id },
        disabled,
      }) : `
        <input
          data-template-field="${escapeHtml(fieldDef.id)}"
          value="${escapeHtml(customValue)}"
          placeholder="Paste token mint address"
          autocomplete="off"
          spellcheck="false"
          ${disabled ? 'disabled' : ''}
        />
      `}
      ${error}
    </div>
  `;
}

function fieldError(fieldId: string): string {
  const message = state.templateFieldErrors[fieldId] ?? state.recurringErrors[fieldId];
  return message ? `<em class="field-error-text">${escapeHtml(message)}</em>` : '';
}

function aiSettingsCard(location: 'rail' | 'planner' = 'planner'): string {
  const status = state.aiStatus;
  const providerPreset = aiProviderPresetById(state.aiSettings.provider);
  const isRail = location === 'rail';
  const scope = isRail ? 'rail' : 'command';
  const formatLabel = aiFormatLabel(state.aiSettings.apiFormat);
  const customProvider = providerPreset.id === 'custom-openai-compatible';
  const selectedPresetModel = providerPreset.models.find((model) => model.id === state.aiSettings.model);
  const usingCustomModel = !selectedPresetModel;
  const modeHelperText = aiModeHelperText();
  const providerHelperText = aiProviderHelperText();
  const setupHelperMessages = Array.from(new Set([modeHelperText, providerHelperText].filter(Boolean)));
  const routeLabel = aiRouteStatusLabel(status);
  const readinessLabel = aiReadinessLabel(status);
  const confirmationLabel = aiConfirmationLabel();
  const confirmationDetail = aiConfirmationDetail();
  const confirming = state.activeOperation === 'confirm-ai-planner';
  const keyLabel = state.aiSettings.mode === 'bridge'
    ? 'Bridge session key'
    : state.aiSettings.mode === 'hosted'
      ? 'Hosted BYOK key'
      : IS_ANDROID_APP
        ? 'Android session key'
        : 'Browser session key';
  const securityCopy = state.aiSettings.mode === 'hosted'
    ? 'Hosted BYOK relays this key only for AI draft requests. It cannot queue approvals, create repeat payments, approve, submit, or sign.'
    : state.aiSettings.mode === 'bridge'
      ? 'Local bridge AI drafts from your machine only. Needs Approval, repeat payments, proofs, and wallet signatures remain separate workflow actions.'
        : `${IS_ANDROID_APP ? 'Android session' : 'Browser session'} keys stay in ${IS_ANDROID_APP ? 'this app runtime' : 'this tab'} and draft plans only. Queueing, repeat payments, approvals, submissions, and signatures use the active workflow, not the AI key.`;
  const keyHint = aiProviderKeyHint(providerPreset.id);
  return `
    <aside class="ai-settings-card" data-ai-settings-scope="${escapeHtml(scope)}">
      ${isRail ? '' : `<div class="ai-settings-intro">
        <span class="workbench-kicker">Connect AI</span>
        <h3>Agent setup</h3>
        <p>${escapeHtml(securityCopy)}</p>
      </div>`}
      <label class="field compact ai-setting-field ai-setting-path">
        <span>AI path</span>
        ${selectPicker({
          id: `aiMode-${scope}`,
          value: state.aiSettings.mode,
          options: aiModeSelectOptions(),
          attrs: { 'data-ai-control': 'mode' },
          disabled: state.busy,
          title: modeHelperText,
        })}
        ${isRail && modeHelperText ? `<em class="ai-route-helper">${escapeHtml(modeHelperText)}</em>` : ''}
      </label>
      <label class="field compact ai-setting-field ai-setting-provider">
        <span>Provider preset</span>
        ${selectPicker({
          id: `aiProvider-${scope}`,
          value: state.aiSettings.provider,
          options: aiProviderSelectOptions(),
          attrs: { 'data-ai-control': 'provider' },
          disabled: state.busy,
          title: providerHelperText,
        })}
        ${isRail && providerHelperText ? `<em class="ai-route-helper">${escapeHtml(providerHelperText)}</em>` : ''}
      </label>
      <label class="field compact ai-setting-field ai-setting-model">
        <span>Model</span>
        ${selectPicker({
          id: `aiModelSelect-${scope}`,
          value: usingCustomModel ? CUSTOM_AI_MODEL_VALUE : state.aiSettings.model,
          options: [
            ...providerPreset.models.map((model) => ({
              value: model.id,
              label: model.label,
              meta: 'Model preset',
            })),
            { value: CUSTOM_AI_MODEL_VALUE, label: 'Custom model', meta: 'Model' },
          ],
          attrs: { 'data-ai-control': 'model-select' },
          disabled: state.busy,
        })}
      </label>
      ${usingCustomModel ? `
        <label class="field compact ai-setting-field ai-setting-custom-model">
          <span>Custom model</span>
          <input id="aiModelCustom-${escapeHtml(scope)}" data-ai-control="model-custom" value="${escapeHtml(state.aiSettings.model)}" placeholder="${escapeHtml(providerPreset.model)}" ${state.busy ? 'disabled' : ''} />
        </label>
      ` : ''}
      ${customProvider ? `
        <label class="field compact ai-setting-field ai-setting-base-url">
          <span>Gateway URL</span>
          <input id="aiBaseUrl-${escapeHtml(scope)}" data-ai-control="base-url" value="${escapeHtml(state.aiSettings.baseUrl)}" placeholder="${escapeHtml(providerPreset.baseUrl)}" ${state.busy ? 'disabled' : ''} />
        </label>
      ` : ''}
      ${!isRail && setupHelperMessages.length ? `
        <div class="ai-helper-row" aria-live="polite">
          ${setupHelperMessages.map((message) => `<em class="ai-route-helper">${escapeHtml(message)}</em>`).join('')}
        </div>
      ` : ''}
      <label class="field compact ai-setting-field ai-setting-key">
        <span>${escapeHtml(keyLabel)}</span>
        <input id="aiApiKey-${escapeHtml(scope)}" data-ai-control="api-key" type="password" value="${escapeHtml(state.aiSettings.apiKey)}" placeholder="Not saved by default" autocomplete="off" ${state.busy ? 'disabled' : ''} />
        ${!isRail && keyHint ? `<em class="ai-route-helper">${escapeHtml(keyHint)}</em>` : ''}
      </label>
      <div class="ai-actions">
        ${state.aiSettings.mode === 'bridge'
          ? `<button id="saveBridgeAiKey-${escapeHtml(scope)}" data-ai-action="save-bridge-key" ${!canSaveBridgeAiKey() ? 'disabled' : ''}>Set bridge key</button>`
          : `<button id="saveDirectAiKey-${escapeHtml(scope)}" data-ai-action="save-direct-key" ${!canSaveDirectAiKey() ? 'disabled' : ''}>Use key for drafts</button>`}
        <button id="confirmAiPlanner-${escapeHtml(scope)}" data-ai-action="confirm-planner" class="utility" ${!canConfirmAiPlanner() ? 'disabled' : ''} title="${escapeHtml(canConfirmAiPlanner() ? 'Confirm planner readiness without creating a plan.' : aiConfirmDisabledReason())}">
          ${confirming ? `${buttonSpinner()}Confirming...` : 'Confirm planner'}
        </button>
        <button id="clearAiKey-${escapeHtml(scope)}" data-ai-action="clear-key" ${!canClearAiKey() ? 'disabled' : ''}>Clear key</button>
        ${state.aiSettings.mode === 'bridge' ? `<button id="refreshAiStatus-${escapeHtml(scope)}" data-ai-action="refresh-status" ${state.busy ? 'disabled' : ''}>Refresh</button>` : ''}
      </div>
      ${isRail
        ? '<p class="ai-security-note compact">Drafts only. Wallet approvals stay separate.</p>'
        : `
          ${aiModeLimitations()}
          ${state.aiSettings.mode === 'bridge' ? localBridgeConnectionCard(status) : ''}
          <div class="ai-readiness-summary" aria-label="AI planner readiness">
            <div>
              <span>Planner check</span>
              <strong id="aiConfirmationStatus-${escapeHtml(scope)}" data-ai-confirmation-status>${escapeHtml(confirmationLabel)}</strong>
              <p id="aiConfirmationDetail-${escapeHtml(scope)}" data-ai-confirmation-detail>${escapeHtml(confirmationDetail)}</p>
            </div>
            <div>
              <span>Status</span>
              <strong>${escapeHtml(readinessLabel)}</strong>
            </div>
            <div>
              <span>Route</span>
              <strong>${escapeHtml(routeLabel)}</strong>
            </div>
            <div>
              <span>Format</span>
              <strong>${escapeHtml(formatLabel)}</strong>
            </div>
            <div>
              <span>Impact</span>
              <strong>Drafting only</strong>
            </div>
          </div>
          ${aiDiagnosticsPanel()}
          <p class="ai-security-note">AI Planner only drafts. Templates, Needs Approval, repeat payments, and proofs use the active workflow; private local bridge is optional.</p>
        `}
    </aside>
  `;
}

function aiModeOptions(): string {
  return aiModeSelectOptions().map((option) => `
      <option
        value="${escapeHtml(option.value)}"
        ${option.value === state.aiSettings.mode ? 'selected' : ''}
        ${option.disabled ? `disabled title="${escapeHtml(option.title ?? option.detail ?? '')}"` : ''}
      >
        ${escapeHtml(option.label)}
      </option>
    `).join('');
}

function aiModeSelectOptions(): SelectPickerOption[] {
  const options: Array<{ id: AiSettings['mode']; label: string }> = IS_ANDROID_APP
    ? [
        { id: 'session', label: 'Android session - drafts only' },
        { id: 'bridge', label: 'Local bridge AI - optional' },
        { id: 'hosted', label: 'Hosted BYOK - hosted web only' },
      ]
    : [
        { id: 'hosted', label: 'Hosted BYOK - drafts only' },
        { id: 'bridge', label: 'Local bridge AI - draft via bridge' },
        { id: 'session', label: 'Browser session - drafts only' },
      ];
  return options.map((option) => {
    const disabledReason = aiModeDisabledReason(option.id);
    return {
      value: option.id,
      label: option.label,
      meta: 'Draft path',
      detail: disabledReason || 'Drafts only; approvals and signatures stay separate.',
      disabled: Boolean(disabledReason),
      title: disabledReason,
    };
  });
}

function aiProviderOptions(): string {
  return aiProviderSelectOptions().map((option) => `
      <option
        value="${escapeHtml(option.value)}"
        ${option.value === state.aiSettings.provider ? 'selected' : ''}
        ${option.disabled ? `disabled title="${escapeHtml(option.title ?? option.detail ?? '')}"` : ''}
      >
        ${escapeHtml(option.label)}
      </option>
    `).join('');
}

function aiProviderSelectOptions(): SelectPickerOption[] {
  return AI_PROVIDER_PRESETS.map((preset) => {
    const disabledReason = aiProviderDisabledReason(preset.id);
    return {
      value: preset.id,
      label: preset.label,
      meta: preset.apiFormat ? aiFormatLabel(preset.apiFormat) : 'Provider',
      detail: disabledReason || preset.baseUrl || 'Provider preset',
      logoId: aiProviderLogoId(preset.id),
      disabled: Boolean(disabledReason),
      title: disabledReason,
    };
  });
}

function aiProviderLogoId(providerId: AiSettings['provider']): BrandLogoId {
  switch (providerId) {
    case 'openai':
      return 'codex';
    case 'anthropic':
      return 'claude';
    case 'gemini':
      return 'gemini';
    case 'openrouter':
    case 'custom-openai-compatible':
      return 'agentRouter';
  }
}

function aiModeDisabledReason(mode: AiSettings['mode']): string {
  if (IS_ANDROID_APP && mode === 'hosted') {
    return ANDROID_HOSTED_BYOK_DISABLED_REASON;
  }
  if (mode === 'session' && state.aiSettings.provider === 'openai') {
    return OPENAI_BROWSER_SESSION_DISABLED_REASON;
  }
  return '';
}

function aiProviderDisabledReason(providerId: string): string {
  if (state.aiSettings.mode === 'session' && providerId === 'openai') {
    return OPENAI_BROWSER_SESSION_DISABLED_REASON;
  }
  if (state.aiSettings.mode === 'hosted' && providerId === 'custom-openai-compatible') {
    return HOSTED_CUSTOM_PROVIDER_DISABLED_REASON;
  }
  return '';
}

function aiModeHelperText(): string {
  const hostedBlockReason = hostedByokCloudSessionReason();
  if (hostedBlockReason) return hostedBlockReason;
  return state.aiSettings.mode === 'session' && state.aiSettings.provider === 'openai'
    ? OPENAI_BROWSER_SESSION_DISABLED_REASON
    : '';
}

function aiProviderHelperText(): string {
  if (state.aiSettings.mode === 'session') {
    if (IS_ANDROID_APP) {
      return state.aiSettings.provider === 'openai'
        ? 'Android session AI drafts in the bundled app only. Use OpenRouter or a browser-compatible gateway.'
        : '';
    }
    return state.aiSettings.provider === 'openai'
      ? OPENAI_BROWSER_SESSION_DISABLED_REASON
      : '';
  }
  if (state.aiSettings.mode === 'hosted') {
    if (IS_ANDROID_APP) {
      return ANDROID_HOSTED_BYOK_DISABLED_REASON;
    }
    return state.aiSettings.provider === 'custom-openai-compatible'
      ? HOSTED_CUSTOM_PROVIDER_DISABLED_REASON
      : '';
  }
  return '';
}

function aiProviderKeyHint(providerId: string): string {
  switch (providerId) {
    case 'openai':
      return 'OpenAI/Codex keys are provider-specific; no universal agent-key pattern exists.';
    case 'anthropic':
      return 'Use a Claude / Anthropic key. Do not rely on a shared pattern across providers.';
    case 'gemini':
      return 'Use a Gemini / Google API key. Treat provider keys as opaque secrets.';
    case 'openrouter':
      return 'Use an OpenRouter key. Examples often use sk-or-v1, but validate by provider.';
    default:
      return 'Provider keys are opaque. Use a key for the selected gateway.';
  }
}

function aiModeLimitations(): string {
  if (state.aiSettings.mode === 'session') {
    return `
      <div class="ai-limitations">
        <span>Browser session limits</span>
        <ul>
          ${BROWSER_AI_LIMITATIONS.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
        </ul>
      </div>
    `;
  }
  if (state.aiSettings.mode === 'hosted') {
    return `
      <div class="ai-limitations">
        <span>Hosted BYOK boundary</span>
        <ul>
          <li>Agentic relays the key only for the current draft request.</li>
          <li>No AI path can approve, submit, sign, or change workflow capability.</li>
        </ul>
      </div>
    `;
  }
  return `
    <div class="ai-limitations">
      <span>Local bridge AI boundary</span>
      <ul>
        <li>Local bridge AI drafts only from your machine.</li>
        <li>Private local workflow remains optional and separate from AI setup.</li>
      </ul>
    </div>
  `;
}

function localBridgeConnectionCard(status: BridgeAiStatus | null): string {
  const connected = state.bridgeActive;
  const aiConfigured = Boolean(status?.available);
  const tone = connected ? 'connected' : aiConfigured ? 'partial' : 'offline';
  const title = connected
    ? 'Local bridge connected'
    : aiConfigured
      ? 'Bridge AI key configured'
      : 'Local bridge not connected';
  const detail = connected
    ? 'Approval queue, repeat payments, proofs, and local AI route are reachable from this browser.'
    : aiConfigured
      ? 'The AI key is set in the local bridge, but this wallet host still needs to connect to the approval bridge.'
      : 'Start the local runtime on this computer, then check the local bridge from this browser.';
  const keyLabel = aiConfigured
    ? `${status?.provider ?? status?.apiFormat ?? 'AI'} - ${status?.model ?? 'model configured'}`
    : 'AI key not configured';
  return `
    <div class="local-bridge-connection-card ${tone}">
      <div class="local-bridge-connection-head">
        <span>${escapeHtml(connected ? 'Connected' : aiConfigured ? 'Key set' : 'Setup needed')}</span>
        <strong>${escapeHtml(title)}</strong>
      </div>
      <p>${escapeHtml(detail)}</p>
      <div class="local-bridge-facts">
        <span>Endpoint <strong>${escapeHtml(compactEndpoint(state.bridgeUrl))}</strong></span>
        <span>Wallet <strong>${escapeHtml(state.address ? short(state.address) : 'Not connected')}</strong></span>
        <span>AI <strong>${escapeHtml(keyLabel)}</strong></span>
      </div>
      ${connected ? '' : `
        <button type="button" class="utility" data-bridge-action="connect" ${!state.address || state.busy ? 'disabled' : ''}>
          Check local bridge
        </button>
      `}
    </div>
  `;
}

function aiDiagnosticsPanel(): string {
  if (state.aiDiagnostics.length === 0) return '';
  return `
    <div class="ai-diagnostics" aria-label="AI diagnostics">
      <span>Diagnostics</span>
      <div class="ai-diagnostics-list">
        ${state.aiDiagnostics.map((entry) => `
          <div class="ai-diagnostic-entry ${entry.code === 'AI_ROUTE_MISMATCH' || entry.code === 'AI_PROVIDER_ERROR' ? 'error' : ''}">
            <strong>${escapeHtml(entry.code)}</strong>
            <p>${escapeHtml(aiDiagnosticMessage(entry))}</p>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function aiDiagnosticMessage(entry: AiDiagnosticEntry): string {
  const parts = [
    entry.message,
    entry.detail,
    entry.status !== undefined ? `status=${entry.status}` : '',
    entry.contentType ? `content-type=${entry.contentType}` : '',
    entry.path ? `path=${entry.path}` : '',
  ].filter(Boolean);
  return redactSecrets(parts.join(' | '), state.aiSettings.apiKey);
}

function currentAiPlannerConfirmationKey(): string {
  const mode = state.aiSettings.mode;
  const provider = mode === 'bridge'
    ? state.aiStatus?.provider ?? state.aiSettings.provider
    : state.aiSettings.provider;
  const apiFormat = mode === 'bridge'
    ? state.aiStatus?.apiFormat ?? state.aiSettings.apiFormat
    : state.aiSettings.apiFormat;
  const baseUrl = mode === 'bridge'
    ? state.aiStatus?.baseUrl ?? state.aiSettings.baseUrl
    : state.aiSettings.baseUrl;
  const model = mode === 'bridge'
    ? state.aiStatus?.model ?? state.aiSettings.model
    : state.aiSettings.model;
  return [mode, provider, apiFormat, baseUrl.trim(), model.trim()].join('|');
}

function isAiPlannerConfirmedForCurrentSettings(): boolean {
  return state.aiPlannerConfirmation.status === 'confirmed'
    && state.aiPlannerConfirmation.key === currentAiPlannerConfirmationKey();
}

function isAiPlannerFailedForCurrentSettings(): boolean {
  return state.aiPlannerConfirmation.status === 'failed'
    && state.aiPlannerConfirmation.key === currentAiPlannerConfirmationKey();
}

function aiConfirmationLabel(): string {
  if (isAiPlannerConfirmedForCurrentSettings()) {
    if (state.aiSettings.mode === 'hosted') return 'Route confirmed';
    if (state.aiSettings.mode === 'session') return 'Config checked';
    return 'Status confirmed';
  }
  if (isAiPlannerFailedForCurrentSettings()) return 'Check failed';
  if (isAiConfiguredForCurrentMode()) return 'Confirm planner';
  return 'Not ready';
}

function aiConfirmationDetail(): string {
  if (isAiPlannerConfirmedForCurrentSettings()) {
    const checkedAt = state.aiPlannerConfirmation.checkedAt
      ? ` Checked ${formatDateTime(state.aiPlannerConfirmation.checkedAt)}.`
      : '';
    return `${state.aiPlannerConfirmation.message}${checkedAt}`.trim();
  }
  if (isAiPlannerFailedForCurrentSettings()) {
    return state.aiPlannerConfirmation.message || 'Planner confirmation failed. Templates still work without AI.';
  }
  if (isAiConfiguredForCurrentMode()) {
    return 'Confirm the planner route before generating if you want a readiness check. Templates still work without AI.';
  }
  return `${aiGenerateDisabledReason()} Templates still work without AI.`;
}

function setAiPlannerConfirmation(status: AiPlannerConfirmationStatus, message: string): void {
  state.aiPlannerConfirmation = {
    status,
    key: currentAiPlannerConfirmationKey(),
    message,
    checkedAt: status === 'untested' ? '' : new Date().toISOString(),
  };
}

function resetAiPlannerConfirmation(message = ''): void {
  state.aiPlannerConfirmation = {
    status: 'untested',
    key: '',
    message,
    checkedAt: '',
  };
}

function canConfirmAiPlanner(): boolean {
  if (state.busy) return false;
  if (state.aiSettings.mode === 'bridge') return true;
  if (hostedByokCloudSessionReason()) return false;
  return Boolean(
    state.aiSettings.apiKey.trim()
      && state.aiSettings.model.trim()
      && aiProviderReadyForCurrentMode(),
  );
}

function aiConfirmDisabledReason(): string {
  if (state.busy) return 'Wait for the current action to finish.';
  if (state.aiSettings.mode === 'bridge') return 'Start the local runtime, then confirm planner status.';
  const hostedBlockReason = hostedByokCloudSessionReason();
  if (hostedBlockReason) return hostedBlockReason;
  if (state.aiSettings.mode === 'session' && state.aiSettings.provider === 'openai') {
    return OPENAI_BROWSER_SESSION_DISABLED_REASON;
  }
  if (!state.aiSettings.apiKey.trim()) {
    return state.aiSettings.mode === 'hosted'
      ? 'Add a Hosted BYOK request key before confirming.'
      : 'Add a browser-compatible session key before confirming.';
  }
  if (!state.aiSettings.model.trim()) return 'Choose or enter an AI model before confirming.';
  if (!aiProviderReadyForCurrentMode()) {
    return state.aiSettings.mode === 'hosted'
      ? HOSTED_CUSTOM_PROVIDER_DISABLED_REASON
      : 'Add a browser-compatible gateway URL for this provider.';
  }
  return 'Confirm planner readiness before generating.';
}

function canSaveBridgeAiKey(): boolean {
  return state.aiSettings.mode === 'bridge'
    && Boolean(state.aiSettings.apiKey.trim())
    && Boolean(state.aiSettings.model.trim())
    && aiProviderReadyForCurrentMode()
    && !state.busy;
}

function canSaveDirectAiKey(): boolean {
  return state.aiSettings.mode !== 'bridge'
    && !hostedByokCloudSessionReason()
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
  if (hostedByokCloudSessionReason()) return false;
  return Boolean(state.aiSettings.apiKey.trim() && modelReady && aiProviderReadyForCurrentMode() && !state.busy);
}

function aiGenerateDisabledReason(): string {
  const modelReady = Boolean(state.aiSettings.model.trim());
  if (state.busy) {
    return 'Wait for the current action to finish.';
  }
  if (state.aiSettings.mode === 'bridge') {
    if (!state.aiStatus?.available) {
      return 'Start the local runtime, set a bridge key, then refresh AI status.';
    }
    return 'Bridge AI is ready.';
  }
  const hostedBlockReason = hostedByokCloudSessionReason();
  if (hostedBlockReason) return hostedBlockReason;
  if (state.aiSettings.mode === 'session' && state.aiSettings.provider === 'openai') {
    return OPENAI_BROWSER_SESSION_DISABLED_REASON;
  }
  if (!state.aiSettings.apiKey.trim()) {
    return state.aiSettings.mode === 'hosted'
      ? 'Add a Hosted BYOK request key.'
      : 'Add a browser-compatible session key.';
  }
  if (!modelReady) {
    return 'Choose or enter an AI model.';
  }
  if (!aiProviderReadyForCurrentMode()) {
    return state.aiSettings.mode === 'hosted'
      ? HOSTED_CUSTOM_PROVIDER_DISABLED_REASON
      : 'Add a browser-compatible gateway URL for this provider.';
  }
  return 'Configure the AI Planner first, or use templates without AI.';
}

function isAiConfiguredForCurrentMode(): boolean {
  const modelReady = Boolean(state.aiSettings.model.trim());
  if (state.aiSettings.mode === 'bridge') {
    return Boolean(state.aiStatus?.available);
  }
  if (hostedByokCloudSessionReason()) return false;
  return Boolean(state.aiSettings.apiKey.trim() && modelReady && aiProviderReadyForCurrentMode());
}

function aiProviderReadyForCurrentMode(): boolean {
  const providerPreset = aiProviderPresetById(state.aiSettings.provider);
  if (state.aiSettings.mode === 'session' && providerPreset.id === 'openai') {
    return false;
  }
  if (state.aiSettings.mode === 'hosted') {
    return providerPreset.id !== 'custom-openai-compatible';
  }
  return providerPreset.id !== 'custom-openai-compatible' || Boolean(state.aiSettings.baseUrl.trim());
}

function aiRouteStatusLabel(status: BridgeAiStatus | null): string {
  if (state.aiSettings.mode === 'hosted') {
    const hostedBlockReason = hostedByokCloudSessionReason();
    if (hostedBlockReason) return 'hosted draft - cloud sign-in required';
    return state.aiSettings.apiKey.trim() ? `hosted draft route - ${state.aiSettings.provider} - ${state.aiSettings.model || 'model configured'}` : 'hosted draft - key required';
  }
  if (state.aiSettings.mode === 'session') {
    if (state.aiSettings.provider === 'openai') {
      return 'browser draft - OpenAI requires hosted or bridge';
    }
    return state.aiSettings.apiKey.trim() ? `browser draft - ${state.aiSettings.provider} - ${state.aiSettings.model || 'model configured'}` : 'browser draft - key required';
  }
  return status?.available
    ? `${status.source} - ${status.provider ?? status.apiFormat ?? 'AI'} - ${status.model ?? 'model configured'}`
    : 'bridge - not configured';
}

function aiReadinessLabel(status: BridgeAiStatus | null): string {
  if (state.aiSettings.mode === 'bridge') {
    return status?.available ? 'Bridge AI verified' : 'Bridge key required';
  }
  if (state.aiSettings.mode === 'session' && state.aiSettings.provider === 'openai') {
    return 'Use hosted or bridge for OpenAI';
  }
  const hostedBlockReason = hostedByokCloudSessionReason();
  if (hostedBlockReason) {
    return 'Cloud sign-in required';
  }
  if (!state.aiSettings.apiKey.trim()) {
    return state.aiSettings.mode === 'hosted' ? 'Hosted key required' : 'Browser key required';
  }
  if (!state.aiSettings.model.trim()) {
    return 'Choose a model';
  }
  if (!aiProviderReadyForCurrentMode()) {
    return state.aiSettings.mode === 'hosted' ? 'Choose hosted provider' : 'Gateway URL required';
  }
  return state.aiSettings.mode === 'hosted' ? 'Hosted key entered' : 'Config ready for this tab';
}

function aiRouteDiagnostic(path: string, method = 'POST'): AiDiagnosticEntry {
  return aiRouteDiagnosticForSettings(state.aiSettings, {
    path,
    method,
    origin: window.location.origin,
    bridgeBaseUrl: bridgeBaseUrl(),
  });
}

function appendAiDiagnostic(entry: AiDiagnosticEntry): void {
  state.aiDiagnostics = [...state.aiDiagnostics, entry].slice(-6);
}

function applyAiErrorDiagnostics(err: unknown, fallbackMessage: string): string {
  const diagnostics = aiDiagnosticsFromError(err);
  if (diagnostics.length > 0) {
    state.aiDiagnostics = diagnostics.slice(-6);
  } else {
    appendAiDiagnostic({
      code: 'AI_PROVIDER_ERROR',
      message: fallbackMessage,
      detail: `${state.aiSettings.provider} ${state.aiSettings.model || 'model configured'}`,
    });
  }
  return aiRouteMismatchDiagnostic(err)?.message ?? fallbackMessage;
}

function aiErrorToastTitle(err: unknown): string {
  return aiRouteMismatchDiagnostic(err) ? 'Hosted AI route failed' : 'AI plan failed';
}

function aiConfirmErrorToastTitle(err: unknown): string {
  return aiRouteMismatchDiagnostic(err) ? 'Hosted AI route failed' : 'Planner check failed';
}

function aiRouteMismatchDiagnostic(err: unknown): AiDiagnosticEntry | undefined {
  return aiDiagnosticsFromError(err).find((entry) => entry.code === 'AI_ROUTE_MISMATCH');
}

function ensureAiProviderAllowedForMode(): void {
  if (IS_ANDROID_APP && state.aiSettings.mode === 'hosted') {
    const preset = aiProviderPresetById(BROWSER_SESSION_DEFAULT_PROVIDER_ID);
    state.aiSettings.mode = 'session';
    state.aiSettings.provider = preset.id;
    state.aiSettings.apiFormat = preset.apiFormat;
    state.aiSettings.baseUrl = preset.baseUrl;
    state.aiSettings.model = preset.model;
    return;
  }
  if (state.aiSettings.mode === 'session' && state.aiSettings.provider === 'openai') {
    const preset = aiProviderPresetById(BROWSER_SESSION_DEFAULT_PROVIDER_ID);
    state.aiSettings.provider = preset.id;
    state.aiSettings.apiFormat = preset.apiFormat;
    state.aiSettings.baseUrl = preset.baseUrl;
    state.aiSettings.model = preset.model;
    return;
  }
  if (state.aiSettings.mode === 'hosted' && state.aiSettings.provider === 'custom-openai-compatible') {
    const preset = aiProviderPresetById(DEFAULT_AI_PROVIDER_ID);
    state.aiSettings.provider = preset.id;
    state.aiSettings.apiFormat = preset.apiFormat;
    state.aiSettings.baseUrl = preset.baseUrl;
    state.aiSettings.model = preset.model;
  }
}

function syncAiActionButtons(): void {
  const generateButton = document.querySelector<HTMLButtonElement>('#generateAiPlan');
  const canGenerateAi = canGenerateAiPlanFromSettings();

  for (const saveButton of document.querySelectorAll<HTMLButtonElement>('[data-ai-action="save-bridge-key"]')) {
    saveButton.disabled = !canSaveBridgeAiKey();
  }
  for (const directKeyButton of document.querySelectorAll<HTMLButtonElement>('[data-ai-action="save-direct-key"]')) {
    directKeyButton.disabled = !canSaveDirectAiKey();
  }
  for (const confirmButton of document.querySelectorAll<HTMLButtonElement>('[data-ai-action="confirm-planner"]')) {
    const canConfirm = canConfirmAiPlanner();
    confirmButton.disabled = !canConfirm;
    confirmButton.title = canConfirm
      ? 'Confirm planner readiness without creating a plan.'
      : aiConfirmDisabledReason();
  }
  for (const clearButton of document.querySelectorAll<HTMLButtonElement>('[data-ai-action="clear-key"]')) {
    clearButton.disabled = !canClearAiKey();
  }
  if (generateButton) {
    generateButton.disabled = !canGenerateAi;
    generateButton.classList.toggle('primary', canGenerateAi);
    generateButton.title = canGenerateAi
      ? 'Create a one-time draft through your configured AI planner.'
      : aiGenerateDisabledReason();
  }
  syncAiConfirmationStatusLine();
}

function syncAiConfirmationStatusLine(): void {
  for (const status of document.querySelectorAll<HTMLElement>('[data-ai-confirmation-status]')) {
    status.textContent = aiConfirmationLabel();
  }
  for (const detail of document.querySelectorAll<HTMLElement>('[data-ai-confirmation-detail]')) {
    detail.textContent = aiConfirmationDetail();
  }
}

function updateLabFieldValue(field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): void {
  const labId = field.dataset.labId || state.activeLab;
  const fieldId = field.dataset.labField;
  if (!fieldId) return;
  state.labFieldValues[labId] = {
    ...(state.labFieldValues[labId] ?? {}),
    [fieldId]: field.value,
  };
  delete state.labFieldErrors[receiptFieldErrorKey(labId, fieldId)];
  state.error = '';
  syncLabActionButton();
}

function syncLabActionButton(): void {
  const button = document.querySelector<HTMLButtonElement>('#createLabArtifact');
  if (button) {
    button.disabled = !state.address || state.busy;
  }
}

function syncRecurringPreview(): void {
  const preview = document.querySelector<HTMLElement>('#recurringNextOccurrence');
  if (preview) {
    preview.textContent = recurringNextOccurrenceLabel(state.recurringDraft);
  }
  const panel = document.querySelector<HTMLElement>('.recurring-production-preview');
  if (panel) {
    panel.outerHTML = recurringDraftPreviewPanel(state.recurringDraft);
  }
}

function syncArtifactSearchResults(): void {
  const search = state.artifactSearch.trim().toLowerCase();
  for (const row of document.querySelectorAll<HTMLElement>('[data-artifact-search-text]')) {
    const haystack = row.dataset.artifactSearchText ?? '';
    row.hidden = Boolean(search) && !haystack.includes(search);
  }
}

const LIST_PAGE_SIZES: Record<AppListPageKey, number> = {
  review: 4,
  inbox: 3,
  recurring: 3,
  receiptArchive: 4,
};

interface PaginatedList<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalPages: number;
  total: number;
  start: number;
  end: number;
}

function isAppListPageKey(value: string | undefined): value is AppListPageKey {
  return value === 'review' || value === 'inbox' || value === 'recurring' || value === 'receiptArchive';
}

function paginateList<T>(items: T[], pageKey: AppListPageKey): PaginatedList<T> {
  const pageSize = LIST_PAGE_SIZES[pageKey];
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const rawPage = Math.trunc(state.listPages[pageKey] || 1);
  const page = Math.min(Math.max(rawPage, 1), totalPages);
  if (state.listPages[pageKey] !== page) {
    state.listPages[pageKey] = page;
  }
  const startIndex = (page - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, total);
  return {
    items: items.slice(startIndex, endIndex),
    page,
    pageSize,
    totalPages,
    total,
    start: total ? startIndex + 1 : 0,
    end: endIndex,
  };
}

function listPagination(pageKey: AppListPageKey, pagination: PaginatedList<unknown>, label: string): string {
  if (pagination.total <= pagination.pageSize) return '';
  const previousPage = Math.max(1, pagination.page - 1);
  const nextPage = Math.min(pagination.totalPages, pagination.page + 1);
  return `
    <nav class="list-pagination" aria-label="${escapeHtml(label)} pagination">
      <span class="list-pagination-summary">
        <strong>${escapeHtml(label)}</strong>
        <span>Showing ${pagination.start}-${pagination.end} of ${pagination.total}</span>
      </span>
      <div class="list-pagination-actions">
        <button
          type="button"
          class="utility"
          data-list-page-key="${pageKey}"
          data-list-page="${previousPage}"
          ${pagination.page <= 1 ? 'disabled' : ''}
        >
          Previous
        </button>
        <span class="list-pagination-page">Page ${pagination.page} / ${pagination.totalPages}</span>
        <button
          type="button"
          class="utility"
          data-list-page-key="${pageKey}"
          data-list-page="${nextPage}"
          ${pagination.page >= pagination.totalPages ? 'disabled' : ''}
        >
          Next
        </button>
      </div>
    </nav>
  `;
}

function approvalInboxPanel(): string {
  if (!state.address) {
    return guidedStartPanel('Needs Approval', 'Connect a wallet before approving or denying queued requests.');
  }
  const actions = filteredPreparedActions();
  return `
    <section class="approval-object signature-stage stage-inbox stage-anchor ${actions.length ? 'stage-active' : 'stage-draft'}">
      <div class="signature-object-head">
        ${sectionTitleLine('Needs Approval', approvalInboxDescription())}
        <div class="inbox-toolbar signature-toolbar">
          ${selectPicker({
            id: 'inboxFilter',
            value: state.inboxFilter,
            options: [
              { value: 'all', label: 'All', meta: 'Approval filter' },
              { value: 'ready', label: 'Ready now', meta: 'Approval filter' },
              { value: 'scheduled', label: 'Scheduled', meta: 'Approval filter' },
              { value: 'attention', label: 'Problems', meta: 'Approval filter' },
              { value: 'one-time', label: 'One-time', meta: 'Approval filter' },
              { value: 'recurring', label: 'Repeats', meta: 'Approval filter' },
            ],
          })}
          <button id="refreshInbox" class="utility" ${state.busy ? 'disabled' : ''}>Refresh</button>
        </div>
      </div>

      ${queueStatusLine(actions.length)}
      ${preparedActionsList(actions)}
      ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
    </section>
  `;
}

function completedPlansPanel(): string {
  const plans = completedPlanRecords();
  const visiblePlans = filteredCompletedPlans(plans);
  const receiptCount = plans.filter((plan) => plan.actionId).length;
  const proofCount = plans.filter((plan) => Boolean(plan.signature)).length;
  const recurringCount = plans.filter((plan) => plan.kind === 'recurring').length;
  return `
    <section class="approval-object signature-stage stage-completed stage-anchor ${plans.length ? 'stage-active' : 'stage-draft'}">
      <div class="signature-object-head">
        ${sectionTitleLine('Done', 'Approved, denied, cancelled, signed, and ended work stays here until you delete it.')}
        <div class="generated-plans-toolbar signature-toolbar">
          <span class="signature-state">${escapeHtml(`${plans.length} completed`)}</span>
          <button id="refreshCompletedPlans" class="utility" ${state.busy ? 'disabled' : ''}>Refresh</button>
        </div>
      </div>

      ${completedPlanFilterControls()}
      <div class="queue-status completed-plan-status">
        <span>${escapeHtml(completedHistorySourceLabel())}</span>
        <strong>${visiblePlans.length} visible</strong>
        <span>${receiptCount} receipt${receiptCount === 1 ? '' : 's'}</span>
        <span>${proofCount} proof${proofCount === 1 ? '' : 's'}</span>
        <span>${recurringCount} recurring</span>
      </div>
      ${completedBridgeStatusHint()}
      ${
        visiblePlans.length
          ? `<div class="generated-plan-grid completed-plan-grid" aria-label="Done work">${visiblePlans.map(completedPlanCard).join('')}</div>`
          : completedPlansEmptyState(plans.length)
      }
      ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
    </section>
  `;
}

function approvalInboxDescription(): string {
  if (activeWorkflowMode() === 'agentic-cloud') {
    return 'One-time requests and due repeat payments wait here for wallet approval or denial.';
  }
  if (activeWorkflowMode() === 'local-bridge') {
    return 'Private local one-time requests and due repeat payments wait here for approve or deny.';
  }
  return 'Browser-local one-time requests and due repeat payments wait here for approve or deny.';
}

function completedBridgeStatusHint(): string {
  if (activeWorkflowMode() === 'agentic-cloud') {
    return `
      <p class="completed-bridge-hint">
        Done cloud approvals are loaded from Agentic Cloud for the signed-in wallet.
      </p>
    `;
  }
  if (activeWorkflowMode() === 'local-bridge') return '';
  return `
    <p class="completed-bridge-hint">
      Done work is local to this browser. Sign in to Agentic Cloud to sync one-time approvals.
    </p>
  `;
}

function completedHistorySourceLabel(): string {
  if (activeWorkflowMode() === 'agentic-cloud') return 'Cloud done work';
  if (activeWorkflowMode() === 'local-bridge') return 'Private local receipts';
  return 'Saved-on-device done work';
}

function completedPlanFilterControls(): string {
  const filters: Array<[CompletedPlanFilter, string]> = [
    ['all', 'All'],
    ['one-time', 'One-time'],
    ['recurring', 'Repeats'],
    ['proofs', 'Proofs'],
    ['receipts', 'Receipts'],
  ];
  return `
    <div class="template-filter-row completed-filter-row" role="group" aria-label="Done work filter">
      ${filters.map(([filter, label]) => `
        <button
          type="button"
          data-completed-filter="${escapeHtml(filter)}"
          class="${state.completedPlanFilter === filter ? 'active' : ''}"
          ${state.busy ? 'disabled' : ''}
        >
          ${escapeHtml(label)}
        </button>
      `).join('')}
    </div>
  `;
}

function completedPlansEmptyState(totalCount: number): string {
  const detail = totalCount
    ? 'No done work matches this filter.'
    : activeWorkflowMode() === 'agentic-cloud'
      ? 'Approve, deny, or cancel a cloud approval to create done work.'
      : 'Sign a review proof, approve or reject a request, or finish a repeat payment to create done work here.';
  return signaturePlaceholder('Nothing done yet', detail);
}

function decisionProofRow(plan: CompletedPlanRecord): string {
  if (!plan.signature && plan.decisionProofVerified === undefined) return '';
  const verified = plan.decisionProofVerified === true;
  const sigShort = plan.signature ? short(plan.signature) : '';
  const when = formatDateTime(plan.completedAt);
  const walletShort = plan.walletAddress ? short(plan.walletAddress) : 'unknown wallet';
  const headline = verified
    ? 'Decision signed by your wallet'
    : plan.signature
      ? 'Decision signature recorded'
      : '';
  if (!headline) return '';
  const proofMessageBlock = plan.decisionProofMessage
    ? `<details class="decision-proof-message"><summary>What you signed</summary><pre class="decision-proof-text">${escapeHtml(plan.decisionProofMessage)}</pre></details>`
    : '';
  const copyButtons = [
    plan.signature ? `<button data-copy="${escapeHtml(plan.signature)}" data-copy-name="Decision signature">Copy signature</button>` : '',
    plan.decisionProofMessage ? `<button data-copy="${escapeHtml(plan.decisionProofMessage)}" data-copy-name="Signed text">Copy signed text</button>` : '',
  ].filter(Boolean).join('');
  return `
    <div class="decision-proof-block ${verified ? 'verified' : ''}" aria-label="Decision proof">
      <div class="decision-proof-headline">
        <span class="decision-proof-icon" aria-hidden="true">${verified ? '✓' : '⚠'}</span>
        <strong>${escapeHtml(headline)}</strong>
      </div>
      <dl class="decision-proof-grid">
        <div><dt>Wallet</dt><dd title="${escapeHtml(plan.walletAddress)}">${escapeHtml(walletShort)}</dd></div>
        <div><dt>When</dt><dd>${escapeHtml(when)}</dd></div>
        ${sigShort ? `<div><dt>Signature</dt><dd title="${escapeHtml(plan.signature ?? '')}">${escapeHtml(sigShort)}</dd></div>` : ''}
      </dl>
      ${proofMessageBlock}
      ${copyButtons ? `<div class="decision-proof-actions">${copyButtons}</div>` : ''}
    </div>
  `;
}

function completedPlanCard(plan: CompletedPlanRecord): string {
  const deleteRequiresBridge = Boolean(
    plan.workflowSource !== 'cloud' &&
    !state.bridgeActive &&
    ((plan.actionId && !isBrowserWorkflowId(plan.actionId)) ||
      (completedPlanIsEndedSchedule(plan) && plan.recurringId && !isBrowserWorkflowId(plan.recurringId))),
  );
  const evidenceLabel = plan.txid ? 'Transaction' : plan.signature ? 'Review proof' : plan.actionId ? 'Receipt' : 'Repeat';
  const copyLabel = plan.actionId ? 'Copy receipt JSON' : plan.signature ? 'Copy proof JSON' : 'Copy schedule JSON';
  const focused = state.lastCompletedFocusId === plan.id || Boolean(plan.actionId && state.lastCompletedFocusId === plan.actionId);
  const decisionProofBlock = decisionProofRow(plan);
  const historyLabel = plan.kind === 'recurring' ? 'Repeat payment done' : 'One-time done';
  return `
    <article class="generated-plan-card completed-plan-card ${focused ? 'focused' : ''}" ${focused ? 'data-completed-focus="true"' : ''}>
      <div class="completed-history-head">
        <div class="completed-history-title-block">
          <div class="completed-history-meta">
            <span class="status-pill ${escapeHtml(plan.tone)}">${escapeHtml(plan.status)}</span>
            <strong class="completed-history-meta-title">${escapeHtml(historyLabel)}</strong>
            <span>${escapeHtml(plan.kind === 'recurring' ? 'Repeat' : 'One-time')}</span>
            <span>${escapeHtml(evidenceLabel)}</span>
            <span>${escapeHtml(titleCaseCluster(plan.cluster))}</span>
          </div>
          <h3 title="${escapeHtml(plan.title)}">${escapeHtml(completedPlanDisplayTitle(plan))}</h3>
          <p>${escapeHtml(formatDateTime(plan.completedAt))}</p>
        </div>
        ${completedPlanHero(plan)}
        <div class="completed-header-actions completed-history-actions">
          <button data-copy="${escapeHtml(plan.copyPayload)}" data-copy-name="Done item">${escapeHtml(copyLabel)}</button>
          ${plan.trustBundlePayload ? `<button data-copy="${escapeHtml(plan.trustBundlePayload)}" data-copy-name="Trust bundle">Copy trust bundle</button>` : ''}
          <button
            class="utility danger"
            data-completed-delete="${escapeHtml(plan.id)}"
            ${state.busy || deleteRequiresBridge ? 'disabled' : ''}
            title="${deleteRequiresBridge ? 'Connect the local bridge before deleting bridge-backed done work.' : 'Delete this item from Done.'}"
          >
            Delete
          </button>
        </div>
      </div>
      ${completedPlanSummaryGrid(plan)}
      ${completedPlanSummaryNote(plan)}
      ${decisionProofBlock}
      ${plan.actionId ? relatedReceiptBlockForApproval(plan.actionId) : ''}
      <div class="completed-history-drawers">
        ${plan.actionId ? recordActivityDetails('approval', plan.actionId) : recordActivityDetails('completed', plan.id)}
        <details class="generated-plan-inline-details completed-plan-details completed-history-details">
          <summary>View details</summary>
          <div>
            <dl class="proof-grid compact">
              ${plan.detailRows.map(([label, value]) => definitionRow(label, value)).join('')}
            </dl>
            ${plan.txid ? txBlock(plan.txid, plan.cluster) : ''}
          </div>
        </details>
      </div>
    </article>
  `;
}

function completedPlanDisplayTitle(plan: CompletedPlanRecord): string {
  const title = plan.title.trim();
  if (!title) return plan.kind === 'recurring' ? 'Repeat payment done' : 'Completed record';
  const compactTitle = title.split(':')[0]?.trim() || title;
  return compactTitle.length <= 54 ? compactTitle : `${compactTitle.slice(0, 51)}...`;
}

function completedPlanHero(plan: CompletedPlanRecord): string {
  const metric = completedPlanMetric(plan);
  return `
    <div class="completed-history-value" title="${escapeHtml(`${metric.primary} ${metric.secondary}`.trim())}">
      <strong>${escapeHtml(metric.primary)}</strong>
      ${metric.secondary ? `<span>${escapeHtml(metric.secondary)}</span>` : ''}
    </div>
  `;
}

function completedPlanMetric(plan: CompletedPlanRecord): { primary: string; secondary: string } {
  const amount = completedPlanAmountLabel(plan);
  const swap = parseCompletedSwapAmount(amount);
  if (swap) {
    return {
      primary: swap.primary,
      secondary: `${swap.from} -> ${swap.to}`,
    };
  }
  return {
    primary: amount,
    secondary: plan.recipient ? `To ${short(plan.recipient)}` : formatDateTime(plan.completedAt),
  };
}

function completedPlanAmountLabel(plan: CompletedPlanRecord): string {
  if (!plan.amount) return plan.txid ? `Tx ${short(plan.txid)}` : plan.signature ? `Proof ${short(plan.signature)}` : 'Completed';
  const token = plan.token?.trim();
  if (!token || plan.amount.includes(token)) return plan.amount;
  return `${plan.amount} ${token}`;
}

function parseCompletedSwapAmount(value: string): { primary: string; from: string; to: string } | null {
  const match = value.match(/^(.+?\s+([A-Za-z0-9]{2,12}))\s+to\s+(.+)$/i);
  if (!match || !match[1] || !match[2] || !match[3]) return null;
  return {
    primary: match[1].trim(),
    from: match[2].trim(),
    to: match[3].trim(),
  };
}

type CompletedPlanRecordRef = {
  label: string;
  value: string;
  title?: string;
  copyValue?: string;
  copyLabel?: string;
  copyName?: string;
};

function completedPlanRecordRef(plan: CompletedPlanRecord): CompletedPlanRecordRef {
  if (plan.txid) {
    const url = plan.explorerUrl ?? explorerUrl(plan.txid, plan.cluster);
    return {
      label: 'Tx',
      value: shortFirstRunWallet(plan.txid),
      title: plan.txid,
      copyValue: url,
      copyLabel: 'Copy tx link',
      copyName: 'Solscan transaction link',
    };
  }
  if (plan.signature) return { label: 'Proof', value: short(plan.signature), copyValue: plan.signature };
  if (plan.actionId) return { label: 'Receipt', value: short(plan.actionId), copyValue: plan.actionId };
  if (plan.recurringId) return { label: 'Repeat', value: short(plan.recurringId), copyValue: plan.recurringId };
  return { label: 'Record', value: 'Local done work' };
}

function completedPlanSummaryGrid(plan: CompletedPlanRecord): string {
  const record = completedPlanRecordRef(plan);
  const rows: Array<{ label: string; value: string; title?: string; copyValue?: string; tone?: 'amount'; copyLabel?: string; copyName?: string }> = [
    { label: 'Wallet', value: plan.walletAddress ? short(plan.walletAddress) : 'No wallet', title: plan.walletAddress || 'No wallet', copyValue: plan.walletAddress || undefined },
    { label: 'Amount', value: completedPlanAmountLabel(plan), tone: 'amount' },
    { label: 'Completed', value: formatDateTime(plan.completedAt) },
    {
      label: record.label,
      value: record.value,
      title: record.title ?? record.copyValue ?? record.value,
      copyValue: record.copyValue,
      copyLabel: record.copyLabel,
      copyName: record.copyName,
    },
  ];
  return `
    <dl class="completed-history-summary-grid" aria-label="Done work summary">
      ${rows.map(completedPlanSummaryItem).join('')}
    </dl>
  `;
}

function completedPlanSummaryItem(row: { label: string; value: string; title?: string; copyValue?: string; tone?: 'amount'; copyLabel?: string; copyName?: string }): string {
  const title = row.title ?? row.value;
  const copyLabel = row.copyLabel ?? 'Copy';
  const copyName = row.copyName ?? row.label;
  return `
    <div class="${row.tone ? `completed-history-summary-${row.tone}` : ''}" title="${escapeHtml(title)}">
      <dt>${escapeHtml(row.label)}</dt>
      <dd class="${row.copyValue ? 'has-copy' : ''}">
        <span>${escapeHtml(row.value)}</span>
        ${row.copyValue ? `
          <button
            type="button"
            class="wallet-action-copy"
            data-copy="${escapeHtml(row.copyValue)}"
            data-copy-name="${escapeHtml(copyName)}"
          >
            <svg class="wallet-action-copy-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M16 1H6a2 2 0 0 0-2 2v12h2V3h10V1Zm3 4H10a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H10V7h9v14Z"/></svg>
            ${escapeHtml(copyLabel)}
          </button>
        ` : ''}
      </dd>
    </div>
  `;
}

function completedPlanSummaryNote(plan: CompletedPlanRecord): string {
  const summary = compactSentence(plan.summary || '');
  if (!summary || summary === completedPlanDisplayTitle(plan)) return '';
  return `
    <section class="completed-history-note" aria-label="Done work note" title="${escapeHtml(summary)}">
      <span>Note</span>
      <p>${escapeHtml(summary)}</p>
    </section>
  `;
}

function relatedReceiptBlockForApproval(approvalId: string): string {
  const receipts = relatedEvidenceReceiptsForApproval(approvalId);
  if (receipts.length === 0) return '';
  return `
    <div class="related-receipts" aria-label="Related evidence receipts">
      <div class="related-receipts-head">
        <strong>Related receipts</strong>
        <span>${receipts.length} wallet-signed</span>
      </div>
      <div class="related-receipt-list">
        ${receipts.map(relatedReceiptRow).join('')}
      </div>
    </div>
  `;
}

function relatedReceiptRow(artifact: LabArtifact): string {
  return `
    <div class="related-receipt-row">
      <div>
        <strong>${escapeHtml(artifact.title || receiptLabelForKind(artifact.kind))}</strong>
        <span>${escapeHtml(formatDateTime(artifact.createdAt))} · ${escapeHtml(short(artifact.signature))}</span>
      </div>
      <div>
        <button data-copy="${escapeHtml(artifact.signingMessage)}" data-copy-name="Related receipt signed text">Copy text</button>
        <button data-copy="${escapeHtml(stableJson(artifact))}" data-copy-name="Related receipt JSON">Copy JSON</button>
        <button data-share-receipt="${escapeHtml(artifact.id)}">Share</button>
      </div>
    </div>
  `;
}

function relatedEvidenceReceiptsForApproval(approvalId: string): LabArtifact[] {
  return state.labArtifacts
    .filter((artifact) => {
      const metadata = artifact.metadata ?? {};
      return (
        (metadata.recordType === 'approval' && metadata.recordId === approvalId) ||
        (metadata.sourceRecordType === 'approval' && metadata.sourceRecordId === approvalId) ||
        (metadata.subjectType === 'approval' && metadata.subjectId === approvalId) ||
        metadata.approvalId === approvalId
      );
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function recordActivityDetails(recordType: AuditRecordType, recordId: string): string {
  const key = auditActivityKey(recordType, recordId);
  const activity: AuditActivityState = state.auditActivity[key] ?? { status: 'idle', events: [] };
  const open = state.auditOpen[key] === true;
  const body = cloudSessionMatchesWallet() || activity.status === 'loaded'
    ? auditActivityBody(activity)
    : '<p class="activity-note">Cloud activity appears here after you sign in to Agentic Cloud. Browser receipts remain visible in this workspace.</p>';
  return `
    <details
      class="record-activity"
      data-audit-record-type="${escapeHtml(recordType)}"
      data-audit-record-id="${escapeHtml(recordId)}"
      ${open ? 'open' : ''}
    >
      <summary>
        <span>Activity</span>
        <button
          type="button"
          class="record-activity-refresh"
          data-audit-refresh-record-type="${escapeHtml(recordType)}"
          data-audit-refresh-record-id="${escapeHtml(recordId)}"
          ${state.busy || !cloudSessionMatchesWallet() ? 'disabled' : ''}
        >
          Refresh
        </button>
      </summary>
      ${body}
    </details>
  `;
}

function auditActivityBody(activity: AuditActivityState): string {
  if (activity.status === 'loading') {
    return '<p class="activity-note">Loading cloud activity...</p>';
  }
  if (activity.status === 'error') {
    return `<p class="activity-note error-text">${escapeHtml(activity.error ?? 'Activity could not be loaded.')}</p>`;
  }
  if (activity.status !== 'loaded') {
    return '<p class="activity-note">Open to load cloud activity for this record.</p>';
  }
  if (activity.events.length === 0) {
    return '<p class="activity-note">No cloud activity found for this record yet.</p>';
  }
  return `
    <div class="activity-event-list">
      ${activity.events.map(auditActivityRow).join('')}
    </div>
  `;
}

function auditActivityRow(event: WorkflowAuditEventRecord): string {
  const metadata = event.metadata ?? {};
  const summary = auditMetadataSummary(metadata);
  return `
    <div class="activity-event-row">
      <span>${escapeHtml(formatDateTime(event.createdAt))}</span>
      <strong>${escapeHtml(event.eventType ?? event.type)}</strong>
      ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    </div>
  `;
}

function auditMetadataSummary(metadata: JsonObject): string {
  const pairs = ['status', 'kind', 'txid', 'finalizationId', 'completedId', 'recordType', 'recordId']
    .map((key) => {
      const value = metadata[key];
      return typeof value === 'string' && value ? `${key}: ${value}` : '';
    })
    .filter(Boolean);
  return pairs.slice(0, 4).join(' · ');
}

function auditActivityKey(recordType: AuditRecordType, recordId: string): string {
  return `${recordType}:${recordId}`;
}

function scheduledApprovalsPanel(): string {
  if (!state.address) {
    return guidedStartPanel('Repeat Payments', 'Connect a wallet before creating repeat payments.');
  }
  const recurringPayments = activeWorkflowRecurringPayments();
  const activeCount = recurringPayments.filter((payment) => payment.status === 'active' && !isRecurringPaymentCompleted(payment)).length;
  return `
    <section class="approval-object signature-stage stage-schedule stage-anchor ${recurringPayments.length ? 'stage-active' : 'stage-draft'}">
      <div class="signature-object-head app-inline-head">
        ${sectionTitleLine('Repeat Payments', 'Set up payments that repeat. Each payment still asks for approval before it sends.')}
        <button id="refreshInbox" class="utility" ${state.busy ? 'disabled' : ''}>Refresh</button>
      </div>

      ${scheduleStatusLine()}
      ${recurringViewTabs(activeCount)}
      ${state.recurringView === 'active' ? recurringList() || signaturePlaceholder('No active repeats', 'Create a repeat payment to track active repeats here.') : recurringComposer()}
      ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
    </section>
  `;
}

function recurringViewTabs(activeCount: number): string {
  return `
    <div class="tabs compact-tabs recurring-view-tabs" role="tablist" aria-label="Repeat payment views">
      ${recurringViewButton('create', 'Create Repeat')}
      ${recurringViewButton('active', activeCount ? `Active Repeats (${activeCount})` : 'Active Repeats')}
    </div>
  `;
}

function recurringViewButton(view: RecurringView, label: string): string {
  const active = state.recurringView === view;
  return `
    <button
      data-recurring-view="${view}"
      class="${active ? 'active' : ''}"
      role="tab"
      aria-selected="${active ? 'true' : 'false'}"
      type="button"
      ${state.busy ? 'disabled' : ''}
    >
      ${escapeHtml(label)}
    </button>
  `;
}

function labsPanel(): string {
  const lab = activeLab();
  const artifact = latestLabArtifact(lab.id);
  const signedArtifacts = state.labArtifacts;
  const complete = state.artifactView === 'signed' ? signedArtifacts.length > 0 : Boolean(artifact);
  const detail =
    state.artifactView === 'signed'
      ? `Review wallet-signed proofs saved on this device${state.bridgeActive ? ' and mirrored to the local bridge archive' : ''}.`
      : 'Save wallet-signed proof for a request, approval, denial, or result.';
  return `
    <section class="approval-object signature-stage stage-labs stage-anchor ${complete ? 'stage-complete' : 'stage-draft'}">
      <div class="signature-object-head artifact-workspace-head">
        ${sectionTitleLine('Save Proof', detail)}
        ${artifactWorkspaceTabs()}
      </div>

      ${state.artifactView === 'signed' ? signedArtifactsPanel() : createArtifactPanel()}
      ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
    </section>
  `;
}

function artifactWorkspaceTabs(): string {
  return `
    <div class="tabs compact-tabs artifact-view-tabs" role="tablist" aria-label="Save proof views">
      ${artifactViewButton('create', 'Save Proof')}
      ${artifactViewButton('signed', 'Saved Proofs')}
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
    return guidedStartPanel('Save Proof', 'Connect a wallet before saving signed proofs.');
  }
  const lab = activeLab();
  const artifact = latestLabArtifact(lab.id);
  const publicReceipt = isPublicReceiptLab(lab);
  return `
      <div class="lab-panel lab-workbench ${publicReceipt ? 'common-proof-workbench' : 'advanced-proof-workbench'}">
        <div class="artifact-create-status">
          <span class="signature-state">${escapeHtml(labIndexLabel())}</span>
        </div>
        ${artifactProofGroupTabs(lab)}
        ${labCommandMenu(lab)}
        <div class="lab-workbench-grid">
          <div class="lab-copy research-brief">
            <span class="workbench-kicker">${publicReceipt ? 'Proof purpose' : 'Advanced proof'}</span>
            <h3>${escapeHtml(lab.title.replace(/^\d+\.\s*/, ''))}</h3>
            <p>${escapeHtml(lab.summary)}</p>
            <div class="receipt-explainer-stack">
              <div>
                <span>What this proves</span>
                <p>${escapeHtml(lab.whatThisProves)}</p>
              </div>
              <div>
                <span>Best use</span>
                <p>${escapeHtml(lab.recommendedUse)}</p>
              </div>
            </div>
            <div class="capabilities compact-caps">
              <span>${escapeHtml(labKindLabel(lab.kind))}</span>
              <span>${artifact ? 'proof saved' : 'ready to sign'}</span>
            </div>
          </div>

          ${publicReceipt ? receiptFieldInputs(lab) : advancedLabInput(lab)}
        </div>

        ${artifactSigningPreview(lab, publicReceipt, artifact)}

        <div class="lab-actions lab-signature-action">
          <button id="createLabArtifact" class="primary" ${!state.address || state.busy ? 'disabled' : ''}>${publicReceipt ? 'Sign and save proof' : 'Sign advanced proof'}</button>
        </div>
      </div>
  `;
}

function artifactSigningPreview(lab: LabDefinition, publicReceipt: boolean, artifact: LabArtifact | null): string {
  return `
    <div class="proof-signing-preview">
      <span class="accent-note">${artifact ? 'Proof saved' : publicReceipt ? 'Common proof ready' : 'Advanced proof ready'}</span>
      <strong>${escapeHtml(publicReceipt ? receiptLabelForKind(lab.kind) : lab.title.replace(/^\d+\.\s*/, ''))}</strong>
      <p>Your wallet signs this evidence record only. No transaction is submitted.</p>
    </div>
  `;
}

type ArtifactProofGroup = 'common' | 'advanced';

function artifactProofGroupForLab(lab: LabDefinition): ArtifactProofGroup {
  return lab.category === 'advanced' ? 'advanced' : 'common';
}

function artifactProofGroupTabs(lab: LabDefinition): string {
  const active = artifactProofGroupForLab(lab);
  return `
    <div class="tabs compact-tabs artifact-proof-group-tabs" role="tablist" aria-label="Proof category">
      ${artifactProofGroupButton('common', 'Common Proofs', active)}
      ${artifactProofGroupButton('advanced', 'Advanced Proofs', active)}
    </div>
  `;
}

function artifactProofGroupButton(group: ArtifactProofGroup, label: string, active: ArtifactProofGroup): string {
  const selected = group === active;
  return `
    <button
      type="button"
      data-artifact-proof-group="${group}"
      class="${selected ? 'active' : ''}"
      role="tab"
      aria-selected="${selected ? 'true' : 'false'}"
      ${state.busy ? 'disabled' : ''}
    >
      ${escapeHtml(label)}
    </button>
  `;
}

function receiptFieldInputs(lab: LabDefinition): string {
  return `
    <div class="receipt-fields lab-intent-document">
      ${(lab.fields ?? []).map((field) => receiptFieldInput(lab, field)).join('')}
    </div>
  `;
}

function receiptFieldInput(lab: LabDefinition, field: LabFieldDefinition): string {
  const value = receiptFieldValue(lab.id, field.id);
  const errorKey = receiptFieldErrorKey(lab.id, field.id);
  const error = state.labFieldErrors[errorKey];
  const label = `${field.label}${field.required ? ' *' : ''}`;
  const attrs = `data-lab-field="${escapeHtml(field.id)}" data-lab-id="${escapeHtml(lab.id)}" ${state.busy ? 'disabled' : ''}`;
  if (field.type === 'select') {
    return `
      <label class="field compact receipt-field ${error ? 'field-error' : ''}">
        <span>${escapeHtml(label)}</span>
        ${selectPicker({
          value,
          options: (field.options ?? []).map((option) => ({
            value: option,
            label: option,
            meta: field.label,
          })),
          attrs: {
            'data-lab-field': field.id,
            'data-lab-id': lab.id,
          },
          disabled: state.busy,
        })}
        ${error ? `<em class="field-error-text">${escapeHtml(error)}</em>` : ''}
      </label>
    `;
  }
  if (field.type === 'textarea') {
    return `
      <label class="field compact receipt-field ${error ? 'field-error' : ''}">
        <span>${escapeHtml(label)}</span>
        <textarea ${attrs} placeholder="${escapeHtml(field.placeholder ?? '')}">${escapeHtml(value)}</textarea>
        ${error ? `<em class="field-error-text">${escapeHtml(error)}</em>` : ''}
      </label>
    `;
  }
  return `
    <label class="field compact receipt-field ${error ? 'field-error' : ''}">
      <span>${escapeHtml(label)}</span>
      <input ${attrs} value="${escapeHtml(value)}" placeholder="${escapeHtml(field.placeholder ?? '')}" />
      ${error ? `<em class="field-error-text">${escapeHtml(error)}</em>` : ''}
    </label>
  `;
}

function advancedLabInput(lab: LabDefinition): string {
  const error = state.labFieldErrors[receiptFieldErrorKey(lab.id, '__advanced')];
  return `
    <label class="field agent-prompt lab-intent-document ${error ? 'field-error' : ''}">
      <span>Evidence note *</span>
      <textarea id="labInput" ${state.busy ? 'disabled' : ''}>${escapeHtml(labInput(lab.id))}</textarea>
      ${error ? `<em class="field-error-text">${escapeHtml(error)}</em>` : ''}
    </label>
  `;
}

function signedArtifactsPanel(): string {
  const artifacts = filteredLabArtifacts();
  return `
    <div class="lab-panel signed-artifacts-panel">
      ${artifactArchiveControls(artifacts.length)}
      ${artifacts.length ? signedArtifactList(artifacts) : signedArtifactsEmptyState()}
    </div>
  `;
}

function artifactArchiveControls(visibleCount: number): string {
  const filters: Array<[ArtifactFilter, string]> = [
    ['all', 'All'],
    ['verified', 'Verified'],
    ['warnings', 'Warnings'],
    ['blocked', 'Blocked'],
  ];
  return `
    <div class="artifact-archive-control-panel">
      <div class="artifact-archive-primary-row">
        <span class="signature-state artifact-visible-count">${escapeHtml(`${visibleCount} visible`)}</span>
      <div class="template-filter-row artifact-filter-row" role="group" aria-label="Saved proof filter">
        ${filters.map(([filter, label]) => `
          <button
            type="button"
            data-artifact-filter="${escapeHtml(filter)}"
            class="${state.artifactFilter === filter ? 'active' : ''}"
            ${state.busy ? 'disabled' : ''}
          >
            ${escapeHtml(label)}
          </button>
        `).join('')}
      </div>
      <label class="field compact">
        ${selectPicker({
          id: 'artifactTypeFilter',
          value: state.artifactTypeFilter,
          options: [
            { value: 'all', label: 'All types', meta: 'Proof type' },
            ...RECEIPT_LABS.map((lab) => ({
              value: lab.id,
              label: lab.title,
              meta: 'Saved proof',
              detail: lab.description,
            })),
            ...ADVANCED_EVIDENCE_LABS.map((lab) => ({
              value: lab.id,
              label: `Legacy / ${lab.title}`,
              meta: 'Advanced evidence',
              detail: lab.description,
            })),
          ],
          disabled: state.busy,
        })}
      </label>
      <label class="field compact artifact-search-field">
        <input id="artifactSearch" value="${escapeHtml(state.artifactSearch)}" placeholder="Search proofs, type, wallet, hash, or intent" ${state.busy ? 'disabled' : ''} />
      </label>
        <button id="refreshLabArtifacts" class="utility artifact-refresh-button" ${state.busy ? 'disabled' : ''}>Refresh</button>
      </div>
      ${artifactArchiveStatusLine()}
    </div>
  `;
}

function artifactArchiveStatusLine(): string {
  const bridge = state.bridgeActive
    ? state.health?.labArtifactStorePath
      ? `Bridge file: ${state.health.labArtifactStorePath}`
      : 'Bridge archive connected'
    : 'Bridge archive unavailable';
  const cloudClass = cloudSessionMatchesWallet() ? 'cloud-active' : 'cloud-inactive';
  return `
    <div class="artifact-archive-status">
      <span>${escapeHtml(state.labArchiveStatus)}</span>
      <span class="cloud-evidence-status ${cloudClass}">${escapeHtml(state.cloudEvidenceStatus)}</span>
      <strong>${escapeHtml(bridge)}</strong>
    </div>
  `;
}

function signedArtifactsEmptyState(): string {
  return `
    <div class="empty lab-empty-state">
      <span>No saved proofs</span>
      <h3>Archive is empty</h3>
      <p>Use Save Proof to add the first wallet-bound proof.</p>
    </div>
  `;
}

function signedArtifactList(artifacts: LabArtifact[]): string {
  const paginatedArtifacts = paginateList(artifacts, 'receiptArchive');
  return `
    <div class="signed-artifact-list">
      ${paginatedArtifacts.items.map((artifact) => signedArtifactRow(artifact)).join('')}
    </div>
    ${listPagination('receiptArchive', paginatedArtifacts, 'Saved proofs')}
  `;
}

function filteredLabArtifacts(): LabArtifact[] {
  const search = state.artifactSearch.trim().toLowerCase();
  return state.labArtifacts.filter((artifact) => {
    if (state.artifactFilter === 'verified' && !artifact.verified) return false;
    if (state.artifactFilter === 'warnings' && artifact.payload.status !== 'warn') return false;
    if (state.artifactFilter === 'blocked' && artifact.payload.status !== 'blocked') return false;
    if (state.artifactTypeFilter !== 'all' && artifact.labId !== state.artifactTypeFilter) return false;
    if (!search) return true;
    return artifactSearchText(artifact).includes(search);
  });
}

function artifactSearchText(artifact: LabArtifact): string {
  return [
    artifact.title,
    artifact.kind,
    artifact.walletAddress,
    artifact.artifactHash,
    artifact.signature,
    artifact.signingMessage,
    artifact.input,
    artifact.payload.receiptType ?? '',
    artifact.payload.thesis,
    artifact.payload.summary ?? '',
    artifact.payload.whatThisProves ?? '',
    artifact.payload.recommendedUse ?? '',
    stableJson(artifact.payload.fieldValues ?? {}),
    stableJson(artifact.metadata ?? {}),
  ].join(' ').toLowerCase();
}

function signedArtifactRow(artifact: LabArtifact): string {
  const lab = labById(artifact.labId);
  const legacy = !lab || lab.category === 'advanced';
  const receiptLabel = legacy ? 'Legacy receipt' : receiptLabelForKind(artifact.kind);
  const requested = receiptRequestedText(artifact);
  const proves = receiptProvesText(artifact);
  const signatureHash = `${short(artifact.signature)} / ${short(artifact.artifactHash)}`;
  const searchText = artifactSearchText(artifact);
  const verdict = artifact.payload.metrics.find((metric) => metric.label.toLowerCase() === 'verdict')?.value ?? (artifact.verified ? 'verified' : 'signed');
  return `
    <article class="signed-artifact-row receipt-proof-card ${legacy ? 'legacy' : ''}" data-artifact-search-text="${escapeHtml(searchText)}">
      <div class="receipt-proof-card-head">
        <div class="receipt-proof-title-block">
          <div class="receipt-proof-meta">
            <span class="status-pill ${artifact.verified ? 'tx-confirmed' : 'tx-pending'}">${artifact.verified ? 'wallet verified' : 'signed'}</span>
            <span class="receipt-proof-type-label">${escapeHtml(labKindLabel(artifact.kind))}</span>
            <time class="receipt-proof-date" datetime="${escapeHtml(artifact.createdAt)}">${escapeHtml(formatDateTime(artifact.createdAt))}</time>
          </div>
          <p>${escapeHtml(artifact.payload.summary ?? artifact.payload.thesis)}</p>
        </div>
        <div class="receipt-proof-value" title="${escapeHtml(`${verdict} - ${artifact.artifactHash}`)}">
          <strong>${escapeHtml(verdict)}</strong>
          <span>${escapeHtml(short(artifact.artifactHash))}</span>
        </div>
        <div class="signed-artifact-actions receipt-proof-actions">
          <button data-share-receipt="${escapeHtml(artifact.id)}">Share proof</button>
          <button data-copy="${escapeHtml(stableJson(artifact))}" data-copy-name="Proof JSON">Copy JSON</button>
        </div>
      </div>
      <dl class="receipt-proof-summary-grid" aria-label="Saved proof summary">
        ${receiptProofSummaryItem('Requested', requested)}
        ${receiptProofSummaryItem('Proves', proves)}
        ${receiptProofSummaryItem('Signed by', short(artifact.walletAddress), artifact.walletAddress, artifact.walletAddress)}
        ${receiptProofSummaryItem('Signature / hash', signatureHash, `${artifact.signature} / ${artifact.artifactHash}`, `${artifact.signature} / ${artifact.artifactHash}`)}
      </dl>
      <div class="receipt-proof-storage-row" aria-label="Saved proof destinations">
        <div class="receipt-proof-storage-badges">
          ${receiptStorageBadges(artifact)}
        </div>
        <button class="utility danger receipt-proof-delete-button" data-artifact-delete="${escapeHtml(artifact.id)}" ${state.busy ? 'disabled' : ''}>Delete</button>
      </div>
      <details class="artifact-technical-details signed-artifact-details">
        <summary>
          <span>Technical details</span>
          <strong>Exact signed text, hashes, signature, and receipt fields</strong>
        </summary>
        ${signedArtifactDetail(artifact)}
      </details>
    </article>
  `;
}

function receiptProofSummaryItem(label: string, value: string, title = value, copyValue?: string): string {
  return `
    <div title="${escapeHtml(title)}">
      <dt>${escapeHtml(label)}</dt>
      <dd class="${copyValue ? 'has-copy' : ''}">
        <span>${escapeHtml(value)}</span>
        ${copyValue ? `
          <button
            type="button"
            class="wallet-action-copy"
            data-copy="${escapeHtml(copyValue)}"
            data-copy-name="${escapeHtml(label)}"
          >
            Copy
          </button>
        ` : ''}
      </dd>
    </div>
  `;
}

function receiptProofRow(
  label: string,
  value: string,
  mode: 'text' | 'pre' | 'code' = 'text',
  title = value,
): string {
  const content = mode === 'pre'
    ? `<pre>${escapeHtml(value)}</pre>`
    : mode === 'code'
      ? `<code title="${escapeHtml(title)}">${escapeHtml(value)}</code>`
      : `<p title="${escapeHtml(title)}">${escapeHtml(value)}</p>`;
  return `
    <div class="${mode === 'pre' ? 'wide' : ''}">
      <dt>${escapeHtml(label)}</dt>
      <dd>${content}</dd>
    </div>
  `;
}

function receiptRequestedText(artifact: LabArtifact): string {
  const fields = artifact.payload.fieldValues ?? {};
  return (
    fields.request ||
    fields.task ||
    fields.policy ||
    fields.risks ||
    artifact.input ||
    artifact.payload.summary ||
    artifact.payload.thesis ||
    'Signed receipt request'
  );
}

function receiptProvesText(artifact: LabArtifact): string {
  return artifact.payload.whatThisProves ||
    labById(artifact.labId)?.whatThisProves ||
    'This wallet signed the displayed receipt text at the recorded time.';
}

function receiptShareText(artifact: LabArtifact): string {
  return [
    `${artifact.title || receiptLabelForKind(artifact.kind)}`,
    `Requested: ${receiptRequestedText(artifact)}`,
    `Signed by: ${artifact.walletAddress}`,
    `When: ${formatDateTime(artifact.createdAt)}`,
    `Signature: ${artifact.signature}`,
    `Receipt hash: ${artifact.artifactHash}`,
  ].join('\n');
}

function archiveFact(label: string, value: string): string {
  return `
    <div>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function receiptStorageBadges(artifact: LabArtifact): string {
  const cloud = Boolean(artifact.cloudReceiptId);
  const bridge = Boolean(artifact.bridgeArchived);
  const cloudLabel = cloud ? 'Archived in Agentic Cloud' : 'Not archived in Agentic Cloud';
  const bridgeLabel = bridge ? 'Mirrored to local bridge archive' : 'Not in bridge archive';
  return `
    <span class="receipt-storage-badge browser" role="status" aria-label="Saved on this device" title="Saved on this device">Browser</span>
    <span class="receipt-storage-badge cloud ${cloud ? 'on' : 'off'}" role="status" aria-label="${escapeHtml(cloudLabel)}" title="${escapeHtml(cloudLabel)}">Cloud${cloud ? '' : ' off'}</span>
    <span class="receipt-storage-badge bridge ${bridge ? 'on' : 'off'}" role="status" aria-label="${escapeHtml(bridgeLabel)}" title="${escapeHtml(bridgeLabel)}">Bridge${bridge ? '' : ' off'}</span>
  `;
}

function signedArtifactDetail(artifact: LabArtifact): string {
  return `
    <div class="receipt-tech-detail">
      <div class="artifact-detail-actions receipt-tech-actions">
        <button data-copy="${escapeHtml(artifact.signingMessage)}" data-copy-name="Signed text">Copy signed text</button>
        <button data-copy="${escapeHtml(artifact.signature)}" data-copy-name="Receipt signature">Copy signature</button>
      </div>
      <div class="artifact-detail-grid receipt-tech-id-grid">
        ${archiveFact('Receipt type', artifact.title)}
        ${archiveFact('Kind', labKindLabel(artifact.kind))}
        ${archiveFact('Created', formatDateTime(artifact.createdAt))}
        ${archiveFact('Cluster', titleCaseCluster(artifact.cluster))}
        ${archiveFact('Wallet', artifact.walletAddress)}
        ${archiveFact('Receipt hash', artifact.artifactHash)}
      </div>
      <div class="artifact-intent-block receipt-tech-request">
        <span>Signed request</span>
        <p>${escapeHtml(artifact.input)}</p>
      </div>
      <div class="artifact-intent-block artifact-signed-message-block">
        <span>Exact signed text</span>
        <pre>${escapeHtml(artifact.signingMessage)}</pre>
      </div>
      ${artifact.payload.whatThisProves || artifact.payload.recommendedUse ? `
        <div class="artifact-detail-grid receipt-tech-explainer-grid">
          ${artifact.payload.whatThisProves ? archiveFact('What this proves', artifact.payload.whatThisProves) : ''}
          ${artifact.payload.recommendedUse ? archiveFact('Recommended use', artifact.payload.recommendedUse) : ''}
        </div>
      ` : ''}
      <div class="artifact-evidence-row receipt-tech-metric-row">
        ${artifactMetricCard(artifact, 'Verdict')}
        ${artifactMetricCard(artifact, 'Custody')}
        ${artifactMetricCard(artifact, 'Effect')}
      </div>
      <div class="artifact-evidence-list receipt-tech-evidence-list">
        ${artifact.payload.evidence.map((entry) => `
          <div class="${escapeHtml(entry.tone)}">
            <span>${escapeHtml(entry.title)}</span>
            <p>${escapeHtml(entry.detail)}</p>
            <code>${escapeHtml(short(entry.hash))}</code>
          </div>
        `).join('')}
      </div>
      <div class="hash-grid receipt-tech-hash-grid">
        ${hashTile('Pre-signature', artifact.preSignatureHash)}
        ${hashTile('Receipt', artifact.artifactHash)}
        ${hashTile('Signature', artifact.signature)}
        ${hashTile('Wallet', artifact.walletAddress)}
      </div>
    </div>
  `;
}

function labCommandMenu(lab: LabDefinition): string {
  return `
    <div class="field compact lab-select-field planner-template-select">
          <span id="artifactPickerLabel">Proof type</span>
      ${artifactPicker(lab)}
    </div>
  `;
}

function artifactPicker(lab: LabDefinition): string {
  const activeGroup = artifactProofGroupForLab(lab);
  const candidates = activeGroup === 'advanced' ? ADVANCED_EVIDENCE_LABS : RECEIPT_LABS;
  const groupLabel = activeGroup === 'advanced' ? 'Advanced proofs' : 'Common proofs';
  return `
    <div class="template-picker artifact-picker" data-artifact-picker>
      <button
        id="artifactPickerButton"
        class="template-picker-trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded="false"
        aria-controls="artifactPickerMenu"
        aria-labelledby="artifactPickerLabel artifactPickerValue"
        ${state.busy ? 'disabled' : ''}
      >
        <span class="template-picker-current">
          <span class="template-picker-category">${escapeHtml(labKindLabel(lab.kind))}</span>
          <strong id="artifactPickerValue">${escapeHtml(lab.title)}</strong>
        </span>
        <span class="template-picker-caret" aria-hidden="true"></span>
      </button>
      <div
        id="artifactPickerMenu"
        class="template-picker-menu"
        role="listbox"
        aria-labelledby="artifactPickerLabel"
        hidden
      >
        <div class="template-picker-group">
          <span>${escapeHtml(groupLabel)}</span>
          ${candidates.map((candidate) => artifactPickerOption(candidate, lab)).join('')}
        </div>
      </div>
    </div>
  `;
}

function artifactPickerOption(candidate: LabDefinition, selectedLab: LabDefinition): string {
  const selected = candidate.id === selectedLab.id;
  return `
    <button
      class="template-picker-option ${selected ? 'selected active' : ''}"
      type="button"
      role="option"
      aria-selected="${selected ? 'true' : 'false'}"
      data-artifact-option="${escapeHtml(candidate.id)}"
      tabindex="${selected ? '0' : '-1'}"
    >
      <span>${escapeHtml(labKindLabel(candidate.kind))}</span>
      <strong>${escapeHtml(candidate.title)}</strong>
      <em>${escapeHtml(candidate.description)}</em>
    </button>
  `;
}

function labEmptyState(): string {
  return `
    <div class="empty lab-empty-state">
      <span>No receipt yet</span>
      <h3>Sign an evidence receipt</h3>
      <p>Your wallet signs a record for your archive only. No transaction is created, approved, or submitted.</p>
    </div>
  `;
}

function contextPanel(): string {
  const latestLab = state.labArtifacts[0];
  const nextAction = state.busy
    ? 'Waiting on wallet response'
    : !state.address
      ? 'Connect a wallet'
      : state.activeTab === 'overview'
        ? 'Choose the next approval step'
      : state.activeTab === 'agent' && state.oneTimePlanView === 'review'
        ? 'Check one-time requests'
        : state.activeTab === 'agent'
          ? 'Create a one-time request'
          : state.activeTab === 'generated'
            ? 'Check saved requests'
            : state.activeTab === 'inbox'
                ? 'Review requests that need approval'
              : state.activeTab === 'schedule'
                ? 'Create repeat payment'
                : state.activeTab === 'completed'
                  ? 'Review done work'
                  : state.activeTab === 'labs' && state.artifactView === 'signed'
                    ? 'Review saved proofs'
                    : state.activeTab === 'labs'
                      ? 'Save a proof'
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
          ${contextRow('Needs Approval', `${activeWorkflowPreparedActions().filter((action) => !action.archived).length} action(s)`, activeWorkflowPreparedActions().length ? 'warn' : '')}
          ${contextRow('Agent proof', state.agentSignature ? short(state.agentSignature) : 'Unsigned')}
          ${contextRow('Last tx', state.txid ? short(state.txid) : latestConfirmedTx())}
          ${contextRow('Latest receipt', latestLab ? short(latestLab.artifactHash) : 'No receipt')}
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
  const openApprovals = activeWorkflowPreparedActions().filter((action) => !action.archived).length;
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
    <details class="panel public-request-context evidence-details" data-layout="request-context">
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
  bindArtifactPicker();
  bindSelectPickers();

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    button.addEventListener('click', () => {
      const tab = button.dataset.tab as ActiveTab;
      trackNavClick(`${currentRoute() ?? '/app'}#${tab}`, 'workspace');
      state.activeTab = tab;
      if (state.activeTab === 'labs') {
        state.artifactView = 'create';
      }
      state.error = '';
      render();
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-command-center-view]')) {
    button.addEventListener('click', () => {
      const view = button.dataset.commandCenterView as CommandCenterView | undefined;
      if (view !== 'center' && view !== 'ai' && view !== 'storage') return;
      state.activeTab = 'overview';
      state.commandCenterView = view;
      state.error = '';
      render();
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-one-time-view]')) {
    button.addEventListener('click', () => {
      const view = button.dataset.oneTimeView as OneTimePlanView | undefined;
      if (!view) return;
      state.activeTab = 'agent';
      state.oneTimePlanView = view;
      if (view === 'create') {
        state.generatedPlanAuditId = '';
      } else {
        state.listPages.review = 1;
      }
      trackNavClick(`${currentRoute() ?? '/app'}#one-time-${view}`, 'one_time_plan');
      render();
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-recurring-view]')) {
    button.addEventListener('click', () => {
      const view = button.dataset.recurringView as RecurringView | undefined;
      if (!view) return;
      state.activeTab = 'schedule';
      state.recurringView = view;
      if (view === 'active') {
        state.listPages.recurring = 1;
      }
      state.error = '';
      render();
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-demo-scenario]')) {
    button.addEventListener('click', () => {
      const scenario = guidedDemoScenarioById(button.dataset.demoScenario);
      state.guidedDemo = defaultGuidedDemoState(scenario.id);
      state.error = '';
      render();
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-demo-action]')) {
    button.addEventListener('click', () => {
      const action = button.dataset.demoAction;
      if (!action) return;
      if (action === 'sign-receipt') {
        void runSignGuidedDemoReceipt();
        return;
      }
      runGuidedDemoAction(action);
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-first-run-action]')) {
    button.addEventListener('click', () => {
      const action = button.dataset.firstRunAction as FirstRunActionId | undefined;
      if (!action) return;
      void runFirstRunAction(action);
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-template-filter]')) {
    button.addEventListener('click', () => {
      const filter = button.dataset.templateFilter as TemplateOutcomeFilter | undefined;
      if (!filter) return;
      state.templateOutcomeFilter = filter;
      const current = selectedTemplate();
      if (filter !== 'all' && templateOutcome(current) !== filter) {
        selectAgentTemplate(firstTemplateForOutcomeFilter(filter).id);
        return;
      }
      render();
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-completed-filter]')) {
    button.addEventListener('click', () => {
      const filter = button.dataset.completedFilter as CompletedPlanFilter | undefined;
      if (!filter) return;
      state.completedPlanFilter = filter;
      state.error = '';
      render();
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-list-page-key]')) {
    button.addEventListener('click', () => {
      const pageKey = button.dataset.listPageKey;
      const nextPage = Number(button.dataset.listPage);
      if (!isAppListPageKey(pageKey) || !Number.isFinite(nextPage)) return;
      state.listPages[pageKey] = nextPage;
      state.error = '';
      render();
    });
  }

  document.querySelector<HTMLButtonElement>('#discover')?.addEventListener('click', runDiscover);
  document.querySelector<HTMLButtonElement>('#connect')?.addEventListener('click', runConnect);
  document.querySelector<HTMLButtonElement>('#disconnect')?.addEventListener('click', runDisconnect);
  document.querySelector<HTMLButtonElement>('#androidReconnectCached')?.addEventListener('click', runReconnectAndroidCached);
  document.querySelector<HTMLButtonElement>('#androidClearTransient')?.addEventListener('click', runClearAndroidTransient);
  document.querySelector<HTMLButtonElement>('#androidFullReset')?.addEventListener('click', runClearAndroidFullReset);
  document.querySelector<HTMLButtonElement>('#androidClearAllAccounts')?.addEventListener('click', runClearAndroidAllAccounts);
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
  document.querySelector<HTMLButtonElement>('#refreshCompletedPlans')?.addEventListener('click', runRefreshInbox);
  document.querySelector<HTMLButtonElement>('#toggleArchivedGeneratedPlans')?.addEventListener('click', () => {
    state.showArchivedGeneratedPlans = !state.showArchivedGeneratedPlans;
    state.listPages.review = 1;
    const auditRecord = generatedPlanById(state.generatedPlanAuditId);
    if (!state.showArchivedGeneratedPlans && auditRecord?.status === 'archived') {
      state.generatedPlanAuditId = '';
    }
    selectFallbackGeneratedPlan();
    state.error = '';
    render();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-generated-plan-action]')) {
    button.addEventListener('click', () => {
      const action = button.dataset.generatedPlanAction;
      const planId = button.dataset.generatedPlanId;
      if (!action || !planId) return;
      void runGeneratedPlanAction(planId, action);
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-completed-delete]')) {
    button.addEventListener('click', () => {
      const completedId = button.dataset.completedDelete;
      if (!completedId) return;
      void runDeleteCompletedPlan(completedId);
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-generated-plan-modal-close]')) {
    button.addEventListener('click', closeGeneratedPlanAuditModal);
  }
  document.querySelector<HTMLElement>('.generated-plan-modal-backdrop')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      closeGeneratedPlanAuditModal();
    }
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-ai-action]')) {
    button.addEventListener('click', () => {
      switch (button.dataset.aiAction) {
        case 'save-bridge-key':
          void runSaveBridgeAiKey();
          return;
        case 'save-direct-key':
          void runSaveDirectAiKey();
          return;
        case 'confirm-planner':
          void runConfirmAiPlanner();
          return;
        case 'clear-key':
          void runClearAiKey();
          return;
        case 'refresh-status':
          void runRefreshAiStatus();
          return;
      }
    });
  }
  for (const details of document.querySelectorAll<HTMLDetailsElement>('.ai-settings-panel')) {
    details.addEventListener('toggle', (event) => {
      state.aiSettingsPanelOpen = (event.currentTarget as HTMLDetailsElement).open;
    });
  }
  for (const details of document.querySelectorAll<HTMLDetailsElement>('.workspace-storage-panel')) {
    details.addEventListener('toggle', (event) => {
      state.workspaceStoragePanelOpen = (event.currentTarget as HTMLDetailsElement).open;
    });
  }
  document.querySelector<HTMLButtonElement>('#cloudSignIn')?.addEventListener('click', runCloudSignIn);
  document.querySelector<HTMLButtonElement>('#cloudLogout')?.addEventListener('click', runCloudLogout);
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-cloud-action]')) {
    button.addEventListener('click', () => {
      if (button.dataset.cloudAction === 'sign-in') {
        void runCloudSignIn();
      }
      if (button.dataset.cloudAction === 'sign-out') {
        void runCloudLogout();
      }
      if (button.dataset.cloudAction === 'delete-workspace') {
        openCloudWorkspaceDeleteModal();
      }
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-cloud-delete-cancel]')) {
    button.addEventListener('click', closeCloudWorkspaceDeleteModal);
  }
  document.querySelector<HTMLButtonElement>('[data-cloud-delete-confirm]')?.addEventListener('click', () => {
    void runConfirmCloudWorkspaceDelete();
  });
  document.querySelector<HTMLElement>('.cloud-delete-modal-backdrop')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      closeCloudWorkspaceDeleteModal();
    }
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-workflow-mode]')) {
    button.addEventListener('click', () => {
      const mode = button.dataset.workflowMode;
      if (!mode || !isWorkflowModePreference(mode)) return;
      void runSetWorkflowModePreference(mode);
    });
  }
  document.querySelector<HTMLButtonElement>('#connectBridge')?.addEventListener('click', runConnectBridge);
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-bridge-action="connect"]')) {
    button.addEventListener('click', runConnectBridge);
  }
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
      trackNavClick(`/demo#${tab}`, 'demo_guide');
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
    clearBrowserWalletSession();
    if (isBrowserWalletSurface()) {
      state.selectedWalletName = '';
      state.browserWalletPickerOpen = false;
    }
    resetWalletConnection();
    void signOutCloudSessionForWalletBoundary('wallet-changed', { toast: true }).then((signedOut) => {
      if (signedOut) render();
    });
    state.error = '';
    savePersistedState();
    render();
  });

  document.querySelector<HTMLSelectElement>('#walletSelect')?.addEventListener('change', (event) => {
    state.selectedWalletName = (event.currentTarget as HTMLSelectElement).value;
    state.browserWalletPickerOpen = false;
    clearBrowserWalletSession();
    resetWalletConnection();
    void signOutCloudSessionForWalletBoundary('wallet-changed', { toast: true }).then((signedOut) => {
      if (signedOut) render();
    });
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
    void signOutCloudSessionForWalletBoundary('wallet-changed', { toast: true }).then((signedOut) => {
      if (signedOut) render();
    });
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
    saveSessionBridgeToken(state.bridgeToken);
    savePersistedState();
  });

  document.querySelector<HTMLTextAreaElement>('#agentPrompt')?.addEventListener('input', (event) => {
    state.agentPrompt = (event.currentTarget as HTMLTextAreaElement).value;
    delete state.templateFieldErrors.__notes;
    state.agentPlan = null;
    state.agentSignature = '';
    state.agentPreparedActionId = '';
  });

  for (const fieldInput of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-template-field]')) {
    fieldInput.addEventListener('input', () => {
      const fieldId = fieldInput.dataset.templateField;
      if (!fieldId) return;
      state.templateFields[fieldId] = fieldInput.value;
      delete state.templateFieldErrors[fieldId];
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

  for (const fieldInput of document.querySelectorAll<HTMLInputElement>('[data-template-slippage-field]')) {
    fieldInput.addEventListener('input', () => {
      const fieldId = fieldInput.dataset.templateSlippageField;
      if (!fieldId) return;
      state.templateFields[fieldId] = slippagePercentInputToBps(fieldInput.value);
      delete state.templateFieldErrors[fieldId];
      state.agentPlan = null;
      state.agentSignature = '';
      state.agentPreparedActionId = '';
    });
    fieldInput.addEventListener('change', () => {
      const fieldId = fieldInput.dataset.templateSlippageField;
      if (!fieldId) return;
      state.templateFields[fieldId] = slippagePercentInputToBps(fieldInput.value);
      fieldInput.value = slippageBpsToPercentInput(state.templateFields[fieldId] ?? '');
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-token-field-mode]')) {
    button.addEventListener('click', () => {
      const fieldId = button.dataset.tokenFieldId;
      const mode = button.dataset.tokenFieldMode;
      const fieldDef = selectedTemplate().fields.find((field) => field.id === fieldId);
      if (!fieldId || !fieldDef || !isTokenSelectField(fieldDef)) return;
      const options = fieldDef.options ?? [];
      const current = state.templateFields[fieldId] ?? defaultTemplateFieldValues(selectedTemplate())[fieldId] ?? '';
      if (mode === 'custom') {
        state.templateFields[fieldId] = options.includes(current) ? '' : current;
      } else {
        state.templateFields[fieldId] = options.includes(current)
          ? current
          : fieldDef.defaultValue || options[0] || '';
      }
      delete state.templateFieldErrors[fieldId];
      state.agentPlan = null;
      state.agentSignature = '';
      state.agentPreparedActionId = '';
      render();
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-ai-mode-choice]')) {
    button.addEventListener('click', () => {
      const value = button.dataset.aiModeChoice;
      const mode: AiSettings['mode'] = value === 'session' || value === 'hosted' ? value : 'bridge';
      setAiPlannerMode(mode);
    });
  }

  for (const control of document.querySelectorAll<HTMLSelectElement>('[data-ai-control="mode"]')) {
    control.addEventListener('change', (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value;
      const mode: AiSettings['mode'] = value === 'session' || value === 'hosted' ? value : 'bridge';
      setAiPlannerMode(mode);
    });
  }

  for (const control of document.querySelectorAll<HTMLSelectElement>('[data-ai-control="provider"]')) {
    control.addEventListener('change', (event) => {
      const preset = aiProviderPresetById((event.currentTarget as HTMLSelectElement).value);
      if (aiProviderDisabledReason(preset.id)) {
        render();
        return;
      }
      state.aiSettings.provider = preset.id;
      state.aiSettings.apiFormat = preset.apiFormat;
      state.aiSettings.baseUrl = preset.baseUrl;
      state.aiSettings.model = preset.model;
      resetAiPlannerConfirmation('AI provider changed. Confirm planner again if needed.');
      savePersistedState();
      render();
    });
  }

  for (const control of document.querySelectorAll<HTMLInputElement>('[data-ai-control="base-url"]')) {
    control.addEventListener('input', (event) => {
      state.aiSettings.baseUrl = (event.currentTarget as HTMLInputElement).value.trim();
      resetAiPlannerConfirmation('Gateway changed. Confirm planner again if needed.');
      savePersistedState();
      syncAiActionButtons();
    });
  }

  for (const control of document.querySelectorAll<HTMLSelectElement>('[data-ai-control="model-select"]')) {
    control.addEventListener('change', (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value;
      state.aiSettings.model = value === CUSTOM_AI_MODEL_VALUE ? '' : value;
      resetAiPlannerConfirmation('Model changed. Confirm planner again if needed.');
      savePersistedState();
      render();
    });
  }

  for (const control of document.querySelectorAll<HTMLInputElement>('[data-ai-control="model-custom"]')) {
    control.addEventListener('input', (event) => {
      state.aiSettings.model = (event.currentTarget as HTMLInputElement).value.trim();
      resetAiPlannerConfirmation('Model changed. Confirm planner again if needed.');
      savePersistedState();
      syncAiActionButtons();
    });
  }

  for (const control of document.querySelectorAll<HTMLInputElement>('[data-ai-control="api-key"]')) {
    control.addEventListener('input', (event) => {
      state.aiSettings.apiKey = (event.currentTarget as HTMLInputElement).value;
      resetAiPlannerConfirmation('AI key changed. Confirm planner again if needed.');
      syncAiActionButtons();
    });
  }

  document.querySelector<HTMLTextAreaElement>('#labInput')?.addEventListener('input', (event) => {
    state.labInputs[state.activeLab] = (event.currentTarget as HTMLTextAreaElement).value;
    delete state.labFieldErrors[receiptFieldErrorKey(state.activeLab, '__advanced')];
    syncLabActionButton();
  });

  document.querySelector<HTMLSelectElement>('#labSelect')?.addEventListener('change', (event) => {
    state.activeLab = (event.currentTarget as HTMLSelectElement).value;
    state.error = '';
    render();
  });

  for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-lab-field]')) {
    field.addEventListener('input', () => updateLabFieldValue(field));
    field.addEventListener('change', () => updateLabFieldValue(field));
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-lab-action]')) {
    button.addEventListener('click', () => {
      if (button.dataset.labAction !== 'create-another') return;
      clearActiveLabDraft();
      state.error = '';
      render();
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-artifact-view]')) {
    button.addEventListener('click', () => {
      const view = button.dataset.artifactView;
      if (view !== 'create' && view !== 'signed') return;
      state.artifactView = view;
      if (view === 'signed') {
        state.listPages.receiptArchive = 1;
      }
      state.error = '';
      render();
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-artifact-proof-group]')) {
    button.addEventListener('click', () => {
      const group = button.dataset.artifactProofGroup as ArtifactProofGroup | undefined;
      if (group !== 'common' && group !== 'advanced') return;
      if (artifactProofGroupForLab(activeLab()) === group) return;
      state.activeLab = group === 'advanced' ? ADVANCED_EVIDENCE_LABS[0]!.id : RECEIPT_LABS[0]!.id;
      state.error = '';
      state.labFieldErrors = {};
      render();
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-artifact-filter]')) {
    button.addEventListener('click', () => {
      const filter = button.dataset.artifactFilter as ArtifactFilter | undefined;
      if (!filter) return;
      state.artifactFilter = filter;
      state.listPages.receiptArchive = 1;
      state.error = '';
      render();
    });
  }

  document.querySelector<HTMLSelectElement>('#artifactTypeFilter')?.addEventListener('change', (event) => {
    state.artifactTypeFilter = (event.currentTarget as HTMLSelectElement).value;
    state.listPages.receiptArchive = 1;
    state.error = '';
    render();
  });

  document.querySelector<HTMLInputElement>('#artifactSearch')?.addEventListener('input', (event) => {
    state.artifactSearch = (event.currentTarget as HTMLInputElement).value;
    state.listPages.receiptArchive = 1;
    syncArtifactSearchResults();
  });
  document.querySelector<HTMLInputElement>('#artifactSearch')?.addEventListener('change', (event) => {
    state.artifactSearch = (event.currentTarget as HTMLInputElement).value;
    state.listPages.receiptArchive = 1;
    state.error = '';
    render();
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-artifact-delete]')) {
    button.addEventListener('click', () => {
      const artifactId = button.dataset.artifactDelete;
      if (!artifactId) return;
      void runDeleteLabArtifact(artifactId);
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-share-receipt]')) {
    button.addEventListener('click', () => {
      const artifactId = button.dataset.shareReceipt;
      if (!artifactId) return;
      void runShareLabArtifact(artifactId);
    });
  }

  document.querySelector<HTMLTextAreaElement>('#txInput')?.addEventListener('input', (event) => {
    state.customTransactionBase64 = (event.currentTarget as HTMLTextAreaElement).value.trim();
    state.txSignature = '';
    state.txid = '';
  });

  document.querySelector<HTMLSelectElement>('#inboxFilter')?.addEventListener('change', (event) => {
    state.inboxFilter = (event.currentTarget as HTMLSelectElement).value as InboxFilter;
    state.listPages.inbox = 1;
    render();
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-recurring-preset]')) {
    button.addEventListener('click', () => {
      const preset = button.dataset.recurringPreset as RecurringPresetId | undefined;
      if (!preset) return;
      applyRecurringPreset(preset);
      render();
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-recurring-action]')) {
    button.addEventListener('click', () => {
      if (button.dataset.recurringAction === 'dca-proof') {
        openDcaReviewProofTemplate();
      }
    });
  }

  for (const recurringInput of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-recurring-field]')) {
    recurringInput.addEventListener('input', () => {
      const field = recurringInput.dataset.recurringField;
      state.recurringDraft = readRecurringDraft();
      if (field) {
        delete state.recurringErrors[`recurring${field.charAt(0).toUpperCase()}${field.slice(1)}`];
      }
      syncRecurringPreview();
    });
    recurringInput.addEventListener('change', () => {
      const field = recurringInput.dataset.recurringField;
      state.recurringDraft = readRecurringDraft();
      if (field) {
        delete state.recurringErrors[`recurring${field.charAt(0).toUpperCase()}${field.slice(1)}`];
      }
      render();
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action-op]')) {
    button.addEventListener('click', () => {
      const actionId = button.dataset.actionId;
      const op = button.dataset.actionOp;
      if (!actionId || !op) return;
      void runPreparedActionOp(actionId, op);
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-inline-receipt-kind]')) {
    button.addEventListener('click', () => {
      const actionId = button.dataset.inlineReceiptActionId;
      const proofKind = button.dataset.inlineReceiptKind as InlineReceiptKind | undefined;
      if (!actionId || !proofKind) return;
      void runInlineReceiptProof(actionId, proofKind);
    });
  }

  for (const details of document.querySelectorAll<HTMLDetailsElement>('[data-audit-record-type][data-audit-record-id]')) {
    const recordType = details.dataset.auditRecordType as AuditRecordType | undefined;
    const recordId = details.dataset.auditRecordId;
    details.addEventListener('toggle', () => {
      if (!recordType || !recordId) return;
      const key = auditActivityKey(recordType, recordId);
      state.auditOpen[key] = details.open;
      if (details.open) {
        void loadAuditEventsForRecord(recordType, recordId);
      }
    });
    if (details.open && recordType && recordId) {
      void loadAuditEventsForRecord(recordType, recordId);
    }
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-audit-refresh-record-type][data-audit-refresh-record-id]')) {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const recordType = button.dataset.auditRefreshRecordType as AuditRecordType | undefined;
      const recordId = button.dataset.auditRefreshRecordId;
      if (!recordType || !recordId) return;
      state.auditOpen[auditActivityKey(recordType, recordId)] = true;
      void loadAuditEventsForRecord(recordType, recordId, { force: true });
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-recurring-op]')) {
    button.addEventListener('click', () => {
      const recurringId = button.dataset.recurringId;
      const op = button.dataset.recurringOp;
      if (!recurringId || !op) return;
      void runRecurringOp(recurringId, op, button.dataset.recurringCursor);
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
      const isJson = button.dataset.copyKind === 'json' || looksLikeJsonValue(value);
      const toastTitle = button.dataset.copyToast ?? (isJson ? 'JSON copied' : `${label} copied`);
      const toastMessage = button.dataset.copyMessage
        ?? (isJson ? '' : formatCopyToastMessage(value));
      try {
        await navigator.clipboard.writeText(value);
        markCopied(copyId);
        pushToast('success', toastTitle, toastMessage);
        const commandKind = trackedCliCommandKind(value);
        if (commandKind) {
          trackCliCommandCopy(commandKind);
        }
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

  for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-download-asset]')) {
    link.addEventListener('click', () => {
      trackDownloadClick(
        link.dataset.downloadKind ?? 'download',
        link.dataset.downloadPlatform ?? 'unknown',
        link.dataset.downloadAsset ?? 'unknown',
      );
    });
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
      trackNavClick(route, navAreaForLink(link));
      if (route === '/mwa-test' && SHOW_ANDROID_EXAMPLE_TAB && agenticAndroidBridge()?.openMwaExample) {
        openAndroidMwaTest();
        return;
      }
      navigateTo(route);
    });
  }
}

function navAreaForLink(link: HTMLAnchorElement): string {
  if (link.closest('.homepage-nav')) return 'header';
  if (link.closest('.homepage-footer')) return 'footer';
  if (link.closest('.hero-command-area')) return 'hero';
  if (link.closest('.homepage-cta-actions')) return 'homepage_cta';
  if (link.closest('.browser-app-actions')) return 'workspace_cta';
  if (link.closest('.command-deck')) return 'runtime_deck';
  return 'internal_link';
}

function trackedCliCommandKind(value: string): string | null {
  if (value === NPM_GLOBAL_INSTALL_COMMAND) return 'npm_global_install';
  if (value === NPM_EXEC_COMMAND) return 'npm_exec_app';
  if (value === INSTALLED_APP_COMMAND) return 'installed_app';
  return null;
}

function walletConnectSurface(): string {
  if (state.androidNativeEnvironment.isAndroidNative) return 'android_native';
  if (state.iosNativeEnvironment.isIosNative) return 'ios_native';
  return 'wallet_standard';
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

function bindArtifactPicker(): void {
  const picker = document.querySelector<HTMLElement>('[data-artifact-picker]');
  if (!picker) return;
  const trigger = picker.querySelector<HTMLButtonElement>('#artifactPickerButton');
  const menu = picker.querySelector<HTMLElement>('#artifactPickerMenu');
  const options = [...picker.querySelectorAll<HTMLButtonElement>('[data-artifact-option]')];
  if (!trigger || !menu || options.length === 0) return;

  const openPicker = (focusOption: 'selected' | 'first' | 'last' | false = false): void => {
    if (trigger.disabled) return;
    closeArtifactPickerInteractions();
    picker.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    menu.hidden = false;
    positionTemplatePickerMenu(trigger, menu);
    window.requestAnimationFrame(() => positionTemplatePickerMenu(trigger, menu));

    const selectedOption = options.find((option) => option.dataset.artifactOption === state.activeLab) ?? options[0]!;
    const activeOption = focusOption === 'first'
      ? options[0]!
      : focusOption === 'last'
        ? options[options.length - 1]!
        : selectedOption;
    setActiveTemplateOption(options, activeOption, Boolean(focusOption));

    artifactPickerController = new AbortController();
    const { signal } = artifactPickerController;
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
    closeArtifactPickerInteractions();
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
      const labId = activeOption.dataset.artifactOption;
      if (!labId) return;
      if (!selectArtifactLab(labId)) {
        closePicker(true);
      }
    }
  });

  for (const option of options) {
    option.addEventListener('click', () => {
      const labId = option.dataset.artifactOption;
      if (!labId) return;
      if (!selectArtifactLab(labId)) {
        closePicker(true);
      }
    });
    option.addEventListener('pointermove', () => setActiveTemplateOption(options, option, false));
  }
}

function closeArtifactPickerInteractions(): void {
  artifactPickerController?.abort();
  artifactPickerController = null;
}

function bindSelectPickers(): void {
  for (const picker of document.querySelectorAll<HTMLElement>('[data-select-picker]')) {
    const shell = picker.closest<HTMLElement>('.select-picker-shell');
    const select = shell?.querySelector<HTMLSelectElement>('select[data-select-picker-native]');
    const trigger = picker.querySelector<HTMLButtonElement>('.select-picker-trigger');
    const menu = picker.querySelector<HTMLElement>('.select-picker-menu');
    const options = [...picker.querySelectorAll<HTMLButtonElement>('[data-select-picker-option]')];
    const enabledOptions = options.filter((option) => !option.disabled);
    if (!select || !trigger || !menu || enabledOptions.length === 0) continue;

    const openPicker = (focusOption: 'selected' | 'first' | 'last' | false = false): void => {
      if (trigger.disabled) return;
      closeSelectPickerInteractions();
      picker.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      menu.hidden = false;
      positionTemplatePickerMenu(trigger, menu);
      window.requestAnimationFrame(() => positionTemplatePickerMenu(trigger, menu));

      const selectedOption = enabledOptions.find((option) => option.dataset.selectPickerOption === select.value) ?? enabledOptions[0]!;
      const activeOption = focusOption === 'first'
        ? enabledOptions[0]!
        : focusOption === 'last'
          ? enabledOptions[enabledOptions.length - 1]!
          : selectedOption;
      setActiveTemplateOption(enabledOptions, activeOption, Boolean(focusOption));

      selectPickerController = new AbortController();
      const { signal } = selectPickerController;
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
      closeSelectPickerInteractions();
      if (returnFocus) {
        trigger.focus({ preventScroll: true });
      }
    };

    const chooseOption = (option: HTMLButtonElement): void => {
      const value = option.dataset.selectPickerOption;
      if (!value || option.disabled) return;
      const changed = select.value !== value;
      select.value = value;
      updateSelectPickerView(picker, value);
      closePicker(false);
      if (changed) {
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
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
        focusAdjacentTemplateOption(enabledOptions, 1);
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        openPicker('selected');
        focusAdjacentTemplateOption(enabledOptions, -1);
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openPicker('selected');
      }
    });

    menu.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusAdjacentTemplateOption(enabledOptions, 1);
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusAdjacentTemplateOption(enabledOptions, -1);
      }
      if (event.key === 'Home') {
        event.preventDefault();
        setActiveTemplateOption(enabledOptions, enabledOptions[0]!, true);
      }
      if (event.key === 'End') {
        event.preventDefault();
        setActiveTemplateOption(enabledOptions, enabledOptions[enabledOptions.length - 1]!, true);
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const activeOption = document.activeElement instanceof HTMLButtonElement
          ? document.activeElement
          : enabledOptions.find((option) => option.classList.contains('active')) ?? enabledOptions[0]!;
        chooseOption(activeOption);
      }
    });

    for (const option of enabledOptions) {
      option.addEventListener('click', () => chooseOption(option));
      option.addEventListener('pointermove', () => setActiveTemplateOption(enabledOptions, option, false));
    }
  }
}

function closeSelectPickerInteractions(): void {
  selectPickerController?.abort();
  selectPickerController = null;
}

function updateSelectPickerView(picker: HTMLElement, value: string): void {
  const options = [...picker.querySelectorAll<HTMLButtonElement>('[data-select-picker-option]')];
  const selectedOption = options.find((option) => option.dataset.selectPickerOption === value);
  if (!selectedOption) return;
  for (const option of options) {
    const selected = option === selectedOption;
    option.classList.toggle('selected', selected);
    option.classList.toggle('active', selected);
    option.setAttribute('aria-selected', selected ? 'true' : 'false');
    option.tabIndex = selected ? 0 : -1;
  }
  const valueNode = picker.querySelector<HTMLElement>('[data-select-picker-value]');
  if (valueNode) {
    valueNode.textContent = selectedOption.dataset.selectPickerLabel ?? selectedOption.textContent?.trim() ?? value;
  }
  const metaNode = picker.querySelector<HTMLElement>('.select-picker-meta');
  if (metaNode) {
    const meta = selectedOption.dataset.selectPickerMeta ?? '';
    metaNode.textContent = meta;
    metaNode.hidden = meta.length === 0;
  }
}

function selectArtifactLab(labId: string): boolean {
  const lab = LABS.find((candidate) => candidate.id === labId);
  if (!lab || lab.id === state.activeLab) {
    return false;
  }
  state.activeLab = lab.id;
  state.error = '';
  state.labFieldErrors = {};
  render();
  return true;
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
  state.templateFieldErrors = {};
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
  const viewportHeight = viewport?.height ?? window.innerHeight;
  const triggerRect = trigger.getBoundingClientRect();
  const safeBottom = viewportTop + viewportHeight - 10;
  const spaceBelow = Math.max(0, Math.floor(safeBottom - triggerRect.bottom - 8));
  const maxHeight = Math.min(420, Math.max(160, spaceBelow));
  menu.classList.remove('drop-up');
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

async function runFirstRunAction(action: FirstRunActionId): Promise<void> {
  switch (action) {
    case 'discover-wallets':
      await runDiscover();
      return;
    case 'connect-wallet':
      await runConnect();
      return;
    case 'cloud-sign-in':
      await runCloudSignIn();
      return;
    case 'open-create-plan':
      state.activeTab = 'agent';
      state.oneTimePlanView = 'create';
      state.generatedPlanAuditId = '';
      state.error = '';
      render();
      return;
    case 'open-ai-setup':
      state.activeTab = 'overview';
      state.commandCenterView = 'ai';
      state.aiSettingsPanelOpen = true;
      state.generatedPlanAuditId = '';
      state.error = '';
      render();
      focusLayoutTarget('ai-setup-panel');
      return;
    case 'open-review':
      state.activeTab = 'agent';
      state.oneTimePlanView = 'review';
      selectFallbackGeneratedPlan();
      state.error = '';
      render();
      return;
    case 'open-inbox':
      state.activeTab = 'inbox';
      state.inboxFilter = 'ready';
      state.error = '';
      render();
      return;
    case 'open-completed':
      state.activeTab = 'completed';
      state.completedPlanFilter = 'receipts';
      state.error = '';
      render();
      return;
  }
}

function focusLayoutTarget(layoutName: string): void {
  window.requestAnimationFrame(() => {
    const target = document.querySelector<HTMLElement>(`[data-layout="${layoutName}"]`);
    if (!target) return;
    if (target instanceof HTMLDetailsElement) {
      target.open = true;
    }
    target.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'center',
    });
    target.focus?.({ preventScroll: true });
  });
}

async function runDiscover(): Promise<void> {
  await run('discover', async () => {
    if (state.androidNativeEnvironment.isAndroidNative) {
      trackWalletConnectClick('android_native', 'discover_button');
      await connectAndroidNativeWallet(true);
      await afterWalletConnected();
      trackWalletConnectSuccess('android_native', state.cluster, 'discover_button');
      pushToast('success', 'Android MWA connected', short(state.address));
      return;
    }
    if (state.iosNativeEnvironment.isIosNative) {
      state.iosWallets = listIosNativeWalletOptions();
      await refreshIosNativeCacheState();
      state.iosNativeStatus = `${state.iosWallets.length} iOS wallet path(s) available. Cached authorizations: ${state.iosAuthCacheCount}.`;
      savePersistedState();
      pushToast('success', 'iOS wallets ready', `${state.iosWallets.length} wallet path(s) available.`);
      return;
    }
    state.wallets = visibleBrowserWallets(listAvailableWallets());
    state.selectedWalletName = reconcileBrowserWalletSelection(state.wallets, state.selectedWalletName);
    state.browserWalletPickerOpen = state.wallets.length > 0 && !state.selectedWalletName;
    if (!browserWalletRestoreName(state.wallets, state.browserWalletSession, state.cluster)) {
      clearBrowserWalletSession();
    }
    if (state.wallets.length === 0) {
      state.selectedWalletName = '';
      state.browserWalletPickerOpen = false;
      clearBrowserWalletSession();
      savePersistedState();
      throw new Error('No Wallet Standard Solana wallets are registered in this browser.');
    }
    savePersistedState();
    pushToast('success', 'Wallets discovered', `${state.wallets.length} provider(s) found.`);
  });
}

async function runConnect(): Promise<void> {
  const connectSurface = walletConnectSurface();
  trackWalletConnectClick(connectSurface, 'connect_button');
  await run('connect', async () => {
    if (state.androidNativeEnvironment.isAndroidNative) {
      await connectAndroidNativeWallet(true);
      state.transactionStatus = `Android MWA wallet connected on ${state.cluster}.`;
      if (state.bridgeActive) {
        await connectBridgeHost();
      }
      await afterWalletConnected();
      savePersistedState();
      trackWalletConnectSuccess(connectSurface, state.cluster, 'connect_button');
      pushToast('success', 'Android MWA connected', short(state.address));
      return;
    }
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
      await afterWalletConnected();
      savePersistedState();
      trackWalletConnectSuccess(connectSurface, state.cluster, 'connect_button');
      pushToast('success', 'iOS wallet connected', short(state.address));
      return;
    }
    const selected = selectedWallet();
    state.browserWalletPickerOpen = false;
    walletBackend = new WalletStandardWebBackend({
      wallet: selected,
      cluster: state.cluster,
      rpcUrl: activeRpcUrl(),
    });
    client = new SolanaSigningClient({ backend: walletBackend });
    state.address = await client.getAddress();
    state.capabilities = await client.capabilities();
    state.transactionStatus = `Wallet connected on ${state.cluster}.`;
    state.selectedWalletName = selected.name;
    state.browserWalletSession = createBrowserWalletSession(selected.name, state.cluster);
    if (state.bridgeActive) {
      await connectBridgeHost();
    }
    await afterWalletConnected();
    savePersistedState();
    trackWalletConnectSuccess(connectSurface, state.cluster, 'connect_button');
    pushToast('success', 'Wallet connected', short(state.address));
  });
}

async function runDisconnect(): Promise<void> {
  await run('connect', async () => {
    const browserWallet = isBrowserWalletSurface();
    if (state.bridgeActive) {
      await disconnectBridgeHost().catch(() => undefined);
    }
    await disconnectWalletBackend().catch(() => undefined);
    resetWalletConnection();
    const cloudSignedOut = await signOutCloudSessionForWalletBoundary('wallet-disconnected');
    if (browserWallet) {
      state.selectedWalletName = '';
      state.browserWalletPickerOpen = false;
      clearBrowserWalletSession();
    }
    await refreshAndroidNativeCacheState();
    if (state.androidNativeEnvironment.isAndroidNative) {
      state.androidNativeStatus = state.androidAuthCacheCount > 0
        ? 'Android MWA disconnected locally. Cached authorization retained.'
        : 'Android MWA disconnected.';
    }
    await refreshIosNativeCacheState();
    savePersistedState();
    pushToast(
      'success',
      'Wallet disconnected',
      cloudSignedOut ? 'Local signing and cloud workspace sessions cleared.' : 'Local signing session cleared.',
    );
  });
}

async function runReconnectAndroidCached(): Promise<void> {
  trackWalletConnectClick('android_native', 'reconnect_cached');
  await run('connect', async () => {
    assertAndroidNativeRuntime();
    const restored = await restoreLatestAndroidNativeWallet({ cluster: androidNativeCluster() });
    if (!restored) {
      throw new Error('No cached Android MWA authorization found.');
    }
    await applyAndroidNativeRestore(restored);
    if (state.bridgeActive) {
      await connectBridgeHost();
    }
    await afterWalletConnected();
    trackWalletConnectSuccess('android_native', state.cluster, 'reconnect_cached');
    pushToast('success', 'Android MWA restored', short(state.address));
  });
}

async function runClearAndroidTransient(): Promise<void> {
  await run('connect', async () => {
    assertAndroidNativeRuntime();
    await androidBackendOrNew().clearTransientState();
    state.androidNativeStatus = 'Android MWA transient state cleared. Cached authorization retained.';
    await refreshAndroidNativeCacheState();
    pushToast('success', 'Android state cleared', 'Cached authorization retained.');
  });
}

async function runClearAndroidFullReset(): Promise<void> {
  await run('connect', async () => {
    assertAndroidNativeRuntime();
    if (state.bridgeActive) {
      await disconnectBridgeHost().catch(() => undefined);
    }
    await androidBackendOrNew().clearStateFullReset();
    resetWalletConnection();
    await refreshAndroidNativeCacheState();
    state.androidNativeStatus = 'Android MWA authorization reset. Discover again to authorize.';
    pushToast('success', 'Android wallet reset', 'Authorization cleared.');
  });
}

async function runClearAndroidAllAccounts(): Promise<void> {
  await run('connect', async () => {
    assertAndroidNativeRuntime();
    if (state.bridgeActive) {
      await disconnectBridgeHost().catch(() => undefined);
    }
    await androidBackendOrNew().clearAllCachedAuthorizations();
    resetWalletConnection();
    await refreshAndroidNativeCacheState();
    state.androidNativeStatus = 'All Android MWA cached authorizations cleared.';
    pushToast('success', 'Android cache cleared', 'All cached accounts removed.');
  });
}

async function runReconnectIosCached(): Promise<void> {
  trackWalletConnectClick('ios_native', 'reconnect_cached');
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
    await afterWalletConnected();
    savePersistedState();
    trackWalletConnectSuccess('ios_native', state.cluster, 'reconnect_cached');
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

function runGuidedDemoAction(action: string): void {
  const currentScenarioId = state.guidedDemo.selectedScenarioId;
  switch (action) {
    case 'prepare':
      state.guidedDemo = {
        ...defaultGuidedDemoState(currentScenarioId),
        stage: 'prepared',
      };
      pushToast('success', 'Demo request prepared', 'Review the constraints, then move it to wallet review.');
      render();
      return;
    case 'queue':
      state.guidedDemo = {
        ...state.guidedDemo,
        stage: 'queued',
        decision: 'pending',
        receiptId: '',
        receiptCreatedAt: '',
        receiptJson: '',
        signedReceipt: '',
      };
      pushToast('success', 'Moved to wallet review', 'Approve or deny the simulated request.');
      render();
      return;
    case 'approve':
      completeGuidedDemo('approved');
      return;
    case 'deny':
      completeGuidedDemo('denied');
      return;
    case 'reset':
      state.guidedDemo = defaultGuidedDemoState(currentScenarioId);
      pushToast('success', 'Demo reset', 'Choose a scenario or prepare the current one again.');
      render();
      return;
    default:
      return;
  }
}

function completeGuidedDemo(decision: Exclude<GuidedDemoDecision, 'pending'>): void {
  const scenario = selectedGuidedDemoScenario();
  const receiptId = newId('demo');
  const receiptCreatedAt = new Date().toISOString();
  state.guidedDemo = {
    ...state.guidedDemo,
    stage: 'receipt',
    decision,
    receiptId,
    receiptCreatedAt,
    receiptJson: stableJson(guidedDemoReceiptPayload(scenario, decision, receiptId, receiptCreatedAt)),
    signedReceipt: '',
  };
  pushToast(
    'success',
    decision === 'approved' ? 'Simulation approved' : 'Simulation denied',
    'Demo receipt created. Nothing was signed or submitted.',
  );
  render();
}

function guidedDemoReceiptPayload(
  scenario: GuidedDemoScenario,
  decision: GuidedDemoDecision,
  receiptId: string,
  createdAt: string,
  signature = '',
): Record<string, unknown> {
  return {
    version: 'agentic-demo-v1',
    demoOnly: true,
    receiptId,
    receiptType: scenario.receiptType,
    createdAt,
    cluster: state.cluster,
    wallet: state.address || 'demo-wallet',
    decision,
    scenario: {
      id: scenario.id,
      title: scenario.title,
      request: scenario.prompt,
    },
    route: scenario.route,
    constraints: scenario.constraints,
    risk: scenario.risk,
    approvalBoundary: scenario.approvalBoundary,
    summary: scenario.receiptSummary,
    signature: signature || undefined,
  };
}

async function runSignGuidedDemoReceipt(): Promise<void> {
  await run('sign', async () => {
    if (state.guidedDemo.stage !== 'receipt' || !state.guidedDemo.receiptJson) {
      throw new Error('Complete the demo decision before signing a demo receipt.');
    }
    const signingClient = requireClient();
    const signingMessage = [
      'Agentic demo receipt',
      `Receipt: ${state.guidedDemo.receiptId}`,
      state.guidedDemo.receiptJson,
    ].join('\n');
    const result = await signingClient.signMessage(signingMessage, signOptions('Demo receipt signature'));
    const scenario = selectedGuidedDemoScenario();
    state.guidedDemo.signedReceipt = result.signature;
    state.guidedDemo.receiptJson = stableJson(
      guidedDemoReceiptPayload(
        scenario,
        state.guidedDemo.decision,
        state.guidedDemo.receiptId,
        state.guidedDemo.receiptCreatedAt,
        result.signature,
      ),
    );
    pushToast('success', 'Demo receipt signed', 'Signature saved only inside this simulated demo.');
  });
}

async function runSignMessage(): Promise<void> {
  await run('sign', async () => {
    const signingClient = requireClient();
    const result = await signingClient.signMessage(DEMO_MESSAGE, signOptions('Home message signature'));
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
  const template = selectedTemplate();
  trackGenerateTemplatePlan(template.id);
  state.activeOperation = 'generate-template-plan';
  const toastId = pushToast('pending', 'Creating template plan', 'Preparing a saved plan for review.');
  try {
    await run(
      'sign',
      async () => {
        const parameters = readTemplateFields(template);
        const userNotes = state.agentPrompt.trim();
        assertValidTemplatePlanInput(template, parameters, userNotes);
        const plan = buildTemplatePlan(template, parameters, 'template', userNotes);
        state.agentPlan = plan;
        state.agentSignature = '';
        state.agentPreparedActionId = '';
        const record = await saveGeneratedPlan(plan, template, userNotes || template.description);
        state.selectedGeneratedPlanId = record.id;
        state.oneTimePlanView = 'review';
        replaceToast(toastId, 'success', 'Plan created', `${template.title} is ready in Check request.`);
      },
      { onError: (message) => replaceToast(toastId, 'error', 'Template plan failed', message) },
    );
  } finally {
    state.activeOperation = null;
    render();
  }
}

async function runGenerateAiPlan(): Promise<void> {
  if (!canGenerateAiPlanFromSettings()) {
    pushToast('error', 'AI setup incomplete', aiGenerateDisabledReason());
    render();
    return;
  }
  const template = selectedTemplate();
  trackGenerateAiPlan(template.id, state.aiSettings.mode, state.aiSettings.provider);
  state.activeOperation = 'generate-ai-plan';
  const toastId = pushToast('pending', 'Creating AI plan', 'Preparing through your configured AI Planner.');
  try {
    await run(
      'ai',
      async () => {
        const parameters = readTemplateFields(template);
        const userNotes = state.agentPrompt.trim();
        assertValidTemplatePlanInput(template, parameters, userNotes);
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
        state.aiDiagnostics = [
          aiRouteDiagnostic(state.aiSettings.mode === 'bridge' ? '/bridge/ai/generate-plan' : '/api/ai/generate-plan'),
        ];
        render();
        const plan = state.aiSettings.mode === 'bridge'
          ? await bridgeRequest<AgentPlan>('/bridge/ai/generate-plan', {
            method: 'POST',
            body: JSON.stringify(request),
          })
          : state.aiSettings.mode === 'hosted'
            ? await generateHostedAiPlan(state.aiSettings, request)
            : await generateSessionAiPlan(state.aiSettings, request);
        state.agentPlan = plan;
        state.agentSignature = '';
        state.agentPreparedActionId = '';
        const record = await saveGeneratedPlan(plan, template, request.prompt);
        state.selectedGeneratedPlanId = record.id;
        state.oneTimePlanView = 'review';
        appendAiDiagnostic({
          code: 'AI_PLAN_READY',
          message: 'AI Planner returned a valid plan.',
          detail: `${state.aiSettings.provider} ${state.aiSettings.model || 'model configured'}`,
        });
        replaceToast(toastId, 'success', 'AI plan created', `${plan.templateTitle} is ready in Check request.`);
      },
      {
        onError: (message, err) => {
          const toastMessage = applyAiErrorDiagnostics(err, message);
          replaceToast(toastId, 'error', aiErrorToastTitle(err), toastMessage);
        },
      },
    );
  } finally {
    state.activeOperation = null;
    render();
  }
}

async function runSignAgentPlan(): Promise<void> {
  await run('sign', async () => {
    if (!state.agentPlan) {
      throw new Error('Create a plan before signing a review proof.');
    }
    const signature = await signAgentPlanProof(state.agentPlan, 'Plan review proof');
    const activeRecord = generatedPlanById(state.selectedGeneratedPlanId);
    state.agentSignature = signature;
    await updateActiveGeneratedPlanRecord({ signature, status: 'signed', error: undefined, failureLabel: undefined });
    if (activeRecord && samePlan(activeRecord.plan, state.agentPlan)) {
      if (state.generatedPlanAuditId === activeRecord.id) {
        state.generatedPlanAuditId = '';
      }
      selectFallbackGeneratedPlan();
    }
    pushToast('success', 'Plan completed', 'Review proof saved in Done.');
  }, {
    onError: async (message) => {
      if (state.selectedGeneratedPlanId) {
        await updateGeneratedPlan(state.selectedGeneratedPlanId, {
          status: 'failed',
          error: message,
          failureLabel: 'Sign failed - try again',
        }).catch(() => undefined);
      }
      pushToast('error', 'Sign proof failed', message);
    },
  });
}

async function runQueueAgentPlan(): Promise<void> {
  await run('inbox', async () => {
    if (!state.agentPlan) {
      throw new Error('Create a plan before sending it for approval.');
    }
    const activeRecord = generatedPlanById(state.selectedGeneratedPlanId);
    const response = await queuePlanThroughActiveWorkflow(state.agentPlan, activeRecord);
    state.agentPreparedActionId = response.id;
    if (response.mode === 'agentic-cloud' && response.planRecordId) {
      state.selectedGeneratedPlanId = response.planRecordId;
    } else {
      await updateActiveGeneratedPlanRecord({ preparedActionId: response.id, status: 'queued', error: undefined, failureLabel: undefined });
    }
    const queuedRecordId = response.planRecordId ?? activeRecord?.id ?? '';
    if (queuedRecordId && activeRecord && samePlan(activeRecord.plan, state.agentPlan)) {
      if (state.generatedPlanAuditId === queuedRecordId || state.generatedPlanAuditId === activeRecord.id) {
        state.generatedPlanAuditId = '';
      }
      selectFallbackGeneratedPlan();
    }
    if (state.agentPlan.actionType === 'recurring_payment') {
      state.activeTab = 'schedule';
      state.recurringView = 'active';
    } else {
      state.activeTab = 'inbox';
      state.inboxFilter = 'ready';
    }
    if (response.mode === 'local-bridge') {
      await refreshInboxData();
    } else if (response.mode === 'agentic-cloud') {
      await refreshCloudWorkspaceData();
    }
    pushToast(
      'success',
      state.agentPlan.actionType === 'recurring_payment' ? 'Repeat payment created' : 'Sent for approval',
      state.agentPlan.actionType === 'recurring_payment'
        ? response.mode === 'browser-workflow'
          ? 'Created one local approval now. Saved-on-device workflow does not run background repeats after this tab closes.'
          : 'Future payments will appear in Needs Approval.'
        : response.mode === 'agentic-cloud'
          ? 'Saved to Agentic Cloud. No localhost required.'
          : response.mode === 'browser-workflow'
            ? 'Saved on this device.'
            : response.id,
    );
  }, {
    onError: async (message) => {
      if (state.selectedGeneratedPlanId) {
        await updateGeneratedPlan(state.selectedGeneratedPlanId, {
          status: 'failed',
          error: message,
          failureLabel: 'Send failed - try again',
        }).catch(() => undefined);
      }
      pushToast('error', 'Send for approval failed', message);
    },
  });
}

async function runGeneratedPlanAction(planId: string, action: string): Promise<void> {
  const record = generatedPlanById(planId);
  if (!record) return;

  if (action === 'view') {
    state.selectedGeneratedPlanId = planId;
    state.generatedPlanAuditId = planId;
    state.error = '';
    render();
    return;
  }
  if (action === 'reuse' || action === 'make-active') {
    useGeneratedPlanAsStartingPoint(record);
    pushToast('success', 'Starting point loaded', `${record.plan.templateTitle} is ready in Create Plan.`);
    render();
    return;
  }
  if (action === 'archive') {
    await updateGeneratedPlan(planId, { status: 'archived' });
    if (state.generatedPlanAuditId === planId) {
      state.generatedPlanAuditId = '';
    }
    selectFallbackGeneratedPlan();
    pushToast('success', 'Plan archived', record.plan.templateTitle);
    render();
    return;
  }
  if (action === 'restore') {
    await updateGeneratedPlan(planId, { status: restoredGeneratedPlanStatus(record) });
    state.selectedGeneratedPlanId = planId;
    pushToast('success', 'Plan restored', record.plan.templateTitle);
    render();
    return;
  }
  if (action === 'delete') {
    if (!window.confirm('Delete this plan permanently?')) return;
    if (record.workflowSource === 'cloud') {
      await cloudRequest(`/api/plans/${encodeURIComponent(planId)}`, { method: 'DELETE' });
    }
    state.generatedPlans = state.generatedPlans.filter((candidate) => candidate.id !== planId);
    if (state.generatedPlanAuditId === planId) {
      state.generatedPlanAuditId = '';
    }
    saveGeneratedPlans();
    selectFallbackGeneratedPlan();
    pushToast('success', 'Plan deleted', record.plan.templateTitle);
    render();
    return;
  }
  if (action === 'sign-proof') {
    await runSignGeneratedPlan(planId);
    return;
  }
  if (action === 'queue') {
    await runQueueGeneratedPlan(planId);
  }
}

async function runDeleteCompletedPlan(completedId: string): Promise<void> {
  const record = completedPlanRecords().find((candidate) => candidate.id === completedId);
  if (!record) return;
  if (!window.confirm('Delete this item from Done?')) return;

  await run('inbox', async () => {
    if (
      record.workflowSource === 'cloud' &&
      record.kind === 'recurring' &&
      record.recurringId &&
      record.id.startsWith('recurring:')
    ) {
      await cloudDeleteRecurring(record.recurringId);
      state.cloudCompletedPlans = state.cloudCompletedPlans.filter((candidate) => candidate.id !== record.id);
      await refreshCloudWorkspaceData().catch(() => undefined);
      pushToast('success', 'Done item deleted', record.title);
      return;
    }
    if (record.workflowSource === 'cloud') {
      await cloudRequest(`/api/completed/${encodeURIComponent(record.id)}`, { method: 'DELETE' });
      state.cloudCompletedPlans = state.cloudCompletedPlans.filter((candidate) => candidate.id !== record.id);
      await refreshCloudWorkspaceData().catch(() => undefined);
      pushToast('success', 'Done item deleted', record.title);
      return;
    }
    if (record.actionId) {
      if (isBrowserWorkflowId(record.actionId)) {
        state.preparedActions = state.preparedActions.filter((candidate) => candidate.id !== record.actionId);
        state.materializedActions = state.preparedActions;
        state.receipts = state.receipts.filter((receipt) => receipt.actionId !== record.actionId);
        saveBrowserWorkflowState();
      } else {
      if (!state.bridgeActive) {
        throw new Error('Connect the local bridge before deleting bridge-backed done work.');
      }
      await bridgeRequest('/bridge/prepared-actions/delete', {
        method: 'POST',
        body: JSON.stringify({ actionId: record.actionId }),
      });
      }
    }
    if (completedPlanIsEndedSchedule(record) && record.recurringId) {
      if (record.workflowSource === 'browser' || isBrowserWorkflowId(record.recurringId)) {
        state.recurringPayments = state.recurringPayments.filter((candidate) => candidate.id !== record.recurringId);
        saveBrowserWorkflowState();
      } else {
      if (!state.bridgeActive) {
        throw new Error('Connect the local bridge before deleting repeat payment history.');
      }
      await bridgeRequest('/bridge/recurring-payments/delete', {
        method: 'POST',
        body: JSON.stringify({ recurringId: record.recurringId }),
      });
      }
    }
    if (record.generatedPlanId) {
      state.generatedPlans = state.generatedPlans.filter((candidate) => candidate.id !== record.generatedPlanId);
      if (state.selectedGeneratedPlanId === record.generatedPlanId) {
        selectFallbackGeneratedPlan();
      }
      if (state.generatedPlanAuditId === record.generatedPlanId) {
        state.generatedPlanAuditId = '';
      }
      saveGeneratedPlans();
    }
    if (state.bridgeActive && (record.actionId || completedPlanIsEndedSchedule(record))) {
      await refreshInboxData();
    }
    pushToast('success', 'Done item deleted', record.title);
  });
}

async function runSignGeneratedPlan(planId: string): Promise<void> {
  await run('sign', async () => {
    const record = requireGeneratedPlanRecord(planId);
    if (record.status === 'archived') {
      throw new Error('Restore this plan before signing a review proof.');
    }
    const signature = await signAgentPlanProof(record.plan, 'Plan review proof');
    await updateGeneratedPlan(planId, { signature, status: 'signed', error: undefined, failureLabel: undefined });
    if (state.generatedPlanAuditId === planId) {
      state.generatedPlanAuditId = '';
    }
    selectFallbackGeneratedPlan();
    if (state.agentPlan && samePlan(state.agentPlan, record.plan)) {
      state.agentSignature = signature;
    }
    pushToast('success', 'Plan completed', 'Review proof saved in Done.');
  }, {
    onError: async (message) => {
      await updateGeneratedPlan(planId, {
        status: 'failed',
        error: message,
        failureLabel: 'Sign failed - try again',
      });
      pushToast('error', 'Sign proof failed', message);
    },
  });
}

async function runQueueGeneratedPlan(planId: string): Promise<void> {
  await run('inbox', async () => {
    const record = requireGeneratedPlanRecord(planId);
    if (record.status === 'archived') {
      throw new Error('Restore this plan before sending it for approval.');
    }
    assertPlanCanQueue(record.plan);
    const response = await queuePlanThroughActiveWorkflow(record.plan, record);
    if (response.mode === 'agentic-cloud' && response.planRecordId) {
      state.selectedGeneratedPlanId = response.planRecordId;
    } else {
      await updateGeneratedPlan(planId, { preparedActionId: response.id, status: 'queued', error: undefined, failureLabel: undefined });
    }
    if (state.generatedPlanAuditId === planId || (response.planRecordId && state.generatedPlanAuditId === response.planRecordId)) {
      state.generatedPlanAuditId = '';
    }
    selectFallbackGeneratedPlan();
    if (state.agentPlan && samePlan(state.agentPlan, record.plan)) {
      state.agentPreparedActionId = response.id;
    }
    if (record.plan.actionType === 'recurring_payment') {
      state.activeTab = 'schedule';
      state.recurringView = 'active';
    } else {
      state.activeTab = 'inbox';
      state.inboxFilter = 'ready';
    }
    if (response.mode === 'local-bridge') {
      await refreshInboxData();
    } else if (response.mode === 'agentic-cloud') {
      await refreshCloudWorkspaceData();
    }
    pushToast(
      'success',
      record.plan.actionType === 'recurring_payment' ? 'Repeat payment created' : 'Sent for approval',
      record.plan.actionType === 'recurring_payment'
        ? response.mode === 'browser-workflow'
          ? 'Created one local approval now. Saved-on-device workflow does not run background repeats after this tab closes.'
          : 'Future payments will appear in Needs Approval.'
        : response.mode === 'agentic-cloud'
          ? 'Saved to Agentic Cloud. No localhost required.'
          : response.mode === 'browser-workflow'
            ? 'Saved on this device.'
            : response.id,
    );
  }, {
    onError: async (message) => {
      await updateGeneratedPlan(planId, {
        status: 'failed',
        error: message,
        failureLabel: 'Send failed - try again',
      });
      pushToast('error', 'Send for approval failed', message);
    },
  });
}

async function saveGeneratedPlan(plan: AgentPlan, template: AgentPlanTemplate, prompt: string): Promise<GeneratedPlanRecord> {
  if (activeWorkflowMode() === 'agentic-cloud' && plan.actionType !== 'recurring_payment') {
    const cloudPlan = parseCloudPlanResponse(await cloudRequest('/api/plans', {
      method: 'POST',
      body: JSON.stringify({
        plan,
        source: plan.source,
        templateId: template.id,
        templateTitle: template.title,
        prompt,
        cluster: state.cluster,
        status: 'draft',
      }),
    }));
    const record = cloudPlanToGeneratedPlan(cloudPlan);
    if (!record) {
      throw new Error('Agentic Cloud did not return a valid plan draft.');
    }
    state.generatedPlans = mergeGeneratedPlans([record], state.generatedPlans.filter((candidate) => candidate.id !== record.id));
    return record;
  }
  const now = new Date().toISOString();
  const record: GeneratedPlanRecord = {
    id: newId('plan'),
    plan,
    createdAt: now,
    updatedAt: now,
    source: plan.source,
    templateId: template.id,
    templateTitle: template.title,
    prompt,
    walletAddress: state.address,
    cluster: state.cluster,
    status: 'draft',
    workflowSource: activeWorkflowMode() === 'local-bridge' ? 'local-bridge' : 'browser',
  };
  state.generatedPlans = mergeGeneratedPlans([record], state.generatedPlans);
  saveGeneratedPlans();
  return record;
}

async function updateGeneratedPlan(
  planId: string,
  patch: Partial<Pick<GeneratedPlanRecord, 'status' | 'signature' | 'preparedActionId' | 'error' | 'failureLabel'>>,
): Promise<void> {
  const existing = generatedPlanById(planId);
  if (existing?.workflowSource === 'cloud' && patch.error === undefined && patch.failureLabel === undefined && patch.status !== 'failed') {
    const cloudPlan = parseCloudPlanResponse(await cloudRequest(`/api/plans/${encodeURIComponent(planId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.signature !== undefined && { signature: patch.signature }),
        ...(patch.preparedActionId !== undefined && { approvalRequestId: patch.preparedActionId }),
      }),
    }));
    const record = cloudPlanToGeneratedPlan(cloudPlan);
    if (!record) {
      throw new Error('Agentic Cloud did not return a valid plan update.');
    }
    state.generatedPlans = mergeGeneratedPlans([record], state.generatedPlans.filter((candidate) => candidate.id !== planId));
    return;
  }
  const updatedAt = new Date().toISOString();
  state.generatedPlans = state.generatedPlans.map((record) => {
    if (record.id !== planId) return record;
    return {
      ...record,
      ...patch,
      updatedAt,
    };
  });
  saveGeneratedPlans();
}

async function updateActiveGeneratedPlanRecord(
  patch: Partial<Pick<GeneratedPlanRecord, 'status' | 'signature' | 'preparedActionId' | 'error' | 'failureLabel'>>,
): Promise<void> {
  if (!state.agentPlan) return;
  const record = generatedPlanById(state.selectedGeneratedPlanId);
  if (record && samePlan(record.plan, state.agentPlan)) {
    await updateGeneratedPlan(record.id, patch);
  }
}

function makeGeneratedPlanActive(record: GeneratedPlanRecord): void {
  state.agentPlan = record.plan;
  state.agentSignature = record.signature ?? '';
  state.agentPreparedActionId = record.preparedActionId ?? '';
  state.selectedGeneratedPlanId = record.id;
  state.generatedPlanAuditId = '';
  state.activeTab = 'agent';
  state.oneTimePlanView = 'review';
  state.error = '';
}

function useGeneratedPlanAsStartingPoint(record: GeneratedPlanRecord): void {
  const template = templateById(record.templateId);
  state.selectedTemplateId = template.id;
  state.templateOutcomeFilter = templateOutcome(template);
  state.templateFields = {
    ...defaultTemplateFieldValues(template),
    ...record.plan.parameters,
  };
  state.templateFieldErrors = {};
  state.agentPrompt = record.plan.userNotes || record.prompt || template.description;
  state.agentPlan = null;
  state.agentSignature = '';
  state.agentPreparedActionId = '';
  state.selectedGeneratedPlanId = record.id;
  state.generatedPlanAuditId = '';
  state.activeTab = 'agent';
  state.oneTimePlanView = 'create';
  state.error = '';
}

function openDcaReviewProofTemplate(): void {
  const template = templateById('dca');
  state.selectedTemplateId = template.id;
  state.templateOutcomeFilter = templateOutcome(template);
  state.templateFields = {
    ...defaultTemplateFieldValues(template),
    token: state.recurringDraft.token || defaultTemplateFieldValues(template).token || '',
    amount: state.recurringDraft.amount || defaultTemplateFieldValues(template).amount || '',
    recipient: state.recurringDraft.recipient || '',
    cadence: state.recurringDraft.cadence || defaultTemplateFieldValues(template).cadence || 'weekly',
    memo: state.recurringDraft.note || defaultTemplateFieldValues(template).memo || 'Repeat DCA approval',
  };
  state.templateFieldErrors = {};
  state.agentPrompt = 'Create a review proof for this recurring DCA strategy before any active schedule is created.';
  state.agentPlan = null;
  state.agentSignature = '';
  state.agentPreparedActionId = '';
  state.activeTab = 'agent';
  state.oneTimePlanView = 'create';
  state.error = '';
  pushToast(
    'success',
    'DCA review proof selected',
    'This creates evidence only. Active repeat payments use the selected workflow and each run still returns to Needs Approval.',
  );
  render();
}

function generatedPlansForPanel(oneTimeOnly = false): GeneratedPlanRecord[] {
  const mode = activeWorkflowMode();
  const scoped = mode === 'agentic-cloud'
    ? state.generatedPlans.filter((record) => record.workflowSource === 'cloud')
    : mode === 'local-bridge'
      ? state.generatedPlans.filter((record) => record.workflowSource === 'local-bridge')
      : state.generatedPlans.filter((record) => record.workflowSource === 'browser' || !record.workflowSource);
  return oneTimeOnly ? scoped.filter(isOneTimeGeneratedPlan) : scoped;
}

function isOneTimeGeneratedPlan(record: GeneratedPlanRecord): boolean {
  return record.plan.actionType !== 'recurring_payment';
}

function visibleGeneratedPlans(oneTimeOnly = false): GeneratedPlanRecord[] {
  const records = generatedPlansForPanel(oneTimeOnly);
  return records.filter(isGeneratedPlanVisibleInReview);
}

function isGeneratedPlanVisibleInReview(record: GeneratedPlanRecord): boolean {
  if (record.status === 'archived') return state.showArchivedGeneratedPlans;
  return isGeneratedPlanActiveInReview(record);
}

function isGeneratedPlanActiveInReview(record: GeneratedPlanRecord): boolean {
  return record.status !== 'archived' && !hasGeneratedPlanMovedPastReview(record);
}

function hasGeneratedPlanMovedPastReview(record: GeneratedPlanRecord): boolean {
  return Boolean(record.signature || record.preparedActionId || record.status === 'signed' || record.status === 'queued');
}

function completedPlanRecords(): CompletedPlanRecord[] {
  const mode = activeWorkflowMode();
  const includeBrowserHistory = mode === 'browser-workflow' || mode === 'agentic-cloud';
  const historyActions = includeBrowserHistory
    ? state.preparedActions.filter((action) => isBrowserWorkflowId(action.id))
    : state.preparedActions.filter((action) => action.workflowSource === 'local-bridge');
  const historyReceipts = includeBrowserHistory
    ? state.receipts.filter((receipt) => isBrowserWorkflowId(receipt.actionId))
    : state.receipts.filter((receipt) => !isBrowserWorkflowId(receipt.actionId));
  const historyPlans = includeBrowserHistory
    ? state.generatedPlans.filter((record) => record.workflowSource === 'browser' || !record.workflowSource)
    : state.generatedPlans.filter((record) => record.workflowSource === 'local-bridge');
  const receiptsByActionId = new Map(historyReceipts.map((receipt) => [receipt.actionId, receipt]));
  const actionsById = new Map(historyActions.map((action) => [action.id, action]));
  const usedActionIds = new Set<string>();
  const records: CompletedPlanRecord[] = mode === 'agentic-cloud' ? [...state.cloudCompletedPlans] : [];

  for (const record of historyPlans.filter(isOneTimeGeneratedPlan)) {
    const action = record.preparedActionId ? actionsById.get(record.preparedActionId) : undefined;
    const receipt = record.preparedActionId ? receiptsByActionId.get(record.preparedActionId) : undefined;
    const hasTerminalAction = Boolean(action && isTerminalPreparedAction(action));
    const hasPendingWalletAction = Boolean(record.preparedActionId && !receipt && !hasTerminalAction);
    const isComplete = Boolean(receipt || hasTerminalAction || (record.signature && !hasPendingWalletAction));
    if (!isComplete) continue;
    records.push(completedPlanFromGeneratedPlan(record, receipt, action));
    if (record.preparedActionId) usedActionIds.add(record.preparedActionId);
  }

  for (const receipt of historyReceipts) {
    if (usedActionIds.has(receipt.actionId)) continue;
    records.push(completedPlanFromReceipt(receipt, actionsById.get(receipt.actionId)));
    usedActionIds.add(receipt.actionId);
  }

  for (const action of historyActions) {
    if (usedActionIds.has(action.id) || !isTerminalPreparedAction(action)) continue;
    records.push(completedPlanFromAction(action));
    usedActionIds.add(action.id);
  }

  const historyRecurring = activeWorkflowRecurringPayments();
  for (const payment of historyRecurring.filter(isRecurringPaymentCompleted)) {
    records.push(completedPlanFromEndedRecurring(payment));
  }

  return records.sort((left, right) => right.completedAt.localeCompare(left.completedAt));
}

function showCompletedHistoryForAction(actionId?: string): void {
  const records = completedPlanRecords();
  const focused = actionId
    ? records.find((record) => record.actionId === actionId || record.id.includes(actionId))
    : records[0];
  state.activeTab = 'completed';
  state.completedPlanFilter = 'receipts';
  state.lastCompletedFocusId = focused?.id ?? actionId ?? records[0]?.id ?? '';
}

function filteredCompletedPlans(records = completedPlanRecords()): CompletedPlanRecord[] {
  switch (state.completedPlanFilter) {
    case 'one-time':
      return records.filter((record) => record.kind === 'one-time');
    case 'recurring':
      return records.filter((record) => record.kind === 'recurring');
    case 'proofs':
      return records.filter((record) => Boolean(record.signature));
    case 'receipts':
      return records.filter((record) => Boolean(record.actionId || record.txid));
    case 'all':
      return records;
  }
}

function completedPlanFromGeneratedPlan(
  record: GeneratedPlanRecord,
  receipt: ActionReceipt | undefined,
  action: PreparedAction | undefined,
): CompletedPlanRecord {
  const terminalStatus = receipt?.status ?? (action && isTerminalPreparedAction(action) ? action.status : undefined);
  const txStatus = receipt?.txStatus ?? action?.txStatus;
  const txid = receipt?.txid ?? action?.txid;
  const actionId = receipt?.actionId ?? action?.id ?? record.preparedActionId;
  const status = terminalStatus
    ? completedActionStatusLabel(terminalStatus, txStatus)
    : record.status === 'archived'
      ? 'archived'
      : 'proof signed';
  const completedAt = receipt?.completedAt ?? actionCompletedAt(action) ?? record.updatedAt;
  const amount = receipt?.amount ?? (action ? amountLabel(action) : planParameter(record.plan, ['amountSol', 'amount', 'inputAmount', 'plannedAmount']));
  const token = receipt?.token ?? (action ? tokenLabel(action) : planParameter(record.plan, ['token', 'inputToken', 'outputToken']));
  const recipient = receipt?.recipient ?? (action ? recipientParam(action) : planParameter(record.plan, ['recipient', 'recipientAddress']));
  const workflowSource = record.workflowSource ?? action?.workflowSource ?? (actionId && isBrowserWorkflowId(actionId) ? 'browser' : undefined);
  const payload = {
    type: 'completed_one_time_plan',
    status,
    plan: record.plan,
    signature: record.signature,
    actionId: receipt?.actionId ?? action?.id ?? record.preparedActionId,
    txid: receipt?.txid ?? action?.txid,
    completedAt,
  };
  return {
    id: `generated:${record.id}`,
    kind: 'one-time',
    status,
    tone: terminalStatus ? completedActionTone(terminalStatus, txStatus) : record.status === 'archived' ? 'neutral' : 'tx-confirmed',
    title: record.plan.intent,
    summary: record.plan.risk,
    completedAt,
    createdAt: record.createdAt,
    walletAddress: receipt?.walletAddress ?? action?.walletAddress ?? record.walletAddress,
    cluster: receipt?.cluster ?? action?.cluster ?? record.cluster,
    ...(amount && { amount }),
    ...(token && { token }),
    ...(recipient && { recipient }),
    ...(record.signature && { signature: record.signature }),
    ...(txid ? { txid } : {}),
    ...(receipt?.explorerUrl && { explorerUrl: receipt.explorerUrl }),
    generatedPlanId: record.id,
    ...(actionId ? { actionId } : {}),
    ...(workflowSource ? { workflowSource } : {}),
    copyPayload: stableJson(payload),
    detailRows: completedRows([
      ['Type', 'One-time plan'],
      ['Status', status],
      ['Template', record.templateTitle],
      ['Action', record.plan.actionType.replace(/_/g, ' ')],
      ['Source', planSourceLabel(record.plan)],
      ['Wallet', (receipt?.walletAddress ?? action?.walletAddress ?? record.walletAddress) || 'No wallet at creation'],
      ['Created', formatDateTime(record.createdAt)],
      ['Completed', formatDateTime(completedAt)],
      actionId ? ['Approval id', actionId] : undefined,
      record.signature ? ['Review proof', record.signature] : undefined,
      txid ? ['Transaction', txid] : undefined,
      ['Approval rule', record.plan.approval],
      ['Route', record.plan.route],
    ]),
  };
}

function completedPlanFromReceipt(receipt: ActionReceipt, action: PreparedAction | undefined): CompletedPlanRecord {
  const kind: CompletedPlanRecord['kind'] = receipt.recurringId || action?.recurringId ? 'recurring' : 'one-time';
  const status = completedActionStatusLabel(receipt.status, receipt.txStatus);
  const recurringId = receipt.recurringId ?? action?.recurringId;
  const occurrenceKey = receipt.occurrenceKey ?? action?.occurrenceKey;
  const workflowSource = action?.workflowSource ?? (isBrowserWorkflowId(receipt.actionId) ? 'browser' : undefined);
  const payload = {
    type: kind === 'recurring' ? 'completed_recurring_occurrence' : 'completed_one_time_approval',
    receipt,
    action,
  };
  return {
    id: `receipt:${receipt.actionId}`,
    kind,
    status,
    tone: completedActionTone(receipt.status, receipt.txStatus),
    title: receipt.summary,
    summary: receipt.note ?? receipt.summary,
    completedAt: receipt.completedAt,
    createdAt: receipt.createdAt,
    walletAddress: receipt.walletAddress,
    cluster: receipt.cluster,
    ...(receipt.amount && { amount: receipt.amount }),
    ...(receipt.token && { token: receipt.token }),
    ...(receipt.recipient && { recipient: receipt.recipient }),
    ...(receipt.txid && { txid: receipt.txid }),
    ...(receipt.explorerUrl && { explorerUrl: receipt.explorerUrl }),
    ...(receipt.proofSignature && { signature: receipt.proofSignature }),
    actionId: receipt.actionId,
    ...(recurringId ? { recurringId } : {}),
    ...(occurrenceKey ? { occurrenceKey } : {}),
    ...(workflowSource ? { workflowSource } : {}),
    copyPayload: stableJson(payload),
    detailRows: completedRows([
      ['Type', kind === 'recurring' ? 'Repeat payment' : 'One-time approval'],
      ['Status', status],
      ['Action id', receipt.actionId],
      recurringId ? ['Repeat id', recurringId] : undefined,
      occurrenceKey ? ['Occurrence', occurrenceKey] : undefined,
      ['Wallet', receipt.walletAddress],
      receipt.recipient ? ['Recipient', receipt.recipient] : undefined,
      receipt.amount ? ['Amount', `${receipt.amount} ${receipt.token ?? ''}`.trim()] : undefined,
      ['Created', formatDateTime(receipt.createdAt)],
      ['Completed', formatDateTime(receipt.completedAt)],
      receipt.proofSignature ? ['Decision proof', receipt.proofSignature] : undefined,
      receipt.txid ? ['Transaction', receipt.txid] : undefined,
      receipt.error ? ['Error', receipt.error] : undefined,
    ]),
  };
}

function completedPlanFromAction(action: PreparedAction): CompletedPlanRecord {
  const kind: CompletedPlanRecord['kind'] = action.recurringId ? 'recurring' : 'one-time';
  const status = action.archived ? 'cancelled' : completedActionStatusLabel(action.status, action.txStatus);
  const completedAt = actionCompletedAt(action) ?? action.updatedAt;
  const recipient = recipientParam(action);
  const amount = amountLabel(action);
  const token = tokenLabel(action);
  return {
    id: `action:${action.id}`,
    kind,
    status,
    tone: action.archived ? 'neutral' : completedActionTone(action.status, action.txStatus),
    title: action.summary,
    summary: action.note ?? action.summary,
    completedAt,
    createdAt: action.createdAt,
    walletAddress: action.walletAddress,
    cluster: action.cluster,
    ...(amount !== 'n/a' && { amount }),
    ...(token !== 'n/a' && { token }),
    ...(recipient && { recipient }),
    ...(action.txid && { txid: action.txid }),
    actionId: action.id,
    ...(action.recurringId && { recurringId: action.recurringId }),
    ...(action.occurrenceKey && { occurrenceKey: action.occurrenceKey }),
    ...(action.workflowSource ? { workflowSource: action.workflowSource } : {}),
    copyPayload: stableJson({ type: kind === 'recurring' ? 'completed_recurring_occurrence' : 'completed_one_time_approval', action }),
    detailRows: completedRows([
      ['Type', kind === 'recurring' ? 'Repeat payment' : 'One-time approval'],
      ['Status', status],
      ['Action id', action.id],
      action.recurringId ? ['Repeat id', action.recurringId] : undefined,
      action.occurrenceKey ? ['Occurrence', action.occurrenceKey] : undefined,
      ['Wallet', action.walletAddress],
      recipient ? ['Recipient', recipient] : undefined,
      amount !== 'n/a' ? ['Amount', `${amount} ${token !== 'n/a' ? token : ''}`.trim()] : undefined,
      ['Created', formatDateTime(action.createdAt)],
      ['Completed', formatDateTime(completedAt)],
      action.txid ? ['Transaction', action.txid] : undefined,
      action.error ? ['Error', action.error] : undefined,
    ]),
  };
}

function completedPlanFromEndedRecurring(payment: RecurringPayment): CompletedPlanRecord {
  const occurrenceCount = payment.occurrencesCreated ?? 0;
  const max = payment.maxOccurrences ?? occurrenceCount;
  const title = `${payment.amount} ${payment.token} repeat payment completed`;
  return {
    id: `recurring-schedule:${payment.id}`,
    kind: 'recurring',
    status: 'schedule complete',
    tone: 'tx-confirmed',
    title,
    summary: `Reached ${occurrenceCount} of ${max} scheduled occurrence${max === 1 ? '' : 's'}.`,
    completedAt: payment.updatedAt,
    createdAt: payment.createdAt,
    walletAddress: payment.walletAddress,
    cluster: payment.cluster,
    amount: payment.amount,
    token: payment.token,
    recipient: payment.recipient,
    recurringId: payment.id,
    workflowSource: recurringPaymentWorkflowSource(payment),
    copyPayload: stableJson({ type: 'completed_recurring_schedule', recurringPayment: payment }),
    detailRows: completedRows([
      ['Type', 'Repeat payment'],
      ['Status', 'schedule complete'],
      ['Repeat id', payment.id],
      ['Wallet', payment.walletAddress],
      ['Recipient', payment.recipient],
      ['Amount', `${payment.amount} ${payment.token}`],
      ['Cadence', payment.cadence],
      ['Schedule', scheduleLabel(payment)],
      ['Occurrences', `${occurrenceCount} of ${max}`],
      ['Created', formatDateTime(payment.createdAt)],
      ['Completed', formatDateTime(payment.updatedAt)],
      payment.note ? ['Note', payment.note] : undefined,
    ]),
  };
}

function completedRows(rows: Array<[string, string] | undefined>): Array<[string, string]> {
  return rows.filter((row): row is [string, string] => Boolean(row && row[1]));
}

function isTerminalPreparedAction(action: PreparedAction): boolean {
  return Boolean(action.archived) || isTerminalPreparedActionStatus(action.status);
}

function isTerminalPreparedActionStatus(status: PreparedActionStatus): boolean {
  return (
    status === 'approved' ||
    status === 'rejected' ||
    status === 'cancelled' ||
    status === 'blocked' ||
    status === 'failed' ||
    status === 'expired'
  );
}

function actionCompletedAt(action: PreparedAction | undefined): string | undefined {
  if (!action || !isTerminalPreparedAction(action)) return undefined;
  if (action.archived) return action.updatedAt;
  return action.confirmedAt ?? action.updatedAt;
}

function completedActionStatusLabel(status: PreparedActionStatus, txStatus?: PreparedActionTxStatus): string {
  if (txStatus === 'confirmed') return 'approved';
  if (txStatus === 'failed') return 'failed';
  return status;
}

function completedActionTone(status: PreparedActionStatus, txStatus?: PreparedActionTxStatus): string {
  if (
    txStatus === 'failed' ||
    status === 'failed' ||
    status === 'blocked' ||
    status === 'rejected' ||
    status === 'cancelled' ||
    status === 'expired'
  ) return 'tx-failed';
  if (status === 'approved' || txStatus === 'confirmed') return 'tx-confirmed';
  return 'neutral';
}

function isRecurringPaymentCompleted(payment: RecurringPayment): boolean {
  return payment.maxOccurrences !== undefined && (payment.occurrencesCreated ?? 0) >= payment.maxOccurrences;
}

function completedPlanIsEndedSchedule(plan: CompletedPlanRecord): boolean {
  return plan.id.startsWith('recurring-schedule:');
}

function planParameter(plan: AgentPlan, keys: string[]): string {
  for (const key of keys) {
    const value = plan.parameters[key];
    if (value?.trim()) return value;
  }
  return '';
}

function selectedGeneratedPlan(): GeneratedPlanRecord | undefined {
  const selected = generatedPlanById(state.selectedGeneratedPlanId);
  if (!selected) return undefined;
  if (!state.showArchivedGeneratedPlans && selected.status === 'archived') return undefined;
  return selected;
}

function generatedPlanById(planId: string): GeneratedPlanRecord | undefined {
  return state.generatedPlans.find((record) => record.id === planId);
}

function requireGeneratedPlanRecord(planId: string): GeneratedPlanRecord {
  const record = generatedPlanById(planId);
  if (!record) {
    throw new Error('Plan was not found.');
  }
  return record;
}

function selectFallbackGeneratedPlan(): void {
  const next = visibleGeneratedPlans()[0] ?? state.generatedPlans[0];
  state.selectedGeneratedPlanId = next?.id ?? '';
  if (state.generatedPlanAuditId && !generatedPlanById(state.generatedPlanAuditId)) {
    state.generatedPlanAuditId = '';
  }
}

function closeGeneratedPlanAuditModal(): void {
  state.generatedPlanAuditId = '';
  render();
}

function restoredGeneratedPlanStatus(record: GeneratedPlanRecord): GeneratedPlanStatus {
  if (record.preparedActionId) return 'queued';
  if (record.signature) return 'signed';
  return 'draft';
}

function generatedPlanStatusLabel(record: GeneratedPlanRecord): string {
  if (record.status === 'archived') return 'archived';
  if (record.preparedActionId || record.status === 'queued') return 'queued';
  if (record.signature || record.status === 'signed') return 'proof signed';
  return 'needs check';
}

function generatedPlanStatusTone(record: GeneratedPlanRecord): string {
  if (record.status === 'archived') return 'neutral';
  if (record.status === 'failed') return 'needs-review';
  if (record.preparedActionId || record.status === 'queued') return 'tx-pending';
  if (record.signature || record.status === 'signed') return 'tx-confirmed';
  return 'needs-review';
}

function signedGeneratedPlanCount(): number {
  return state.generatedPlans.filter((record) => Boolean(record.signature)).length;
}

function generatedPlanMeta(record: GeneratedPlanRecord): string {
  const wallet = record.walletAddress ? short(record.walletAddress) : 'No wallet at creation';
  return `${formatDateTime(record.createdAt)} · ${titleCaseCluster(record.cluster)} · ${wallet}`;
}

function signProofTitle(record: GeneratedPlanRecord): string {
  if (record.status === 'archived') return 'Restore this plan before signing review evidence.';
  if (!state.address) return 'Connect a wallet before signing a review proof.';
  return record.signature
    ? 'Sign a fresh review proof. This does not queue, approve, or submit a transaction.'
    : 'Sign that you reviewed this plan. This creates audit evidence only.';
}

function generatedQueuePlanTitle(record: GeneratedPlanRecord): string {
  if (record.status === 'archived') return 'Restore this plan before sending it for approval.';
  if (!state.address) return 'Connect a wallet before sending for approval.';
  if (!canQueueAgentPlan(record.plan)) return 'Only transfers, swaps, and repeat payments can be queued.';
  const report = planGuardrailReport(record.plan);
  if (report?.verdict === 'block') return report.summary;
  const mode = activeWorkflowMode();
  if (record.plan.actionType === 'recurring_payment') {
    if (mode === 'agentic-cloud') return 'Create an Agentic Cloud repeat payment. Each due payment appears in Needs Approval.';
    return mode === 'local-bridge'
      ? 'Create a local repeat payment. Each due payment appears in Needs Approval.'
      : 'Create one browser-local repeat approval now. Background repeats need Agentic Cloud or Private local mode.';
  }
  if (mode === 'agentic-cloud') return 'Send this plan to Agentic Cloud Needs Approval for wallet review.';
  return mode === 'local-bridge'
    ? 'Send this plan to local Needs Approval for wallet review.'
    : 'Send this plan to browser Needs Approval. It stays local to this device.';
}

function samePlan(left: AgentPlan, right: AgentPlan): boolean {
  return stableJson(left) === stableJson(right);
}

async function signAgentPlanProof(plan: AgentPlan, summary: string): Promise<string> {
  const signingClient = requireClient();
  const result = await signingClient.signMessage(agentPlanApprovalMessage(plan), signOptions(summary));
  return result.signature;
}

function agentPlanApprovalMessage(plan: AgentPlan): string {
  return [
    'Solana Agent Wallet Adapter plan review proof',
    `Address: ${state.address}`,
    `Cluster: ${state.cluster}`,
    `Source: ${plan.source}`,
    `Template: ${plan.templateTitle}`,
    `Action: ${plan.actionType}`,
    `Prepared by: ${planPreparedBy(plan)}`,
    `Intent: ${plan.intent}`,
    `Route: ${plan.route}`,
    `Risk: ${plan.risk}`,
    `Approval: ${plan.approval}`,
    `Parameters: ${stableJson(plan.parameters)}`,
    `User notes: ${plan.userNotes || 'None'}`,
    `Safeguards: ${plan.safeguards.join(' | ')}`,
    `Time: ${new Date().toISOString()}`,
  ].join('\n');
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
    await refreshBridgeAiStatus(true);
    resetAiPlannerConfirmation('Bridge key changed. Confirm planner again if needed.');
    const connected = await ensureBridgeConnectedAfterLocalCall();
    pushToast(
      'success',
      'Bridge AI key set',
      connected
        ? 'The key is held in local bridge memory and the approval bridge is connected.'
        : 'The key is held in local bridge memory. Connect a wallet, then check the local bridge.',
    );
  }, {
    async onError(message) {
      state.error = '';
      if (isBridgeOfflineMessage(message)) {
        await showBridgeOfflineToast('AI bridge offline');
        return;
      }
      pushToast('error', 'AI setup failed', message);
    },
  });
}

async function runSaveDirectAiKey(): Promise<void> {
  if (!canSaveDirectAiKey()) {
    pushToast('error', 'AI setup incomplete', aiGenerateDisabledReason());
    render();
    return;
  }
  await run('ai', async () => {
    resetAiPlannerConfirmation('AI draft key saved. Confirm planner before generating if you want a route or config check.');
    appendAiDiagnostic(aiRouteDiagnostic('/api/ai/generate-plan'));
    pushToast(
      'success',
      state.aiSettings.mode === 'hosted'
        ? 'Hosted BYOK key entered'
        : IS_ANDROID_APP
          ? 'Android session key entered'
          : 'Browser session key entered',
      state.aiSettings.mode === 'hosted'
        ? 'Hosted BYOK will relay only submitted AI draft requests. Queueing, schedules, and signing stay in the active workflow.'
        : `${IS_ANDROID_APP ? 'Android session' : 'Browser session'} AI can draft plans in ${IS_ANDROID_APP ? 'this app runtime' : 'this tab'}. Queueing, schedules, and signing stay in the active workflow.`,
    );
  });
}

async function runConfirmAiPlanner(): Promise<void> {
  if (!canConfirmAiPlanner()) {
    const message = aiConfirmDisabledReason();
    setAiPlannerConfirmation('failed', message);
    pushToast('error', 'Planner check unavailable', message);
    render();
    return;
  }

  state.activeOperation = 'confirm-ai-planner';
  const toastId = pushToast('pending', 'Confirming planner', 'Checking the selected AI draft route.');
  try {
    await run('ai', async () => {
      if (state.aiSettings.mode === 'bridge') {
        state.aiDiagnostics = [aiRouteDiagnostic('/bridge/ai/status', 'GET')];
        await refreshBridgeAiStatus(true);
        if (!state.aiStatus?.available) {
          throw new Error('Local bridge AI is not configured. Set a bridge key or AGENTIC_AI_API_KEY, then confirm again.');
        }
        const detail = `${state.aiStatus.source} - ${state.aiStatus.provider ?? state.aiStatus.apiFormat ?? 'AI'} - ${state.aiStatus.model ?? 'model configured'}`;
        state.aiDiagnostics = [
          aiRouteDiagnostic('/bridge/ai/status', 'GET'),
          {
            code: 'AI_PLAN_READY',
            message: 'Local bridge AI planner confirmed. No plan was generated.',
            detail,
            method: 'GET',
            path: '/bridge/ai/status',
          },
        ];
        setAiPlannerConfirmation('confirmed', 'Local bridge AI is configured and reachable for drafts only. Workflow capability is unchanged.');
        replaceToast(toastId, 'success', 'Planner confirmed', 'Local bridge AI can draft plans only.');
        return;
      }

      if (state.aiSettings.mode === 'hosted') {
        const hostedBlockReason = hostedByokCloudSessionReason();
        if (hostedBlockReason) throw new Error(hostedBlockReason);
        state.aiDiagnostics = await confirmHostedAiPlanner(state.aiSettings);
        setAiPlannerConfirmation('confirmed', 'Hosted BYOK route is reachable for draft requests only. Provider key validity is checked on the first AI draft. Workflow capability is unchanged.');
        replaceToast(toastId, 'success', 'Planner confirmed', 'Hosted BYOK can draft plans only.');
        return;
      }

      if (state.aiSettings.provider === 'openai') {
        throw new Error(OPENAI_BROWSER_SESSION_DISABLED_REASON);
      }
      if (!state.aiSettings.apiKey.trim() || !state.aiSettings.model.trim() || !aiProviderReadyForCurrentMode()) {
        throw new Error(aiConfirmDisabledReason());
      }
      state.aiDiagnostics = [
        aiRouteDiagnostic('browser-session'),
        {
          code: 'AI_PLAN_READY',
          message: 'Browser session planner configuration confirmed. No provider request was made.',
          detail: BROWSER_AI_LIMITATIONS.join(' '),
        },
      ];
      setAiPlannerConfirmation('confirmed', 'Browser session AI config was checked for this tab. No provider request was made; it drafts only and workflow capability is unchanged.');
      replaceToast(toastId, 'success', 'Planner confirmed', 'Browser session AI can draft plans only.');
    }, {
      onError(message, err) {
        const toastMessage = applyAiErrorDiagnostics(err, message);
        setAiPlannerConfirmation('failed', toastMessage);
        replaceToast(toastId, 'error', aiConfirmErrorToastTitle(err), toastMessage);
      },
    });
  } finally {
    state.activeOperation = null;
    render();
  }
}

async function runClearAiKey(): Promise<void> {
  await run('ai', async () => {
    state.aiSettings.apiKey = '';
    resetAiPlannerConfirmation('AI key cleared.');
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
    state.aiSettings.apiKey = '';
    resetAiPlannerConfirmation('Bridge AI status refreshed. Confirm planner again if needed.');
    const connected = await ensureBridgeConnectedAfterLocalCall();
    pushToast(
      'success',
      'AI status refreshed',
      state.aiStatus?.available
        ? connected
          ? 'Bridge AI is available and the approval bridge is connected.'
          : 'Bridge AI is available. Connect a wallet, then check the local bridge.'
        : 'Bridge AI is not configured.',
    );
  }, {
    async onError(message) {
      state.error = '';
      if (isBridgeOfflineMessage(message)) {
        await showBridgeOfflineToast('AI bridge offline');
        return;
      }
      pushToast('error', 'AI status unavailable', message);
    },
  });
}

function aiClearMessage(): string {
  if (state.aiSettings.mode === 'hosted') {
    return 'Hosted BYOK key removed from this browser session.';
  }
  if (state.aiSettings.mode === 'session') {
    return IS_ANDROID_APP
      ? 'Android session key removed from this app.'
      : 'Browser session key removed from this app.';
  }
  return 'Session key removed from this app and local bridge memory.';
}

function aiModeToastMessage(mode: AiSettings['mode']): string {
  if (mode === 'bridge') {
    return 'Local bridge AI can draft plans in private local mode.';
  }
  if (mode === 'hosted') {
    return 'Hosted BYOK drafts plans only. Workflow actions still require explicit wallet review.';
  }
  return IS_ANDROID_APP
    ? 'Android session AI drafts plans only and keeps the key in this app runtime.'
    : 'Browser session AI drafts plans only and keeps the key in this tab.';
}

function setAiPlannerMode(mode: AiSettings['mode']): void {
  if (aiModeDisabledReason(mode)) {
    render();
    return;
  }
  if (state.aiSettings.mode === mode) {
    return;
  }
  state.aiSettings.mode = mode;
  ensureAiProviderAllowedForMode();
  resetAiPlannerConfirmation('AI path changed. Workflow capability is unchanged.');
  savePersistedState();
  pushToast('success', 'AI Planner path changed', aiModeToastMessage(mode));
  render();
}

function activeWorkflowMode(): ActiveWorkflowMode {
  if (state.workflowModePreference === 'local-bridge' && state.bridgeActive) {
    return 'local-bridge';
  }
  if (cloudSessionMatchesWallet()) {
    return 'agentic-cloud';
  }
  return 'browser-workflow';
}

function activeWorkflowLabel(): string {
  switch (activeWorkflowMode()) {
    case 'agentic-cloud':
      return 'Agentic Cloud workspace';
    case 'local-bridge':
      return 'Private local mode';
    case 'browser-workflow':
      return 'Saved on this device';
  }
}

function cloudSessionMatchesWallet(): boolean {
  return Boolean(
    state.address &&
      state.cloudSession.status === 'signed-in' &&
      state.cloudSession.walletAddress === state.address,
  );
}

function cloudSessionWalletMismatch(): boolean {
  return Boolean(
    state.address &&
      state.cloudSession.status === 'signed-in' &&
      state.cloudSession.walletAddress &&
      state.cloudSession.walletAddress !== state.address,
  );
}

function cloudSessionNeedsWalletBoundaryLogout(): boolean {
  return shouldAutoSignOutCloudSession({
    cloudStatus: state.cloudSession.status,
    cloudWalletAddress: state.cloudSession.walletAddress,
    connectedWalletAddress: state.address,
  });
}

async function signOutCloudSession(): Promise<boolean> {
  if (state.cloudSession.status !== 'signed-in' || !state.cloudSession.walletAddress) {
    return false;
  }
  resetCloudWorkspaceState();
  if (activeWorkflowMode() === 'browser-workflow') {
    refreshBrowserWorkflowData();
  }
  await cloudRequest('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
  return true;
}

async function signOutCloudSessionForWalletBoundary(
  reason: CloudSessionLogoutReason,
  options: { toast?: boolean } = {},
): Promise<boolean> {
  if (!cloudSessionNeedsWalletBoundaryLogout()) return false;
  const signedInWallet = state.cloudSession.walletAddress;
  const connectedWallet = state.address;
  const signedOut = await signOutCloudSession();
  if (signedOut && options.toast) {
    pushToast('success', 'Cloud workspace signed out', cloudBoundaryLogoutDetail(reason, signedInWallet, connectedWallet));
  }
  return signedOut;
}

function cloudBoundaryLogoutDetail(
  reason: CloudSessionLogoutReason,
  signedInWallet: string,
  connectedWallet: string,
): string {
  if (reason === 'wallet-mismatch' && connectedWallet) {
    return `Previous cloud workspace ${short(signedInWallet)} signed out. Sign in with ${short(connectedWallet)} to use cloud workflow.`;
  }
  if (reason === 'wallet-changed') {
    return `Cloud workspace ${short(signedInWallet)} signed out because the wallet selection changed.`;
  }
  if (reason === 'startup') {
    return `Cloud workspace ${short(signedInWallet)} signed out because no matching wallet session was restored.`;
  }
  return `Cloud workspace ${short(signedInWallet)} signed out because the wallet disconnected.`;
}

function hostedByokCloudSessionReason(): string {
  return hostedByokCloudSessionBlockReason({
    aiMode: state.aiSettings.mode,
    cloudSessionMatchesWallet: cloudSessionMatchesWallet(),
  });
}

async function afterWalletConnected(): Promise<void> {
  await refreshCloudSession(false);
  if (await signOutCloudSessionForWalletBoundary('wallet-mismatch', { toast: true })) {
    return;
  }
  if (cloudSessionMatchesWallet()) {
    await refreshCloudWorkspaceData().catch((err) => {
      state.cloudSession = {
        ...state.cloudSession,
        error: err instanceof Error ? err.message : String(err),
      };
    });
  } else if (activeWorkflowMode() === 'browser-workflow') {
    refreshBrowserWorkflowData();
  }
}

async function runCloudSignIn(): Promise<void> {
  await run('connect', async () => {
    if (!state.address) {
      throw new Error('Connect a wallet before signing in to Agentic Cloud.');
    }
    const signingClient = requireClient();
    const nonce = parseAuthNonceResponse(await cloudRequest('/api/auth/nonce', {
      method: 'POST',
      body: JSON.stringify({ walletAddress: state.address }),
    }));
    const message = stringPayload(nonce.message, 'Auth message');
    const nonceValue = stringPayload(nonce.nonce, 'Auth nonce');
    const result = await signingClient.signMessage(message, signOptions('Agentic Cloud sign-in'));
    const session = parseSessionResponse(await cloudRequest('/api/auth/verify-wallet', {
      method: 'POST',
      body: JSON.stringify({
        walletAddress: state.address,
        nonce: nonceValue,
        message,
        signature: result.signature,
        domain: stringPayload(nonce.domain, 'Auth domain'),
        issuedAt: stringPayload(nonce.issuedAt, 'Auth issued time'),
        expiresAt: stringPayload(nonce.expiresAt, 'Auth expiration time'),
        signatureEncoding: 'base58',
      }),
    }));
    state.cloudSession = cloudSessionFromResponse(session);
    state.workflowModePreference = 'auto';
    savePersistedState();
    await refreshCloudWorkspaceData();
    pushToast('success', 'Cloud workspace signed in', short(state.address));
  });
}

async function runCloudLogout(): Promise<void> {
  await run('connect', async () => {
    await signOutCloudSession();
    pushToast('success', 'Cloud workspace signed out', 'Saved-on-device workflow is active in this browser.');
  });
}

function openCloudWorkspaceDeleteModal(): void {
  if (!cloudSessionMatchesWallet()) {
    pushToast('error', 'Cloud delete unavailable', 'Connect the signed-in wallet before deleting this cloud workspace.');
    return;
  }
  state.cloudWorkspaceDeleteModalOpen = true;
  render();
}

function closeCloudWorkspaceDeleteModal(): void {
  if (!state.cloudWorkspaceDeleteModalOpen) return;
  state.cloudWorkspaceDeleteModalOpen = false;
  render();
}

async function runConfirmCloudWorkspaceDelete(): Promise<void> {
  state.cloudWorkspaceDeleteModalOpen = false;
  await run('connect', async () => {
    if (!cloudSessionMatchesWallet()) {
      throw new Error('Connect the signed-in wallet before deleting this cloud workspace.');
    }
    const signingClient = requireClient();
    const intent = parseCloudWorkspaceDeleteIntentResponse(await cloudRequest('/api/cloud-workspace/delete-intent', {
      method: 'POST',
      body: JSON.stringify({}),
    }));
    const message = stringPayload(intent.message, 'Cloud deletion message');
    const signature = await signingClient.signMessage(message, signOptions('Delete Agentic Cloud workspace'));
    const result = parseCloudWorkspaceDeleteResponse(await cloudRequest('/api/cloud-workspace/delete', {
      method: 'POST',
      body: JSON.stringify({
        walletAddress: state.address,
        nonce: intent.nonce,
        message,
        signature: signature.signature,
        domain: intent.domain,
        issuedAt: intent.issuedAt,
        expiresAt: intent.expiresAt,
        signatureEncoding: 'base58',
      }),
    }));
    resetCloudWorkspaceState();
    refreshBrowserWorkflowData();
    pushToast(
      'success',
      'Cloud workspace deleted',
      `${cloudDeleteCount(result.deleted)} cloud record${cloudDeleteCount(result.deleted) === 1 ? '' : 's'} removed. Browser storage is still available.`,
    );
  });
}

function resetCloudWorkspaceState(): void {
  state.cloudSession = emptyCloudSession('signed-out');
  state.cloudCompletedPlans = [];
  state.cloudLastSync = '';
  state.cloudEvidenceStatus = 'Cloud evidence archive: sign in to also store receipts in Agentic Cloud.';
  state.cloudEvidenceLastSyncAt = 0;
  state.generatedPlans = state.generatedPlans.filter((plan) => plan.workflowSource !== 'cloud');
  selectFallbackGeneratedPlan();
  state.recurringOccurrenceHistory = {};
  state.recurringNotificationStatus = {};
  state.recurringWebhookSecretOnce = null;
  state.auditActivity = {};
}

async function runSetWorkflowModePreference(preference: WorkflowModePreference): Promise<void> {
  await run('bridge', async () => {
    if (preference === 'local-bridge' && !state.bridgeActive) {
      throw new Error('Connect the local bridge before using private local mode.');
    }
    state.workflowModePreference = preference;
    savePersistedState();
    await refreshActiveWorkflowData();
    pushToast(
      'success',
      preference === 'local-bridge' ? 'Private local mode active' : 'Workspace mode updated',
      `${activeWorkflowLabel()} will handle new one-time workflow actions.`,
    );
  });
}

async function refreshCloudSession(strict: boolean): Promise<void> {
  try {
    const response = parseSessionResponse(await cloudRequest('/api/session', { method: 'GET' }));
    state.cloudSession = cloudSessionFromResponse(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.cloudSession = {
      status: 'unavailable',
      walletAddress: '',
      expiresAt: '',
      error: message,
    };
    if (strict) throw err;
  }
}

async function refreshActiveWorkflowData(): Promise<void> {
  switch (activeWorkflowMode()) {
    case 'agentic-cloud':
      await refreshCloudWorkspaceData();
      return;
    case 'local-bridge':
      await refreshInboxData();
      return;
    case 'browser-workflow':
      refreshBrowserWorkflowData();
      return;
  }
}

function refreshBrowserWorkflowData(): void {
  const browserWorkflow = loadBrowserWorkflowState();
  state.preparedActions = browserWorkflow.preparedActions;
  state.materializedActions = browserWorkflow.preparedActions;
  state.recurringPayments = browserWorkflow.recurringPayments;
  state.receipts = browserWorkflow.receipts;
}

async function refreshCloudWorkspaceData(): Promise<void> {
  if (state.cloudSession.status !== 'signed-in') {
    throw new Error('Sign in to Agentic Cloud before loading cloud workflow data.');
  }
  const browserWorkflow = loadBrowserWorkflowState();
  const recurringResponse: Awaited<ReturnType<typeof cloudRecurringList>> = await cloudRecurringList().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('Cloud recurring API unavailable:', err);
    return {
      schedules: [] as CloudRecurringScheduleRecord[],
      occurrences: [] as CloudRecurringOccurrenceRecord[],
      views: undefined,
    };
  });
  const [plansResponse, approvalsResponse, completedResponse] = await Promise.all([
    cloudRequest('/api/plans', { method: 'GET' }).then((payload) => parsePlanListResponse(payload)),
    cloudRequest('/api/approvals', { method: 'GET' }).then((payload) => parseApprovalListResponse(payload)),
    cloudRequest('/api/completed', { method: 'GET' }).then((payload) => parseCompletedListResponse(payload)),
  ]);
  const cloudPlans = plansResponse.plans.map(cloudPlanToGeneratedPlan).filter(isGeneratedPlanRecord);
  const localPlans = state.generatedPlans.filter((plan) => plan.workflowSource !== 'cloud');
  state.generatedPlans = mergeGeneratedPlans(cloudPlans, localPlans);

  const scheduleIndex = new Map<string, CloudRecurringScheduleRecord>();
  for (const schedule of recurringResponse.schedules) {
    if (schedule && typeof schedule === 'object' && typeof schedule.id === 'string') {
      scheduleIndex.set(schedule.id, schedule);
    }
  }
  const cloudApprovals = approvalsResponse.approvals.map(cloudApprovalToPreparedAction).filter(isPreparedAction);
  state.preparedActions = mergePreparedActions(cloudApprovals, browserWorkflow.preparedActions);
  state.materializedActions = state.preparedActions;
  state.recurringPayments = mergeRecurringPayments(recurringResponse.schedules
    .filter((schedule) => schedule.status === 'active' || schedule.status === 'paused')
    .map((schedule) => cloudRecurringScheduleToPayment(schedule, recurringResponse.views?.[schedule.id]))
    .filter((payment): payment is RecurringPayment => Boolean(payment)), browserWorkflow.recurringPayments);
  state.receipts = mergeActionReceipts(state.receipts, browserWorkflow.receipts);
  const cloudCompletedFromApprovals = completedResponse.completed
    .map(cloudCompletedToCompletedPlan)
    .filter((record): record is CompletedPlanRecord => Boolean(record));
  const cloudCompletedFromSchedules = recurringResponse.schedules
    .filter((schedule) => schedule.status === 'completed' || schedule.status === 'cancelled')
    .map(cloudEndedScheduleToCompletedPlan)
    .filter((record): record is CompletedPlanRecord => Boolean(record));
  state.cloudCompletedPlans = [...cloudCompletedFromApprovals, ...cloudCompletedFromSchedules].sort(
    (left, right) => right.completedAt.localeCompare(left.completedAt),
  );
  state.cloudLastSync = new Date().toISOString();
  selectFallbackGeneratedPlan();
  if (Date.now() - state.cloudEvidenceLastSyncAt > CLOUD_EVIDENCE_SYNC_TTL_MS) {
    await syncLabArtifactsWithCloud().catch(() => undefined);
  }
}

const CLOUD_EVIDENCE_SYNC_TTL_MS = 60_000;

async function cloudRequest<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'include',
      headers,
    });
  } catch {
    throw new Error('Agentic Cloud is not reachable from this page.');
  }
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    if (response.status === 401) {
      state.cloudSession = emptyCloudSession('signed-out');
    }
    throw new Error(cloudErrorMessage(payload, response.status));
  }
  if (payload === null) {
    throw new Error('Agentic Cloud did not return JSON. Use the same-origin Render app for cloud workflow APIs.');
  }
  return payload as T;
}

async function loadAuditEventsForRecord(
  recordType: AuditRecordType,
  recordId: string,
  options: { force?: boolean } = {},
): Promise<void> {
  if (!cloudSessionMatchesWallet()) return;
  const key = auditActivityKey(recordType, recordId);
  const current = state.auditActivity[key];
  if (current?.status === 'loading' || (current?.status === 'loaded' && !options.force)) return;
  state.auditActivity[key] = { status: 'loading', events: [] };
  render();
  try {
    const payload = await cloudRequest<{ events?: unknown[] }>(
      `/api/audit?recordType=${encodeURIComponent(recordType)}&recordId=${encodeURIComponent(recordId)}&limit=25`,
      { method: 'GET' },
    );
    const events = Array.isArray(payload.events)
      ? payload.events.map((event, index) => parseAuditEventRecord(event, `$.events[${index}]`))
      : [];
    state.auditActivity[key] = {
      status: 'loaded',
      events,
      loadedAt: new Date().toISOString(),
    };
  } catch (err) {
    state.auditActivity[key] = {
      status: 'error',
      events: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
  render();
}

function cloudSessionFromResponse(response: CloudSessionResponse): CloudSessionState {
  const walletAddress = typeof response.user?.walletAddress === 'string' ? response.user.walletAddress : '';
  const expiresAt = typeof response.session?.expiresAt === 'string'
    ? response.session.expiresAt
    : typeof response.expiresAt === 'string'
      ? response.expiresAt
      : '';
  if (response.signedIn && walletAddress) {
    return {
      status: 'signed-in',
      walletAddress,
      expiresAt,
      error: '',
    };
  }
  return emptyCloudSession('signed-out');
}

function parseCloudWorkspaceDeleteIntentResponse(payload: unknown): CloudWorkspaceDeleteIntentResponse {
  const record = cloudResponseObject(payload, 'cloud workspace deletion intent');
  return {
    walletAddress: stringPayload(record.walletAddress, 'Cloud deletion wallet address'),
    nonce: stringPayload(record.nonce, 'Cloud deletion nonce'),
    message: stringPayload(record.message, 'Cloud deletion message'),
    domain: stringPayload(record.domain, 'Cloud deletion domain'),
    issuedAt: stringPayload(record.issuedAt, 'Cloud deletion issued time'),
    expiresAt: stringPayload(record.expiresAt, 'Cloud deletion expiration time'),
  };
}

function parseCloudWorkspaceDeleteResponse(payload: unknown): CloudWorkspaceDeleteResponse {
  const record = cloudResponseObject(payload, 'cloud workspace deletion response');
  const deleted = isJsonObject(record.deleted) ? record.deleted : {};
  return {
    ok: record.ok === true,
    signedOut: record.signedOut === true,
    deleted: deleted as CloudWorkspaceDeleteCounts,
  };
}

function cloudDeleteCount(counts: CloudWorkspaceDeleteCounts): number {
  return Object.values(counts).reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);
}

function emptyCloudSession(status: Exclude<CloudSessionStatus, 'signed-in'>): CloudSessionState {
  return {
    status,
    walletAddress: '',
    expiresAt: '',
    error: '',
  };
}

function cloudErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim()) return record.message;
    if (typeof record.error === 'string' && record.error.trim()) {
      if (status === 404 && record.error === 'not_found') return 'Agentic Cloud workflow APIs are not available from this host yet.';
      return record.error;
    }
  }
  if (status === 404) return 'Agentic Cloud workflow APIs are not available from this host yet.';
  if (status === 401) return 'Sign in to Agentic Cloud before using cloud workflow actions.';
  return `Agentic Cloud request failed with HTTP ${status}.`;
}

function stringPayload(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  throw new Error(`${label} was missing from Agentic Cloud.`);
}

function parseCloudPlanResponse(payload: unknown): CloudPlanDraftRecord {
  const record = cloudResponseObject(payload, 'plan draft response');
  return parsePlanDraftRecord(record.plan, '$.plan');
}

function parseCloudApprovalResponse(payload: unknown): CloudApprovalRequestRecord {
  const record = cloudResponseObject(payload, 'approval response');
  return parseApprovalRequestRecord(record.approval, '$.approval');
}

function parseCloudRecurringScheduleResponse(payload: unknown): CloudRecurringScheduleRecord {
  const record = cloudResponseObject(payload, 'repeat payment response');
  return parseRecurringScheduleRecord(record.schedule, '$.schedule');
}

function cloudResponseObject(payload: unknown, label: string): Record<string, unknown> {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  throw new Error(`Agentic Cloud returned an invalid ${label}.`);
}

function cloudPlanToGeneratedPlan(value: unknown): GeneratedPlanRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<CloudPlanDraftRecord>;
  if (
    typeof record.id !== 'string' ||
    typeof record.walletAddress !== 'string' ||
    !isAgentPlan(record.plan) ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string' ||
    (record.source !== 'template' && record.source !== 'ai') ||
    typeof record.templateId !== 'string' ||
    typeof record.templateTitle !== 'string' ||
    typeof record.prompt !== 'string' ||
    !isGeneratedPlanStatus(record.status)
  ) {
    return null;
  }
  const cluster = typeof record.cluster === 'string' && isCluster(record.cluster) ? record.cluster : state.cluster;
  const plan = planWithCloudGuardrails(record.plan, record.riskMetadata);
  const localFields = record as Partial<GeneratedPlanRecord>;
  return {
    id: record.id,
    plan,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    source: record.source,
    templateId: record.templateId,
    templateTitle: record.templateTitle,
    prompt: record.prompt,
    walletAddress: record.walletAddress,
    cluster,
    status: record.status,
    ...(typeof record.signature === 'string' && { signature: record.signature }),
    ...(typeof record.approvalRequestId === 'string' && { preparedActionId: record.approvalRequestId }),
    ...(typeof localFields.error === 'string' && { error: localFields.error }),
    ...(typeof localFields.failureLabel === 'string' && { failureLabel: localFields.failureLabel }),
    workflowSource: 'cloud',
  };
}

function planWithCloudGuardrails(plan: AgentPlan, riskMetadata: unknown): AgentPlan {
  const report = guardrailReportFromRiskMetadata(riskMetadata);
  const constraintFingerprint = isJsonObject(riskMetadata) && typeof riskMetadata.constraintFingerprint === 'string'
    ? riskMetadata.constraintFingerprint
    : report?.constraintFingerprint;
  const constraintHash = isJsonObject(riskMetadata) && typeof riskMetadata.constraintHash === 'string'
    ? riskMetadata.constraintHash
    : report?.constraintHash;
  if (!report && !constraintFingerprint && !constraintHash) return plan;
  return {
    ...plan,
    ...(report ? { guardrailReport: report } : {}),
    ...(constraintFingerprint ? { constraintFingerprint } : {}),
    ...(constraintHash ? { constraintHash } : {}),
  };
}

function guardrailReportFromRiskMetadata(riskMetadata: unknown): AiGuardrailReport | undefined {
  if (!isJsonObject(riskMetadata)) return undefined;
  return isAiGuardrailReport(riskMetadata.aiGuardrails) ? riskMetadata.aiGuardrails : undefined;
}

function cloudApprovalToPreparedAction(value: unknown): PreparedAction | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<CloudApprovalRequestRecord>;
  if (
    typeof record.id !== 'string' ||
    typeof record.walletAddress !== 'string' ||
    typeof record.kind !== 'string' ||
    typeof record.summary !== 'string' ||
    !isJsonObject(record.params) ||
    typeof record.dueAt !== 'string' ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string'
  ) {
    return null;
  }
  const kind = preparedActionKindFromCloud(record.kind);
  const cluster = typeof record.cluster === 'string' && isCluster(record.cluster) ? record.cluster : state.cluster;
  const status = preparedActionStatusFromCloud(record.status);
  const planDraftId = typeof record.planDraftId === 'string'
    ? record.planDraftId
    : typeof record.planId === 'string'
      ? record.planId
      : undefined;
  const finalization = cloudFinalizationFromMetadata(record.metadata);
  return {
    id: record.id,
    kind,
    status,
    walletAddress: record.walletAddress,
    cluster,
    summary: record.summary,
    params: paramsFromCloudApproval(record),
    ...(isJsonObject(record.params) && { decisionProofParams: { ...record.params } }),
    dueAt: record.dueAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(planDraftId && { planDraftId }),
    ...(typeof record.recurringScheduleId === 'string' && { recurringId: record.recurringScheduleId }),
    ...(typeof record.occurrenceKey === 'string' && { occurrenceKey: record.occurrenceKey }),
    ...(typeof record.txid === 'string' && { txid: record.txid }),
    ...(typeof record.txStatus === 'string' && isPreparedActionTxStatus(record.txStatus) && { txStatus: record.txStatus }),
    ...(finalization && { finalization }),
    ...(finalization?.id && { finalizationId: finalization.id }),
    ...(finalization?.status && { finalizationStatus: finalization.status }),
    ...(finalization?.transactionHash && { transactionHash: finalization.transactionHash }),
    ...(finalization?.messageHash && { messageHash: finalization.messageHash }),
    ...(finalization?.quote?.quoteHash && { quoteHash: finalization.quote.quoteHash }),
    ...(finalization?.simulation?.simulationHash && { simulationHash: finalization.simulation.simulationHash }),
    ...(finalization?.confirmationStatus && { confirmationStatus: finalization.confirmationStatus }),
    ...(typeof record.error === 'string' && { error: record.error }),
    ...(typeof record.note === 'string' && { note: record.note }),
    ...(record.status === 'cancelled' && { archived: true }),
    workflowSource: 'cloud',
  };
}

function cloudCompletedToCompletedPlan(value: unknown): CompletedPlanRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<CloudCompletedRecord>;
  if (
    typeof record.id !== 'string' ||
    typeof record.status !== 'string' ||
    typeof record.title !== 'string' ||
    typeof record.summary !== 'string' ||
    typeof record.walletAddress !== 'string' ||
    typeof record.createdAt !== 'string' ||
    typeof record.completedAt !== 'string'
  ) {
    return null;
  }
  const cluster = typeof record.cluster === 'string' && isCluster(record.cluster) ? record.cluster : state.cluster;
  const signature = typeof record.signature === 'string'
    ? record.signature
    : typeof record.proofSignature === 'string'
      ? record.proofSignature
      : undefined;
  const generatedPlanId = typeof record.planDraftId === 'string'
    ? record.planDraftId
    : typeof record.planId === 'string'
      ? record.planId
      : undefined;
  const actionId = typeof record.approvalRequestId === 'string'
    ? record.approvalRequestId
    : typeof record.approvalId === 'string'
      ? record.approvalId
      : undefined;
  const kind: CompletedPlanRecord['kind'] = record.kind === 'recurring_occurrence' ? 'recurring' : 'one-time';
  const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
    ? record.metadata as Record<string, unknown>
    : undefined;
  const decisionProofVerified = typeof metadata?.decisionProofVerified === 'boolean'
    ? metadata.decisionProofVerified
    : undefined;
  const decisionProofMessage = typeof metadata?.decisionProofMessage === 'string'
    ? metadata.decisionProofMessage
    : undefined;
  const trustBundlePayload = cloudTrustBundlePayload(record, metadata, signature, decisionProofMessage);
  return {
    id: record.id,
    kind,
    status: record.status,
    tone: completedStatusTone(record.status),
    title: record.title,
    summary: record.summary,
    completedAt: record.completedAt,
    createdAt: record.createdAt,
    walletAddress: record.walletAddress,
    cluster,
    ...(typeof record.amount === 'string' && { amount: record.amount }),
    ...(typeof record.token === 'string' && { token: record.token }),
    ...(typeof record.recipient === 'string' && { recipient: record.recipient }),
    ...(signature && { signature }),
    ...(typeof record.txid === 'string' && { txid: record.txid }),
    ...(typeof record.explorerUrl === 'string' && { explorerUrl: record.explorerUrl }),
    ...(generatedPlanId && { generatedPlanId }),
    ...(actionId && { actionId }),
    ...(typeof record.recurringScheduleId === 'string' && { recurringId: record.recurringScheduleId }),
    ...(typeof record.occurrenceKey === 'string' && { occurrenceKey: record.occurrenceKey }),
    ...(decisionProofVerified !== undefined && { decisionProofVerified }),
    ...(decisionProofMessage !== undefined && { decisionProofMessage }),
    copyPayload: stableJson(record.payload ?? record.copyPayload ?? record),
    ...(trustBundlePayload ? { trustBundlePayload } : {}),
    detailRows: Array.isArray(record.detailRows) && record.detailRows.every(isDetailRow)
      ? record.detailRows
      : completedRows([
          ['Type', kind === 'recurring' ? 'Cloud repeat approval' : 'Cloud one-time approval'],
          ['Status', record.status],
          actionId ? ['Approval id', actionId] : undefined,
          generatedPlanId ? ['Plan id', generatedPlanId] : undefined,
          ['Wallet', record.walletAddress],
          ['Created', formatDateTime(record.createdAt)],
          ['Completed', formatDateTime(record.completedAt)],
          signature ? ['Decision proof', signature] : undefined,
          typeof record.txid === 'string' ? ['Transaction', record.txid] : undefined,
        ]),
    workflowSource: 'cloud',
  };
}

type CloudRecurringScheduleRecord = WorkflowRecurringScheduleRecord;
type CloudRecurringOccurrenceRecord = WorkflowRecurringOccurrenceRecord;
type CloudRecurringOccurrenceView = RecurringOccurrenceHistoryItem;

interface CloudRecurringScheduleView {
  lifetimeSpend?: LifetimeSpend;
  nextRuns?: string[];
}

interface CloudRecurringMutationResponse {
  schedule: CloudRecurringScheduleRecord;
  lifetimeSpend?: LifetimeSpend;
  nextRuns?: string[];
  webhookSecretOnce?: string;
}

function cloudEndedScheduleToCompletedPlan(value: unknown): CompletedPlanRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<CloudRecurringScheduleRecord>;
  if (
    typeof record.id !== 'string' ||
    typeof record.walletAddress !== 'string' ||
    typeof record.cluster !== 'string' ||
    typeof record.token !== 'string' ||
    typeof record.recipient !== 'string' ||
    typeof record.amount !== 'string' ||
    typeof record.cadence !== 'string' ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string'
  ) {
    return null;
  }
  if (record.status !== 'completed' && record.status !== 'cancelled') return null;
  const cluster = isCluster(record.cluster) ? record.cluster : state.cluster;
  const reason = record.status === 'completed' ? 'Schedule completed' : 'Schedule cancelled';
  const tone = completedStatusTone(record.status);
  const occurrenceLabel = typeof record.occurrencesCreated === 'number'
    ? `${record.occurrencesCreated} occurrence${record.occurrencesCreated === 1 ? '' : 's'} materialized`
    : 'No occurrences materialized';
  return {
    id: `recurring:${record.id}`,
    kind: 'recurring',
    status: record.status,
    tone,
    title: `${record.amount} ${record.token} repeat payment`,
    summary: reason,
    completedAt: record.updatedAt,
    createdAt: record.createdAt,
    walletAddress: record.walletAddress,
    cluster,
    amount: record.amount,
    token: record.token,
    recipient: record.recipient,
    recurringId: record.id,
    copyPayload: stableJson(record),
    detailRows: completedRows([
      ['Type', 'Cloud repeat payment'],
      ['Status', record.status],
      ['Cadence', record.cadence],
      ['Recipient', record.recipient],
      [`Amount ${record.token}`, record.amount],
      ['Wallet', record.walletAddress],
      ['Created', formatDateTime(record.createdAt)],
      ['Ended', formatDateTime(record.updatedAt)],
      ['Occurrences', occurrenceLabel],
    ]),
    workflowSource: 'cloud',
  };
}

function cloudTrustBundlePayload(
  record: Partial<CloudCompletedRecord>,
  metadata: Record<string, unknown> | undefined,
  signature: string | undefined,
  decisionProofMessage: string | undefined,
): string | undefined {
  const payload = isJsonObject(record.payload) ? record.payload : {};
  const finalization = isJsonObject(payload.finalization)
    ? payload.finalization
    : isJsonObject(metadata?.finalization)
      ? metadata.finalization
      : undefined;
  const hasTrustEvidence = Boolean(signature || decisionProofMessage || finalization || record.txid);
  if (!hasTrustEvidence) return undefined;
  const bundle = {
    receiptType: 'agentic_trust_bundle_v1',
    approvalRequestId: record.approvalRequestId,
    planDraftId: record.planDraftId ?? record.planId,
    completedRecordId: record.id,
    walletAddress: record.walletAddress,
    cluster: record.cluster,
    kind: record.kind,
    status: record.status,
    executionMode: finalization ? 'wallet_execute' : 'proof_only',
    finalizationId: isJsonObject(finalization) ? finalization.id : undefined,
    transactionHash: isJsonObject(finalization) ? finalization.transactionHash : record.transactionHash,
    messageHash: isJsonObject(finalization) ? finalization.messageHash : record.messageHash,
    quoteHash: isJsonObject(finalization) && isJsonObject(finalization.quote) ? finalization.quote.quoteHash : record.quoteHash,
    simulationHash: isJsonObject(finalization) && isJsonObject(finalization.simulation) ? finalization.simulation.simulationHash : record.simulationHash,
    txid: record.txid,
    explorerUrl: record.explorerUrl,
    decisionProofSignature: signature,
    decisionProofMessage,
    decisionProofVerified: metadata?.decisionProofVerified,
    verification: isJsonObject(finalization) && isJsonObject(finalization.metadata) && isJsonObject(finalization.metadata.verification)
      ? finalization.metadata.verification
      : undefined,
    trustBoundary: {
      noKeyCustody: true,
      noUnlimitedSigner: true,
      aiCannotApprove: true,
      walletApprovalRequiredForExecution: true,
      serverVerificationRequiredForTransactionReceipt: Boolean(finalization),
    },
    finalization,
  };
  return stableJson(stripUndefined(bundle));
}


function cloudRecurringScheduleToPayment(
  value: unknown,
  view?: CloudRecurringScheduleView,
): RecurringPayment | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<CloudRecurringScheduleRecord>;
  if (
    typeof record.id !== 'string' ||
    typeof record.walletAddress !== 'string' ||
    typeof record.cluster !== 'string' ||
    typeof record.token !== 'string' ||
    typeof record.recipient !== 'string' ||
    typeof record.amount !== 'string' ||
    typeof record.cadence !== 'string' ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string'
  ) {
    return null;
  }
  const status: 'active' | 'paused' = record.status === 'paused' ? 'paused' : 'active';
  return {
    id: record.id,
    status,
    walletAddress: record.walletAddress,
    cluster: record.cluster as Cluster,
    token: record.token,
    recipient: record.recipient,
    amount: record.amount,
    cadence: record.cadence as RecurringCadence,
    ...(typeof record.dayOfWeek === 'number' && { dayOfWeek: record.dayOfWeek }),
    ...(typeof record.dayOfMonth === 'number' && { dayOfMonth: record.dayOfMonth }),
    ...(typeof record.intervalDays === 'number' && { intervalDays: record.intervalDays }),
    ...(typeof record.intervalHours === 'number' && { intervalHours: record.intervalHours }),
    ...(typeof record.intervalMinutes === 'number' && { intervalMinutes: record.intervalMinutes }),
    ...(typeof record.localTime === 'string' && { localTime: record.localTime }),
    ...(typeof record.startAt === 'string' && { startAt: record.startAt }),
    ...(typeof record.maxOccurrences === 'number' && { maxOccurrences: record.maxOccurrences }),
    ...(typeof record.occurrencesCreated === 'number' && { occurrencesCreated: record.occurrencesCreated }),
    ...(typeof record.expiresAt === 'string' && { expiresAt: record.expiresAt }),
    ...(isJsonObject(record.notifications) && {
      notifications: {
        ...(typeof record.notifications.inApp === 'boolean' && { inApp: record.notifications.inApp }),
        ...(typeof record.notifications.webhookUrl === 'string' && { webhookUrl: record.notifications.webhookUrl }),
      },
    }),
    ...(view?.lifetimeSpend && { lifetimeSpend: view.lifetimeSpend }),
    ...(view?.nextRuns && { nextRuns: view.nextRuns }),
    ...(typeof record.note === 'string' && { note: record.note }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(typeof record.nextDueAt === 'string' && { nextDueAt: record.nextDueAt }),
    workflowSource: 'cloud',
  };
}

function cloudOccurrenceToPreparedAction(
  value: unknown,
  schedules: Map<string, CloudRecurringScheduleRecord>,
): PreparedAction | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<CloudRecurringOccurrenceRecord>;
  if (
    typeof record.id !== 'string' ||
    typeof record.recurringScheduleId !== 'string' ||
    typeof record.walletAddress !== 'string' ||
    typeof record.cluster !== 'string' ||
    typeof record.occurrenceKey !== 'string' ||
    typeof record.dueAt !== 'string' ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string'
  ) {
    return null;
  }
  const schedule = schedules.get(record.recurringScheduleId);
  const token = schedule?.token ?? 'SOL';
  const isSol = token.toUpperCase() === 'SOL';
  const summary = schedule
    ? `${schedule.amount} ${schedule.token} repeat approval`
    : 'Repeat payment approval';
  const status: PreparedActionStatus = record.status === 'completed'
    ? 'approved'
    : record.status === 'cancelled'
      ? 'cancelled'
      : record.status === 'failed' || record.status === 'skipped'
        ? 'failed'
      : new Date(record.dueAt).getTime() > Date.now()
        ? 'scheduled'
        : 'ready';
  return {
    id: record.id,
    kind: isSol ? 'transfer_sol' : 'transfer_spl',
    status,
    walletAddress: record.walletAddress,
    cluster: record.cluster as Cluster,
    summary,
    params: schedule
      ? isSol
        ? { recipient: schedule.recipient, amountSol: schedule.amount, memo: schedule.note ?? '' }
        : { token: schedule.token, recipient: schedule.recipient, amount: schedule.amount, memo: schedule.note ?? '' }
      : { recurringScheduleId: record.recurringScheduleId, occurrenceKey: record.occurrenceKey },
    dueAt: record.dueAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    recurringId: record.recurringScheduleId,
    occurrenceKey: record.occurrenceKey,
    workflowSource: 'cloud',
  };
}

async function cloudRecurringList(): Promise<{
  schedules: CloudRecurringScheduleRecord[];
  occurrences: CloudRecurringOccurrenceRecord[];
  views?: Record<string, CloudRecurringScheduleView>;
}> {
  const payload = await cloudRequest('/api/recurring', { method: 'GET' });
  const parsed = parseRecurringListResponse(payload);
  return {
    ...parsed,
    views: cloudRecurringViewsFromPayload(payload),
  };
}

function cloudRecurringViewsFromPayload(payload: unknown): Record<string, CloudRecurringScheduleView> | undefined {
  if (!isJsonObject(payload) || !isJsonObject(payload.views)) return undefined;
  const views: Record<string, CloudRecurringScheduleView> = {};
  for (const [id, raw] of Object.entries(payload.views)) {
    if (!isJsonObject(raw)) continue;
    const view: CloudRecurringScheduleView = {};
    if (Array.isArray(raw.nextRuns) && raw.nextRuns.every((entry) => typeof entry === 'string')) {
      view.nextRuns = raw.nextRuns;
    }
    if (isLifetimeSpend(raw.lifetimeSpend)) {
      view.lifetimeSpend = raw.lifetimeSpend;
    }
    views[id] = view;
  }
  return views;
}

function isLifetimeSpend(value: unknown): value is LifetimeSpend {
  if (!isJsonObject(value) || typeof value.bounded !== 'boolean') return false;
  if (typeof value.perWeek !== 'string' || typeof value.perMonth !== 'string') return false;
  if (value.totalRuns !== undefined && typeof value.totalRuns !== 'number') return false;
  if (value.totalAmount !== undefined && typeof value.totalAmount !== 'string') return false;
  return true;
}

async function cloudCreateRecurring(body: Record<string, unknown>): Promise<CloudRecurringMutationResponse> {
  const payload = await cloudRequest('/api/recurring', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return cloudRecurringMutationResponse(payload);
}

async function cloudPatchRecurring(id: string, patch: Record<string, unknown>): Promise<CloudRecurringMutationResponse> {
  const payload = await cloudRequest(`/api/recurring/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return cloudRecurringMutationResponse(payload);
}

async function cloudPauseRecurring(id: string): Promise<void> {
  await cloudRequest(`/api/recurring/${encodeURIComponent(id)}/pause`, {
    method: 'POST',
    body: '{}',
  });
}

async function cloudResumeRecurring(id: string): Promise<void> {
  await cloudRequest(`/api/recurring/${encodeURIComponent(id)}/resume`, {
    method: 'POST',
    body: '{}',
  });
}

async function cloudRotateRecurringWebhookSecret(id: string): Promise<CloudRecurringMutationResponse> {
  const payload = await cloudRequest(`/api/recurring/${encodeURIComponent(id)}/notifications/rotate`, {
    method: 'POST',
    body: '{}',
  });
  return cloudRecurringMutationResponse(payload);
}

async function cloudRecurringNotifications(id: string): Promise<RecurringNotificationStatusState> {
  const payload = await cloudRequest(`/api/recurring/${encodeURIComponent(id)}/notifications?limit=10`, {
    method: 'GET',
  });
  if (!isJsonObject(payload)) throw new Error('Agentic Cloud returned invalid notification status.');
  const deliveries = Array.isArray(payload.deliveries)
    ? payload.deliveries.map(recurringNotificationDelivery).filter((entry): entry is RecurringNotificationDelivery => Boolean(entry))
    : [];
  const lastDelivery = recurringNotificationDelivery(payload.lastDelivery);
  return {
    enabled: payload.enabled === true,
    ...(typeof payload.webhookUrl === 'string' && { webhookUrl: payload.webhookUrl }),
    ...(lastDelivery && { lastDelivery }),
    deliveries,
    loadedAt: new Date().toISOString(),
  };
}

function cloudRecurringMutationResponse(payload: unknown): CloudRecurringMutationResponse {
  const record = cloudResponseObject(payload, 'repeat payment response');
  const schedule = parseRecurringScheduleRecord(record.schedule, '$.schedule');
  return {
    schedule,
    ...(isLifetimeSpend(record.lifetimeSpend) && { lifetimeSpend: record.lifetimeSpend }),
    ...(Array.isArray(record.nextRuns) && record.nextRuns.every((entry) => typeof entry === 'string') && { nextRuns: record.nextRuns }),
    ...(typeof record.webhookSecretOnce === 'string' && { webhookSecretOnce: record.webhookSecretOnce }),
  };
}

function recurringNotificationDelivery(value: unknown): RecurringNotificationDelivery | null {
  if (!isJsonObject(value)) return null;
  if (
    typeof value.id !== 'string' ||
    typeof value.type !== 'string' ||
    typeof value.scheduleId !== 'string' ||
    typeof value.occurrenceId !== 'string' ||
    typeof value.status !== 'string' ||
    typeof value.attempts !== 'number' ||
    typeof value.nextAttemptAt !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    return null;
  }
  if (!['pending', 'delivered', 'failed', 'abandoned'].includes(value.status)) return null;
  return {
    id: value.id,
    type: value.type,
    scheduleId: value.scheduleId,
    occurrenceId: value.occurrenceId,
    status: value.status as RecurringNotificationDelivery['status'],
    attempts: value.attempts,
    nextAttemptAt: value.nextAttemptAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(typeof value.lastError === 'string' && { lastError: value.lastError }),
    ...(typeof value.deliveredAt === 'string' && { deliveredAt: value.deliveredAt }),
  };
}

async function cloudDeleteRecurring(id: string): Promise<void> {
  await cloudRequest(`/api/recurring/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

async function cloudMaterializeRecurring(): Promise<void> {
  await cloudRequest('/api/recurring/materialize-due', { method: 'POST', body: '{}' });
}

async function cloudRecurringOccurrences(
  id: string,
  cursor?: string,
): Promise<{ occurrences: CloudRecurringOccurrenceView[]; nextCursor?: string }> {
  const params = new URLSearchParams({ limit: '25' });
  if (cursor) params.set('cursor', cursor);
  const payload = await cloudRequest(`/api/recurring/${encodeURIComponent(id)}/occurrences?${params.toString()}`, {
    method: 'GET',
  });
  if (!isJsonObject(payload) || !Array.isArray(payload.occurrences)) {
    throw new Error('Agentic Cloud returned invalid repeat payment history.');
  }
  const occurrences = payload.occurrences
    .map(cloudRecurringOccurrenceView)
    .filter((entry): entry is CloudRecurringOccurrenceView => Boolean(entry));
  return {
    occurrences,
    ...(typeof payload.nextCursor === 'string' && { nextCursor: payload.nextCursor }),
  };
}

function cloudRecurringOccurrenceView(value: unknown): CloudRecurringOccurrenceView | null {
  if (!isJsonObject(value)) return null;
  const parsed = parseRecurringOccurrenceRecord(value);
  const approval = isJsonObject(value.approval)
    ? {
        id: typeof value.approval.id === 'string' ? value.approval.id : '',
        status: typeof value.approval.status === 'string' ? value.approval.status : '',
        ...(typeof value.approval.decidedAt === 'string' && { decidedAt: value.approval.decidedAt }),
        ...(typeof value.approval.txid === 'string' && { txid: value.approval.txid }),
        ...(typeof value.approval.txStatus === 'string' && { txStatus: value.approval.txStatus }),
        ...(typeof value.approval.explorerUrl === 'string' && { explorerUrl: value.approval.explorerUrl }),
      }
    : undefined;
  const completed = isJsonObject(value.completed)
    ? {
        id: typeof value.completed.id === 'string' ? value.completed.id : '',
        status: typeof value.completed.status === 'string' ? value.completed.status : '',
        completedAt: typeof value.completed.completedAt === 'string' ? value.completed.completedAt : '',
        ...(typeof value.completed.txid === 'string' && { txid: value.completed.txid }),
        ...(typeof value.completed.explorerUrl === 'string' && { explorerUrl: value.completed.explorerUrl }),
      }
    : undefined;
  const statusLabel = isJsonObject(value.statusLabel) &&
    typeof value.statusLabel.label === 'string' &&
    typeof value.statusLabel.tone === 'string'
    ? { label: value.statusLabel.label, tone: value.statusLabel.tone as StatusLabel['tone'] }
    : formatOccurrenceStatus(parsed.status, approval);
  return {
    ...parsed,
    statusLabel,
    ...(approval?.id && approval.status ? { approval } : {}),
    ...(completed?.id && completed.status && completed.completedAt ? { completed } : {}),
  };
}

function isDetailRow(value: unknown): value is [string, string] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string';
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isAiGuardrailReport(value: unknown): value is AiGuardrailReport {
  if (!isJsonObject(value)) return false;
  return (
    (value.verdict === 'pass' || value.verdict === 'warn' || value.verdict === 'block') &&
    typeof value.source === 'string' &&
    typeof value.actionType === 'string' &&
    typeof value.finalizationRequirement === 'string' &&
    typeof value.constraintFingerprint === 'string' &&
    Array.isArray(value.violations) &&
    typeof value.summary === 'string'
  );
}

function cloudFinalizationFromMetadata(metadata: unknown): CloudTransactionFinalizationRecord | undefined {
  if (!isJsonObject(metadata) || !isJsonObject(metadata.finalization)) return undefined;
  const value = metadata.finalization as Partial<CloudTransactionFinalizationRecord>;
  if (
    typeof value.id !== 'string' ||
    typeof value.approvalRequestId !== 'string' ||
    typeof value.walletAddress !== 'string' ||
    typeof value.kind !== 'string' ||
    typeof value.status !== 'string' ||
    typeof value.cluster !== 'string' ||
    typeof value.transactionHash !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    !isJsonObject(value.walletAction)
  ) {
    return undefined;
  }
  return value as CloudTransactionFinalizationRecord;
}

function preparedActionKindFromCloud(value: string): PreparedActionKind {
  if (isPreparedActionKind(value)) return value;
  return 'custom';
}

function preparedActionStatusFromCloud(status: CloudApprovalRequestRecord['status'] | undefined): PreparedActionStatus {
  if (status === 'scheduled') return 'scheduled';
  if (status === 'overdue') return 'overdue';
  if (status === 'approval_pending') return 'approval_pending';
  if (status === 'approved') return 'approved';
  if (status === 'rejected' || status === 'denied') return 'rejected';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'expired') return 'expired';
  if (status === 'blocked') return 'blocked';
  if (status === 'failed') return 'failed';
  return 'ready';
}

function paramsFromCloudApproval(record: Partial<CloudApprovalRequestRecord>): Record<string, unknown> {
  const params: Record<string, unknown> = { ...(record.params ?? {}) };
  if (typeof record.amount === 'string' && params.amount === undefined && params.amountSol === undefined) {
    params[record.kind === 'transfer_sol' ? 'amountSol' : 'amount'] = record.amount;
  }
  if (typeof record.token === 'string' && params.token === undefined) {
    params.token = record.token;
  }
  if (typeof record.recipient === 'string' && params.recipient === undefined) {
    params.recipient = record.recipient;
  }
  return params;
}

function completedStatusTone(status: string): string {
  if (status === 'approved' || status === 'completed') return 'tx-confirmed';
  if (status === 'denied' || status === 'rejected' || status === 'failed') return 'tx-failed';
  return 'neutral';
}

async function runConnectBridge(): Promise<void> {
  await run('bridge', async () => {
    state.bridgeUrl = inputValue('#bridgeUrl') || state.bridgeUrl;
    state.bridgeToken = inputValue('#bridgeToken') || state.bridgeToken;
    await activateBridgeConnection({ refreshConfig: true, strictSync: true });
    if (activeWorkflowMode() !== 'local-bridge') {
      await refreshActiveWorkflowData();
    }
    pushToast('success', 'Bridge connected', 'Select private local mode to route workflow storage through the bridge.');
  }, {
    async onError(message) {
      state.bridgeActive = false;
      stopBridgePolling();
      state.bridgeStatus = message;
      if (isBridgeOfflineMessage(message)) {
        state.error = '';
        await showBridgeOfflineToast('Approval bridge offline');
        return;
      }
      pushToast('error', 'Bridge connection failed', message);
    },
  });
}

async function runDisconnectBridge(): Promise<void> {
  await run('bridge', async () => {
    await disconnectBridgeHost();
    state.bridgeActive = false;
    state.bridgeStatus = 'Bridge disconnected.';
    if (state.workflowModePreference === 'local-bridge') {
      state.workflowModePreference = 'auto';
      savePersistedState();
    }
    stopBridgePolling();
    pushToast('success', 'Bridge disconnected', 'Local approval host stopped polling.');
  });
}

async function runRefreshInbox(): Promise<void> {
  await run('inbox', async () => {
    if (activeWorkflowMode() === 'local-bridge') {
      await Promise.all([refreshInboxData(), refreshHealth(), refreshBalances().catch(() => undefined), syncLabArtifactsWithBridge()]);
    } else {
      await refreshActiveWorkflowData();
    }
    pushToast('success', 'Workspace refreshed', `${activeWorkflowPreparedActions().length} approval request(s) loaded from ${activeWorkflowLabel()}.`);
  });
}

async function runCreateRecurring(): Promise<void> {
  await run('inbox', async () => {
    state.recurringDraft = readRecurringDraft();
    assertValidRecurringDraft(state.recurringDraft);
    const mode = activeWorkflowMode();
    const body = recurringBody(state.recurringDraft);
    if (mode === 'local-bridge') {
      await bridgeRequest('/bridge/recurring-payments', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      await refreshInboxData();
    } else if (mode === 'agentic-cloud') {
      const response = await cloudCreateRecurring({ ...body, cluster: state.cluster });
      if (response.webhookSecretOnce) {
        state.recurringWebhookSecretOnce = {
          scheduleId: response.schedule.id,
          secret: response.webhookSecretOnce,
          createdAt: new Date().toISOString(),
        };
      }
      await refreshCloudWorkspaceData();
    } else {
      const payment = browserRecurringPaymentFromDraft(state.recurringDraft);
      const occurrence = browserOccurrenceFromRecurring(payment);
      state.recurringPayments = mergeRecurringPayments([payment], state.recurringPayments);
      state.preparedActions = mergePreparedActions([occurrence], state.preparedActions);
      state.materializedActions = state.preparedActions;
      saveBrowserWorkflowState();
    }
    state.activeTab = 'schedule';
    state.recurringView = 'active';
    pushToast(
      'success',
      'Repeat payment created',
      mode === 'local-bridge'
        ? 'Future payments will appear in Needs Approval.'
        : mode === 'agentic-cloud'
          ? 'Each run returns to your wallet for review.'
          : 'Created one local approval now. Saved-on-device workflow does not run background repeats after this tab closes.',
    );
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

  const action = state.preparedActions.find((candidate) => candidate.id === actionId);
  if (action?.workflowSource === 'cloud') {
    await run('inbox', async () => {
      await runCloudPreparedActionOp(action, op);
    });
    return;
  }

  if (isBrowserWorkflowId(actionId)) {
    await run('inbox', async () => {
      await runBrowserPreparedActionOp(actionId, op);
    });
    return;
  }

  await run('inbox', async () => {
    switch (op) {
      case 'execute':
        await bridgeRequest('/bridge/prepared-actions/execute', {
          method: 'POST',
          body: JSON.stringify({ actionId }),
        });
        await refreshInboxData();
        showCompletedHistoryForAction(actionId);
        pushToast('success', 'Approval completed', 'Receipt saved in Done.');
        break;
      case 'reject':
        await bridgeRequest('/bridge/prepared-actions/reject', {
          method: 'POST',
          body: JSON.stringify({ actionId, reason: 'Rejected in browser wallet UI.' }),
        });
        await refreshInboxData();
        showCompletedHistoryForAction(actionId);
        pushToast('success', 'Request rejected', 'Saved in Done.');
        break;
      case 'archive':
        await bridgeRequest('/bridge/prepared-actions/archive', {
          method: 'POST',
          body: JSON.stringify({ actionId }),
        });
        await refreshInboxData();
        showCompletedHistoryForAction(actionId);
        pushToast('success', 'Request cancelled', 'Saved in Done.');
        break;
      case 'delete':
        await bridgeRequest('/bridge/prepared-actions/delete', {
          method: 'POST',
          body: JSON.stringify({ actionId }),
        });
        pushToast('success', 'Deleted permanently', actionId);
        break;
      default:
        throw new Error(`Unknown action operation: ${op}`);
    }
    if (state.activeTab !== 'completed') {
      await refreshInboxData();
    }
  });
}

async function runCloudPreparedActionOp(action: PreparedAction, op: string): Promise<void> {
  switch (op) {
    case 'confirm': {
      if (!canConfirmCloudFinalization(action)) {
        throw new Error('This request does not have a submitted cloud transaction to confirm.');
      }
      await runCloudFinalizationConfirm(action);
      return;
    }
    case 'execute': {
      if (canFinalizeCloudSolTransfer(action)) {
        await runCloudSolTransferFinalization(action);
        return;
      }
      const blockReason = cloudExecutionBlockReason(action);
      if (blockReason) {
        throw new Error(blockReason);
      }
      const decisionProof = await signCloudWorkflowDecision(action, 'approved');
      await cloudRequest(`/api/approvals/${encodeURIComponent(action.id)}/approve`, {
        method: 'POST',
        body: JSON.stringify({
          proofSignature: decisionProof.signature,
          decisionProofMessage: decisionProof.message,
          signatureEncoding: 'base58',
          note: 'Proof-only approval recorded in Agentic Cloud workspace. No transaction was submitted.',
        }),
      });
      await refreshCloudWorkspaceData();
      showCompletedHistoryForAction(action.id);
      pushToast('success', 'Approval recorded', 'Cloud receipt saved in Done.');
      return;
    }
    case 'reject': {
      const decisionProof = await signCloudWorkflowDecision(action, 'rejected');
      await cloudRequest(`/api/approvals/${encodeURIComponent(action.id)}/deny`, {
        method: 'POST',
        body: JSON.stringify({
          proofSignature: decisionProof.signature,
          decisionProofMessage: decisionProof.message,
          signatureEncoding: 'base58',
          note: 'Denied in Agentic Cloud workspace.',
        }),
      });
      await refreshCloudWorkspaceData();
      showCompletedHistoryForAction(action.id);
      pushToast('success', 'Request denied', 'Cloud denial receipt saved in Done.');
      return;
    }
    case 'archive':
    case 'delete':
      await cloudRequest(`/api/approvals/${encodeURIComponent(action.id)}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ note: 'Cancelled in Agentic Cloud workspace.' }),
      });
      await refreshCloudWorkspaceData();
      showCompletedHistoryForAction(action.id);
      pushToast('success', 'Request cancelled', 'Cloud cancellation receipt saved in Done.');
      return;
    default:
      throw new Error(`Unknown action operation: ${op}`);
  }
}

async function runCloudSolTransferFinalization(action: PreparedAction): Promise<void> {
  const toastId = pushToast('pending', 'Preparing transaction', 'Building the wallet transaction.');
  const toastContext: TransactionToastContext = { toastId, actionId: action.id, cluster: action.cluster };
  const prepareResponse = await runTransactionToastStep(
    toastContext,
    'Preparing transaction',
    'Building the wallet transaction.',
    () => cloudRequest(`/api/approvals/${encodeURIComponent(action.id)}/finalization/prepare`, {
      method: 'POST',
      body: '{}',
    }),
  ).catch((err) => {
    replaceToast(toastId, 'error', 'Transaction failed', redactSecrets(err instanceof Error ? err.message : String(err)));
    throw err;
  });
  const { finalization, transactionBase64 } = cloudPreparedFinalizationFromResponse(prepareResponse);
  const finalizationId = finalization.id;
  const decisionProof = await signCloudFinalizationProof(action, finalization);
  const signingClient = requireClient();
  let txid = '';
  try {
    const signed = await runTransactionToastStep(
      toastContext,
      'Signing transaction',
      finalization.walletAction.summary,
      () => signingClient.signTransaction(
        transactionBase64,
        { cluster: action.cluster, summary: finalization.walletAction.summary },
      ),
    );
    txid = await runTransactionToastStep(
      toastContext,
      'Sending transaction',
      'Broadcasting the signed transaction to Solana RPC.',
      () => broadcastSignedBrowserTransactionWithRetry(action.cluster, signed.signature, toastContext),
    );
  } catch (err) {
    replaceToast(toastId, 'error', 'Transaction failed', redactSecrets(err instanceof Error ? err.message : String(err)));
    await cloudRequest(`/api/approvals/${encodeURIComponent(action.id)}/finalization/${encodeURIComponent(finalizationId)}/fail`, {
      method: 'POST',
      body: JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
        note: 'Wallet approval did not complete.',
      }),
    }).catch(() => undefined);
    await refreshCloudWorkspaceData().catch(() => undefined);
    throw err;
  }

  let confirmed = true;
  let confirmationError = '';
  try {
    confirmed = await resolveSubmittedTransactionStatus(action.cluster, txid, toastContext) === 'confirmed';
  } catch (err) {
    confirmed = false;
    confirmationError = err instanceof Error ? err.message : String(err);
  }

  const submitResponse = await cloudRequest(`/api/approvals/${encodeURIComponent(action.id)}/finalization/${encodeURIComponent(finalizationId)}/submit`, {
    method: 'POST',
    body: JSON.stringify({
      finalizationStatus: confirmed ? 'confirmed' : 'submitted',
      txStatus: confirmed ? 'confirmed' : 'pending',
      txid,
      transactionHash: finalization.transactionHash,
      ...(finalization.messageHash ? { messageHash: finalization.messageHash } : {}),
      ...(finalization.quote?.quoteHash ? { quoteHash: finalization.quote.quoteHash } : {}),
      ...(finalization.simulation?.simulationHash ? { simulationHash: finalization.simulation.simulationHash } : {}),
      explorerUrl: explorerUrl(txid, action.cluster),
      proofSignature: decisionProof.signature,
      decisionProofMessage: decisionProof.message,
      signatureEncoding: 'base58',
      note: confirmed
        ? 'Wallet approved and transaction finalization receipt was saved.'
        : 'Wallet submitted a transaction and confirmation is still pending.',
      ...(confirmationError ? { error: confirmationError } : {}),
      metadata: {
        transactionBoundary: 'server_wallet_finalization_v1',
        transactionHash: finalization.transactionHash,
      },
    }),
  });
  const submitObject = cloudResponseObject(submitResponse, 'finalization submit response');
  const submittedFinalization = cloudFinalizationFromRecord(submitObject.finalization);

  await refreshCloudWorkspaceData();
  if (submittedFinalization?.status === 'failed') {
    replaceToast(toastId, 'error', 'Transaction failed', submittedFinalization.error ?? 'Submitted transaction failed server verification.');
    throw new Error(submittedFinalization.error ?? 'Submitted transaction failed server verification.');
  }
  if (!isJsonObject(submitObject.completed)) {
    replaceToast(toastId, 'pending', 'Transaction submitted', `Server verification is still pending: ${short(txid)}`, {
      linkHref: explorerUrl(txid, action.cluster),
      linkLabel: 'Open Solscan',
    });
    return;
  }
  showCompletedHistoryForAction(action.id);
  replaceToast(toastId, 'success', 'Transaction finalized', 'Wallet receipt saved in Done.', {
    linkHref: explorerUrl(txid, action.cluster),
    linkLabel: 'Open Solscan',
  });
}

async function runCloudFinalizationConfirm(action: PreparedAction): Promise<void> {
  if (!action.finalizationId) {
    throw new Error('Finalization id is missing.');
  }
  const response = await cloudRequest(`/api/approvals/${encodeURIComponent(action.id)}/finalization/${encodeURIComponent(action.finalizationId)}/confirm`, {
    method: 'POST',
    body: '{}',
  });
  const responseObject = cloudResponseObject(response, 'finalization confirm response');
  const finalization = cloudFinalizationFromRecord(responseObject.finalization);
  await refreshCloudWorkspaceData();
  if (finalization?.status === 'failed') {
    throw new Error(finalization.error ?? 'Submitted transaction failed server verification.');
  }
  if (!isJsonObject(responseObject.completed)) {
    pushToast('pending', 'Still confirming', action.txid ? `Server verification is still pending: ${short(action.txid)}` : action.id);
    return;
  }
  showCompletedHistoryForAction(action.id);
  pushToast('success', 'Transaction finalized', 'Wallet receipt saved in Done.');
}

function cloudPreparedFinalizationFromResponse(payload: unknown): {
  finalization: CloudTransactionFinalizationRecord;
  transactionBase64: string;
} {
  const response = cloudResponseObject(payload, 'finalization prepare response');
  const finalization = cloudFinalizationFromRecord(response.finalization);
  if (!finalization) {
    throw new Error('Finalization prepare response was missing finalization.');
  }
  return {
    finalization,
    transactionBase64: stringPayload(response.transactionBase64, 'Prepared transaction'),
  };
}

function cloudFinalizationFromResponse(payload: unknown): CloudTransactionFinalizationRecord {
  const response = cloudResponseObject(payload, 'finalization response');
  const finalization = cloudFinalizationFromRecord(response.finalization);
  if (!finalization) {
    throw new Error('Finalization response was missing finalization.');
  }
  return finalization;
}

function cloudFinalizationFromRecord(value: unknown): CloudTransactionFinalizationRecord | undefined {
  if (!isJsonObject(value)) return undefined;
  return cloudFinalizationFromMetadata({ finalization: value });
}

async function runBrowserPreparedActionOp(actionId: string, op: string): Promise<void> {
  const action = state.preparedActions.find((candidate) => candidate.id === actionId);
  if (!action) {
    throw new Error('Approval request was not found.');
  }
  switch (op) {
    case 'confirm':
      await runBrowserTransactionConfirm(action);
      return;
    case 'execute': {
      if (isExecutableBrowserAction(action)) {
        await executeBrowserPreparedAction(action);
        return;
      }
      const proofSignature = await signBrowserWorkflowDecision(action, 'approved');
      completeBrowserPreparedAction(action, 'approved', proofSignature);
      showCompletedHistoryForAction(action.id);
      pushToast('success', 'Approval recorded', 'Wallet proof saved in Done.');
      return;
    }
    case 'reject': {
      const proofSignature = await signBrowserWorkflowDecision(action, 'rejected');
      completeBrowserPreparedAction(action, 'rejected', proofSignature);
      showCompletedHistoryForAction(action.id);
      pushToast('success', 'Request rejected', 'Wallet rejection proof saved in Done.');
      return;
    }
    case 'archive':
      state.preparedActions = state.preparedActions.map((candidate) =>
        candidate.id === action.id
          ? { ...candidate, archived: true, updatedAt: new Date().toISOString() }
          : candidate,
      );
      state.materializedActions = state.preparedActions;
      saveBrowserWorkflowState();
      showCompletedHistoryForAction(action.id);
      pushToast('success', 'Request cancelled', 'Saved in Done.');
      return;
    case 'delete':
      state.preparedActions = state.preparedActions.filter((candidate) => candidate.id !== action.id);
      state.materializedActions = state.preparedActions;
      state.receipts = state.receipts.filter((receipt) => receipt.actionId !== action.id);
      saveBrowserWorkflowState();
      pushToast('success', 'Deleted permanently', action.id);
      return;
    default:
      throw new Error(`Unknown action operation: ${op}`);
  }
}

async function runBrowserTransactionConfirm(action: PreparedAction): Promise<void> {
  if (!canConfirmBrowserTransaction(action)) {
    throw new Error('This request does not have a submitted browser transaction to confirm.');
  }
  const txid = action.txid!;
  const toastId = pushToast('pending', 'Checking transaction', short(txid), {
    linkHref: explorerUrl(txid, action.cluster),
    linkLabel: 'Open Solscan',
  });
  const toastContext: TransactionToastContext = { toastId, actionId: action.id, cluster: action.cluster };
  const txStatus = await resolveSubmittedTransactionStatus(action.cluster, txid, toastContext);
  if (txStatus !== 'confirmed') {
    updateBrowserPreparedAction(action.id, {
      status: 'approval_pending',
      txStatus: 'pending',
      txid,
      txError: undefined,
      error: undefined,
    });
    replaceToast(toastId, 'pending', 'Transaction submitted', short(txid), {
      linkHref: explorerUrl(txid, action.cluster),
      linkLabel: 'Open Solscan',
    });
    render();
    return;
  }
  completeBrowserExecutedAction(action, {
    txid,
    txStatus,
    explorerUrl: explorerUrl(txid, action.cluster),
  });
  recordBrowserActionActivity(action.id, 'browser.transaction.saved', {
    kind: action.kind,
    status: txStatus,
    txid,
  });
  showCompletedHistoryForAction(action.id);
  replaceToast(toastId, 'success', 'Transaction finalized', short(txid), {
    linkHref: explorerUrl(txid, action.cluster),
    linkLabel: 'Open Solscan',
  });
}

async function signCloudWorkflowDecision(
  action: PreparedAction,
  decision: 'approved' | 'rejected',
): Promise<{ signature: string; message: string }> {
  const signingClient = requireClient();
  const signingMessage = workflowDecisionProofMessage({
    approval: {
      id: action.id,
      walletAddress: action.walletAddress,
      cluster: action.cluster,
      summary: action.summary,
      kind: action.kind,
      params: workflowProofParams(action),
    },
    decision,
  });
  const result = await signingClient.signMessage(signingMessage, signOptions(`Agentic Cloud ${decision}`));
  return { signature: result.signature, message: signingMessage };
}

async function signCloudFinalizationProof(
  action: PreparedAction,
  finalization: CloudTransactionFinalizationRecord,
): Promise<{ signature: string; message: string }> {
  const signingClient = requireClient();
  const signingMessage = workflowFinalizationProofMessage({
    approval: {
      id: action.id,
      walletAddress: action.walletAddress,
      cluster: action.cluster,
      summary: action.summary,
      kind: action.kind,
      params: workflowProofParams(action),
    },
    finalization,
  });
  const result = await signingClient.signMessage(signingMessage, { cluster: action.cluster, summary: 'Agentic Cloud transaction finalization' });
  return { signature: result.signature, message: signingMessage };
}

function workflowProofParams(action: PreparedAction): JsonObject {
  return stripUndefined(action.decisionProofParams ?? action.params) as JsonObject;
}

async function signBrowserWorkflowDecision(
  action: PreparedAction,
  decision: 'approved' | 'rejected',
): Promise<string> {
  const signingClient = requireClient();
  const signingMessage = [
    'Agentic browser workflow decision',
    `Decision: ${decision}`,
    `Approval: ${action.id}`,
    `Wallet: ${state.address}`,
    `Cluster: ${state.cluster}`,
    `Summary: ${action.summary}`,
    `Kind: ${action.kind}`,
    `Params: ${stableJson(action.params)}`,
    `Time: ${new Date().toISOString()}`,
    'This signature records a browser workflow decision only. It does not submit a transaction.',
  ].join('\n');
  const result = await signingClient.signMessage(signingMessage, signOptions(`Browser workflow ${decision}`));
  return result.signature;
}

function isExecutableBrowserAction(action: PreparedAction): boolean {
  return (action.workflowSource === 'browser' || isBrowserWorkflowId(action.id)) &&
    EXECUTABLE_BROWSER_ACTION_KINDS.has(action.kind);
}

async function executeBrowserPreparedAction(action: PreparedAction): Promise<void> {
  assertBrowserActionWalletReady(action);
  const priorStatus: PreparedActionStatus = action.status === 'overdue' ? 'overdue' : 'ready';
  const toastId = pushToast('pending', 'Opening wallet', browserExecutionStartMessage(action));
  const toastContext: TransactionToastContext = { toastId, actionId: action.id, cluster: action.cluster };
  updateBrowserPreparedAction(action.id, {
    status: 'approval_pending',
    txStatus: 'pending',
    txError: undefined,
    error: undefined,
  });
  recordBrowserActionActivity(action.id, 'browser.transaction.start', {
    kind: action.kind,
    status: 'approval_pending',
    summary: action.summary,
  });
  render();

  try {
    const current = state.preparedActions.find((candidate) => candidate.id === action.id) ?? action;
    const execution = await executeBrowserPreparedActionRecord(current, toastContext);
    if (execution.txStatus === 'pending') {
      updateBrowserPreparedAction(action.id, {
        status: 'approval_pending',
        txStatus: 'pending',
        txid: execution.txid,
        txError: undefined,
        error: undefined,
      });
      recordBrowserActionActivity(action.id, 'browser.transaction.pending', {
        kind: action.kind,
        status: 'pending',
        txid: execution.txid,
      });
      state.activeTab = 'inbox';
      replaceToast(
        toastId,
        'pending',
        'Transaction submitted',
        short(execution.txid),
        { linkHref: execution.explorerUrl, linkLabel: 'Open Solscan' },
      );
      render();
      return;
    }
    completeBrowserExecutedAction(current, execution);
    recordBrowserActionActivity(action.id, 'browser.transaction.saved', {
      kind: action.kind,
      status: execution.txStatus,
      txid: execution.txid,
    });
    showCompletedHistoryForAction(action.id);
    replaceToast(
      toastId,
      execution.txStatus === 'confirmed' ? 'success' : 'pending',
      execution.txStatus === 'confirmed' ? 'Transaction finalized' : 'Transaction submitted',
      `${short(execution.txid)} - Solscan link saved in Done.`,
      { linkHref: execution.explorerUrl, linkLabel: 'Open Solscan' },
    );
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : String(err));
    updateBrowserPreparedAction(action.id, {
      status: priorStatus,
      txStatus: 'failed',
      txError: message,
      error: message,
    });
    recordBrowserActionActivity(action.id, 'browser.transaction.failed', {
      kind: action.kind,
      status: 'failed',
      error: message,
    });
    state.activeTab = 'inbox';
    state.auditOpen[auditActivityKey('approval', action.id)] = true;
    replaceToast(toastId, 'error', 'Transaction failed', message);
  }
}

function browserExecutionStartMessage(action: PreparedAction): string {
  switch (action.kind) {
    case 'transfer_sol':
    case 'transfer_spl':
      return `Approve the wallet transaction to send ${amountLabel(action)}.`;
    case 'swap':
      return `Approve the wallet transaction to swap ${amountLabel(action)} ${tokenLabel(action)}.`;
    case 'custom_transaction':
      return 'Approve the wallet transaction to broadcast the provided transaction bytes.';
    default:
      return 'Approve the wallet transaction.';
  }
}

function assertBrowserActionWalletReady(action: PreparedAction): void {
  if (!state.address) {
    throw new Error('Connect the approval wallet before sending this transaction.');
  }
  if (state.address !== action.walletAddress) {
    throw new Error(`Connect ${short(action.walletAddress)} before sending this transaction.`);
  }
  if (action.cluster !== state.cluster) {
    throw new Error(`Switch to ${titleCaseCluster(action.cluster)} before sending this transaction.`);
  }
}

async function executeBrowserPreparedActionRecord(
  action: PreparedAction,
  toastContext: TransactionToastContext,
): Promise<BrowserTransactionExecution> {
  const bridgeExecution = await executeBrowserPreparedActionThroughBridge(action, toastContext);
  if (bridgeExecution) return bridgeExecution;
  switch (action.kind) {
    case 'transfer_sol':
      return executeBrowserSolTransfer(action, toastContext);
    case 'transfer_spl':
      return executeBrowserSplTransfer(action, toastContext);
    case 'swap':
      return executeBrowserSwap(action, toastContext);
    case 'custom_transaction':
      return executeBrowserCustomTransaction(action, toastContext);
    default:
      throw new Error(`Browser workflow cannot broadcast ${action.kind}.`);
  }
}

async function executeBrowserPreparedActionThroughBridge(
  action: PreparedAction,
  toastContext: TransactionToastContext,
): Promise<BrowserTransactionExecution | undefined> {
  if (!canAttemptLocalBridgeForCluster(action.cluster)) return undefined;
  if (!state.bridgeActive && !(await activateBridgeForTransaction(action.cluster))) {
    return undefined;
  }
  if (action.cluster !== state.cluster) return undefined;
  let path = '';
  let body: Record<string, unknown> = {};
  switch (action.kind) {
    case 'transfer_sol':
      path = '/bridge/action/transfer-sol';
      body = {
        recipient: requiredActionParam(action, 'recipient'),
        amountSol: requiredActionParam(action, 'amountSol'),
      };
      break;
    case 'transfer_spl':
      path = '/bridge/action/transfer-spl';
      body = {
        token: requiredActionParam(action, 'token'),
        recipient: requiredActionParam(action, 'recipient'),
        amount: requiredActionParam(action, 'amount'),
      };
      break;
    case 'swap':
      path = '/bridge/action/swap';
      body = {
        inputToken: requiredActionParam(action, 'inputToken'),
        outputToken: requiredActionParam(action, 'outputToken'),
        amount: requiredActionParam(action, 'amount'),
        slippageBps: browserSlippageBps(action),
      };
      break;
    default:
      return undefined;
  }

  const result = await runTransactionToastStep(
    toastContext,
    'Sending transaction',
    'Submitting through the local bridge. Do not approve this request twice.',
    () => bridgeRequest<Record<string, unknown>>(path, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
  const txid = requiredResponseString(result.txid ?? result.signature, 'Bridge transaction signature');
  markBrowserTransactionSubmitted(action, txid);
  const txStatus = await resolveSubmittedTransactionStatus(action.cluster, txid, toastContext);
  return {
    txid,
    txStatus,
    explorerUrl: explorerUrl(txid, action.cluster),
    result,
  };
}

async function executeBrowserSolTransfer(
  action: PreparedAction,
  toastContext: TransactionToastContext,
): Promise<BrowserTransactionExecution> {
  const from = publicKeyFromConnectedWallet();
  const recipient = publicKeyParam(requiredActionParam(action, 'recipient'), 'recipient');
  const amountSol = requiredActionParam(action, 'amountSol');
  const lamports = parseDecimalAmountToRaw(amountSol, 9, 'SOL transfer amount');
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from,
      toPubkey: recipient,
      lamports: rawLamportsToNumber(lamports),
    }),
  );
  addOptionalMemo(transaction, from, stringParam(action, 'memo'));
  const txid = await signAndBroadcastBrowserTransaction(
    action,
    transaction,
    `Transfer ${amountSol} SOL to ${recipient.toBase58()}`,
    toastContext,
  );
  markBrowserTransactionSubmitted(action, txid);
  const txStatus = await resolveSubmittedTransactionStatus(action.cluster, txid, toastContext);
  return {
    txid,
    txStatus,
    explorerUrl: explorerUrl(txid, action.cluster),
  };
}

async function executeBrowserSplTransfer(
  action: PreparedAction,
  toastContext: TransactionToastContext,
): Promise<BrowserTransactionExecution> {
  const token = requiredActionParam(action, 'token');
  const amount = requiredActionParam(action, 'amount');
  if (isNativeSolToken(token)) {
    return executeBrowserSolTransfer({
      ...action,
      kind: 'transfer_sol',
      params: {
        recipient: requiredActionParam(action, 'recipient'),
        amountSol: amount,
        memo: stringParam(action, 'memo'),
      },
    }, toastContext);
  }

  const owner = publicKeyFromConnectedWallet();
  const recipientOwner = publicKeyParam(requiredActionParam(action, 'recipient'), 'recipient');
  const connection = browserActionConnection(action.cluster);
  const tokenMetadata = await resolveBrowserTokenMetadata(connection, token);
  const rawAmount = parseDecimalAmountToRaw(amount, tokenMetadata.decimals, `${tokenMetadata.symbol} amount`);
  const sourceAta = associatedTokenAddress(tokenMetadata.mint, owner, tokenMetadata.tokenProgramId);
  const destinationAta = associatedTokenAddress(tokenMetadata.mint, recipientOwner, tokenMetadata.tokenProgramId);
  const sourceBalance = await connection.getTokenAccountBalance(sourceAta, 'confirmed').catch(() => null);
  if (!sourceBalance || BigInt(sourceBalance.value.amount) < rawAmount) {
    throw new Error(`Insufficient ${tokenMetadata.symbol} balance for ${amount}.`);
  }

  const transaction = new Transaction();
  const destinationAccount = await connection.getAccountInfo(destinationAta, 'confirmed');
  if (!destinationAccount) {
    transaction.add(createAssociatedTokenAccountInstruction(owner, destinationAta, recipientOwner, tokenMetadata));
  }
  transaction.add(createTransferCheckedInstruction(
    sourceAta,
    tokenMetadata.mint,
    destinationAta,
    owner,
    rawAmount,
    tokenMetadata.decimals,
    tokenMetadata.tokenProgramId,
  ));
  addOptionalMemo(transaction, owner, stringParam(action, 'memo'));

  const txid = await signAndBroadcastBrowserTransaction(
    action,
    transaction,
    `Transfer ${amount} ${tokenMetadata.symbol} to ${recipientOwner.toBase58()}`,
    toastContext,
  );
  markBrowserTransactionSubmitted(action, txid);
  const txStatus = await resolveSubmittedTransactionStatus(action.cluster, txid, toastContext);
  return {
    txid,
    txStatus,
    explorerUrl: explorerUrl(txid, action.cluster),
    result: {
      token: tokenMetadata.symbol,
      mint: tokenMetadata.mintText,
      recipient: recipientOwner.toBase58(),
    },
  };
}

async function executeBrowserSwap(
  action: PreparedAction,
  toastContext: TransactionToastContext,
): Promise<BrowserTransactionExecution> {
  const signingClient = requireClient();
  if (state.capabilities?.supports.signTransaction !== true) {
    throw new Error('Selected wallet cannot sign swap transactions from this browser.');
  }
  const taker = state.address;
  const connection = browserActionConnection(action.cluster);
  const inputToken = await resolveBrowserTokenMetadata(connection, requiredActionParam(action, 'inputToken'));
  const outputToken = await resolveBrowserTokenMetadata(connection, requiredActionParam(action, 'outputToken'));
  const amountRaw = parseDecimalAmountToRaw(requiredActionParam(action, 'amount'), inputToken.decimals, `${inputToken.symbol} swap amount`);
  const slippageBps = browserSlippageBps(action);
  recordBrowserActionActivity(action.id, 'browser.swap.order_requested', {
    inputMint: inputToken.mintText,
    outputMint: outputToken.mintText,
    amount: amountRaw.toString(),
    slippageBps: String(slippageBps),
  });
  const order = await runTransactionToastStep(
    toastContext,
    'Preparing swap',
    'Fetching the Jupiter transaction for wallet review.',
    () => hostedSwapRequest('/api/swap/order', {
      inputMint: inputToken.mintText,
      outputMint: outputToken.mintText,
      amount: amountRaw.toString(),
      taker,
      slippageBps,
    }),
  );
  const transactionBase64 = requiredResponseString(order.transaction, 'Jupiter order transaction');
  const requestId = requiredResponseString(order.requestId, 'Jupiter request id');
  recordBrowserActionActivity(action.id, 'browser.swap.order_ready', {
    requestId,
    status: 'ready_to_sign',
  });
  const signed = await runTransactionToastStep(
    toastContext,
    'Signing swap',
    `Sign Jupiter swap ${short(requestId)} in your wallet.`,
    () => signingClient.signTransaction(transactionBase64, {
      cluster: action.cluster,
      summary: `Swap ${requiredActionParam(action, 'amount')} ${inputToken.symbol} to ${outputToken.symbol}`,
    }),
  );
  const executed = await executeSignedJupiterSwapWithRetry(action, signed.signature, order, requestId, toastContext);
  const txid = requiredResponseString(executed.signature ?? executed.txid, 'Jupiter execution signature');
  markBrowserTransactionSubmitted(action, txid);
  const txStatus = await resolveSubmittedTransactionStatus(action.cluster, txid, toastContext);
  return {
    txid,
    txStatus,
    explorerUrl: explorerUrl(txid, action.cluster),
    result: {
      order: orderSummaryForReceipt(order),
      execution: orderSummaryForReceipt(executed),
    },
  };
}

async function executeBrowserCustomTransaction(
  action: PreparedAction,
  toastContext: TransactionToastContext,
): Promise<BrowserTransactionExecution> {
  const transactionBase64 = stringParam(action, 'transactionBase64') ||
    stringParam(action, 'transaction') ||
    stringParam(action, 'base64') ||
    stringParam(action, 'tx');
  if (!transactionBase64) {
    throw new Error('Custom transaction is missing base64 transaction bytes.');
  }
  const txid = await signAndBroadcastBrowserTransactionBase64(
    action,
    transactionBase64,
    action.summary || 'Custom wallet transaction',
    toastContext,
  );
  markBrowserTransactionSubmitted(action, txid);
  const txStatus = await resolveSubmittedTransactionStatus(action.cluster, txid, toastContext);
  return {
    txid,
    txStatus,
    explorerUrl: explorerUrl(txid, action.cluster),
  };
}

async function signAndBroadcastBrowserTransaction(
  action: PreparedAction,
  transaction: Transaction,
  summary: string,
  toastContext: TransactionToastContext,
): Promise<string> {
  const feePayer = publicKeyFromConnectedWallet();
  const latest = await browserLatestBlockhash(action.cluster);
  transaction.feePayer = feePayer;
  transaction.recentBlockhash = latest.blockhash;
  const transactionBase64 = encodeBase64(
    transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }),
  );
  return signAndBroadcastBrowserTransactionBase64(action, transactionBase64, summary, toastContext);
}

async function signAndBroadcastBrowserTransactionBase64(
  action: PreparedAction,
  transactionBase64: string,
  summary: string,
  toastContext: TransactionToastContext,
): Promise<string> {
  const signingClient = requireClient();
  if (state.capabilities?.supports.signTransaction === true) {
    const signed = await runTransactionToastStep(
      toastContext,
      'Signing transaction',
      summary,
      () => signingClient.signTransaction(transactionBase64, {
        cluster: action.cluster,
        summary,
      }),
    );
    return broadcastSignedBrowserTransactionWithRetry(action.cluster, signed.signature, toastContext);
  }
  if (state.capabilities?.supports.signAndSendTransaction === true) {
    const result = await runTransactionToastStep(
      toastContext,
      'Signing and sending transaction',
      `${summary}. This wallet path cannot be safely retried without a returned transaction id.`,
      () => signingClient.signAndSendTransaction(transactionBase64, {
        cluster: action.cluster,
        summary,
      }),
    );
    const txid = result.txid ?? result.signature;
    updateTransactionToast(toastContext, 'pending', 'Confirming transaction', short(txid), txid);
    return txid;
  }
  throw new Error('Selected wallet cannot sign and send transactions from this browser.');
}

async function executeSignedJupiterSwapWithRetry(
  action: PreparedAction,
  signedTransactionBase64: string,
  order: Record<string, unknown>,
  requestId: string,
  toastContext: TransactionToastContext,
): Promise<Record<string, unknown>> {
  const signedTxid = signedTransactionId(signedTransactionBase64);
  let lastError: unknown;
  for (let attempt = 1; attempt <= TX_RETRY_MAX_ATTEMPTS; attempt += 1) {
    const knownStatus = await transactionStatusSeenForRetry(action.cluster, signedTxid);
    if (knownStatus) {
      updateTransactionToast(toastContext, 'pending', 'Transaction already submitted', short(signedTxid), signedTxid);
      return { signature: signedTxid, status: knownStatus };
    }

    updateTransactionToast(
      toastContext,
      'pending',
      attempt === 1 ? 'Sending swap transaction' : 'Retrying swap transaction',
      attempt === 1
        ? 'Submitting the signed swap through Jupiter.'
        : `Retry ${attempt} of ${TX_RETRY_MAX_ATTEMPTS} with the same signed transaction.`,
      signedTxid,
    );

    try {
      const executed = await hostedSwapRequest('/api/swap/execute', {
        signedTransaction: signedTransactionBase64,
        requestId,
        ...(typeof order.lastValidBlockHeight === 'string' || typeof order.lastValidBlockHeight === 'number'
          ? { lastValidBlockHeight: order.lastValidBlockHeight }
          : {}),
      });
      assertJupiterExecutionSucceeded(executed);
      const txid = requiredResponseString(executed.signature ?? executed.txid, 'Jupiter execution signature');
      updateTransactionToast(toastContext, 'pending', 'Confirming swap transaction', short(txid), txid);
      return executed;
    } catch (err) {
      lastError = err;
      const landedStatus = await transactionStatusSeenForRetry(action.cluster, signedTxid);
      if (landedStatus) {
        updateTransactionToast(toastContext, 'pending', 'Transaction already submitted', short(signedTxid), signedTxid);
        return { signature: signedTxid, status: landedStatus };
      }
      if (attempt >= TX_RETRY_MAX_ATTEMPTS || !shouldRetryTransactionSend(err)) {
        break;
      }
      await waitBeforeTransactionRetry(toastContext, err, attempt, signedTxid);
    }
  }

  if (lastError && isPossiblySubmittedTransactionError(lastError)) {
    await waitBeforeTransactionRetry(toastContext, lastError, TX_RETRY_MAX_ATTEMPTS, signedTxid);
    return { signature: signedTxid, status: await finalTransactionStatusOrPending(action.cluster, signedTxid) };
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Jupiter swap execution failed.'));
}

async function broadcastSignedBrowserTransactionWithRetry(
  cluster: Cluster,
  signedTransactionBase64: string,
  toastContext: TransactionToastContext,
): Promise<string> {
  const signedTxid = signedTransactionId(signedTransactionBase64);
  let lastError: unknown;
  for (let attempt = 1; attempt <= TX_RETRY_MAX_ATTEMPTS; attempt += 1) {
    const knownStatus = await transactionStatusSeenForRetry(cluster, signedTxid);
    if (knownStatus) {
      updateTransactionToast(toastContext, 'pending', 'Transaction already submitted', short(signedTxid), signedTxid);
      return signedTxid;
    }

    updateTransactionToast(
      toastContext,
      'pending',
      attempt === 1 ? 'Sending transaction' : 'Retrying transaction send',
      attempt === 1
        ? 'Broadcasting the signed transaction to Solana RPC.'
        : `Retry ${attempt} of ${TX_RETRY_MAX_ATTEMPTS} with the same signed transaction.`,
      signedTxid,
    );

    try {
      const txid = await broadcastSignedBrowserTransaction(cluster, signedTransactionBase64);
      updateTransactionToast(toastContext, 'pending', 'Confirming transaction', short(txid), txid);
      return txid;
    } catch (err) {
      lastError = err;
      const landedStatus = await transactionStatusSeenForRetry(cluster, signedTxid);
      if (landedStatus) {
        updateTransactionToast(toastContext, 'pending', 'Transaction already submitted', short(signedTxid), signedTxid);
        return signedTxid;
      }
      if (attempt >= TX_RETRY_MAX_ATTEMPTS || !shouldRetryTransactionSend(err)) {
        break;
      }
      await waitBeforeTransactionRetry(toastContext, err, attempt, signedTxid);
    }
  }

  if (lastError && isPossiblySubmittedTransactionError(lastError)) {
    await waitBeforeTransactionRetry(toastContext, lastError, TX_RETRY_MAX_ATTEMPTS, signedTxid);
    await finalTransactionStatusOrPending(cluster, signedTxid);
    return signedTxid;
  }
  throw lastError instanceof Error ? lastError : new Error('Transaction broadcast failed.');
}

async function resolveSubmittedTransactionStatus(
  cluster: Cluster,
  txid: string,
  toastContext?: TransactionToastContext,
): Promise<PreparedActionTxStatus> {
  const deadline = Date.now() + TX_CONFIRMATION_POLL_TIMEOUT_MS;
  void toastContext;
  while (true) {
    const status = await browserSignatureStatus(cluster, txid);
    if (status.txStatus === 'failed') {
      throw new Error(`Transaction ${short(txid)} failed on-chain: ${status.error ?? status.confirmationStatus ?? 'failed'}`);
    }
    if (status.txStatus === 'confirmed') {
      return 'confirmed';
    }
    if (Date.now() >= deadline) {
      return 'pending';
    }
    await sleep(Math.min(TX_CONFIRMATION_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
}

function completeBrowserExecutedAction(action: PreparedAction, execution: BrowserTransactionExecution): void {
  const completedAt = new Date().toISOString();
  const updatedAction: PreparedAction = {
    ...action,
    status: 'approved',
    txStatus: execution.txStatus,
    txid: execution.txid,
    txError: undefined,
    error: undefined,
    updatedAt: completedAt,
    confirmedAt: execution.txStatus === 'confirmed' ? completedAt : undefined,
  };
  const receipt: ActionReceipt = {
    actionId: action.id,
    status: 'approved',
    txStatus: execution.txStatus,
    txid: execution.txid,
    explorerUrl: execution.explorerUrl,
    summary: action.summary,
    note: action.note,
    walletAddress: action.walletAddress,
    recipient: recipientParam(action) || undefined,
    amount: amountLabel(action) === 'n/a' ? undefined : amountLabel(action),
    token: tokenLabel(action) === 'n/a' ? undefined : tokenLabel(action),
    cluster: action.cluster,
    createdAt: action.createdAt,
    completedAt,
    ...(action.recurringId && { recurringId: action.recurringId }),
    ...(action.occurrenceKey && { occurrenceKey: action.occurrenceKey }),
  };
  state.preparedActions = mergePreparedActions([updatedAction], state.preparedActions);
  state.materializedActions = state.preparedActions;
  state.receipts = mergeActionReceipts([receipt], state.receipts);
  saveBrowserWorkflowState();
}

function updateBrowserPreparedAction(actionId: string, patch: Partial<PreparedAction>): PreparedAction {
  const updatedAt = new Date().toISOString();
  let updated: PreparedAction | undefined;
  state.preparedActions = state.preparedActions.map((candidate) => {
    if (candidate.id !== actionId) return candidate;
    updated = {
      ...candidate,
      ...patch,
      updatedAt,
    };
    return updated;
  });
  state.materializedActions = state.preparedActions;
  saveBrowserWorkflowState();
  if (!updated) {
    throw new Error(`Approval request ${actionId} was not found.`);
  }
  return updated;
}

function recordBrowserActionActivity(actionId: string, eventType: string, metadata: JsonObject): void {
  const key = auditActivityKey('approval', actionId);
  const now = new Date().toISOString();
  const current = state.auditActivity[key];
  const event: WorkflowAuditEventRecord = {
    id: newId('browser-audit'),
    walletAddress: state.address || state.preparedActions.find((action) => action.id === actionId)?.walletAddress || '',
    type: eventType,
    eventType,
    recordType: 'approval',
    recordId: actionId,
    subjectType: 'approval',
    subjectId: actionId,
    createdAt: now,
    metadata,
  };
  state.auditActivity[key] = {
    status: 'loaded',
    events: [event, ...(current?.events ?? [])].slice(0, 25),
    loadedAt: now,
  };
}

function markBrowserTransactionSubmitted(action: PreparedAction, txid: string): void {
  updateBrowserPreparedAction(action.id, {
    status: 'approval_pending',
    txStatus: 'pending',
    txid,
    txError: undefined,
    error: undefined,
  });
  recordBrowserActionActivity(action.id, 'browser.transaction.submitted', {
    kind: action.kind,
    status: 'pending',
    txid,
  });
}

async function runTransactionToastStep<T>(
  toastContext: TransactionToastContext,
  title: string,
  message: string,
  task: () => Promise<T>,
): Promise<T> {
  updateTransactionToast(toastContext, 'pending', title, message);
  return task();
}

function updateTransactionToast(
  toastContext: TransactionToastContext,
  kind: ToastKind,
  title: string,
  message: string,
  txid?: string,
): void {
  replaceToast(toastContext.toastId, kind, title, message, {
    linkHref: txid ? explorerUrl(txid, toastContext.cluster) : undefined,
    linkLabel: txid ? 'Open Solscan' : undefined,
  });
}

async function waitBeforeTransactionRetry(
  toastContext: TransactionToastContext,
  err: unknown,
  attempt: number,
  txid: string,
): Promise<void> {
  const message = redactSecrets(err instanceof Error ? err.message : String(err));
  updateTransactionToast(
    toastContext,
    'pending',
    attempt >= TX_RETRY_MAX_ATTEMPTS ? 'Checking transaction status' : 'Send retry queued',
    attempt >= TX_RETRY_MAX_ATTEMPTS
      ? `Checking ${short(txid)} before reporting the final status.`
      : `First send failed: ${message}. Retrying in ${Math.round(TX_RETRY_DELAY_MS / 1000)} seconds with the same signed transaction.`,
    txid,
  );
  await sleep(TX_RETRY_DELAY_MS);
}

async function transactionStatusSeenForRetry(
  cluster: Cluster,
  txid: string,
): Promise<PreparedActionTxStatus | null> {
  const status = await browserSignatureStatus(cluster, txid).catch(() => null);
  if (!status) return null;
  if (status.txStatus === 'failed') {
    throw new Error(`Transaction ${short(txid)} failed on-chain: ${status.error ?? status.confirmationStatus ?? 'failed'}`);
  }
  if (status.txStatus === 'confirmed') {
    return 'confirmed';
  }
  return status.confirmationStatus ? 'pending' : null;
}

async function finalTransactionStatusOrPending(
  cluster: Cluster,
  txid: string,
): Promise<PreparedActionTxStatus> {
  const deadline = Date.now() + TX_RETRY_DELAY_MS;
  while (Date.now() < deadline) {
    const status = await browserSignatureStatus(cluster, txid).catch(() => null);
    if (status?.txStatus === 'failed') {
      throw new Error(`Transaction ${short(txid)} failed on-chain: ${status.error ?? status.confirmationStatus ?? 'failed'}`);
    }
    if (status?.txStatus === 'confirmed') {
      return 'confirmed';
    }
    if (status?.txStatus === 'pending' && status.confirmationStatus) {
      return 'pending';
    }
    await sleep(500);
  }
  return 'pending';
}

function signedTransactionId(signedTransactionBase64: string): string {
  const bytes = decodeBase64(signedTransactionBase64);
  try {
    const transaction = Transaction.from(bytes);
    const signature = transaction.signatures.find((entry) => entry.signature)?.signature;
    if (signature && !isZeroSignature(signature)) {
      return bs58.encode(signature);
    }
  } catch {
    // Try versioned transaction parsing below.
  }
  try {
    const transaction = VersionedTransaction.deserialize(bytes);
    const signature = transaction.signatures.find((entry) => !isZeroSignature(entry));
    if (signature) {
      return bs58.encode(signature);
    }
  } catch {
    // Fall through to a clear error.
  }
  throw new Error('Wallet returned signed transaction bytes without a readable transaction signature.');
}

function isZeroSignature(signature: Uint8Array): boolean {
  return signature.every((byte) => byte === 0);
}

function shouldRetryTransactionSend(err: unknown): boolean {
  return isPossiblySubmittedTransactionError(err) && !isDefiniteTransactionFailure(err);
}

function isPossiblySubmittedTransactionError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /timeout|timed out|network|failed to fetch|fetch failed|temporar|rate|429|500|502|503|504|gateway|service unavailable|block height|confirmation|not confirmed|node is behind|already processed|already been processed/.test(message);
}

function isDefiniteTransactionFailure(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /user rejected|rejected|denied|cancelled|canceled|insufficient|invalid|malformed|signature verification failed|blockhash not found|expired|slippage|unauthorized|not configured|missing .*key|simulation failed|custom program error/.test(message);
}

async function browserLatestBlockhash(cluster: Cluster): Promise<BrowserLatestBlockhash> {
  let bridgeError: unknown;
  if (canAttemptLocalBridgeForCluster(cluster)) {
    try {
      return await bridgeRequest<BrowserLatestBlockhash>('/bridge/solana/latest-blockhash', {
        method: 'POST',
        body: JSON.stringify({ cluster }),
      });
    } catch (err) {
      bridgeError = err;
      if (state.bridgeActive) throw err;
    }
  }
  try {
    return await sameOriginTransactionRequest<BrowserLatestBlockhash>('/api/solana/latest-blockhash', { cluster });
  } catch (err) {
    if (canUseDirectBrowserRpc(cluster)) {
      return browserActionConnection(cluster).getLatestBlockhash('confirmed');
    }
    if (bridgeError) throw transactionApiUnavailableError(bridgeError);
    throw transactionApiUnavailableError(err);
  }
}

async function broadcastSignedBrowserTransaction(cluster: Cluster, signedTransactionBase64: string): Promise<string> {
  const request = { cluster, signedTransactionBase64 };
  let bridgeError: unknown;
  if (canAttemptLocalBridgeForCluster(cluster)) {
    try {
      const response = await bridgeRequest<BrowserSendTransactionResponse>('/bridge/solana/send-transaction', {
        method: 'POST',
        body: JSON.stringify(request),
      });
      return requiredResponseString(response.txid ?? response.signature, 'Bridge transaction signature');
    } catch (err) {
      bridgeError = err;
      if (state.bridgeActive) throw err;
    }
  }
  try {
    const response = await sameOriginTransactionRequest<BrowserSendTransactionResponse>('/api/solana/send-transaction', request);
    return requiredResponseString(response.txid ?? response.signature, 'Transaction signature');
  } catch (err) {
    if (canUseDirectBrowserRpc(cluster)) {
      return browserActionConnection(cluster).sendRawTransaction(decodeBase64(signedTransactionBase64), {
        preflightCommitment: 'confirmed',
        maxRetries: 5,
      });
    }
    if (bridgeError) throw transactionApiUnavailableError(bridgeError);
    throw transactionApiUnavailableError(err);
  }
}

async function browserSignatureStatus(cluster: Cluster, txid: string): Promise<BrowserSignatureStatusResponse> {
  const request = { cluster, txid };
  let bridgeError: unknown;
  if (canAttemptLocalBridgeForCluster(cluster)) {
    try {
      return await bridgeRequest<BrowserSignatureStatusResponse>('/bridge/solana/signature-status', {
        method: 'POST',
        body: JSON.stringify(request),
      });
    } catch (err) {
      bridgeError = err;
      if (state.bridgeActive) throw err;
    }
  }
  try {
    return await sameOriginTransactionRequest<BrowserSignatureStatusResponse>('/api/solana/signature-status', request);
  } catch (err) {
    if (canUseDirectBrowserRpc(cluster)) {
      const status = (await browserActionConnection(cluster).getSignatureStatuses([txid], {
        searchTransactionHistory: true,
      })).value[0];
      if (!status) return { txStatus: 'pending' };
      if (status.err) return { txStatus: 'failed', confirmationStatus: status.confirmationStatus ?? undefined, error: stableJson(status.err) };
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return { txStatus: 'confirmed', confirmationStatus: status.confirmationStatus };
      }
      return { txStatus: 'pending', confirmationStatus: status.confirmationStatus ?? undefined };
    }
    if (bridgeError) throw transactionApiUnavailableError(bridgeError);
    throw transactionApiUnavailableError(err);
  }
}

async function sameOriginTransactionRequest<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {
    throw new Error('Agentic transaction APIs are not reachable from this page.');
  });
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error(transactionApiUnavailableMessage());
  }
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    throw new Error(cloudErrorMessage(payload, response.status));
  }
  if (payload === null) {
    throw new Error(transactionApiUnavailableMessage());
  }
  return payload as T;
}

function canUseDirectBrowserRpc(cluster: Cluster): boolean {
  return cluster !== 'mainnet-beta';
}

function canAttemptLocalBridgeForCluster(cluster: Cluster): boolean {
  return Boolean(state.bridgeToken) &&
    isLoopbackBridgeUrl(state.bridgeUrl) &&
    cluster === state.cluster;
}

async function activateBridgeForTransaction(cluster: Cluster): Promise<boolean> {
  if (!state.address || !state.capabilities || !canAttemptLocalBridgeForCluster(cluster)) {
    return false;
  }
  try {
    await activateBridgeConnection({ refreshConfig: true, strictSync: false });
    return state.bridgeActive && state.cluster === cluster;
  } catch (err) {
    state.bridgeActive = false;
    stopBridgePolling();
    state.bridgeStatus = err instanceof Error ? err.message : String(err);
    return false;
  }
}

function transactionApiUnavailableError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/not_found|not available|not reachable|transaction APIs/i.test(message)) {
    return new Error(transactionApiUnavailableMessage());
  }
  return new Error(message);
}

function transactionApiUnavailableMessage(): string {
  if (isLocalBrowserHost()) {
    return `Local transaction RPC is not connected. Start ${NPM_EXEC_COMMAND}, keep the bridge terminal open, open the printed local app URL, then approve again.`;
  }
  return 'Transaction RPC requires the hosted transaction API or a connected local bridge. This is separate from AI sign-in.';
}

function swapApiUnavailableMessage(): string {
  if (isLocalBrowserHost()) {
    return `Local swap execution is not connected. Start ${NPM_EXEC_COMMAND}, keep the bridge terminal open, open the printed local app URL, then approve again.`;
  }
  return 'Swap execution requires the hosted swap API or a connected local bridge. This is separate from AI sign-in.';
}

function isLocalBrowserHost(): boolean {
  const host = window.location.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function browserActionConnection(cluster: Cluster): Connection {
  return new Connection(cluster === state.cluster ? activeRpcUrl() : defaultRpcUrl(cluster), 'confirmed');
}

function requiredActionParam(action: PreparedAction, key: string): string {
  const value = stringParam(action, key).trim();
  if (!value) {
    throw new Error(`Approval ${short(action.id)} is missing ${key}.`);
  }
  return value;
}

function publicKeyParam(value: string, label: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${label} is not a valid Solana address.`);
  }
}

function isNativeSolToken(token: string): boolean {
  const normalized = token.trim();
  return normalized.toUpperCase() === 'SOL' || normalized === WSOL_MINT;
}

async function resolveBrowserTokenMetadata(connection: Connection, token: string): Promise<BrowserTokenMetadata> {
  const known = KNOWN_BROWSER_TOKENS[token.trim().toUpperCase()];
  const mintText = known?.mint ?? token.trim();
  const symbol = known?.symbol ?? tokenDisplayLabel(mintText);
  if (isNativeSolToken(token)) {
    return {
      symbol: 'SOL',
      mint: new PublicKey(WSOL_MINT),
      mintText: WSOL_MINT,
      decimals: 9,
      tokenProgramId: TOKEN_PROGRAM_ID,
    };
  }
  const mint = publicKeyParam(mintText, 'token mint');
  const account = await connection.getParsedAccountInfo(mint, 'confirmed').catch(() => null);
  const owner = account?.value?.owner;
  const tokenProgramId = owner?.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const parsedData = account?.value?.data;
  const parsed = parsedData && typeof parsedData === 'object' && 'parsed' in parsedData
    ? parsedData.parsed as { info?: { decimals?: unknown } }
    : undefined;
  const decimals = known?.decimals ?? (typeof parsed?.info?.decimals === 'number' ? parsed.info.decimals : undefined);
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`Could not read decimals for token ${tokenDisplayLabel(mintText)}.`);
  }
  return {
    symbol,
    mint,
    mintText: mint.toBase58(),
    decimals,
    tokenProgramId,
  };
}

function associatedTokenAddress(mint: PublicKey, owner: PublicKey, tokenProgramId: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

function createAssociatedTokenAccountInstruction(
  payer: PublicKey,
  associatedToken: PublicKey,
  owner: PublicKey,
  token: BrowserTokenMetadata,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: token.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: token.tokenProgramId, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array() as unknown as InstructionData,
  });
}

function createTransferCheckedInstruction(
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint,
  decimals: number,
  tokenProgramId: PublicKey,
): TransactionInstruction {
  const data = new Uint8Array(10);
  data[0] = 12;
  writeBigUint64Le(data, amount, 1);
  data[9] = decimals;
  return new TransactionInstruction({
    programId: tokenProgramId,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: data as unknown as InstructionData,
  });
}

function addOptionalMemo(transaction: Transaction, signer: PublicKey, memo: string): void {
  const trimmed = memo.trim();
  if (!trimmed) return;
  transaction.add(new TransactionInstruction({
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM_ID,
    data: new TextEncoder().encode(trimmed.slice(0, 500)) as unknown as InstructionData,
  }));
}

function browserSlippageBps(action: PreparedAction): number {
  const raw = action.params.slippageBps;
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 50;
  return Math.trunc(parsed);
}

async function hostedSwapRequest(path: '/api/swap/order' | '/api/swap/execute', body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error(swapApiUnavailableMessage());
  }
  const payload = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new Error(cloudErrorMessage(payload, response.status));
  }
  return cloudResponseObject(payload, 'swap response');
}

function requiredResponseString(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  throw new Error(`${label} was missing.`);
}

function assertJupiterExecutionSucceeded(executed: Record<string, unknown>): void {
  const status = typeof executed.status === 'string' ? executed.status.toLowerCase() : '';
  const error = executed.error ?? executed.errorMessage ?? executed.message;
  if (status && status !== 'success' && status !== 'succeeded' && status !== 'submitted') {
    throw new Error(`Jupiter execute failed: ${typeof error === 'string' ? error : stableJson(executed)}`);
  }
  if (typeof error === 'string' && error.trim() && !executed.signature && !executed.txid) {
    throw new Error(`Jupiter execute failed: ${error}`);
  }
}

function orderSummaryForReceipt(value: Record<string, unknown>): Record<string, unknown> {
  return stripUndefined({
    status: value.status,
    mode: value.mode,
    router: value.router,
    requestId: value.requestId,
    inputMint: value.inputMint,
    outputMint: value.outputMint,
    inAmount: value.inAmount,
    outAmount: value.outAmount,
    slippageBps: value.slippageBps,
    signature: value.signature ?? value.txid,
    error: value.error ?? value.errorMessage,
  }) as Record<string, unknown>;
}

function parseDecimalAmountToRaw(value: string, decimals: number, label: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`${label} must be a positive decimal string.`);
  }
  const [wholeRaw = '0', fractionRaw = ''] = trimmed.split('.');
  if (fractionRaw.length > decimals) {
    throw new Error(`${label} has too many decimal places for a ${decimals}-decimal token.`);
  }
  const whole = BigInt(wholeRaw);
  const fraction = BigInt((fractionRaw || '').padEnd(decimals, '0') || '0');
  const amount = whole * (10n ** BigInt(decimals)) + fraction;
  if (amount <= 0n) {
    throw new Error(`${label} must be greater than zero.`);
  }
  return amount;
}

function rawLamportsToNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('SOL amount is too large for this browser transaction builder.');
  }
  return Number(value);
}

function writeBigUint64Le(target: Uint8Array, value: bigint, offset: number): void {
  let remaining = value;
  for (let index = 0; index < 8; index += 1) {
    target[offset + index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function pushTransactionToast(kind: ToastKind, title: string, txid: string, cluster: Cluster): number {
  return pushToast(kind, title, short(txid), {
    linkHref: explorerUrl(txid, cluster),
    linkLabel: 'Open Solscan',
  });
}

function completeBrowserPreparedAction(
  action: PreparedAction,
  status: Extract<PreparedActionStatus, 'approved' | 'rejected'>,
  proofSignature: string,
): void {
  const completedAt = new Date().toISOString();
  const updatedAction: PreparedAction = {
    ...action,
    status,
    updatedAt: completedAt,
    confirmedAt: completedAt,
  };
  const receipt: ActionReceipt = {
    actionId: action.id,
    status,
    summary: action.summary,
    note: action.note,
    walletAddress: action.walletAddress,
    recipient: stringParam(action, 'recipient') || undefined,
    amount: amountLabel(action) === 'n/a' ? undefined : amountLabel(action),
    token: tokenLabel(action) === 'n/a' ? undefined : tokenLabel(action),
    cluster: action.cluster,
    createdAt: action.createdAt,
    completedAt,
    proofSignature,
    ...(action.recurringId && { recurringId: action.recurringId }),
    ...(action.occurrenceKey && { occurrenceKey: action.occurrenceKey }),
  };
  state.preparedActions = mergePreparedActions([updatedAction], state.preparedActions);
  state.materializedActions = state.preparedActions;
  state.receipts = mergeActionReceipts([receipt], state.receipts);
  saveBrowserWorkflowState();
}

async function loadCloudRecurringHistory(recurringId: string, cursor?: string): Promise<void> {
  const current = state.recurringOccurrenceHistory[recurringId];
  const response = await cloudRecurringOccurrences(recurringId, cursor);
  state.recurringOccurrenceHistory[recurringId] = {
    occurrences: cursor
      ? [...(current?.occurrences ?? []), ...response.occurrences]
      : response.occurrences,
    ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
    loadedAt: new Date().toISOString(),
  };
}

async function loadCloudRecurringNotifications(recurringId: string): Promise<void> {
  state.recurringNotificationStatus[recurringId] = await cloudRecurringNotifications(recurringId);
}

function browserRecurringHistory(recurringId: string): RecurringOccurrenceHistoryItem[] {
  return state.preparedActions
    .filter((action) => action.recurringId === recurringId)
    .map((action) => {
      const status: WorkflowRecurringOccurrenceRecord['status'] = action.status === 'approved'
        ? 'completed'
        : action.status === 'rejected' || action.status === 'cancelled'
          ? 'cancelled'
          : action.status === 'failed' || action.status === 'blocked' || action.status === 'expired'
            ? 'failed'
            : 'approval_pending';
      return {
        id: action.id,
        recurringScheduleId: recurringId,
        walletAddress: action.walletAddress,
        cluster: action.cluster,
        status,
        occurrenceKey: action.occurrenceKey ?? action.id,
        dueAt: action.dueAt,
        createdAt: action.createdAt,
        updatedAt: action.updatedAt,
        ...(action.error ? { error: action.error } : {}),
        statusLabel: formatOccurrenceStatus(status, {
          status: action.status,
          ...(action.txStatus ? { txStatus: action.txStatus } : {}),
        }),
        approval: {
          id: action.id,
          status: action.status,
          ...(action.confirmedAt ? { decidedAt: action.confirmedAt } : {}),
          ...(action.txid ? { txid: action.txid } : {}),
          ...(action.txStatus ? { txStatus: action.txStatus } : {}),
        },
      } satisfies RecurringOccurrenceHistoryItem;
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function runRecurringOp(recurringId: string, op: string, cursor?: string): Promise<void> {
  const payment = state.recurringPayments.find((candidate) => candidate.id === recurringId);
  const source = payment
    ? recurringPaymentWorkflowSource(payment)
    : isBrowserWorkflowId(recurringId)
      ? 'browser'
      : activeWorkflowMode() === 'agentic-cloud'
        ? 'cloud'
        : 'local-bridge';

  if (source === 'browser') {
    await run('inbox', async () => {
      if (op === 'history' || op === 'history-more') {
        state.recurringOccurrenceHistory[recurringId] = {
          occurrences: browserRecurringHistory(recurringId),
          loadedAt: new Date().toISOString(),
        };
        pushToast('success', 'Repeat history loaded', recurringId);
        return;
      }
      runBrowserRecurringOp(recurringId, op);
    });
    return;
  }

  if (source === 'cloud') {
    await run('inbox', async () => {
      switch (op) {
        case 'pause':
          await cloudPauseRecurring(recurringId);
          break;
        case 'resume':
          await cloudResumeRecurring(recurringId);
          break;
        case 'history':
          await loadCloudRecurringHistory(recurringId);
          break;
        case 'history-more':
          await loadCloudRecurringHistory(recurringId, cursor);
          break;
        case 'notifications':
          await loadCloudRecurringNotifications(recurringId);
          break;
        case 'rotate-secret': {
          const response = await cloudRotateRecurringWebhookSecret(recurringId);
          if (response.webhookSecretOnce) {
            state.recurringWebhookSecretOnce = {
              scheduleId: response.schedule.id,
              secret: response.webhookSecretOnce,
              createdAt: new Date().toISOString(),
            };
          }
          await loadCloudRecurringNotifications(recurringId).catch(() => undefined);
          break;
        }
        case 'delete':
          await cloudDeleteRecurring(recurringId);
          break;
        default:
          throw new Error(`Unknown recurring operation: ${op}`);
      }
      if (op !== 'history' && op !== 'history-more' && op !== 'notifications') {
        await refreshCloudWorkspaceData();
      }
      pushToast(
        'success',
        op === 'delete'
          ? 'Deleted permanently'
          : op.startsWith('history')
            ? 'Repeat history loaded'
            : op === 'notifications'
              ? 'Notifications loaded'
              : op === 'rotate-secret'
                ? 'Webhook secret rotated'
                : `Repeat ${op}`,
        recurringId,
      );
    });
    return;
  }

  await run('inbox', async () => {
    if (op === 'history' || op === 'history-more') {
      state.recurringOccurrenceHistory[recurringId] = {
        occurrences: browserRecurringHistory(recurringId),
        loadedAt: new Date().toISOString(),
      };
      pushToast('success', 'Repeat history loaded', recurringId);
      return;
    }
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
    pushToast('success', op === 'delete' ? 'Deleted permanently' : `Repeat ${op}`, recurringId);
  });
}

function runBrowserRecurringOp(recurringId: string, op: string): void {
  const payment = state.recurringPayments.find((candidate) => (
    candidate.id === recurringId && recurringPaymentWorkflowSource(candidate) === 'browser'
  ));
  if (!payment) {
    throw new Error('Repeat payment was not found.');
  }
  const updatedAt = new Date().toISOString();
  switch (op) {
    case 'pause':
      state.recurringPayments = mergeRecurringPayments([{ ...payment, status: 'paused', updatedAt }], state.recurringPayments);
      saveBrowserWorkflowState();
      pushToast('success', 'Repeat paused', recurringId);
      return;
    case 'resume':
      state.recurringPayments = mergeRecurringPayments([{ ...payment, status: 'active', updatedAt }], state.recurringPayments);
      saveBrowserWorkflowState();
      pushToast('success', 'Repeat resumed', recurringId);
      return;
    case 'delete':
      state.recurringPayments = state.recurringPayments.filter((candidate) => candidate.id !== recurringId);
      state.preparedActions = state.preparedActions.filter((candidate) => candidate.recurringId !== recurringId || isTerminalPreparedAction(candidate));
      state.materializedActions = state.preparedActions;
      saveBrowserWorkflowState();
      pushToast('success', 'Deleted permanently', recurringId);
      return;
    default:
      throw new Error(`Unknown recurring operation: ${op}`);
  }
}

async function runCreateLabArtifact(): Promise<void> {
  await run('lab', async () => {
    const lab = activeLab();
    const fieldValues = isPublicReceiptLab(lab) ? readReceiptFieldValues(lab) : {};
    validateLabForSigning(lab, fieldValues);
    const input = isPublicReceiptLab(lab) ? receiptInputSummary(lab, fieldValues) : labInput(lab.id).trim();
    const { archiveResult } = await signAndArchiveEvidenceReceipt({
      lab,
      input,
      fieldValues,
      signSummary: isPublicReceiptLab(lab) ? lab.title : `${lab.title} evidence`,
    });
    clearActiveLabDraft();
    state.artifactFilter = 'all';
    state.artifactTypeFilter = 'all';
    state.artifactSearch = '';
    state.listPages.receiptArchive = 1;
    state.artifactView = 'signed';
    pushToast(
      'success',
      isPublicReceiptLab(lab) ? 'Receipt signed' : 'Evidence signed',
      archiveLabArtifactToastDetail(archiveResult, lab),
    );
  });
}

async function signAndArchiveEvidenceReceipt(input: {
  lab: LabDefinition;
  input: string;
  fieldValues: Record<string, string>;
  metadata?: JsonObject;
  signSummary?: string;
}): Promise<{ artifact: LabArtifact; archiveResult: ArchiveLabArtifactResult }> {
  const signingClient = requireClient();
  const createdAt = new Date().toISOString();
  const payload = await labPayload(input.lab.id, input.input, createdAt, input.fieldValues);
  const id = newId(input.lab.id.slice(0, 3).replace(/[^a-z]/g, '') || 'lab');
  const unsigned = {
    version: 'labs-ui-v1',
    id,
    labId: input.lab.id,
    kind: input.lab.kind,
    createdAt,
    walletAddress: state.address,
    cluster: state.cluster,
    title: input.lab.title,
    input: input.input,
    payload,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
  const preSignatureHash = await sha256(stableJson(unsigned));
  const signingMessage = receiptProofSigningMessage(input, id, preSignatureHash);
  const result = await signingClient.signMessage(signingMessage, signOptions(input.signSummary ?? input.lab.title));
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
  const archiveResult = await archiveLabArtifact(artifact);
  return { artifact, archiveResult };
}

function receiptProofSigningMessage(
  input: {
    lab: LabDefinition;
    input: string;
    fieldValues: Record<string, string>;
    metadata?: JsonObject;
  },
  id: string,
  preSignatureHash: string,
): string {
  const proofUseCase = typeof input.metadata?.proofUseCase === 'string'
    ? input.metadata.proofUseCase.replace(/_/g, ' ')
    : input.lab.title;
  const fieldLines = (input.lab.fields ?? [])
    .map((field) => {
      const value = input.fieldValues[field.id]?.trim();
      return value ? `${field.label}: ${value}` : '';
    })
    .filter(Boolean);
  return [
    'Solana Agent Wallet Adapter',
    `Saved proof: ${input.lab.title}`,
    `Use case: ${proofUseCase}`,
    `Receipt: ${id}`,
    `Wallet: ${state.address}`,
    `Cluster: ${state.cluster}`,
    'What was requested:',
    input.input || '(no request text)',
    'Receipt fields:',
    ...(fieldLines.length ? fieldLines : ['(no receipt fields)']),
    'What this proves:',
    input.lab.whatThisProves ?? input.lab.summary ?? 'Wallet signed this evidence receipt.',
    'Effect: evidence only; no transaction submitted; no custody or delegated authority granted.',
    `Pre-signature hash: ${preSignatureHash}`,
  ].join('\n');
}

async function runInlineReceiptProof(actionId: string, proofKind: InlineReceiptKind): Promise<void> {
  const action = state.preparedActions.find((candidate) => candidate.id === actionId);
  if (!action) {
    pushToast('error', 'Approval not found', actionId);
    return;
  }
  await run('lab', async () => {
    if (!state.address || state.address !== action.walletAddress) {
      throw new Error('Connect the approval wallet before signing this receipt.');
    }
    const lab = labById(receiptLabIdForInlineKind(proofKind));
    if (!lab) throw new Error('Receipt type is not available.');
    const fieldValues = inlineReceiptFieldValues(action, proofKind);
    const receiptInput = receiptInputSummary(lab, fieldValues);
    const { archiveResult } = await signAndArchiveEvidenceReceipt({
      lab,
      input: receiptInput,
      fieldValues,
      metadata: inlineReceiptMetadata(action, proofKind),
      signSummary: `${lab.title} for ${short(action.id)}`,
    });
    delete state.auditActivity[auditActivityKey('approval', action.id)];
    if (proofKind === 'rejection' && !isTerminalPreparedAction(action)) {
      await rejectPreparedActionAfterReceiptProof(action);
      pushToast('success', 'Request denied with proof', archiveLabArtifactToastDetail(archiveResult, lab));
      return;
    }
    pushToast('success', `${lab.title} signed`, archiveLabArtifactToastDetail(archiveResult, lab));
  });
}

async function rejectPreparedActionAfterReceiptProof(action: PreparedAction): Promise<void> {
  if (action.workflowSource === 'cloud') {
    const decisionProof = await signCloudWorkflowDecision(action, 'rejected');
    await cloudRequest(`/api/approvals/${encodeURIComponent(action.id)}/deny`, {
      method: 'POST',
      body: JSON.stringify({
        proofSignature: decisionProof.signature,
        decisionProofMessage: decisionProof.message,
        signatureEncoding: 'base58',
        note: 'Denied with a wallet-signed rejection receipt.',
      }),
    });
    await refreshCloudWorkspaceData();
    showCompletedHistoryForAction(action.id);
    return;
  }
  if (isBrowserWorkflowId(action.id)) {
    const proofSignature = await signBrowserWorkflowDecision(action, 'rejected');
    completeBrowserPreparedAction(action, 'rejected', proofSignature);
    showCompletedHistoryForAction(action.id);
    return;
  }
  await bridgeRequest('/bridge/prepared-actions/reject', {
    method: 'POST',
    body: JSON.stringify({ actionId: action.id, reason: 'Denied with a wallet-signed rejection receipt.' }),
  });
  await refreshInboxData();
  showCompletedHistoryForAction(action.id);
}

function inlineReceiptFieldValues(action: PreparedAction, proofKind: InlineReceiptKind): Record<string, string> {
  const request = actionReceiptRequestText(action);
  const constraints = actionReceiptConstraintText(action);
  switch (proofKind) {
    case 'intent':
      return {
        request,
        constraints,
        context: action.recurringId
          ? `Approval ${action.id}; repeat payment ${action.recurringId}${action.occurrenceKey ? `; occurrence ${action.occurrenceKey}` : ''}`
          : `Approval ${action.id}`,
      };
    case 'rejection':
      return {
        request,
        reason: action.error || cloudExecutionBlockReason(action) || 'User chose Deny with proof for this wallet request.',
        policy: 'No wallet action should proceed unless the request matches the visible constraints and the user approves in-wallet.',
      };
    case 'policy':
      return {
        policy: 'Check recipient, amount, token, cluster, finalization requirement, and no delegated or unlimited signing authority.',
        request,
        result: 'Pass',
      };
    case 'review':
      return {
        request,
        risks: actionReviewRiskText(action),
        verdict: cloudExecutionBlockReason(action) ? 'Warning' : 'Recorded',
      };
  }
}

function inlineReceiptMetadata(action: PreparedAction, proofKind: InlineReceiptKind): JsonObject {
  const metadata: JsonObject = {
    source: 'inline-proof',
    recordType: 'approval',
    recordId: action.id,
    sourceRecordType: 'approval',
    sourceRecordId: action.id,
    subjectType: 'approval',
    subjectId: action.id,
    approvalId: action.id,
    proofUseCase: proofKind,
    approvalKind: action.kind,
    workflowSource: action.workflowSource ?? (isBrowserWorkflowId(action.id) ? 'browser' : 'local-bridge'),
  };
  if (action.planDraftId) metadata.planDraftId = action.planDraftId;
  if (action.recurringId) metadata.recurringScheduleId = action.recurringId;
  if (action.occurrenceKey) metadata.occurrenceKey = action.occurrenceKey;
  if (action.finalizationId) metadata.finalizationId = action.finalizationId;
  return metadata;
}

function actionReceiptRequestText(action: PreparedAction): string {
  const rows = [
    action.summary,
    `Approval: ${action.id}`,
    `Kind: ${action.kind.replace(/_/g, ' ')}`,
    `Cluster: ${titleCaseCluster(action.cluster)}`,
    recipientParam(action) ? `Recipient: ${recipientParam(action)}` : '',
    amountLabel(action) !== 'n/a' ? `Amount: ${amountLabel(action)}` : '',
    tokenLabel(action) !== 'n/a' ? `Token: ${tokenLabel(action)}` : '',
    action.recurringId ? `Repeat payment: ${action.recurringId}` : '',
    action.occurrenceKey ? `Occurrence: ${action.occurrenceKey}` : '',
  ].filter(Boolean);
  return rows.join('\n');
}

function actionReceiptConstraintText(action: PreparedAction): string {
  const constraints = [
    recipientParam(action) ? `Recipient must match ${recipientParam(action)}.` : '',
    amountLabel(action) !== 'n/a' ? `Amount must match ${amountLabel(action)}.` : '',
    tokenLabel(action) !== 'n/a' ? `Token route must match ${tokenLabel(action)}.` : '',
    `Cluster must be ${titleCaseCluster(action.cluster)}.`,
    requiresCloudTransactionFinalization(action)
      ? 'Fresh quote/fixed transfer preview, successful simulation, wallet approval, and final receipt are required before funds move.'
      : 'This proof alone does not submit a transaction or grant spending authority.',
    'No private key, delegated signer, server signer, or unlimited approval is granted.',
  ].filter(Boolean);
  return constraints.join('\n');
}

function actionReviewRiskText(action: PreparedAction): string {
  const risks = [
    'Recipient mismatch',
    'Amount/token mismatch',
    'Wrong cluster',
    'Unexpected authority grant',
    'Route or quote drift',
    'Simulation failure',
    'Wallet capability mismatch',
  ];
  const blockReason = cloudExecutionBlockReason(action);
  if (blockReason) risks.push(`Current blocker: ${blockReason}`);
  if (action.finalization?.simulation?.status) risks.push(`Simulation status: ${action.finalization.simulation.status}`);
  if (action.finalization?.quote?.quoteHash || action.quoteHash) risks.push(`Quote hash: ${action.finalization?.quote?.quoteHash ?? action.quoteHash}`);
  return risks.join('\n');
}

function archiveLabArtifactToastDetail(result: ArchiveLabArtifactResult, lab: LabDefinition): string {
  if (result.savedToCloud && result.savedToBridge) return 'Saved locally, to Agentic Cloud, and to the bridge archive.';
  if (result.savedToCloud) return 'Saved locally and to the Agentic Cloud archive.';
  if (result.savedToBridge) return 'Saved locally and to the bridge archive.';
  const mode = activeWorkflowMode();
  if (mode === 'local-bridge' && isPublicReceiptLab(lab)) {
    return 'Saved to the local device archive. Private local mode keeps receipts off Agentic Cloud.';
  }
  if (mode !== 'agentic-cloud' && isPublicReceiptLab(lab)) {
    return 'Saved to the local device archive. Sign in to also archive to Agentic Cloud.';
  }
  return 'Saved to the local device archive.';
}

async function runRefreshLabArtifacts(): Promise<void> {
  await run('lab', async () => {
    await refreshCloudSession(false);
    await signOutCloudSessionForWalletBoundary('wallet-mismatch');
    await hydrateLabArtifactArchive();
    if (state.bridgeActive) {
      await syncLabArtifactsWithBridge();
    }
    if (activeWorkflowMode() === 'agentic-cloud') {
      await syncLabArtifactsWithCloud();
    }
    pushToast('success', 'Receipts refreshed', `${state.labArtifacts.length} receipt${state.labArtifacts.length === 1 ? '' : 's'} loaded.`);
  });
}

async function runDeleteLabArtifact(artifactId: string): Promise<void> {
  const artifact = state.labArtifacts.find((candidate) => candidate.id === artifactId);
  if (!artifact) return;
  if (!window.confirm(deleteEvidenceConfirmCopy(artifact))) return;
  await run('lab', async () => {
    state.labArtifacts = state.labArtifacts.filter((candidate) => candidate.id !== artifactId);
    await saveLabArtifacts();
    if (state.bridgeActive) {
      await deleteBridgeLabArtifact(artifactId);
    }
    let cloudResult: DeleteCloudEvidenceResult = { kind: 'skipped' };
    if (activeWorkflowMode() === 'agentic-cloud') {
      cloudResult = await deleteCloudEvidenceArtifact(artifact);
    }
    pushToast('success', 'Receipt deleted', artifact.title);
    if (cloudResult.kind === 'failed') {
      pushToast(
        'error',
        'Cloud delete failed',
        `Receipt removed locally but still in Agentic Cloud: ${cloudResult.message}`,
      );
    } else if (cloudResult.kind === 'missing-id') {
      pushToast(
        'error',
        'Cloud delete skipped',
        'Cloud receipt id was missing locally — refresh the archive to retry.',
      );
    }
  });
}

async function runShareLabArtifact(artifactId: string): Promise<void> {
  const artifact = state.labArtifacts.find((candidate) => candidate.id === artifactId);
  if (!artifact) return;
  const text = receiptShareText(artifact);
  try {
    if (navigator.share) {
      await navigator.share({
        title: artifact.title || receiptLabelForKind(artifact.kind),
        text,
      });
      pushToast('success', 'Receipt shared', short(artifact.artifactHash));
      return;
    }
    await navigator.clipboard.writeText(text);
    pushToast('success', 'Receipt share text copied', short(artifact.artifactHash));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Share was cancelled or blocked.';
    pushToast('error', 'Share failed', message);
  }
}

function deleteEvidenceConfirmCopy(artifact: LabArtifact): string {
  const destinations = ['this device'];
  if (activeWorkflowMode() === 'agentic-cloud' && artifact.cloudReceiptId) destinations.push('Agentic Cloud');
  if (state.bridgeActive) destinations.push('the local bridge archive');
  return `Delete this evidence receipt permanently from ${destinations.join(', ')}?`;
}

async function run(
  stepName: StepName,
  action: () => Promise<void>,
  options: { onError?: (message: string, err: unknown) => void | Promise<void> } = {},
): Promise<void> {
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
    if (options.onError) {
      await options.onError(state.error, err);
    } else {
      pushToast('error', 'Action failed', state.error);
    }
  } finally {
    state.busy = false;
    render();
  }
}

interface ArchiveLabArtifactResult {
  savedToCloud: boolean;
  savedToBridge: boolean;
}

async function archiveLabArtifact(artifact: LabArtifact): Promise<ArchiveLabArtifactResult> {
  let working: LabArtifact = artifact;
  state.labArtifacts = mergeLabArtifacts([working], state.labArtifacts);
  await saveLabArtifacts();
  const result: ArchiveLabArtifactResult = { savedToCloud: false, savedToBridge: false };
  const mode = activeWorkflowMode();
  if (mode === 'agentic-cloud' && isCloudEvidenceReceiptKind(working.kind)) {
    try {
      const response = await cloudRequest<{ receipt?: { id?: unknown } }>('/api/evidence', {
        method: 'POST',
        body: JSON.stringify(cloudEvidenceCreateBody(working)),
      });
      const cloudId = typeof response.receipt?.id === 'string' && response.receipt.id ? response.receipt.id : undefined;
      if (cloudId) {
        working = { ...working, cloudReceiptId: cloudId };
        state.cloudEvidenceStatus = 'Cloud evidence archive synced for the signed-in wallet.';
      } else {
        state.cloudEvidenceStatus = 'Cloud archive accepted the receipt but did not return an id — refresh archive to recover it.';
      }
      result.savedToCloud = true;
    } catch (err) {
      state.cloudEvidenceStatus = `Cloud evidence archive failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (state.bridgeActive) {
    try {
      await saveBridgeLabArtifact(working);
      working = { ...working, bridgeArchived: true };
      result.savedToBridge = true;
    } catch (err) {
      state.bridgeStatus = `Receipt bridge archive failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (working !== artifact) {
    state.labArtifacts = mergeLabArtifacts([working], state.labArtifacts);
    await saveLabArtifacts();
  }
  return result;
}

function cloudEvidenceCreateBody(artifact: LabArtifact): Record<string, unknown> {
  return {
    title: artifact.title,
    kind: artifact.kind,
    status: artifact.payload.status,
    cluster: artifact.cluster,
    payload: artifact.payload,
    preSignatureHash: artifact.preSignatureHash,
    signingMessage: artifact.signingMessage,
    signature: artifact.signature,
    artifactHash: artifact.artifactHash,
    receiptType: artifact.payload.receiptType ?? artifact.kind,
    summary: artifact.payload.summary ?? artifact.input,
    verdict: artifact.payload.verdict,
    effect: artifact.payload.effect,
    metadata: {
      ...(artifact.metadata ?? {}),
      labId: artifact.labId,
      browserArtifactId: artifact.id,
      input: artifact.input,
    },
  };
}

async function syncLabArtifactsWithCloud(): Promise<void> {
  if (activeWorkflowMode() !== 'agentic-cloud') return;
  try {
    const remote = await loadCloudEvidenceArtifacts();
    const local = state.labArtifacts;
    const remoteIds = new Set(remote.map((artifact) => artifact.id));
    const missingRemote = local.filter(
      (artifact) =>
        !remoteIds.has(artifact.id) &&
        artifact.walletAddress === state.address &&
        isCloudEvidenceReceiptKind(artifact.kind) &&
        !artifact.cloudReceiptId,
    );
    const pushed: LabArtifact[] = [];
    for (const artifact of missingRemote) {
      try {
        const response = await cloudRequest<{ receipt?: { id?: unknown } }>('/api/evidence', {
          method: 'POST',
          body: JSON.stringify(cloudEvidenceCreateBody(artifact)),
        });
        const cloudId = typeof response.receipt?.id === 'string' && response.receipt.id ? response.receipt.id : undefined;
        if (cloudId) pushed.push({ ...artifact, cloudReceiptId: cloudId });
      } catch (err) {
        state.cloudEvidenceStatus = `Cloud evidence archive failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    state.labArtifacts = mergeLabArtifacts(remote, pushed, local);
    await saveLabArtifacts();
    state.cloudEvidenceLastSyncAt = Date.now();
    state.cloudEvidenceStatus = `Cloud evidence archive synced (${remote.length} receipt${remote.length === 1 ? '' : 's'}).`;
  } catch (err) {
    state.cloudEvidenceStatus = `Cloud evidence archive unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function loadCloudEvidenceArtifacts(): Promise<LabArtifact[]> {
  const response = await cloudRequest<{ receipts?: unknown[] }>('/api/evidence', { method: 'GET' });
  const records = Array.isArray(response.receipts) ? response.receipts : [];
  const artifacts: LabArtifact[] = [];
  for (const record of records) {
    const artifact = cloudEvidenceRecordToLabArtifact(record);
    if (artifact) artifacts.push(artifact);
  }
  return artifacts;
}

function cloudEvidenceRecordToLabArtifact(value: unknown): LabArtifact | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const metadata = (record.metadata && typeof record.metadata === 'object') ? record.metadata as Record<string, unknown> : {};
  const cloudId = typeof record.id === 'string' ? record.id : '';
  const browserId = typeof metadata.browserArtifactId === 'string' && metadata.browserArtifactId
    ? metadata.browserArtifactId
    : cloudId;
  const labId = typeof metadata.labId === 'string' && metadata.labId ? metadata.labId : labIdForKind(record.kind);
  const cluster = typeof record.cluster === 'string' && isCluster(record.cluster) ? record.cluster : state.cluster;
  const payload = record.payload as LabPayload | undefined;
  if (!payload || typeof payload !== 'object') return null;
  const signingMessage = stringField(record.signingMessage) ?? '';
  const signature = stringField(record.signature) ?? '';
  const verified = signingMessage && signature ? verifyMessageSignature(signingMessage, signature) : false;
  const candidate: LabArtifact = {
    id: browserId,
    labId,
    title: stringField(record.title) ?? '',
    kind: stringField(record.kind) ?? '',
    createdAt: stringField(record.createdAt) ?? new Date().toISOString(),
    walletAddress: stringField(record.walletAddress) ?? state.address,
    cluster,
    input: stringField(metadata.input) ?? stringField(record.summary) ?? stringField(payload.summary) ?? stringField(payload.thesis) ?? '',
    payload,
    preSignatureHash: stringField(record.preSignatureHash) ?? '',
    signingMessage,
    signature,
    verified,
    artifactHash: stringField(record.artifactHash) ?? stringField(record.preSignatureHash) ?? '',
    ...(cloudId ? { cloudReceiptId: cloudId } : {}),
    ...(isJsonObject(metadata) ? { metadata } : {}),
  };
  return isLabArtifact(candidate) ? candidate : null;
}

function labIdForKind(value: unknown): string {
  const kind = typeof value === 'string' ? value : '';
  switch (kind) {
    case 'intent_receipt':
      return 'intent-receipt';
    case 'policy_receipt':
      return 'policy-receipt';
    case 'risk_review_receipt':
      return 'risk-receipt';
    case 'rejection_receipt':
      return 'rejection-receipt';
    case 'tool_trace_receipt':
      return 'tool-trace-receipt';
    default:
      return 'intent-receipt';
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

type DeleteCloudEvidenceResult =
  | { kind: 'skipped' }
  | { kind: 'missing-id' }
  | { kind: 'deleted' }
  | { kind: 'failed'; message: string };

async function deleteCloudEvidenceArtifact(artifact: LabArtifact): Promise<DeleteCloudEvidenceResult> {
  if (activeWorkflowMode() !== 'agentic-cloud' || !isCloudEvidenceReceiptKind(artifact.kind)) {
    return { kind: 'skipped' };
  }
  if (!artifact.cloudReceiptId) {
    state.cloudEvidenceStatus = 'Cloud receipt id missing — refresh archive then retry delete.';
    return { kind: 'missing-id' };
  }
  try {
    await cloudRequest(`/api/evidence/${encodeURIComponent(artifact.cloudReceiptId)}`, { method: 'DELETE' });
    return { kind: 'deleted' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.cloudEvidenceStatus = `Cloud evidence delete failed: ${message}`;
    return { kind: 'failed', message };
  }
}

function isCloudEvidenceReceiptKind(value: string): value is EvidenceReceiptKind {
  return (EVIDENCE_RECEIPT_KINDS as readonly string[]).includes(value);
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
    state.bridgeStatus = `Receipt bridge archive unavailable: ${err instanceof Error ? err.message : String(err)}`;
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

async function deleteBridgeLabArtifact(artifactId: string): Promise<void> {
  await bridgeRequest('/bridge/lab-artifacts/delete', {
    method: 'POST',
    body: JSON.stringify({ artifactId }),
  });
}

async function refreshInboxData(): Promise<void> {
  const browserWorkflow = loadBrowserWorkflowState();
  const [actionsResponse, recurringResponse, receiptsResponse, txResponse] = await Promise.all([
    bridgeRequest<{ materialized?: PreparedAction[]; actions?: PreparedAction[] }>('/bridge/prepared-actions'),
    bridgeRequest<{ recurringPayments?: RecurringPayment[] }>('/bridge/recurring-payments'),
    bridgeRequest<{ receipts?: ActionReceipt[] }>('/bridge/receipts'),
    bridgeRequest<{ updates?: unknown[]; actions?: PreparedAction[] }>('/bridge/prepared-actions/tx-status').catch(() => null),
  ]);
  state.materializedActions = mergePreparedActions(
    withPreparedActionSource(actionsResponse.materialized ?? [], 'local-bridge'),
    browserWorkflow.preparedActions,
  );
  state.preparedActions = mergePreparedActions(
    withPreparedActionSource(txResponse?.actions ?? actionsResponse.actions ?? [], 'local-bridge'),
    browserWorkflow.preparedActions,
  );
  state.recurringPayments = mergeRecurringPayments(
    withRecurringPaymentSource(recurringResponse.recurringPayments ?? [], 'local-bridge'),
    browserWorkflow.recurringPayments,
  );
  state.receipts = mergeActionReceipts(receiptsResponse.receipts ?? [], browserWorkflow.receipts);
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

async function activateBridgeConnection(
  options: { refreshConfig?: boolean; strictSync?: boolean } = {},
): Promise<void> {
  if (options.refreshConfig) {
    await loadBridgeConfig(true);
  } else {
    await loadBridgeConfig(false);
  }
  await connectBridgeHost();
  state.bridgeActive = true;
  state.bridgeStatus = 'Connected to local bridge. Waiting for agent requests.';
  startBridgePolling();
  await refreshConnectedBridgeState(Boolean(options.strictSync));
  savePersistedState();
}

async function refreshConnectedBridgeState(strict: boolean): Promise<void> {
  const refreshes = [
    refreshInboxData(),
    refreshHealth(),
    refreshBalances().catch(() => undefined),
    syncLabArtifactsWithBridge(),
  ];
  if (strict) {
    await Promise.all(refreshes);
    return;
  }
  await Promise.all(refreshes.map((refresh) => refresh.catch(() => undefined)));
}

async function ensureBridgeConnectedAfterLocalCall(): Promise<boolean> {
  if (!state.address || !state.capabilities) {
    return false;
  }
  try {
    await activateBridgeConnection({ refreshConfig: false, strictSync: false });
    return true;
  } catch (err) {
    state.bridgeActive = false;
    stopBridgePolling();
    state.bridgeStatus = err instanceof Error ? err.message : String(err);
    return false;
  }
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
    if (
      activeWorkflowMode() === 'local-bridge' &&
      (state.activeTab === 'inbox' || state.activeTab === 'schedule') &&
      now - lastPassiveInboxRefresh > 5000
    ) {
      lastPassiveInboxRefresh = now;
      await refreshInboxData().catch(() => undefined);
      render();
    }
  } catch (err) {
    state.bridgeStatus = err instanceof Error ? err.message : String(err);
    if (isBridgeOfflineMessage(state.bridgeStatus)) {
      state.bridgeActive = false;
      stopBridgePolling();
    }
    render();
  } finally {
    bridgeRequestBusy = false;
  }
}

async function handleBridgeSigningRequest(request: SigningRequest): Promise<void> {
  const signingClient = requireClient();
  const toastId = pushToast('pending', bridgeSigningToastTitle(request.kind), request.display?.summary ?? request.id);
  const toastContext: TransactionToastContext = { toastId, cluster: request.cluster };
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
        result = await runTransactionToastStep(
          toastContext,
          'Signing message',
          request.display?.summary ?? request.id,
          () => signingClient.signMessage(request.payload.data, requestSignOptions(request)),
        );
        break;
      case 'sign_transaction':
        result = await runTransactionToastStep(
          toastContext,
          'Signing transaction',
          request.display?.summary ?? request.id,
          () => signingClient.signTransaction(request.payload.data, requestSignOptions(request)),
        );
        break;
      case 'sign_and_send_transaction':
        if (state.capabilities?.supports.signTransaction === true) {
          const signed = await runTransactionToastStep(
            toastContext,
            'Signing transaction',
            request.display?.summary ?? request.id,
            () => signingClient.signTransaction(request.payload.data, requestSignOptions(request)),
          );
          const txid = await broadcastSignedBrowserTransactionWithRetry(request.cluster, signed.signature, toastContext);
          result = { signature: txid, txid };
        } else {
          result = await runTransactionToastStep(
            toastContext,
            'Signing and sending transaction',
            `${request.display?.summary ?? request.id}. This wallet path cannot be safely retried without a returned transaction id.`,
            () => signingClient.signAndSendTransaction(request.payload.data, requestSignOptions(request)),
          );
        }
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
    const submittedTxid = request.kind === 'sign_and_send_transaction' ? result.txid ?? result.signature : result.txid;
    if (submittedTxid) {
      replaceToast(toastId, 'success', 'Transaction submitted', short(submittedTxid), {
        linkHref: explorerUrl(submittedTxid, request.cluster),
        linkLabel: 'Open Solscan',
      });
    } else {
      replaceToast(toastId, 'success', 'Bridge request approved', short(result.signature));
    }
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
    replaceToast(toastId, 'error', 'Bridge request failed', error.message);
  } finally {
    await refreshInboxData().catch(() => undefined);
    render();
  }
}

function bridgeSigningToastTitle(kind: SigningRequest['kind']): string {
  if (kind === 'sign_and_send_transaction') return 'Signing and sending transaction';
  if (kind === 'sign_transaction') return 'Signing transaction';
  return 'Signing message';
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
  for (const input of document.querySelectorAll<HTMLInputElement>('[data-template-slippage-field]')) {
    const fieldId = input.dataset.templateSlippageField;
    if (fieldId) {
      current[fieldId] = slippagePercentInputToBps(input.value);
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

function assertValidTemplatePlanInput(template: AgentPlanTemplate, parameters: Record<string, string>, userNotes: string): void {
  const errors: Record<string, string> = {};
  for (const fieldDef of template.fields) {
    if (fieldDef.required && !parameters[fieldDef.id]?.trim()) {
      errors[fieldDef.id] = `${fieldDef.label} is required.`;
    }
  }
  if (templateRequiresUserNotes(template) && !userNotes.trim()) {
    errors.__notes = 'Describe the custom request before creating this plan.';
  }
  state.templateFieldErrors = errors;
  if (Object.keys(errors).length > 0) {
    throw new Error('Complete required fields before creating this plan.');
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

function planGuardrailReport(plan: AgentPlan): AiGuardrailReport | undefined {
  return isAiGuardrailReport(plan.guardrailReport) ? plan.guardrailReport : undefined;
}

function planGuardrailVerdict(plan: AgentPlan): AiGuardrailReport['verdict'] | 'unknown' {
  return planGuardrailReport(plan)?.verdict ?? 'unknown';
}

function canQueueAgentPlan(plan: AgentPlan): boolean {
  return ['transfer_sol', 'transfer_spl', 'swap', 'recurring_payment', 'custom_transaction'].includes(plan.actionType);
}

function canQueueGuardedPlan(plan: AgentPlan): boolean {
  return canQueueAgentPlan(plan) &&
    planGuardrailVerdict(plan) !== 'block';
}

function canQueueGeneratedPlan(record: GeneratedPlanRecord): boolean {
  return record.status !== 'archived' && canQueueGuardedPlan(record.plan);
}

function assertPlanCanQueue(plan: AgentPlan): void {
  if (!canQueueAgentPlan(plan)) {
    throw new Error('Only transfer, swap, custom transaction, and repeat payments can be queued.');
  }
  const report = planGuardrailReport(plan);
  if (report?.verdict === 'block') {
    throw new Error(report.summary || 'This plan is blocked by Agentic guardrails.');
  }
}

function queuePlanTitle(): string {
  if (!state.address) return 'Connect a wallet before sending for approval.';
  if (!state.agentPlan) return 'Create a plan before sending for approval.';
  if (!canQueueAgentPlan(state.agentPlan)) return 'Only transfer, swap, custom transaction, and repeat payments can be queued.';
  const report = planGuardrailReport(state.agentPlan);
  if (report?.verdict === 'block') return report.summary;
  const mode = activeWorkflowMode();
  if (mode === 'agentic-cloud') {
    const unsupported = cloudQueueUnsupportedReason(state.agentPlan);
    if (unsupported) return 'Send this plan to browser-local Needs Approval for wallet review. Agentic Cloud does not finalize this action type yet.';
  }
  if (state.agentPlan.actionType === 'recurring_payment') {
    if (mode === 'agentic-cloud') return 'Create an Agentic Cloud repeat payment. Each due payment appears in Needs Approval.';
    return mode === 'local-bridge'
      ? 'Create a local repeat payment. Each due payment appears in Needs Approval.'
      : 'Create one browser-local repeat approval now. Background repeats need Agentic Cloud or Private local mode.';
  }
  if (mode === 'agentic-cloud') return 'Send this plan to Agentic Cloud Needs Approval for wallet review.';
  return mode === 'local-bridge'
    ? 'Send this plan to local Needs Approval for wallet review.'
    : 'Send this plan to browser Needs Approval. It stays local to this device.';
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

async function queuePlanThroughActiveWorkflow(
  plan: AgentPlan,
  sourceRecord?: GeneratedPlanRecord,
): Promise<QueueWorkflowResult> {
  assertPlanCanQueue(plan);
  const mode = activeWorkflowMode();
  if (mode === 'local-bridge') {
    const response = await queuePlanThroughBridge(plan);
    return { ...response, mode: 'local-bridge' };
  }
  if (mode === 'agentic-cloud') {
    const unsupported = cloudQueueUnsupportedReason(plan);
    if (unsupported) {
      const response = queuePlanThroughBrowserWorkflow(plan);
      return { ...response, mode: 'browser-workflow' };
    }
    const response = plan.actionType === 'recurring_payment'
      ? await queueRecurringPlanThroughCloud(plan)
      : await queuePlanThroughCloud(plan, sourceRecord);
    return { ...response, mode: 'agentic-cloud' };
  }
  const response = queuePlanThroughBrowserWorkflow(plan);
  return { ...response, mode: 'browser-workflow' };
}

async function queuePlanThroughCloud(plan: AgentPlan, sourceRecord?: GeneratedPlanRecord): Promise<{ id: string; planRecordId: string }> {
  if (!cloudSessionMatchesWallet()) {
    throw new Error('Sign in to Agentic Cloud with the connected wallet before sending to Cloud Needs Approval.');
  }
  const unsupported = cloudQueueUnsupportedReason(plan);
  if (unsupported) throw new Error(unsupported);
  const cloudRecord = sourceRecord?.workflowSource === 'cloud' && samePlan(sourceRecord.plan, plan)
    ? sourceRecord
    : state.generatedPlans.find((record) =>
        record.workflowSource === 'cloud' && record.status !== 'archived' && samePlan(record.plan, plan),
      );
  const template = sourceRecord ? templateById(sourceRecord.templateId) : templateById(state.selectedTemplateId);
  const planId = cloudRecord
    ? cloudRecord.id
    : (await saveGeneratedPlan(plan, template, sourceRecord?.prompt || plan.userNotes || plan.intent)).id;
  const approvalRecord = parseCloudApprovalResponse(await cloudRequest('/api/approvals', {
    method: 'POST',
    body: JSON.stringify({
      planDraftId: planId,
      kind: plan.actionType,
      summary: plan.intent,
      params: plan.parameters,
      cluster: state.cluster,
      note: plan.userNotes || plan.approval,
      amount: planParameter(plan, ['amountSol', 'amount', 'inputAmount', 'plannedAmount']),
      token: planParameter(plan, ['token', 'inputToken']),
      recipient: planParameter(plan, ['recipient', 'recipientAddress']),
    }),
  }));
  const approval = cloudApprovalToPreparedAction(approvalRecord);
  if (!approval) {
    throw new Error('Agentic Cloud did not return a valid approval request.');
  }
  return { id: approval.id, planRecordId: planId };
}

function cloudQueueUnsupportedReason(plan: AgentPlan): string | undefined {
  if (plan.actionType === 'transfer_sol') return undefined;
  if (plan.actionType === 'recurring_payment' && (plan.parameters.token ?? 'SOL').toUpperCase() === 'SOL') return undefined;
  if (plan.actionType === 'transfer_spl' || plan.actionType === 'swap') {
    return 'Agentic Cloud currently finalizes SOL transfers only. Use Private local mode for SPL transfers and swaps.';
  }
  if (plan.actionType === 'custom_transaction') {
    return 'Agentic Cloud does not accept custom executable transactions yet. Use a proof-only review or Private local mode.';
  }
  if (plan.actionType === 'recurring_payment') {
    return 'Agentic Cloud recurring execution currently supports SOL payments only. Use Private local mode for token schedules.';
  }
  return undefined;
}

async function queueRecurringPlanThroughCloud(plan: AgentPlan): Promise<{ id: string }> {
  if (!cloudSessionMatchesWallet()) {
    throw new Error('Sign in to Agentic Cloud with the connected wallet before creating cloud repeat payments.');
  }
  const body = {
    cluster: state.cluster,
    token: requiredPlanParam(plan, 'token'),
    recipient: requiredPlanParam(plan, 'recipient'),
    amount: requiredPlanParam(plan, 'amount'),
    ...recurringSchedulePayload(plan),
    note: plan.userNotes || plan.intent,
  };
  const cloudSchedule = parseCloudRecurringScheduleResponse(await cloudRequest('/api/recurring', {
    method: 'POST',
    body: JSON.stringify(body),
  }));
  const schedule = cloudRecurringScheduleToPayment(cloudSchedule);
  if (!schedule) {
    throw new Error('Agentic Cloud did not return a valid repeat payment.');
  }
  await cloudMaterializeRecurring().catch(() => undefined);
  return { id: schedule.id };
}

function queuePlanThroughBrowserWorkflow(plan: AgentPlan): { id: string } {
  if (!state.address) {
    throw new Error('Connect a wallet before sending for approval.');
  }
  if (plan.actionType === 'recurring_payment') {
    const recurring = browserRecurringPaymentFromPlan(plan);
    const occurrence = browserOccurrenceFromRecurring(recurring, plan.intent);
    state.recurringPayments = mergeRecurringPayments([recurring], state.recurringPayments);
    state.preparedActions = mergePreparedActions([occurrence], state.preparedActions);
    state.materializedActions = state.preparedActions;
    saveBrowserWorkflowState();
    return { id: recurring.id };
  }
  const action = browserPreparedActionFromPlan(plan);
  state.preparedActions = mergePreparedActions([action], state.preparedActions);
  state.materializedActions = state.preparedActions;
  saveBrowserWorkflowState();
  return { id: action.id };
}

function browserPreparedActionFromPlan(plan: AgentPlan): PreparedAction {
  const now = new Date().toISOString();
  const id = newId('browser-action');
  const kind = browserActionKindForPlan(plan);
  return {
    id,
    kind,
    status: 'ready',
    walletAddress: state.address,
    cluster: state.cluster,
    summary: plan.intent,
    params: browserActionParams(plan, kind),
    dueAt: now,
    createdAt: now,
    updatedAt: now,
    note: plan.userNotes || plan.approval,
    workflowSource: 'browser',
  };
}

function browserActionKindForPlan(plan: AgentPlan): PreparedActionKind {
  if (plan.actionType === 'transfer_sol') return 'transfer_sol';
  if (plan.actionType === 'transfer_spl') return 'transfer_spl';
  if (plan.actionType === 'swap') return 'swap';
  if (plan.actionType === 'custom_transaction') return 'custom_transaction';
  throw new Error('Only transfers, swaps, custom transactions, and repeat payments can be queued.');
}

function browserActionParams(plan: AgentPlan, kind: PreparedActionKind): Record<string, unknown> {
  if (kind === 'transfer_sol') {
    return {
      recipient: requiredPlanParam(plan, 'recipient'),
      amountSol: requiredPlanParam(plan, 'amount'),
      memo: plan.parameters.memo ?? '',
    };
  }
  if (kind === 'transfer_spl') {
    return {
      token: requiredPlanParam(plan, 'token'),
      recipient: requiredPlanParam(plan, 'recipient'),
      amount: requiredPlanParam(plan, 'amount'),
      memo: plan.parameters.memo ?? '',
    };
  }
  if (kind === 'swap') {
    return {
      inputToken: plan.parameters.inputToken || 'SOL',
      outputToken: plan.parameters.outputToken || 'USDC',
      amount: requiredPlanParam(plan, 'amount'),
      slippageBps: plan.parameters.slippageBps || '50',
    };
  }
  if (kind === 'custom_transaction') {
    return {
      transactionBase64: requiredPlanParam(plan, 'transactionBase64'),
      reason: plan.userNotes || plan.intent,
    };
  }
  return {
    reason: plan.userNotes || plan.intent,
  };
}

function browserRecurringPaymentFromPlan(plan: AgentPlan): RecurringPayment {
  const now = new Date().toISOString();
  const payload = recurringSchedulePayload(plan);
  const maxOccurrences = Number(plan.parameters.maxOccurrences);
  return {
    id: newId('browser-recurring'),
    status: 'active',
    walletAddress: state.address,
    cluster: state.cluster,
    token: plan.parameters.token || 'SOL',
    recipient: requiredPlanParam(plan, 'recipient'),
    amount: requiredPlanParam(plan, 'amount'),
    ...payload,
    ...(Number.isInteger(maxOccurrences) && maxOccurrences > 0 ? { maxOccurrences } : {}),
    occurrencesCreated: 1,
    note: plan.userNotes || plan.intent,
    createdAt: now,
    updatedAt: now,
    nextDueAt: recurringNextDueFromPayload(payload),
    workflowSource: 'browser',
  };
}

function browserRecurringPaymentFromDraft(draft: RecurringDraft): RecurringPayment {
  const now = new Date().toISOString();
  const payload = recurringBody(draft);
  const schedulePayload = payload as ReturnType<typeof recurringSchedulePayload>;
  const maxOccurrences = Number(draft.maxOccurrences);
  return {
    id: newId('browser-recurring'),
    status: 'active',
    walletAddress: state.address,
    cluster: state.cluster,
    token: draft.token,
    recipient: draft.recipient,
    amount: draft.amount,
    ...schedulePayload,
    ...(Number.isInteger(maxOccurrences) && maxOccurrences > 0 ? { maxOccurrences } : {}),
    occurrencesCreated: 1,
    ...(typeof payload.expiresAt === 'string' && { expiresAt: payload.expiresAt }),
    ...(isJsonObject(payload.notifications) && {
      notifications: {
        ...(typeof payload.notifications.inApp === 'boolean' && { inApp: payload.notifications.inApp }),
        ...(typeof payload.notifications.webhookUrl === 'string' && { webhookUrl: payload.notifications.webhookUrl }),
      },
    }),
    note: draft.note || 'Saved-on-device repeat payment',
    createdAt: now,
    updatedAt: now,
    nextDueAt: recurringDraftNextRuns(draft)[0],
    workflowSource: 'browser',
  };
}

function browserOccurrenceFromRecurring(payment: RecurringPayment, summary?: string): PreparedAction {
  const now = new Date().toISOString();
  const actionId = newId('browser-action');
  const token = payment.token || 'SOL';
  return {
    id: actionId,
    kind: token.toUpperCase() === 'SOL' ? 'transfer_sol' : 'transfer_spl',
    status: 'ready',
    walletAddress: payment.walletAddress,
    cluster: payment.cluster,
    summary: summary || `${payment.amount} ${payment.token} repeat approval`,
    params: token.toUpperCase() === 'SOL'
      ? {
          recipient: payment.recipient,
          amountSol: payment.amount,
          memo: payment.note ?? '',
        }
      : {
          token: payment.token,
          recipient: payment.recipient,
          amount: payment.amount,
          memo: payment.note ?? '',
        },
    dueAt: now,
    createdAt: now,
    updatedAt: now,
    note: payment.note,
    recurringId: payment.id,
    occurrenceKey: `browser-${now}`,
    workflowSource: 'browser',
  };
}

function recurringNextDueFromPayload(payload: ReturnType<typeof recurringSchedulePayload>): string | undefined {
  const draft: RecurringDraft = {
    ...defaultRecurringDraft(),
    cadence: payload.cadence,
    dayOfWeek: payload.dayOfWeek === undefined ? '' : String(payload.dayOfWeek),
    dayOfMonth: payload.dayOfMonth === undefined ? '' : String(payload.dayOfMonth),
    intervalDays: payload.intervalDays === undefined ? '' : String(payload.intervalDays),
    intervalHours: payload.intervalHours === undefined ? '' : String(payload.intervalHours),
    intervalMinutes: payload.intervalMinutes === undefined ? '' : String(payload.intervalMinutes),
    localTime: payload.localTime ?? '09:00',
    startAt: payload.startAt ? localDateTime(new Date(payload.startAt)) : defaultRecurringDraft().startAt,
  };
  return recurringDraftNextRuns(draft)[0];
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
  if (!isLoopbackBridgeUrl(state.bridgeUrl)) {
    throw new Error('Local bridge URL must use localhost, 127.0.0.1, or ::1.');
  }
  const url = new URL(path, bridgeBaseUrl());
  const headers = new Headers(init?.headers);
  headers.set('x-agent-wallet-token', state.bridgeToken);
  if (init?.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers,
    });
  } catch {
    throw new Error(bridgeOfflineMessage());
  }
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

function bridgeOfflineMessage(): string {
  return `Local approval bridge is not running at ${compactEndpoint(state.bridgeUrl)}. Run ${NPM_EXEC_COMMAND}, keep that terminal open, then click Check local bridge.`;
}

function isBridgeOfflineMessage(message: string): boolean {
  return message.startsWith('Local approval bridge is not running at ');
}

async function showBridgeOfflineToast(title: string): Promise<void> {
  const detail = await bridgeOfflineDiagnosticMessage();
  state.bridgeStatus = detail;
  pushToast('error', title, detail);
}

async function bridgeOfflineDiagnosticMessage(): Promise<string> {
  const bridgeEndpoint = compactEndpoint(state.bridgeUrl);
  const walletHostUrl = inferredWalletHostUrl();
  const walletHostReachable = walletHostUrl ? await canReachLocalEndpoint(walletHostUrl) : false;
  if (walletHostReachable) {
    return `Wallet host is running at ${compactEndpoint(walletHostUrl)}, but the approval bridge is stopped at ${bridgeEndpoint}. Run ${NPM_EXEC_COMMAND}, keep that terminal open, then click Check local bridge.`;
  }
  return `Local approval bridge is not running at ${bridgeEndpoint}. Run ${NPM_EXEC_COMMAND}, keep that terminal open, then click Check local bridge.`;
}

function inferredWalletHostUrl(): string {
  try {
    const bridge = new URL(bridgeBaseUrl());
    bridge.port = '5174';
    bridge.pathname = '/';
    bridge.search = '';
    bridge.hash = '';
    return bridge.toString();
  } catch {
    return 'http://127.0.0.1:5174/';
  }
}

async function canReachLocalEndpoint(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 1200);
  try {
    await fetch(url, {
      cache: 'no-store',
      mode: 'no-cors',
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeout);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function isBrowserWalletSurface(): boolean {
  return !state.androidNativeEnvironment.isAndroidNative && !state.iosNativeEnvironment.isIosNative;
}

function clearBrowserWalletSession(): void {
  state.browserWalletSession = undefined;
}

async function restoreBrowserWalletSession(): Promise<void> {
  state.wallets = visibleBrowserWallets(listAvailableWallets());
  state.selectedWalletName = reconcileBrowserWalletSelection(state.wallets, state.selectedWalletName);
  state.browserWalletPickerOpen = false;
  const restoreName = browserWalletRestoreName(state.wallets, state.browserWalletSession, state.cluster);
  if (!restoreName) {
    if (state.browserWalletSession) {
      clearBrowserWalletSession();
      savePersistedState();
    }
    return;
  }

  state.selectedWalletName = restoreName;
  const selected = selectedWallet();
  const backend = new WalletStandardWebBackend({
    wallet: selected,
    cluster: state.cluster,
    rpcUrl: activeRpcUrl(),
  });

  try {
    const address = await backend.connect({ silent: true });
    walletBackend = backend;
    client = new SolanaSigningClient({ backend });
    state.address = address;
    state.capabilities = await client.capabilities();
    state.transactionStatus = `Wallet restored on ${state.cluster}.`;
    state.steps.connect = 'done';
    state.browserWalletSession = createBrowserWalletSession(
      selected.name,
      state.cluster,
      state.browserWalletSession?.connectedAt,
    );
    await afterWalletConnected();
    savePersistedState();
  } catch (err) {
    client = null;
    walletBackend = null;
    state.address = '';
    state.capabilities = null;
    state.transactionStatus = '';
    state.steps.connect = 'idle';
    state.selectedWalletName = '';
    state.browserWalletPickerOpen = state.wallets.length > 0;
    clearBrowserWalletSession();
    savePersistedState();
    console.info('Browser wallet silent restore skipped.', err);
  }
}

function selectedWallet(): DiscoveredWallet {
  const wallet = state.wallets.find((candidate) => candidate.name === state.selectedWalletName);
  if (!wallet) {
    throw new Error('Click Discover, choose a wallet, then connect.');
  }
  return wallet;
}

async function connectAndroidNativeWallet(_forcePicker: boolean): Promise<void> {
  assertAndroidNativeRuntime();
  const backend = new AndroidNativeWalletBackend({ cluster: androidNativeCluster() });
  walletBackend = backend;
  client = new SolanaSigningClient({ backend });
  const cachedAddress = _forcePicker ? null : await backend.reconnectLatest();
  state.address = cachedAddress ?? await backend.connect();
  state.capabilities = await client.capabilities();
  state.selectedWalletName = backend.walletName();
  state.wallets = [];
  state.androidAuthCacheCount = backend.cacheCount();
  state.androidNativeStatus = `Android ${state.selectedWalletName} connected on ${state.cluster}.`;
  state.transactionStatus = `Android MWA wallet connected on ${state.cluster}.`;
  state.steps.connect = 'done';
  savePersistedState();
}

async function applyAndroidNativeRestore(restored: AndroidNativeRestoreResult): Promise<void> {
  walletBackend = restored.backend;
  client = new SolanaSigningClient({ backend: walletBackend });
  state.address = restored.address;
  state.selectedWalletName = restored.walletName;
  state.wallets = [];
  state.capabilities = await client.capabilities();
  state.androidAuthCacheCount = restored.cacheCount;
  state.androidNativeStatus = `Restored cached ${restored.walletName} authorization on ${state.cluster}.`;
  state.transactionStatus = `Android MWA wallet connected on ${state.cluster}.`;
  state.steps.connect = 'done';
  savePersistedState();
}

async function restoreAndroidNativeSession(): Promise<void> {
  if (state.cluster === 'localnet') {
    state.androidNativeStatus = 'Android native MWA supports mainnet-beta, devnet, and testnet. Select devnet for local testing.';
    return;
  }
  const restored = await restoreLatestAndroidNativeWallet({
    cluster: androidNativeCluster(),
  });
  if (!restored) {
    state.androidNativeStatus = 'No cached Android MWA authorization found. Tap Discover to open the wallet picker.';
    return;
  }
  await applyAndroidNativeRestore(restored);
}

async function refreshAndroidNativeCacheState(): Promise<void> {
  if (!state.androidNativeEnvironment.isAndroidNative) {
    return;
  }
  const summary = await androidNativeCacheSummary().catch(() => ({ count: 0 }));
  state.androidAuthCacheCount = summary.count;
}

function androidBackendOrNew(): AndroidNativeWalletBackend {
  return walletBackend instanceof AndroidNativeWalletBackend
    ? walletBackend
    : new AndroidNativeWalletBackend({ cluster: androidNativeCluster() });
}

function androidNativeCluster(): Cluster {
  if (state.cluster === 'localnet') {
    state.cluster = 'devnet';
    savePersistedState();
  }
  return state.cluster;
}

function assertAndroidNativeRuntime(): void {
  if (!state.androidNativeEnvironment.isAndroidNative) {
    throw new Error('Android native MWA controls are available only inside the Android app.');
  }
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
  if (!hasDiscoveredBrowserWalletSelection(state.wallets, state.selectedWalletName)) return '';
  return reconcileBrowserWalletSelection(state.wallets, state.selectedWalletName);
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
  if (state.androidNativeEnvironment.isAndroidNative) {
    return {
      icon: 'MW',
      logoId: 'solanaMobile',
      title: 'Android MWA standby',
      summary: 'Mobile Wallet Adapter',
      detail: state.androidAuthCacheCount > 0 ? `${state.androidAuthCacheCount} cached authorization(s)` : 'Tap Discover to open the wallet picker',
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

function walletSelectOptions(): SelectPickerOption[] {
  return browserWalletPickerOptions(state.wallets).map((option) => ({
    ...option,
    ...(option.value ? {} : { hiddenFromMenu: state.wallets.length > 0 }),
    ...(option.value ? { logoId: walletLogoIdForName(option.value) } : {}),
  }));
}

function iosWalletOptions(): string {
  return state.iosWallets
    .map(
      (wallet) =>
        `<option value="${escapeHtml(wallet.id)}" ${wallet.id === state.selectedIosWalletId ? 'selected' : ''}>${escapeHtml(wallet.name)} - ${escapeHtml(wallet.detail)}</option>`,
    )
    .join('');
}

function iosWalletSelectOptions(): SelectPickerOption[] {
  return state.iosWallets.map((wallet) => ({
    value: wallet.id,
    label: wallet.name,
    meta: 'iOS wallet',
    detail: wallet.detail,
  }));
}

function iosWalletLabel(walletId: IosNativeWalletId): string {
  return state.iosWallets.find((wallet) => wallet.id === walletId)?.name ?? walletId;
}

function isIosNativeWalletId(value: string): value is IosNativeWalletId {
  return state.iosWallets.some((wallet) => wallet.id === value);
}

function selectPicker(input: {
  id?: string;
  value: string;
  options: SelectPickerOption[];
  attrs?: Record<string, string | boolean | undefined>;
  disabled?: boolean;
  open?: boolean;
  labelId?: string;
  className?: string;
  title?: string;
}): string {
  const selected = input.options.find((option) => option.value === input.value) ??
    input.options.find((option) => !option.disabled) ??
    input.options[0];
  const menuOptions = input.options.filter((option) => !option.hiddenFromMenu);
  const menuOpen = Boolean(input.open && !input.disabled && menuOptions.some((option) => !option.disabled));
  const baseId = selectPickerBaseId(input);
  const selectedLabel = selected?.label ?? 'Select';
  const selectedMeta = selected?.meta ?? '';
  const selectedLogo = selected?.logoId ? selectPickerLogo(selected.logoId) : '';
  const attrs = htmlAttrs({
    ...(input.id ? { id: input.id } : {}),
    ...(input.attrs ?? {}),
    class: 'native-select-fallback',
    'data-select-picker-native': true,
    disabled: input.disabled,
    tabindex: '-1',
    'aria-hidden': 'true',
  });
  const labelledBy = [input.labelId, `${baseId}-value`].filter(Boolean).join(' ');
  return `
    <div class="select-picker-shell ${input.className ? escapeHtml(input.className) : ''}">
      <select ${attrs}>
        ${input.options.map((option) => `
          <option value="${escapeHtml(option.value)}" ${option.value === input.value ? 'selected' : ''} ${option.disabled ? 'disabled' : ''}>
            ${escapeHtml(option.label)}
          </option>
        `).join('')}
      </select>
      <div class="template-picker select-picker ${menuOpen ? 'open' : ''}" data-select-picker>
        <button
          id="${escapeHtml(`${baseId}-button`)}"
          class="template-picker-trigger select-picker-trigger"
          type="button"
          aria-haspopup="listbox"
          aria-expanded="${menuOpen ? 'true' : 'false'}"
          aria-controls="${escapeHtml(`${baseId}-menu`)}"
          aria-labelledby="${escapeHtml(labelledBy)}"
          ${input.disabled ? 'disabled' : ''}
          ${input.title ? `title="${escapeHtml(input.title)}"` : ''}
        >
          ${selectedLogo}
          <span class="template-picker-current">
            <span class="template-picker-category select-picker-meta" ${selectedMeta ? '' : 'hidden'}>${escapeHtml(selectedMeta)}</span>
            <strong id="${escapeHtml(`${baseId}-value`)}" data-select-picker-value>${escapeHtml(selectedLabel)}</strong>
          </span>
          <span class="template-picker-caret" aria-hidden="true"></span>
        </button>
        <div
          id="${escapeHtml(`${baseId}-menu`)}"
          class="template-picker-menu select-picker-menu"
          role="listbox"
          aria-labelledby="${escapeHtml(labelledBy)}"
          ${menuOpen ? '' : 'hidden'}
        >
          <div class="template-picker-group select-picker-group">
            ${menuOptions.map((option) => selectPickerOption(option, option.value === input.value)).join('')}
          </div>
        </div>
      </div>
    </div>
  `;
}

function selectPickerOption(option: SelectPickerOption, selected: boolean): string {
  const title = option.title ?? option.detail ?? option.label;
  const logo = option.logoId ? selectPickerLogo(option.logoId) : '';
  return `
    <button
      class="template-picker-option select-picker-option ${logo ? 'has-logo' : ''} ${selected ? 'selected active' : ''}"
      type="button"
      role="option"
      aria-selected="${selected ? 'true' : 'false'}"
      data-select-picker-option="${escapeHtml(option.value)}"
      data-select-picker-label="${escapeHtml(option.label)}"
      data-select-picker-meta="${escapeHtml(option.meta ?? '')}"
      tabindex="${selected ? '0' : '-1'}"
      ${option.disabled ? 'disabled aria-disabled="true"' : ''}
      ${title ? `title="${escapeHtml(title)}"` : ''}
    >
      ${logo}
      <span class="select-picker-option-copy">
        ${option.meta ? `<span>${escapeHtml(option.meta)}</span>` : ''}
        <strong>${escapeHtml(option.label)}</strong>
        ${option.detail ? `<em>${escapeHtml(option.detail)}</em>` : ''}
      </span>
    </button>
  `;
}

function selectPickerLogo(logoId: BrandLogoId): string {
  return brandLogo(logoId, 'select-picker-logo');
}

function selectPickerBaseId(input: {
  id?: string;
  value: string;
  attrs?: Record<string, string | boolean | undefined>;
  labelId?: string;
}): string {
  const seed = input.id ??
    stringAttr(input.attrs, 'data-template-field') ??
    stringAttr(input.attrs, 'data-recurring-field') ??
    (stringAttr(input.attrs, 'data-lab-field')
      ? `${stringAttr(input.attrs, 'data-lab-id') ?? 'select'}-${stringAttr(input.attrs, 'data-lab-field')}`
      : undefined) ??
    input.labelId ??
    input.value;
  return `select-picker-${seed.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'control'}`;
}

function stringAttr(attrs: Record<string, string | boolean | undefined> | undefined, key: string): string | undefined {
  const value = attrs?.[key];
  return typeof value === 'string' && value.length ? value : undefined;
}

function htmlAttrs(attrs: Record<string, string | boolean | undefined>): string {
  return Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([key, value]) => value === true ? key : `${key}="${escapeHtml(String(value))}"`)
    .join(' ');
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
  const lockedReason = lockedTabReason(tab);
  const locked = Boolean(lockedReason);
  const className = [
    state.activeTab === tab ? 'active' : '',
    mobileLabel ? 'has-mobile-label' : '',
  ].filter(Boolean).join(' ');
  const content = mobileLabel
    ? `<span class="nav-label nav-label-full">${escapeHtml(label)}</span><span class="nav-label nav-label-mobile">${escapeHtml(mobileLabel)}</span>`
    : `<span class="nav-label">${escapeHtml(label)}</span>`;
  const button = `<button data-tab="${tab}" class="${className}" aria-label="${escapeHtml(label)}" ${locked ? `disabled title="${escapeHtml(lockedReason)}"` : ''}>${content}</button>`;
  return locked
    ? `<span class="workspace-tab-tooltip" data-tab-tooltip="${escapeHtml(lockedReason)}">${button}</span>`
    : button;
}

function lockedTabReason(tab: ActiveTab): string {
  if (state.address) return '';
  if (tab === 'schedule') return 'Connect a wallet to create or manage repeat payments.';
  if (tab === 'inbox') return 'Connect a wallet to review requests that need approval.';
  return '';
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
  const outcome = planOutcome(plan);
  return `
    <article class="plan-card proof-preview">
      <div>
        <span class="workbench-kicker">${escapeHtml(plan.source === 'ai' ? 'AI plan' : 'Template plan')}</span>
        <h3>${escapeHtml(plan.intent)}</h3>
      </div>
      <div class="pill-row">
        <span class="status-pill neutral">${escapeHtml(titleCase(plan.category))}</span>
        <span class="status-pill neutral">${escapeHtml(plan.actionType.replace(/_/g, ' '))}</span>
        <span class="status-pill ${canQueueAgentPlan(plan) ? 'tx-confirmed' : 'tx-pending'}">${escapeHtml(outcomeShortLabel(outcome))}</span>
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
  return plan.source === 'ai' ? 'AI plan reviewed in Agentic' : 'You in Agentic';
}

function planSourceLabel(plan: AgentPlan): string {
  return plan.source === 'ai' ? 'Bring-your-own-key AI plan' : 'Keyless template, no AI';
}

function agentResultBlock(): string {
  if (!state.agentSignature) {
    return '<div class="empty">Optional review proof appears here after signing. It does not approve or submit a transaction.</div>';
  }
  return `
    <div class="results">
      <div class="result-row">
        <span>Review proof signature</span>
        <code>${escapeHtml(state.agentSignature)}</code>
        <button data-copy="${escapeHtml(state.agentSignature)}">Copy</button>
      </div>
    </div>
  `;
}

function queueStatusLine(visibleCount: number): string {
  const total = activeWorkflowPreparedActions().filter(isActionInboxActive).length;
  const bridge = activeWorkflowLabel();
  const filter = queueFilterLabel(state.inboxFilter);
  return `
    <div class="queue-status">
      <span>${escapeHtml(bridge)}</span>
      <strong>${visibleCount} need approval</strong>
      <span>${total} in queue</span>
      <span>${escapeHtml(filter)}</span>
    </div>
  `;
}

function scheduleStatusLine(): string {
  const payments = activeWorkflowRecurringPayments();
  const active = payments.filter((payment) => payment.status === 'active' && !isRecurringPaymentCompleted(payment)).length;
  const completed = payments.filter(isRecurringPaymentCompleted).length;
  const total = payments.length;
  const owner = activeWorkflowMode() === 'agentic-cloud'
    ? 'Agentic Cloud repeats'
    : activeWorkflowMode() === 'local-bridge'
      ? 'Private local mode'
      : 'Saved on this device';
  return `
    <div class="queue-status">
      <span>${escapeHtml(owner)}</span>
      <strong>${active} active repeat payment${active === 1 ? '' : 's'}</strong>
      <span>${total} saved</span>
      <span>${completed} completed</span>
      <span>Each payment still needs wallet approval</span>
    </div>
  `;
}

function preparedActionsList(actions = filteredPreparedActions()): string {
  if (activeWorkflowMode() !== 'local-bridge' && actions.length === 0) {
    return queueEmptyState('bridge');
  }
  if (actions.length === 0) {
    return queueEmptyState('clear');
  }
  const paginatedActions = paginateList(actions, 'inbox');
  return `
    <div class="inbox-list">
      ${paginatedActions.items.map(preparedActionCard).join('')}
    </div>
    ${listPagination('inbox', paginatedActions, 'Needs Approval requests')}
  `;
}

function queueEmptyState(kind: 'bridge' | 'clear'): string {
  const bridgeMissing = kind === 'bridge';
  const title = bridgeMissing ? 'No approvals waiting' : 'No approvals waiting';
  const detail = bridgeMissing
    ? activeWorkflowMode() === 'agentic-cloud'
      ? 'Send a one-time plan to Agentic Cloud for wallet review. No localhost is required.'
      : 'Create a one-time request or repeat payment. Saved-on-device workflow stays local to this browser.'
    : emptyInboxText();
  const chip = bridgeMissing ? 'Nothing waiting' : 'Nothing waiting';
  return `
    <div class="empty queue-empty queue-empty-state">
      <div>
        <span>${escapeHtml(chip)}</span>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(detail)}</p>
        <button type="button" class="primary" data-tab="agent">New Request</button>
      </div>
    </div>
  `;
}

function preparedActionCard(action: PreparedAction): string {
  const executable = ['ready', 'overdue', 'failed'].includes(action.status);
  const browserWorkflow = isBrowserWorkflowId(action.id);
  const cloudWorkflow = action.workflowSource === 'cloud';
  const decisionLabels = preparedActionDecisionLabels(action);
  const effectCopy = approvalEffectCopy(action);
  const executionBlockReason = cloudExecutionBlockReason(action);
  const confirmable = canConfirmCloudFinalization(action) || canConfirmBrowserTransaction(action);
  const executeDisabled = (!state.bridgeActive && !browserWorkflow && !cloudWorkflow) ||
    state.busy ||
    !executable ||
    Boolean(executionBlockReason);
  return `
    <article class="inbox-item approval-ticket inbox-approval-card ${action.status}">
      <div class="ticket-body inbox-approval-body">
        <div class="inbox-approval-head">
          <div class="inbox-approval-title-block">
            <div class="inbox-approval-meta">
              <span class="status-pill ${statusTone(action.status)}">${escapeHtml(action.status)}</span>
              <strong class="inbox-approval-meta-title">${escapeHtml(preparedActionCardTitle(action))}</strong>
              <span>${escapeHtml(action.kind.replace(/_/g, ' '))}</span>
              ${action.recurringId ? '<span>Repeat</span>' : ''}
              ${inboxActionFailurePill(action)}
              ${action.txStatus && action.txStatus !== 'failed' ? `<span class="status-pill ${txTone(action.txStatus)}">tx ${escapeHtml(action.txStatus)}</span>` : ''}
              <span>${escapeHtml(inboxApprovalSourceLabel(action))}</span>
            </div>
            <p class="ticket-meta-line">${escapeHtml(action.kind)} on ${escapeHtml(action.cluster)} - due ${formatDateTime(action.dueAt)}</p>
          </div>
          ${inboxApprovalHero(action)}
          <div class="inbox-actions inbox-approval-actions">
            <button data-action-op="execute" data-action-id="${action.id}" class="primary" ${executeDisabled ? 'disabled' : ''} ${executionBlockReason ? `title="${escapeHtml(executionBlockReason)}"` : ''}>${escapeHtml(decisionLabels.approve)}</button>
            ${confirmable ? `<button data-action-op="confirm" data-action-id="${action.id}" class="primary" ${state.busy ? 'disabled' : ''}>Check confirmation</button>` : ''}
            <button class="utility danger" data-action-op="reject" data-action-id="${action.id}" ${state.busy || isTerminalPreparedAction(action) ? 'disabled' : ''}>${escapeHtml(decisionLabels.reject)}</button>
          </div>
        </div>
        ${inboxApprovalSummaryGrid(action)}
        ${inboxApprovalNote(action)}
        ${finalizationChecklist(action)}
        <div class="inbox-approval-drawers">
          ${inlineReceiptActions(action)}
          ${recordActivityDetails('approval', action.id)}
        </div>
        ${relatedReceiptBlockForApproval(action.id)}
        ${action.error ? `<p class="error-text">${escapeHtml(action.error)}</p>` : ''}
        ${action.txError ? `<p class="error-text">${escapeHtml(action.txError)}</p>` : ''}
        ${action.txid ? txBlock(action.txid, action.cluster) : ''}
        <div class="approval-effect" data-approval-effect="${escapeHtml(action.workflowSource ?? (browserWorkflow ? 'browser' : 'local-bridge'))}">
          <strong>What this decision does</strong>
          <p>${escapeHtml(effectCopy)}</p>
        </div>
        ${executionBlockReason ? `<p class="error-text">${escapeHtml(executionBlockReason)}</p>` : ''}
        <div class="inbox-approval-footer-row">
          <button class="utility inbox-footer-action" data-action-op="copy" data-action-id="${action.id}">Copy request</button>
          <button class="utility inbox-footer-action" data-action-op="archive" data-action-id="${action.id}" ${state.busy ? 'disabled' : ''} title="Remove from Needs Approval without signing a denial proof.">Archive</button>
          <button class="utility danger recurring-delete-mini" data-action-op="delete" data-action-id="${action.id}" ${state.busy ? 'disabled' : ''}>Delete</button>
        </div>
      </div>
    </article>
  `;
}

function preparedActionCardTitle(action: PreparedAction): string {
  if (action.recurringId) return 'Repeat payment approval';
  if (action.kind === 'transfer_sol' || action.kind === 'transfer_spl') return 'Transfer approval';
  if (action.kind === 'swap') return 'Swap approval';
  return action.summary;
}

function inboxActionFailurePill(action: PreparedAction): string {
  const failed = action.txStatus === 'failed' ||
    action.status === 'failed' ||
    Boolean((action.txError || action.error) && EXECUTABLE_BROWSER_ACTION_KINDS.has(action.kind));
  if (!failed) return '';
  const label = action.kind === 'swap'
    ? 'Swap failed - try again'
    : action.kind === 'transfer_sol' || action.kind === 'transfer_spl'
      ? 'Send failed - try again'
      : 'Tx failed - try again';
  return `<span class="status-pill tx-failed">${escapeHtml(label)}</span>`;
}

function inboxApprovalHero(action: PreparedAction): string {
  const primary = amountLabel(action);
  const secondary = recipientParam(action)
    ? `To ${short(recipientParam(action))}`
    : formatDateTime(action.dueAt);
  return `
    <div class="inbox-approval-value" title="${escapeHtml(`${primary} ${secondary}`.trim())}">
      <strong>${escapeHtml(primary)}</strong>
      <span>${escapeHtml(secondary)}</span>
    </div>
  `;
}

function inboxApprovalTokenSummary(action: PreparedAction): { value: string; title: string; copyValue?: string } {
  if (action.kind === 'transfer_sol') {
    return { value: 'SOL', title: 'SOL', copyValue: WSOL_MINT };
  }
  const token = stringParam(action, 'token');
  if (token) {
    return { value: tokenDisplayLabel(token), title: token, copyValue: resolveTokenMintForCopy(token) };
  }
  const inputToken = stringParam(action, 'inputToken');
  const outputToken = stringParam(action, 'outputToken');
  if (inputToken || outputToken) {
    const input = inputToken || 'input';
    const output = outputToken || 'output';
    return {
      value: `${tokenDisplayLabel(input)} -> ${tokenDisplayLabel(output)}`,
      title: `${input} -> ${output}`,
      copyValue: `${resolveTokenMintForCopy(input)} -> ${resolveTokenMintForCopy(output)}`,
    };
  }
  return { value: 'n/a', title: 'n/a' };
}

function resolveTokenMintForCopy(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (looksLikeMintAddress(trimmed)) return trimmed;
  const known = KNOWN_BROWSER_TOKENS[trimmed.toUpperCase()];
  return known?.mint ?? trimmed;
}

function tokenDisplayLabel(value: string): string {
  const trimmed = value.trim();
  if (!looksLikeMintAddress(trimmed)) return trimmed;
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function looksLikeMintAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function inboxApprovalSummaryGrid(action: PreparedAction): string {
  const recipient = recipientParam(action);
  const tokenSummary = inboxApprovalTokenSummary(action);
  const rows: Array<{ label: string; value: string; title?: string; copyValue?: string; tone?: 'amount' }> = [
    { label: 'Wallet', value: short(action.walletAddress), title: action.walletAddress, copyValue: action.walletAddress },
    { label: 'Recipient', value: recipient ? short(recipient) : 'n/a', title: recipient || 'n/a', copyValue: recipient || undefined },
    { label: 'Token', value: tokenSummary.value, title: tokenSummary.title, copyValue: tokenSummary.copyValue },
    { label: 'Due', value: formatDateTime(action.dueAt) },
  ];
  return `
    <dl class="inbox-approval-summary-grid" aria-label="Approval summary">
      ${rows.map((row) => inboxApprovalSummaryItem(row)).join('')}
    </dl>
  `;
}

function inboxApprovalSummaryItem(row: { label: string; value: string; title?: string; copyValue?: string; tone?: 'amount' }): string {
  const title = row.title ?? row.value;
  return `
    <div class="${row.tone ? `inbox-approval-summary-${row.tone}` : ''}" title="${escapeHtml(title)}">
      <dt>${escapeHtml(row.label)}</dt>
      <dd class="${row.copyValue ? 'has-copy' : ''}">
        <span>${escapeHtml(row.value)}</span>
        ${row.copyValue ? `
          <button
            type="button"
            class="wallet-action-copy"
            data-copy="${escapeHtml(row.copyValue)}"
            data-copy-name="${escapeHtml(row.label)}"
          >
            Copy
          </button>
        ` : ''}
      </dd>
    </div>
  `;
}

function inboxApprovalNote(action: PreparedAction): string {
  const note = action.note?.trim();
  if (!note) return '';
  return `
    <section class="review-plan-user-note inbox-approval-note" aria-label="Approval note" title="${escapeHtml(note)}">
      <span>Note</span>
      <p>${escapeHtml(note)}</p>
    </section>
  `;
}

function inboxApprovalSourceLabel(action: PreparedAction): string {
  if (action.workflowSource === 'cloud') return 'Cloud';
  if (action.workflowSource === 'local-bridge') return 'Local bridge';
  if (action.workflowSource === 'browser' || isBrowserWorkflowId(action.id)) return 'Browser';
  return 'Local bridge';
}

function inlineReceiptActions(action: PreparedAction): string {
  const disabled = !state.address || state.address !== action.walletAddress || state.busy;
  const alreadySigned = relatedEvidenceReceiptsForApproval(action.id);
  const signedKinds = new Set(alreadySigned.map((artifact) => artifact.kind));
  const actions: Array<[InlineReceiptKind, string, string, string]> = [
    ['intent', 'Sign proof of intent', 'Record the exact request before deciding.', 'Proof of intent signed'],
    ['policy', 'Sign proof of policy', 'Record the caps and wallet rules checked.', 'Proof of policy signed'],
    ['review', 'Sign proof of review', 'Record the risks reviewed before the wallet opens.', 'Proof of review signed'],
    ['rejection', 'Deny with proof', 'Sign a rejection receipt, then deny this request.', 'Rejection proof signed'],
  ];
  return `
    <details class="inline-receipt-actions receipt-proof-drawer" aria-label="Saved proof actions">
      <summary>
        <strong>Saved proofs</strong>
        <span>Optional evidence only</span>
      </summary>
      <div class="inline-receipt-button-grid">
        ${actions.map(([kind, label, title, signedLabel]) => {
          const lab = labById(receiptLabIdForInlineKind(kind));
          const signed = lab ? signedKinds.has(lab.kind) : false;
          return `
            <button
              type="button"
              data-inline-receipt-kind="${escapeHtml(kind)}"
              data-inline-receipt-action-id="${escapeHtml(action.id)}"
              title="${escapeHtml(title)}"
              ${disabled || signed ? 'disabled' : ''}
            >
              ${escapeHtml(signed ? signedLabel : label)}
            </button>
          `;
        }).join('')}
      </div>
    </details>
  `;
}

function preparedActionDecisionLabels(action: PreparedAction): { approve: string; reject: string } {
  if (canFinalizeCloudSolTransfer(action)) {
    return {
      approve: 'Review and send',
      reject: 'Deny request',
    };
  }
  if (isExecutableBrowserAction(action)) {
    return {
      approve: action.kind === 'swap' ? 'Approve swap' : 'Approve and send',
      reject: 'Deny request',
    };
  }
  if (requiresCloudTransactionFinalization(action)) {
    return {
      approve: 'Use private local mode',
      reject: 'Deny request',
    };
  }
  if (action.workflowSource === 'cloud' || isBrowserWorkflowId(action.id)) {
    return {
      approve: 'Sign approval proof',
      reject: 'Deny request',
    };
  }
  return {
    approve: 'Approve in wallet',
    reject: 'Reject',
  };
}

function approvalEffectCopy(action: PreparedAction): string {
  if (canFinalizeCloudSolTransfer(action)) {
    return 'Agentic Cloud prepares and simulates the exact SOL transfer, your browser opens your wallet for that transaction only, then Agentic saves a finalization receipt. Agentic never receives signing authority.';
  }
  if (requiresCloudTransactionFinalization(action)) {
    return action.kind === 'transfer_sol'
      ? 'This cloud transfer requires transaction finalization, but the connected wallet cannot sign this transaction from this browser session.'
      : 'This money-moving request requires transaction finalization. Cloud finalization for this action type is not live yet, so proof-only approval is blocked.';
  }
  if (action.workflowSource === 'cloud') {
    return 'Your wallet signs a decision proof bound to this approval. Agentic Cloud saves the receipt; this proof does not submit a transaction.';
  }
  if (isExecutableBrowserAction(action)) {
    if (action.kind === 'swap') {
      return 'Your wallet signs the swap transaction. Pending transactions stay here with a Solscan link; Done appears after confirmation.';
    }
    return 'Your wallet signs and submits the transaction. Pending transactions stay here with a Solscan link; Done appears after confirmation.';
  }
  if (isBrowserWorkflowId(action.id)) {
    return 'Your wallet signs a browser-local decision proof. The receipt stays on this device; no transaction is submitted by this proof.';
  }
  return 'Private local mode sends the prepared action to your local runtime. The connected wallet still controls the final signature or send request.';
}

const CLOUD_TRANSACTION_FINALIZATION_KINDS = new Set<PreparedActionKind>([
  'transfer_sol',
  'transfer_spl',
  'swap',
  'custom_transaction',
]);

function canFinalizeCloudSolTransfer(action: PreparedAction): boolean {
  return action.workflowSource === 'cloud' &&
    action.kind === 'transfer_sol' &&
    state.capabilities?.supports.signTransaction === true &&
    Boolean(state.address && state.address === action.walletAddress);
}

function canConfirmCloudFinalization(action: PreparedAction): boolean {
  return action.workflowSource === 'cloud' &&
    Boolean(action.finalizationId && action.txid) &&
    (action.status === 'approval_pending' || action.finalizationStatus === 'submitted' || action.txStatus === 'pending');
}

function canConfirmBrowserTransaction(action: PreparedAction): boolean {
  return isExecutableBrowserAction(action) &&
    Boolean(action.txid) &&
    (action.status === 'approval_pending' || action.txStatus === 'pending');
}

function requiresCloudTransactionFinalization(action: PreparedAction): boolean {
  return action.workflowSource === 'cloud' && CLOUD_TRANSACTION_FINALIZATION_KINDS.has(action.kind);
}

function cloudExecutionBlockReason(action: PreparedAction): string | null {
  if (!requiresCloudTransactionFinalization(action)) return null;
  if (action.kind === 'transfer_sol') {
    if (!state.address || state.address !== action.walletAddress) {
      return 'Connect the approval wallet before finalizing this cloud SOL transfer.';
    }
    if (state.capabilities?.supports.signTransaction !== true) {
      return 'This wallet cannot sign transactions from this browser. Use private local mode or reject this request.';
    }
    return null;
  }
  return 'Cloud transaction finalization for this action is not live yet. Use private local mode or reject this request.';
}

function finalizationChecklist(action: PreparedAction): string {
  const requiresWalletFinalization = requiresCloudTransactionFinalization(action);
  if (!requiresWalletFinalization && !action.finalization) return '';
  const status = action.finalization?.status ?? action.finalizationStatus ?? 'not_started';
  const rows: Array<{ label: string; complete: boolean; detail: string }> = [
    {
      label: 'Constraints locked',
      complete: true,
      detail: action.transactionHash ? short(action.transactionHash) : 'Approval parameters are bound to this request.',
    },
    {
      label: 'Quote refreshed',
      complete: Boolean(action.finalization?.quote || status === 'simulation_passed' || status === 'submitted' || status === 'confirmed'),
      detail: action.quoteHash ? short(action.quoteHash) : 'Refreshed at final review.',
    },
    {
      label: 'Simulation passed',
      complete: action.finalization?.simulation?.status === 'ok' || status === 'simulation_passed' || status === 'submitted' || status === 'confirmed',
      detail: action.simulationHash ? short(action.simulationHash) : 'Required before wallet opens.',
    },
    {
      label: 'Receipt saved',
      complete: Boolean(action.txid || status === 'confirmed'),
      detail: action.txid ? short(action.txid) : 'Saved after wallet approval.',
    },
  ];
  return `
    <div class="finalization-checklist" aria-label="Transaction finalization checklist">
      ${rows.map((row) => `
        <div class="${row.complete ? 'complete' : ''}">
          <span>${row.complete ? 'ok' : ''}</span>
          <strong>${escapeHtml(row.label)}</strong>
          <p>${escapeHtml(row.detail)}</p>
        </div>
      `).join('')}
    </div>
  `;
}

function actionPreview(action: PreparedAction): string {
  const rows: Array<[string, string]> = [
    ['Wallet', short(action.walletAddress)],
    ['Recipient', recipientParam(action) ? short(recipientParam(action)) : 'n/a'],
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
  const limit = recurringDraftLimitLabel(draft);
  const createDisabled = !state.address || state.busy;
  const workflowMode = activeWorkflowMode();
  const browserWorkflow = workflowMode === 'browser-workflow';
  const recurringHelp = browserWorkflow
    ? 'Creates one local approval item now. Use Cloud or the local connector for background repeats.'
    : 'Every payment returns to Needs Approval before wallet signing.';
  const boundaryCopy = browserWorkflow
    ? 'One local approval item is created now; background repeats need Cloud or local connector.'
    : `${activeWorkflowLabel()} owns this repeat payment. No transaction signs until you approve a payment.`;
  const actionHelper = !state.address
    ? 'Connect a wallet before creating a repeat payment.'
    : browserWorkflow
      ? 'Creates one local approval item now.'
      : 'Future payments will appear in Needs Approval.';
  return `
    <div class="recurring-panel recurring-contract">
      <div class="contract-head app-inline-head recurring-composer-head">
        <div>
          <span>Repeat setup</span>
          <h3>Create repeat payment</h3>
          <p class="recurring-help">${escapeHtml(recurringHelp)}</p>
        </div>
        <div class="recurring-composer-meta">
          <strong>${escapeHtml(recurringCadenceLabel(draft.cadence))}</strong>
          <em class="accent-note">${browserWorkflow ? 'Local now; Cloud for background' : `${activeWorkflowLabel()} scheduler`}</em>
        </div>
      </div>
      <div class="recurring-create-primary-row">
        <div class="recurring-boundary-note">
          <strong>Signing boundary</strong>
          <p>${escapeHtml(boundaryCopy)}</p>
        </div>
        <div class="recurring-form-actions contract-actions">
          <button id="createRecurring" class="primary" ${createDisabled ? 'disabled' : ''}>Create repeat payment</button>
          <button type="button" class="utility" data-recurring-action="dca-proof">Create DCA review proof</button>
          <span class="contract-helper accent-note">${escapeHtml(actionHelper)}</span>
        </div>
      </div>
      <dl class="contract-summary recurring-create-summary">
        ${definitionRow('Asset', `${draft.amount || 'Amount'} ${draft.token || 'Token'}`)}
        ${definitionRow('Recipient', recipient)}
        ${definitionRow('Cadence', recurringDraftScheduleLabel(draft))}
        ${definitionRow('Limit', limit)}
      </dl>
      ${recurringPresetControls()}
      <div class="contract-section recurring-create-section">
        <div>
          <span>Payment terms</span>
          <p>Token, amount, recipient.</p>
        </div>
        <div class="recurring-grid">
          ${recurringTokenSelect(draft.token)}
          ${fieldInput('recurringAmount', 'Amount *', draft.amount)}
          ${fieldInput('recurringRecipient', 'Recipient *', draft.recipient)}
        </div>
      </div>
      <div class="contract-section recurring-create-section">
        <div>
          <span>Schedule terms</span>
          <p>Cadence and local time.</p>
        </div>
        <div class="recurring-grid schedule-grid">
          <label class="field compact">
            <span>Cadence</span>
            ${selectPicker({
              id: 'recurringCadence',
              value: draft.cadence,
              attrs: { 'data-recurring-field': 'cadence' },
              options: [
                { value: 'weekly', label: 'Weekly', meta: 'Cadence' },
                { value: 'monthly', label: 'Monthly', meta: 'Cadence' },
                { value: 'interval_days', label: 'Interval days', meta: 'Cadence' },
                { value: 'interval_hours', label: 'Interval hours', meta: 'Cadence' },
                { value: 'interval_minutes', label: 'Interval minutes', meta: 'Cadence' },
              ],
            })}
          </label>
          ${recurringScheduleFields(draft)}
        </div>
      </div>
      <div class="contract-section recurring-create-section recurring-note-section">
        <div>
          <span>Notes for approval</span>
          <p>Purpose shown when this needs approval.</p>
        </div>
        <label class="field compact approval-memo recurring-note-field">
          <span>What is this for?</span>
          <textarea
            id="recurringNote"
            data-recurring-field="note"
            placeholder="Example: rent, payroll, DCA, subscription, or invoice #42"
          >${escapeHtml(draft.note)}</textarea>
        </label>
      </div>
      <details class="recurring-advanced-details">
        <summary>Advanced</summary>
        <div class="contract-section">
          <div>
            <span>Caps and reminders</span>
            <p>Stop time and webhook reminders.</p>
          </div>
          <div class="recurring-grid">
            ${fieldInput('recurringMaxOccurrences', 'Max occurrences', draft.maxOccurrences, 'empty for indefinite')}
            ${fieldInput('recurringExpiresAt', 'Expires at', draft.expiresAt, '', 'datetime-local')}
            ${fieldInput('recurringWebhookUrl', 'Webhook URL', draft.webhookUrl, 'https://example.com/agentic-webhook')}
          </div>
        </div>
      </details>
      ${recurringDraftPreviewPanel(draft)}
    </div>
  `;
}

function recurringDraftLimitLabel(draft: RecurringDraft): string {
  const parts: string[] = [];
  if (draft.maxOccurrences.trim()) {
    parts.push(`${draft.maxOccurrences.trim()} occurrence${draft.maxOccurrences.trim() === '1' ? '' : 's'}`);
  }
  if (draft.expiresAt.trim()) {
    const expiresAt = optionalLocalDateTimeToIso(draft.expiresAt);
    parts.push(expiresAt ? `expires ${formatDateTime(expiresAt)}` : 'expiry needs a valid date');
  }
  return parts.length ? parts.join(' · ') : 'Manual review every time';
}

function recurringDraftPreviewPanel(draft: RecurringDraft): string {
  const runs = recurringDraftNextRuns(draft);
  const spend = recurringDraftLifetimeSpend(draft);
  return `
    <div class="recurring-next-preview recurring-production-preview">
      <div>
        <span>Next runs</span>
        <strong id="recurringNextOccurrence">${escapeHtml(runs[0] ? formatDateTime(runs[0]) : recurringNextOccurrenceLabel(draft))}</strong>
      </div>
      ${runs.length ? `<ol>${runs.map((run) => `<li>${escapeHtml(formatDateTime(run))}</li>`).join('')}</ol>` : ''}
      ${spend ? `<p>${escapeHtml(lifetimeSpendCopy(spend, draft.token))}</p>` : ''}
    </div>
  `;
}

function lifetimeSpendCopy(spend: LifetimeSpend, token: string): string {
  const rate = `${spend.perWeek} ${token}/week · ${spend.perMonth} ${token}/month`;
  if (spend.bounded && spend.totalAmount !== undefined && spend.totalRuns !== undefined) {
    return `Runs up to ${spend.totalRuns} time${spend.totalRuns === 1 ? '' : 's'} and spends up to ${spend.totalAmount} ${token}. ${rate}.`;
  }
  return `No lifetime cap set. Current rate estimate: ${rate}.`;
}

function recurringPresetControls(): string {
  return `
    <div class="template-filter-row recurring-preset-row" role="group" aria-label="Repeat payment presets">
      ${RECURRING_PRESETS.map((preset) => `
        <button
          type="button"
          data-recurring-preset="${escapeHtml(preset.id)}"
          class="${state.recurringPreset === preset.id ? 'active' : ''}"
          ${state.busy ? 'disabled' : ''}
          title="${escapeHtml(preset.description)}"
        >
          ${escapeHtml(preset.title)}
        </button>
      `).join('')}
    </div>
  `;
}

function recurringTokenSelect(value: string): string {
  const error = fieldError('recurringToken');
  return `
    <label class="field compact ${state.recurringErrors.recurringToken ? 'field-error' : ''}">
      <span>Token</span>
      ${selectPicker({
        id: 'recurringToken',
        value,
        attrs: { 'data-recurring-field': 'token' },
        options: RECURRING_TOKEN_OPTIONS.map((token) => ({
          value: token,
          label: token,
          meta: 'Token',
        })),
      })}
      ${error}
    </label>
  `;
}

function recurringList(): string {
  const payments = activeWorkflowRecurringPayments();
  if (payments.length === 0) {
    return '';
  }
  const paginatedPayments = paginateList(payments, 'recurring');
  return `
    <div class="recurring-list">
      ${paginatedPayments.items.map(recurringCard).join('')}
    </div>
    ${listPagination('recurring', paginatedPayments, 'Active recurring')}
  `;
}

function recurringCard(payment: RecurringPayment): string {
  const completed = isRecurringPaymentCompleted(payment);
  const status = completed ? formatScheduleStatus('completed') : formatScheduleStatus(payment.status);
  const nextRuns = recurringPaymentNextRuns(payment);
  const spend = recurringPaymentLifetimeSpend(payment);
  const flipOp = payment.status === 'active' ? 'pause' : 'resume';
  const history = state.recurringOccurrenceHistory[payment.id];
  const notifications = state.recurringNotificationStatus[payment.id];
  const source = recurringPaymentWorkflowSource(payment);
  return `
    <article class="recurring-item recurring-card">
      <div class="recurring-card-main">
        <div class="recurring-card-head">
          <div class="recurring-card-title-block">
            <div class="recurring-card-meta">
              <span class="status-pill ${statusLabelToneClass(status.tone)}">${escapeHtml(status.label)}</span>
              <span>${escapeHtml(recurringCadenceLabel(payment.cadence))}</span>
              <span>${escapeHtml(recurringOccurrenceCountLabel(payment))}</span>
              <span>${escapeHtml(recurringSourceLabel(source))}</span>
            </div>
            <h3>${escapeHtml(recurringPaymentTitle(payment))}</h3>
            <p title="${escapeHtml(payment.recipient)}">To ${escapeHtml(short(payment.recipient))}</p>
          </div>
          ${recurringCardHero(payment, nextRuns)}
          <div class="recurring-actions recurring-card-actions">
            <button data-recurring-op="${flipOp}" data-recurring-id="${payment.id}" ${completed || state.busy ? 'disabled' : ''}>${payment.status === 'active' ? 'Pause' : 'Resume'}</button>
            <button data-recurring-op="history" data-recurring-id="${payment.id}" ${state.busy ? 'disabled' : ''}>${history ? 'Refresh past payments' : 'Load past payments'}</button>
          </div>
        </div>
        ${recurringCardSummaryGrid(payment, nextRuns, spend, source)}
        ${recurringCardNote(payment)}
        ${recurringCardFooter(payment, history, notifications, source, nextRuns)}
      </div>
    </article>
  `;
}

function recurringPaymentTitle(payment: RecurringPayment): string {
  return payment.token === 'SOL' ? 'Repeat SOL transfer' : `Repeat ${payment.token} transfer`;
}

function recurringCardHero(payment: RecurringPayment, nextRuns: string[]): string {
  const nextRun = nextRuns[0] ? `Next ${formatDateTime(nextRuns[0])}` : 'No future run preview';
  return `
    <div class="recurring-card-value" title="${escapeHtml(`${payment.amount} ${payment.token} - ${nextRun}`)}">
      <strong>${escapeHtml(`${payment.amount} ${payment.token}`)}</strong>
      <span>${escapeHtml(nextRun)}</span>
    </div>
  `;
}

function recurringCardSummaryGrid(
  payment: RecurringPayment,
  nextRuns: string[],
  spend: LifetimeSpend,
  source: WorkflowRecordSource,
): string {
  const nextRun = nextRuns[0] ? formatDateTime(nextRuns[0]) : 'No preview';
  const rows: Array<{ label: string; value: string; title?: string; copyValue?: string; tone?: 'amount' }> = [
    { label: 'Recipient', value: short(payment.recipient), title: payment.recipient, copyValue: payment.recipient },
    { label: 'Next run', value: nextRun },
    { label: 'Cadence', value: recurringScheduleShortLabel(payment) },
    { label: 'Limit', value: recurringLimitShortLabel(payment) },
    { label: 'Rate', value: recurringRateShortLabel(spend, payment.token), tone: 'amount' },
    { label: 'Source', value: recurringSourceLabel(source) },
  ];
  return `
    <dl class="recurring-card-summary-grid" aria-label="Repeat payment summary">
      ${rows.map((row) => recurringCardSummaryItem(row)).join('')}
    </dl>
  `;
}

function recurringCardSummaryItem(row: { label: string; value: string; title?: string; copyValue?: string; tone?: 'amount' }): string {
  const title = row.title ?? row.value;
  return `
    <div class="${row.tone ? `recurring-card-summary-${row.tone}` : ''}" title="${escapeHtml(title)}">
      <dt>${escapeHtml(row.label)}</dt>
      <dd class="${row.copyValue ? 'has-copy' : ''}">
        <span>${escapeHtml(row.value)}</span>
        ${row.copyValue ? `
          <button
            type="button"
            class="wallet-action-copy"
            data-copy="${escapeHtml(row.copyValue)}"
            data-copy-name="${escapeHtml(row.label)}"
          >
            Copy
          </button>
        ` : ''}
      </dd>
    </div>
  `;
}

function recurringCardNote(payment: RecurringPayment): string {
  const note = payment.note?.trim();
  if (!note) return '';
  return `
    <section class="review-plan-user-note recurring-card-note" aria-label="Repeat payment note" title="${escapeHtml(note)}">
      <span>Note</span>
      <p>${escapeHtml(note)}</p>
    </section>
  `;
}

function recurringCardFooter(
  payment: RecurringPayment,
  history: RecurringOccurrenceHistoryState | undefined,
  notifications: RecurringNotificationStatusState | undefined,
  source: WorkflowRecordSource,
  nextRuns: string[],
): string {
  const completed = isRecurringPaymentCompleted(payment);
  return `
    <div class="recurring-card-footer-row">
      <div class="recurring-card-footer-stack">
        ${recurringUpcomingRunsDetails(nextRuns)}
        ${recurringHistoryPanel(payment, history)}
        ${recurringNotificationsPanel(payment, notifications, source)}
      </div>
      <div class="recurring-card-footer-actions">
        <button class="utility danger recurring-delete-mini" data-recurring-op="delete" data-recurring-id="${payment.id}" ${completed || state.busy ? 'disabled' : ''}>Delete</button>
      </div>
    </div>
  `;
}

function recurringUpcomingRunsDetails(nextRuns: string[]): string {
  if (!nextRuns.length) return '';
  return `
    <details class="recurring-upcoming-runs">
      <summary>Upcoming runs</summary>
      <ol>${nextRuns.map((run) => `<li>${escapeHtml(formatDateTime(run))}</li>`).join('')}</ol>
    </details>
  `;
}

function recurringOccurrenceCountLabel(payment: RecurringPayment): string {
  const created = payment.occurrencesCreated ?? 0;
  return payment.maxOccurrences ? `${created} of ${payment.maxOccurrences}` : `${created} created`;
}

function recurringSourceLabel(source: WorkflowRecordSource): string {
  switch (source) {
    case 'cloud':
      return 'Cloud';
    case 'local-bridge':
      return 'Local bridge';
    default:
      return 'Browser';
  }
}

function recurringScheduleShortLabel(payment: RecurringPayment): string {
  if (payment.cadence === 'weekly') {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return `${days[payment.dayOfWeek ?? -1] ?? 'Weekly'} ${payment.localTime ?? '?'}`;
  }
  if (payment.cadence === 'monthly') {
    return `Day ${payment.dayOfMonth ?? '?'} ${payment.localTime ?? '?'}`;
  }
  if (payment.cadence === 'interval_hours') {
    return `Every ${payment.intervalHours ?? '?'} hr`;
  }
  if (payment.cadence === 'interval_minutes') {
    return `Every ${payment.intervalMinutes ?? '?'} min`;
  }
  return `Every ${payment.intervalDays ?? '?'} day`;
}

function recurringLimitShortLabel(payment: RecurringPayment): string {
  const created = payment.occurrencesCreated ?? 0;
  const count = payment.maxOccurrences ? `${created} of ${payment.maxOccurrences}` : 'Indefinite';
  return payment.expiresAt ? `${count} - expires ${formatDateTime(payment.expiresAt)}` : count;
}

function recurringRateShortLabel(spend: LifetimeSpend, token: string): string {
  return `${spend.perWeek} ${token}/week - ${spend.perMonth} ${token}/month`;
}

function recurringHistoryPanel(
  payment: RecurringPayment,
  history: RecurringOccurrenceHistoryState | undefined,
): string {
  if (!history) {
    return '';
  }
  if (history.error) {
    return `<div class="recurring-history-strip error-text">${escapeHtml(history.error)}</div>`;
  }
  if (history.occurrences.length === 0) {
    return `
      <div class="recurring-history-strip">
        <strong>No runs yet</strong>
        <span>${escapeHtml(payment.nextDueAt ? `First run is scheduled for ${formatDateTime(payment.nextDueAt)}.` : 'Runs appear here after they materialize.')}</span>
      </div>
    `;
  }
  return `
    <div class="recurring-history-list">
      <div class="recurring-history-head">
        <strong>Payment history</strong>
        ${history.loadedAt ? `<span>Updated ${escapeHtml(formatDateTime(history.loadedAt))}</span>` : ''}
      </div>
      ${history.occurrences.map(recurringHistoryRow).join('')}
      ${history.nextCursor ? `<button data-recurring-op="history-more" data-recurring-id="${payment.id}" data-recurring-cursor="${escapeHtml(history.nextCursor)}" ${state.busy ? 'disabled' : ''}>Show older</button>` : ''}
    </div>
  `;
}

function recurringNotificationsPanel(
  payment: RecurringPayment,
  notifications: RecurringNotificationStatusState | undefined,
  source: WorkflowRecordSource,
): string {
  if (source !== 'cloud' || !payment.notifications?.webhookUrl) return '';
  const reveal = state.recurringWebhookSecretOnce?.scheduleId === payment.id
    ? state.recurringWebhookSecretOnce
    : null;
  const latest = notifications?.lastDelivery;
  return `
    <div class="recurring-notifications-panel">
      <div class="recurring-history-head">
        <strong>Notifications</strong>
        <span>${escapeHtml(short(payment.notifications.webhookUrl))}</span>
      </div>
      ${reveal ? `
        <div class="recurring-secret-reveal">
          <span>Webhook secret shown once</span>
          <code>${escapeHtml(reveal.secret)}</code>
          <button data-copy="${escapeHtml(reveal.secret)}" data-copy-name="Webhook secret">Copy secret</button>
        </div>
      ` : ''}
      ${notifications?.error ? `<p class="error-text">${escapeHtml(notifications.error)}</p>` : ''}
      ${latest ? `
        <div class="recurring-history-strip">
          <strong>${escapeHtml(notificationDeliveryLabel(latest))}</strong>
          <span>${escapeHtml(notificationDeliveryDetail(latest))}</span>
        </div>
      ` : `
        <div class="recurring-history-strip">
          <strong>Delivery status not loaded</strong>
          <span>Refresh notifications to see webhook attempts and retries.</span>
        </div>
      `}
      <div class="recurring-actions inline-actions">
        <button data-recurring-op="notifications" data-recurring-id="${payment.id}" ${state.busy ? 'disabled' : ''}>Refresh</button>
        <button data-recurring-op="rotate-secret" data-recurring-id="${payment.id}" ${state.busy ? 'disabled' : ''}>Rotate secret</button>
      </div>
    </div>
  `;
}

function notificationDeliveryLabel(delivery: RecurringNotificationDelivery): string {
  switch (delivery.status) {
    case 'delivered':
      return 'Webhook delivered';
    case 'pending':
      return 'Webhook pending';
    case 'failed':
      return 'Webhook retry scheduled';
    case 'abandoned':
      return 'Webhook abandoned';
  }
}

function notificationDeliveryDetail(delivery: RecurringNotificationDelivery): string {
  if (delivery.status === 'delivered') {
    return `Delivered ${delivery.deliveredAt ? formatDateTime(delivery.deliveredAt) : formatDateTime(delivery.updatedAt)} after ${delivery.attempts} attempt${delivery.attempts === 1 ? '' : 's'}.`;
  }
  const retry = delivery.status === 'pending' || delivery.status === 'failed'
    ? ` Next attempt ${formatDateTime(delivery.nextAttemptAt)}.`
    : '';
  return `${delivery.attempts} attempt${delivery.attempts === 1 ? '' : 's'}.${retry}${delivery.lastError ? ` ${delivery.lastError}` : ''}`;
}

function recurringHistoryRow(occurrence: RecurringOccurrenceHistoryItem): string {
  const label = occurrence.statusLabel ?? formatOccurrenceStatus(occurrence.status, occurrence.approval);
  const txid = occurrence.completed?.txid ?? occurrence.approval?.txid;
  return `
    <div class="recurring-history-row">
      <span class="status-pill ${statusLabelToneClass(label.tone)}">${escapeHtml(label.label)}</span>
      <strong>${escapeHtml(formatDateTime(occurrence.dueAt))}</strong>
      ${occurrence.approval ? `<span>${escapeHtml(`Approval ${short(occurrence.approval.id)}`)}</span>` : ''}
      ${txid ? `<button data-copy="${escapeHtml(txid)}" data-copy-name="Transaction id">Copy txid</button>` : ''}
      ${occurrence.error ? `<p class="error-text">${escapeHtml(occurrence.error)}</p>` : ''}
    </div>
  `;
}

function statusLabelToneClass(tone: StatusLabel['tone']): string {
  if (tone === 'success') return 'tx-confirmed';
  if (tone === 'danger') return 'tx-failed';
  if (tone === 'warning' || tone === 'info') return 'tx-pending';
  return 'neutral';
}

function labArtifactCard(artifact: LabArtifact): string {
  const legacy = labById(artifact.labId)?.category === 'advanced';
  return `
    <article class="lab-artifact artifact-summary-card">
      <div class="artifact-summary-head">
        <div class="artifact-meta-line">
          <span class="status-pill ${artifact.verified ? 'tx-confirmed' : 'tx-pending'}">${artifact.verified ? 'verified' : 'signed'}</span>
          <span>${escapeHtml(labKindLabel(artifact.kind))}</span>
        </div>
        <span>${escapeHtml(formatDateTime(artifact.createdAt))}</span>
      </div>
      <h3>${escapeHtml(legacy ? 'Legacy receipt signed and saved' : 'Receipt signed and saved')}</h3>
      <p class="lab-thesis">No further action is required. Use this record for your own audit trail or share it with an agent, auditor, support thread, or teammate.</p>
      <div class="artifact-intent-block">
        <span>Signed request</span>
        <p>${escapeHtml(artifact.input)}</p>
      </div>
      <div class="artifact-evidence-row">
        ${artifactMetricCard(artifact, 'Verdict')}
        ${artifactMetricCard(artifact, 'Custody')}
        ${artifactMetricCard(artifact, 'Effect')}
      </div>
      <div class="lab-actions lab-signature-action">
        <button type="button" class="utility" data-artifact-view="signed">View in archive</button>
        <button type="button" data-copy="${escapeHtml(stableJson(artifact))}" data-copy-name="Receipt JSON">Copy receipt JSON</button>
        <button type="button" class="utility" data-lab-action="create-another">Create another</button>
      </div>
      <details class="artifact-technical-details">
        <summary>
          <span>Technical details</span>
          <strong>Hashes and signed message</strong>
        </summary>
        <div class="hash-grid">
          ${hashTile('Pre-signature', artifact.preSignatureHash)}
          ${hashTile('Receipt', artifact.artifactHash)}
          ${hashTile('Signature', artifact.signature)}
          ${hashTile('Wallet', artifact.walletAddress)}
        </div>
        <div class="results compact-results">
          <div class="result-row">
            <span>Signing message</span>
            <code>${escapeHtml(artifact.signingMessage)}</code>
            <button data-copy="${escapeHtml(artifact.signingMessage)}" data-copy-name="Copy signed message">Copy</button>
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
      <h3>Recent saved proofs</h3>
      ${state.labArtifacts.slice(0, 5).map(
        (artifact) => `
          <article>
            <strong>${escapeHtml(artifact.title)}</strong>
            <span>${escapeHtml(formatDateTime(artifact.createdAt))}</span>
            <button data-copy="${escapeHtml(stableJson(artifact))}" data-copy-name="Receipt JSON">Copy receipt JSON</button>
          </article>
        `,
      ).join('')}
    </div>
  `;
}

function filteredPreparedActions(): PreparedAction[] {
  const actions = activeWorkflowPreparedActions().filter(isActionInboxActive);
  switch (state.inboxFilter) {
    case 'one-time':
      return actions.filter((action) => !action.recurringId);
    case 'recurring':
      return actions.filter((action) => Boolean(action.recurringId));
    case 'ready':
      return actions.filter((action) => action.status === 'ready' || action.status === 'overdue' || action.status === 'approval_pending');
    case 'scheduled':
      return actions.filter((action) => action.status === 'scheduled');
    case 'attention':
      return actions.filter((action) => action.status === 'failed' || action.status === 'blocked');
    case 'all':
      return actions;
  }
}

function activeWorkflowPreparedActions(): PreparedAction[] {
  switch (activeWorkflowMode()) {
    case 'agentic-cloud':
      return state.preparedActions.filter((action) => action.workflowSource === 'cloud' || isBrowserWorkflowId(action.id));
    case 'browser-workflow':
      return state.preparedActions.filter((action) => isBrowserWorkflowId(action.id));
    case 'local-bridge':
      return state.preparedActions.filter((action) => action.workflowSource === 'local-bridge');
  }
}

function activeWorkflowRecurringPayments(): RecurringPayment[] {
  switch (activeWorkflowMode()) {
    case 'agentic-cloud':
      return state.recurringPayments.filter((payment) => {
        const source = recurringPaymentWorkflowSource(payment);
        return source === 'cloud' || source === 'browser';
      });
    case 'browser-workflow':
      return state.recurringPayments.filter((payment) => recurringPaymentWorkflowSource(payment) === 'browser');
    case 'local-bridge':
      return state.recurringPayments.filter((payment) => recurringPaymentWorkflowSource(payment) === 'local-bridge');
  }
}

function isActionInboxActive(action: PreparedAction): boolean {
  return !isTerminalPreparedAction(action);
}

function inboxFilterOption(value: InboxFilter, label: string): string {
  return `<option value="${value}" ${state.inboxFilter === value ? 'selected' : ''}>${escapeHtml(label)}</option>`;
}

function queueFilterLabel(filter: InboxFilter): string {
  switch (filter) {
    case 'ready':
      return 'Showing ready now';
    case 'scheduled':
      return 'Showing scheduled items';
    case 'attention':
      return 'Showing problems';
    case 'one-time':
      return 'Showing one-time approvals';
    case 'recurring':
      return 'Showing repeats';
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
  if (draft.cadence === 'weekly') {
    return `
      <label class="field compact">
        <span>Day</span>
        ${selectPicker({
          id: 'recurringDayOfWeek',
          value: draft.dayOfWeek,
          attrs: { 'data-recurring-field': 'dayOfWeek' },
          options: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
            .map((day, index) => ({
              value: String(index),
              label: day,
              meta: 'Weekday',
            })),
        })}
        ${fieldError('recurringDayOfWeek')}
      </label>
      ${fieldInput('recurringLocalTime', 'Local time', draft.localTime, '09:00')}
    `;
  }
  if (draft.cadence === 'monthly') {
    return `
      ${fieldInput('recurringDayOfMonth', 'Day of month', draft.dayOfMonth, '1-31')}
      ${fieldInput('recurringLocalTime', 'Local time', draft.localTime, '09:00')}
    `;
  }
  if (draft.cadence === 'interval_hours') {
    return `
      ${fieldInput('recurringIntervalHours', 'Every hours', draft.intervalHours, '1')}
      ${fieldInput('recurringStartAt', 'Start at', draft.startAt, '', 'datetime-local')}
    `;
  }
  if (draft.cadence === 'interval_minutes') {
    return `
      ${fieldInput('recurringIntervalMinutes', 'Every minutes', draft.intervalMinutes, '60')}
      ${fieldInput('recurringStartAt', 'Start at', draft.startAt, '', 'datetime-local')}
    `;
  }
  return `
    ${fieldInput('recurringIntervalDays', 'Every days', draft.intervalDays, '1')}
    ${fieldInput('recurringStartAt', 'Start at', draft.startAt, '', 'datetime-local')}
  `;
}

function fieldInput(id: string, label: string, value: string, placeholder = '', type = 'text'): string {
  const error = fieldError(id);
  return `
    <label class="field compact ${state.recurringErrors[id] ? 'field-error' : ''}">
      <span>${escapeHtml(label)}</span>
      <input id="${id}" data-recurring-field="${escapeHtml(id.replace(/^recurring/, '').replace(/^[A-Z]/, (match) => match.toLowerCase()))}" type="${type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" />
      ${error}
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
  if (state.activeTab === 'generated') {
    const selected = selectedGeneratedPlan();
    return {
      status: state.generatedPlans.length ? 'Saved' : 'Empty',
      detail: selected?.plan.intent ?? 'Template and AI plans are saved here for later review.',
      meta: selected ? `${generatedPlanStatusLabel(selected)} · ${formatDateTime(selected.createdAt)}` : undefined,
    };
  }
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
      meta: 'Plan is ready for review.',
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
    const count = activeWorkflowPreparedActions().filter((action) => !action.archived).length;
    return {
      status: count ? 'Queued' : 'Empty',
      detail: count ? `${count} request(s) need approval.` : 'No queued approvals are currently waiting.',
      meta: activeWorkflowLabel(),
    };
  }
  if (state.activeTab === 'completed') {
    const plans = completedPlanRecords();
    return {
      status: plans.length ? 'Completed' : 'Empty',
      detail: plans[0]?.title ?? 'Completed proofs, approvals, and repeat payments appear here.',
      meta: plans[0] ? `${plans[0].status} · ${formatDateTime(plans[0].completedAt)}` : undefined,
    };
  }
  if (state.activeTab === 'schedule') {
    const activeSchedules = activeWorkflowRecurringPayments().filter((payment) => payment.status === 'active' && !isRecurringPaymentCompleted(payment)).length;
    return {
      status: activeSchedules ? 'Repeats' : 'Draft',
      detail: activeSchedules
        ? `${activeSchedules} repeat payment${activeSchedules === 1 ? '' : 's'} active.`
        : 'Create a repeat payment for future wallet review.',
        meta: activeWorkflowLabel(),
    };
  }
  if (state.activeTab === 'labs') {
    if (state.artifactView === 'signed') {
      return {
      status: state.labArtifacts.length ? 'Archived' : 'Empty',
      detail: state.labArtifacts.length
          ? `${state.labArtifacts.length} saved proof${state.labArtifacts.length === 1 ? '' : 's'} are available for review.`
          : 'No saved proofs have been created yet.',
        meta: state.labArtifacts[0] ? short(state.labArtifacts[0].artifactHash) : undefined,
      };
    }
    const lab = activeLab();
    return {
      status: 'Save Proof',
      detail: lab.summary,
      meta: lab.title,
    };
  }
  return {
    status: state.address ? 'Ready' : 'Waiting',
    detail: state.address ? 'Select a workflow to prepare intent.' : 'Connect a wallet before intent can be reviewed.',
  };
}

function evidencePolicy(): { status: string; detail: string; meta?: string } {
  const openApprovals = activeWorkflowPreparedActions().filter((action) => !action.archived).length;
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
      status: state.agentPlan ? 'Plan scoped' : 'Plan',
      detail: state.agentPlan?.risk ?? 'Create a plan to expose route and risk before sending for approval.',
      meta: `Approval path: ${activeWorkflowLabel()}`,
    };
  }
  if (state.activeTab === 'generated') {
    const selected = selectedGeneratedPlan();
    return {
      status: selected ? 'Review scoped' : 'No plans',
      detail: selected?.plan.risk ?? 'Plans stay separate from approval until you send them.',
      meta: selected && canQueueAgentPlan(selected.plan) ? `Approval-ready through ${activeWorkflowLabel()}` : 'Proof-only review',
    };
  }
  if (state.activeTab === 'schedule') {
    const recurringPlans = activeWorkflowRecurringPayments().length;
    return {
      status: 'Repeats ready',
      detail: 'Repeat payments create future approval items, not automatic signatures.',
      meta: recurringPlans ? `${recurringPlans} repeat payment(s) · ${activeWorkflowLabel()}` : activeWorkflowLabel(),
    };
  }
  if (state.activeTab === 'completed') {
    const plans = completedPlanRecords();
    return {
      status: plans.length ? 'Done' : 'Nothing done yet',
      detail: plans.length
        ? 'Done work is read-only unless you explicitly delete a card.'
        : 'Plans stay out of Done until a proof is signed, an approval is terminal, or a repeat payment ends.',
      meta: plans.length ? `${plans.length} done item(s)` : undefined,
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
      detail: 'Saved proofs bind payload hash, wallet, cluster, and signature for review.',
      meta: state.labArtifacts.length ? `${state.labArtifacts.length} receipt${state.labArtifacts.length === 1 ? '' : 's'}` : 'No receipts yet',
    };
  }
  if (openApprovals > 0) {
    return {
      status: 'Queued',
      detail: `${openApprovals} prepared action(s) are waiting for review.`,
      meta: `${activeWorkflowLabel()} policy is active.`,
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
        : `${activeWorkflowLabel()} will hold queued work until explicit wallet approval.`,
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
      status: 'Review proof',
      detail: 'The signed plan review proof is available for audit.',
      meta: short(state.agentSignature),
    };
  }
  if (state.activeTab === 'generated') {
    const selected = selectedGeneratedPlan();
    if (selected?.signature) {
      return {
        status: 'Proof signed',
        detail: 'This plan has a wallet-signed review proof.',
        meta: short(selected.signature),
      };
    }
    if (selected?.preparedActionId) {
      return {
        status: 'Queued',
        detail: 'This plan has been sent for approval or repeat payment setup.',
        meta: selected.preparedActionId,
      };
    }
  }
  if (state.activeTab === 'completed') {
    const plans = completedPlanRecords();
    if (plans.length) {
      const evidenceId = plans[0]?.actionId ?? plans[0]?.signature ?? '';
      return {
        status: 'Done ready',
        detail: `${plans.length} done record(s) are available.`,
        meta: evidenceId ? short(evidenceId) : undefined,
      };
    }
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
      detail: 'The plan review proof is available for copy or audit.',
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
      status: 'Saved proof',
      detail: 'A signed proof is available for review.',
      meta: short(latestLab.artifactHash),
    };
  }
  return {
    status: 'Pending',
    detail:
      state.activeTab === 'inbox' || state.activeTab === 'schedule'
        ? 'Receipts appear after an approval is approved, rejected, or archived.'
        : 'Receipts appear after wallet approval or proof signing.',
  };
}

function evidenceTone(kind: 'intent' | 'policy' | 'wallet' | 'receipt'): 'good' | 'active' | 'warn' | 'idle' {
  switch (kind) {
    case 'intent':
      return state.agentPlan || state.generatedPlans.length || state.signature || state.customTransactionBase64
        ? 'good'
        : state.address
          ? 'active'
          : 'idle';
    case 'policy':
      if (activeWorkflowPreparedActions().length || state.bridgeActive) return 'good';
      return state.cluster === 'mainnet-beta' ? 'warn' : 'idle';
    case 'wallet':
      return state.address ? 'good' : 'idle';
    case 'receipt':
      return state.txid || state.txSignature || state.agentSignature || state.receipts.length || completedPlanRecords().length || state.labArtifacts.length
        ? 'good'
        : 'idle';
  }
}

function trustChain(): string {
  const hasReceipt = Boolean(state.txid || state.txSignature || state.agentSignature || signedGeneratedPlanCount() || state.receipts.length || completedPlanRecords().length || state.labArtifacts.length);
  return `
    <div class="trust-chain" aria-label="Approval trust chain">
      ${trustNode('Intent', Boolean(state.agentPlan || state.generatedPlans.length || state.signature || state.customTransactionBase64), state.activeTab === 'agent' || state.activeTab === 'generated')}
      ${trustNode('Policy', Boolean(state.bridgeActive || activeWorkflowPreparedActions().length), state.activeTab === 'inbox' || state.activeTab === 'schedule')}
      ${trustNode('Wallet', Boolean(state.address), state.busy)}
      ${trustNode('Receipt', hasReceipt, state.activeTab === 'completed')}
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
      <a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Open Solscan</a>
      <button data-copy="${escapeHtml(txid)}" data-copy-name="Transaction id">Copy txid</button>
      <button data-copy="${escapeHtml(url)}" data-copy-name="Solscan transaction link">Copy Solscan link</button>
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
      <dd title="${escapeHtml(value)}">${escapeHtml(value)}</dd>
    </div>
  `;
}

function surfaceEyebrow(): string {
  switch (state.activeTab) {
    case 'overview':
      return 'Home';
    case 'wallet':
      return 'Direct signing';
    case 'agent':
      return 'New request';
    case 'generated':
      return 'Review';
    case 'inbox':
      return 'Needs approval';
    case 'completed':
      return 'Done';
    case 'schedule':
      return 'Repeat payments';
    case 'labs':
      return state.artifactView === 'signed' ? 'Saved proofs' : 'Save proof';
  }
}

function surfaceTitle(): string {
  switch (state.activeTab) {
    case 'overview':
      return 'Home';
    case 'wallet':
      return 'Wallet signing';
    case 'agent':
      return 'New Request';
    case 'generated':
      return 'Review';
    case 'inbox':
      return 'Needs Approval';
    case 'completed':
      return 'Done';
    case 'schedule':
      return 'Repeat Payments';
    case 'labs':
      return 'Save Proof';
  }
}

function emptyInboxText(): string {
  if (state.inboxFilter === 'one-time') {
    return 'No one-time approvals. Queue a send or swap plan when you want a wallet decision.';
  }
  if (state.inboxFilter === 'recurring') {
    return 'No repeat payments waiting. Create a repeat payment first.';
  }
  return 'No approvals waiting. Create a one-time request or repeat payment. Due repeat payments appear here for approve or deny.';
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

function recipientParam(action: PreparedAction): string {
  return stringParam(action, 'recipient') || stringParam(action, 'recipientAddress');
}

function scheduleLabel(payment: RecurringPayment): string {
  const count = payment.maxOccurrences
    ? `, ${payment.occurrencesCreated ?? 0} of ${payment.maxOccurrences} created`
    : ', indefinite';
  const expiry = payment.expiresAt ? `, expires ${formatDateTime(payment.expiresAt)}` : '';
  if (payment.cadence === 'weekly') {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return `Weekly on ${days[payment.dayOfWeek ?? -1] ?? 'unknown day'} at ${payment.localTime ?? '?'}${count}${expiry}.`;
  }
  if (payment.cadence === 'monthly') {
    return `Monthly on day ${payment.dayOfMonth ?? '?'} at ${payment.localTime ?? '?'}${count}${expiry}.`;
  }
  if (payment.cadence === 'interval_hours') {
    return `Every ${payment.intervalHours ?? '?'} hour(s) starting ${formatDateTime(payment.startAt ?? '')}${count}${expiry}.`;
  }
  if (payment.cadence === 'interval_minutes') {
    return `Every ${payment.intervalMinutes ?? '?'} minute(s) starting ${formatDateTime(payment.startAt ?? '')}${count}${expiry}.`;
  }
  return `Every ${payment.intervalDays ?? '?'} day(s) starting ${formatDateTime(payment.startAt ?? '')}${count}${expiry}.`;
}

function recurringNextOccurrenceLabel(draft: RecurringDraft): string {
  const [next] = recurringDraftNextRuns(draft);
  return next ? formatDateTime(next) : 'Complete schedule fields to preview';
}

function recurringDraftNextRuns(draft: RecurringDraft): string[] {
  const fields = recurringDraftCadenceFields(draft);
  if (!fields) return [];
  return previewUpcoming(fields, new Date(), 5).map((occurrence) => occurrence.dueAt.toISOString());
}

function recurringDraftLifetimeSpend(draft: RecurringDraft): LifetimeSpend | null {
  const fields = recurringDraftCadenceFields(draft);
  if (!fields || !(Number(draft.amount) > 0)) return null;
  return lifetimeSpendEstimate(fields, draft.amount, new Date());
}

function recurringDraftCadenceFields(draft: RecurringDraft): CadenceFields | null {
  const now = new Date().toISOString();
  const maxOccurrences = Number(draft.maxOccurrences);
  const expiresAt = optionalLocalDateTimeToIso(draft.expiresAt);
  const base: CadenceFields = {
    cadence: draft.cadence,
    createdAt: now,
    occurrencesCreated: 0,
    ...(Number.isInteger(maxOccurrences) && maxOccurrences > 0 ? { maxOccurrences } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
  if (draft.cadence === 'weekly') {
    const dayOfWeek = Number(draft.dayOfWeek);
    if (!Number.isInteger(dayOfWeek) || !isValidLocalTime(draft.localTime)) return null;
    return { ...base, dayOfWeek, localTime: draft.localTime };
  }
  if (draft.cadence === 'monthly') {
    const dayOfMonth = Number(draft.dayOfMonth);
    if (!Number.isInteger(dayOfMonth) || !isValidLocalTime(draft.localTime)) return null;
    return { ...base, dayOfMonth, localTime: draft.localTime };
  }
  const startAt = optionalLocalDateTimeToIso(draft.startAt);
  if (!startAt) return null;
  if (draft.cadence === 'interval_hours') {
    const intervalHours = Number(draft.intervalHours);
    return Number.isInteger(intervalHours) && intervalHours > 0 ? { ...base, intervalHours, startAt } : null;
  }
  if (draft.cadence === 'interval_minutes') {
    const intervalMinutes = Number(draft.intervalMinutes);
    return Number.isInteger(intervalMinutes) && intervalMinutes > 0 ? { ...base, intervalMinutes, startAt } : null;
  }
  const intervalDays = Number(draft.intervalDays);
  return Number.isInteger(intervalDays) && intervalDays > 0 ? { ...base, intervalDays, startAt } : null;
}

function recurringPaymentNextRuns(payment: RecurringPayment): string[] {
  if (payment.nextRuns?.length) return payment.nextRuns;
  return previewUpcoming(payment, new Date(), 5).map((occurrence) => occurrence.dueAt.toISOString());
}

function recurringPaymentLifetimeSpend(payment: RecurringPayment): LifetimeSpend {
  return payment.lifetimeSpend ?? lifetimeSpendEstimate(payment, payment.amount, new Date());
}

function optionalLocalDateTimeToIso(value: string): string | undefined {
  if (!value.trim()) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function statusTone(status: PreparedActionStatus): string {
  if (status === 'approved' || status === 'ready' || status === 'overdue') return 'tx-confirmed';
  if (status === 'approval_pending' || status === 'scheduled') return 'tx-pending';
  if (status === 'failed' || status === 'blocked' || status === 'rejected' || status === 'cancelled' || status === 'expired') return 'tx-failed';
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
  if (state.androidNativeEnvironment.isAndroidNative) return 'Android native MWA ready';
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

function labById(labId: string): LabDefinition | null {
  return LABS.find((lab) => lab.id === labId) ?? null;
}

function activeLab(): LabDefinition {
  return LABS.find((lab) => lab.id === state.activeLab) ?? LABS[0]!;
}

function isPublicReceiptLab(lab: LabDefinition): boolean {
  return lab.category === 'receipt';
}

function receiptLabelForKind(kind: string): string {
  switch (kind) {
    case 'intent_receipt':
      return 'Intent';
    case 'policy_receipt':
      return 'Approval Decision';
    case 'risk_review_receipt':
      return 'Risk Review';
    case 'rejection_receipt':
      return 'Rejection';
    case 'tool_trace_receipt':
      return 'Tool Trace';
    default:
      return labKindLabel(kind);
  }
}

function receiptLabIdForInlineKind(kind: InlineReceiptKind): string {
  switch (kind) {
    case 'intent':
      return 'intent-receipt';
    case 'rejection':
      return 'rejection-receipt';
    case 'policy':
      return 'policy-receipt';
    case 'review':
      return 'risk-receipt';
  }
}

function labInput(labId: string): string {
  return state.labInputs[labId] ?? LABS.find((lab) => lab.id === labId)?.defaultInput ?? '';
}

function labIndexLabel(): string {
  const lab = activeLab();
  if (isPublicReceiptLab(lab)) {
    const index = RECEIPT_LABS.findIndex((candidate) => candidate.id === lab.id);
    return index >= 0 ? `receipt ${index + 1} of ${RECEIPT_LABS.length}` : 'receipt';
  }
  const index = ADVANCED_EVIDENCE_LABS.findIndex((candidate) => candidate.id === lab.id);
  return index >= 0 ? `advanced lab ${index + 1} of ${ADVANCED_EVIDENCE_LABS.length}` : 'legacy lab';
}

function receiptFieldValue(labId: string, fieldId: string): string {
  return state.labFieldValues[labId]?.[fieldId] ?? '';
}

function receiptFieldErrorKey(labId: string, fieldId: string): string {
  return `${labId}.${fieldId}`;
}

function readReceiptFieldValues(lab: LabDefinition): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of lab.fields ?? []) {
    const selector = `[data-lab-id="${CSS.escape(lab.id)}"][data-lab-field="${CSS.escape(field.id)}"]`;
    const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector);
    values[field.id] = (element?.value ?? receiptFieldValue(lab.id, field.id)).trim();
  }
  state.labFieldValues[lab.id] = values;
  return values;
}

function validateLabForSigning(lab: LabDefinition, fieldValues: Record<string, string>): void {
  state.labFieldErrors = {};
  if (isPublicReceiptLab(lab)) {
    for (const field of lab.fields ?? []) {
      if (field.required && !fieldValues[field.id]?.trim()) {
        state.labFieldErrors[receiptFieldErrorKey(lab.id, field.id)] = `${field.label} is required.`;
      }
    }
  } else {
    const input = labInput(lab.id).trim();
    if (!input || input === lab.defaultInput.trim()) {
      state.labFieldErrors[receiptFieldErrorKey(lab.id, '__advanced')] = 'Add your own evidence note before signing this advanced lab.';
    }
  }
  if (Object.keys(state.labFieldErrors).length > 0) {
    throw new Error('Complete the required evidence fields before signing.');
  }
}

function clearActiveLabDraft(): void {
  const lab = activeLab();
  if (isPublicReceiptLab(lab)) {
    state.labFieldValues[lab.id] = {};
  } else {
    state.labInputs[lab.id] = '';
  }
  state.labFieldErrors = {};
}

function receiptInputSummary(lab: LabDefinition, values: Record<string, string>): string {
  return (lab.fields ?? [])
    .map((field) => [field.label, values[field.id]?.trim()] as const)
    .filter(([, value]) => Boolean(value))
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
}

async function labPayload(labId: string, input: string, createdAt: string, fieldValues: Record<string, string> = {}): Promise<LabPayload> {
  const lab = labById(labId);
  const unsafe = /\bunlimited\b|seed phrase|private key|unknown custody/i.test(input);
  const status = receiptStatus(lab, fieldValues, input, unsafe);
  const baseEvidence: Array<[string, string, 'good' | 'warn' | 'danger' | 'neutral']> = [
    ...receiptEvidenceEntries(lab, fieldValues, input, status),
    ['Wallet boundary', 'This receipt is evidence only. It does not approve or submit a transaction.', 'good'],
    ['Integrity', `Receipt time ${createdAt} binds this record to one review moment.`, 'good'],
  ];
  const evidence = await Promise.all(
    baseEvidence.map(async ([title, detail, tone]) => ({
      title,
      detail,
      tone,
      hash: await sha256(stableJson({ title, detail, tone })),
    })),
  );
  const verdict = receiptVerdictLabel(status);
  return {
    status,
    thesis: labThesis(labId, status),
    nextSignatureGate: status === 'blocked'
      ? 'Receipt complete. Use it to explain why matching requests should be rejected.'
      : 'Receipt complete. Compare future wallet requests against this signed record before approving.',
    receiptType: lab ? `${lab.kind}_v1` : labId,
    summary: lab?.summary,
    verdict,
    effect: 'evidence only, no transaction',
    whatThisProves: lab?.whatThisProves,
    recommendedUse: lab?.recommendedUse,
    fieldValues,
    metrics: [
      { label: 'Verdict', value: verdict, tone: status === 'blocked' ? 'danger' : status === 'warn' ? 'warn' : status === 'observed' ? 'neutral' : 'good' },
      { label: 'Custody', value: 'user wallet', tone: 'good' },
      { label: 'Effect', value: 'evidence only', tone: 'neutral' },
    ],
    evidence,
  };
}

function receiptStatus(
  lab: LabDefinition | null,
  fieldValues: Record<string, string>,
  input: string,
  unsafe: boolean,
): LabPayload['status'] {
  if (unsafe || lab?.id === 'rejection-receipt') return 'blocked';
  const explicit = (fieldValues.verdict || fieldValues.result || '').toLowerCase();
  if (explicit.includes('blocked')) return 'blocked';
  if (explicit.includes('warning')) return 'warn';
  if (explicit.includes('pass')) return 'approved';
  if (/unknown|authority|insurance|override/i.test(input)) return 'warn';
  return lab?.category === 'receipt' ? 'observed' : 'approved';
}

function receiptVerdictLabel(status: LabPayload['status']): string {
  switch (status) {
    case 'approved':
      return 'approved';
    case 'blocked':
      return 'blocked';
    case 'warn':
      return 'warning';
    case 'observed':
      return 'recorded';
  }
}

function receiptEvidenceEntries(
  lab: LabDefinition | null,
  fieldValues: Record<string, string>,
  input: string,
  status: LabPayload['status'],
): Array<[string, string, 'good' | 'warn' | 'danger' | 'neutral']> {
  if (!lab || !isPublicReceiptLab(lab) || !lab.fields?.length) {
    return [['Evidence note', input, status === 'blocked' ? 'danger' : status === 'warn' ? 'warn' : 'neutral']];
  }
  return lab.fields
    .map((field) => {
      const value = fieldValues[field.id]?.trim();
      if (!value) return null;
      const tone: 'good' | 'warn' | 'danger' | 'neutral' =
        status === 'blocked' && /reason|policy|request/i.test(field.id)
          ? 'danger'
          : status === 'warn' && /risk|verdict|result|request/i.test(field.id)
            ? 'warn'
            : 'neutral';
      return [field.label, value, tone] as [string, string, 'good' | 'warn' | 'danger' | 'neutral'];
    })
    .filter((entry): entry is [string, string, 'good' | 'warn' | 'danger' | 'neutral'] => Boolean(entry));
}

function labThesis(labId: string, status: LabPayload['status']): string {
  const lab = LABS.find((candidate) => candidate.id === labId);
  if (!lab) return 'Signed evidence record created.';
  if (isPublicReceiptLab(lab)) {
    if (status === 'blocked') return `${lab.title} signed and saved as a blocked evidence record.`;
    if (status === 'warn') return `${lab.title} signed and saved with a warning verdict.`;
    if (status === 'observed') return `${lab.title} signed and saved as evidence only.`;
    return `${lab.title} signed and saved with an approved verdict.`;
  }
  if (status === 'blocked') {
    return 'The request becomes a refusal fingerprint without exposing private wallet data.';
  }
  if (status === 'warn') {
    return 'The advanced evidence lab was signed with a warning. No transaction was submitted.';
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
    expiresAt: inputValue('#recurringExpiresAt') || state.recurringDraft.expiresAt,
    webhookUrl: inputValue('#recurringWebhookUrl') || state.recurringDraft.webhookUrl,
    note: inputValue('#recurringNote'),
  };
}

function applyRecurringPreset(presetId: RecurringPresetId): void {
  const preset = RECURRING_PRESETS.find((candidate) => candidate.id === presetId) ?? RECURRING_PRESETS[0]!;
  state.recurringPreset = preset.id;
  state.recurringDraft = {
    ...state.recurringDraft,
    ...preset.draft,
  };
  state.recurringErrors = {};
  state.error = '';
}

function assertValidRecurringDraft(draft: RecurringDraft): void {
  const errors: Record<string, string> = {};
  if (!draft.recipient.trim()) errors.recurringRecipient = 'Recipient is required.';
  if (!draft.amount.trim()) {
    errors.recurringAmount = 'Amount is required.';
  } else if (!(Number(draft.amount) > 0)) {
    errors.recurringAmount = 'Amount must be greater than zero.';
  }
  if (draft.maxOccurrences.trim()) {
    const max = Number(draft.maxOccurrences);
    if (!Number.isInteger(max) || max <= 0) errors.recurringMaxOccurrences = 'Use a positive whole number or leave empty.';
  }
  if (draft.expiresAt.trim()) {
    const expiry = new Date(draft.expiresAt);
    if (Number.isNaN(expiry.getTime())) errors.recurringExpiresAt = 'Expiry must be a valid local date and time.';
  }
  if (draft.webhookUrl.trim()) {
    try {
      const url = new URL(draft.webhookUrl);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        errors.recurringWebhookUrl = 'Webhook URL must start with http:// or https://.';
      }
    } catch {
      errors.recurringWebhookUrl = 'Webhook URL must be valid.';
    }
  }
  if (draft.cadence === 'weekly') {
    const day = Number(draft.dayOfWeek);
    if (!Number.isInteger(day) || day < 0 || day > 6) errors.recurringDayOfWeek = 'Choose a valid weekday.';
    if (!isValidLocalTime(draft.localTime)) errors.recurringLocalTime = 'Use HH:MM local time.';
  } else if (draft.cadence === 'monthly') {
    const day = Number(draft.dayOfMonth);
    if (!Number.isInteger(day) || day < 1 || day > 31) errors.recurringDayOfMonth = 'Use a day from 1 to 31.';
    if (!isValidLocalTime(draft.localTime)) errors.recurringLocalTime = 'Use HH:MM local time.';
  } else if (draft.cadence === 'interval_hours') {
    validatePositiveInteger(errors, 'recurringIntervalHours', draft.intervalHours, 'Hours must be a positive whole number.');
    validateStartAt(errors, draft.startAt);
  } else if (draft.cadence === 'interval_minutes') {
    validatePositiveInteger(errors, 'recurringIntervalMinutes', draft.intervalMinutes, 'Minutes must be a positive whole number.');
    validateStartAt(errors, draft.startAt);
  } else {
    validatePositiveInteger(errors, 'recurringIntervalDays', draft.intervalDays, 'Days must be a positive whole number.');
    validateStartAt(errors, draft.startAt);
  }
  state.recurringErrors = errors;
  if (Object.keys(errors).length > 0) {
    throw new Error('Complete required recurring fields before creating this schedule.');
  }
}

function validatePositiveInteger(errors: Record<string, string>, key: string, value: string, message: string): void {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) errors[key] = message;
}

function validateStartAt(errors: Record<string, string>, value: string): void {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) errors.recurringStartAt = 'Start time must be valid.';
}

function isValidLocalTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
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
  if (draft.expiresAt.trim()) {
    body.expiresAt = localDateTimeToIso(draft.expiresAt);
  }
  if (draft.webhookUrl.trim()) {
    body.notifications = {
      inApp: true,
      webhookUrl: draft.webhookUrl.trim(),
    };
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
    expiresAt: '',
    webhookUrl: '',
    note: '',
  };
}

function defaultLabInputs(): Record<string, string> {
  return Object.fromEntries(LABS.map((lab) => [lab.id, isPublicReceiptLab(lab) ? '' : lab.defaultInput]));
}

function defaultLabFieldValues(): Record<string, Record<string, string>> {
  return Object.fromEntries(
    RECEIPT_LABS.map((lab) => [
      lab.id,
      Object.fromEntries((lab.fields ?? []).map((field) => [field.id, field.type === 'select' ? (field.options?.[0] ?? '') : ''])),
    ]),
  );
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

function isLoopbackBridgeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
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
  switch (kind) {
    case 'intent_receipt':
      return 'Proof of Intent';
    case 'policy_receipt':
      return 'Proof of Policy';
    case 'risk_review_receipt':
      return 'Proof of Review';
    case 'rejection_receipt':
      return 'Proof of Rejection';
    case 'tool_trace_receipt':
      return 'Tool Trace Receipt';
  }
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
      VITE_AGENTIC_APP_SURFACE?: string;
      VITE_AGENTIC_DEV_CONTROLS?: string;
    };
  }).env;
  const surface = String(viteEnv?.VITE_AGENTIC_APP_SURFACE ?? '').trim().toLowerCase();
  if (surface === 'debug') return true;
  if (surface === 'public') return false;

  const explicit = String(viteEnv?.VITE_AGENTIC_DEV_CONTROLS ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(explicit)) return true;
  return false;
}

function shouldProbeBridgeOnStartup(): boolean {
  return isLocalOrPrivateHostname(globalThis.location?.hostname ?? '');
}

function defaultAiMode(): AiSettings['mode'] {
  if (IS_ANDROID_APP) return 'session';
  return isLocalBrowserOrigin() ? 'bridge' : 'hosted';
}

function persistedAiSettings(persistedState: PersistedState): Omit<AiSettings, 'apiKey'> {
  const fallback = aiProviderPresetById(DEFAULT_AI_PROVIDER_ID);
  const provider = persistedState.aiProvider ? aiProviderPresetById(persistedState.aiProvider) : fallback;
  const mode = normalizeAiModeForSurface(persistedState.aiMode ?? defaultAiMode());
  const model = persistedState.aiModel?.trim() || provider.model;
  const settings = {
    mode,
    provider: provider.id,
    apiFormat: persistedState.aiApiFormat ?? provider.apiFormat,
    baseUrl: persistedState.aiBaseUrl?.trim() || provider.baseUrl,
    model,
  };
  if (settings.mode === 'hosted' && settings.provider === 'custom-openai-compatible') {
    return {
      mode: settings.mode,
      provider: fallback.id,
      apiFormat: fallback.apiFormat,
      baseUrl: fallback.baseUrl,
      model: fallback.model,
    };
  }
  if (settings.mode === 'session' && settings.provider === 'openai') {
    const browserPreset = aiProviderPresetById(BROWSER_SESSION_DEFAULT_PROVIDER_ID);
    return {
      mode: settings.mode,
      provider: browserPreset.id,
      apiFormat: browserPreset.apiFormat,
      baseUrl: browserPreset.baseUrl,
      model: browserPreset.model,
    };
  }
  return settings;
}

function normalizeAiModeForSurface(mode: AiSettings['mode']): AiSettings['mode'] {
  if (IS_ANDROID_APP && mode === 'hosted') return 'session';
  return mode;
}

function isLocalBrowserOrigin(): boolean {
  const hostname = globalThis.location?.hostname ?? '';
  return isLoopbackHostname(hostname) || normalizeHostname(hostname) === '';
}

function isLocalOrPrivateHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return (
    isLoopbackHostname(normalized) ||
    normalized.endsWith('.local') ||
    isPrivateIpv4Hostname(normalized) ||
    isPrivateIpv6Hostname(normalized)
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '';
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isPrivateIpv4Hostname(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    const value = Number(part);
    return value >= 0 && value <= 255 ? value : Number.NaN;
  });
  if (octets.some((octet) => Number.isNaN(octet))) return false;
  const [first, second] = octets as [number, number, number, number];
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function isPrivateIpv6Hostname(hostname: string): boolean {
  if (!hostname.includes(':')) return false;
  return hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80:');
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

function resolveAndroidAppSurface(): boolean {
  const viteEnv = (import.meta as ImportMeta & {
    env?: {
      VITE_AGENTIC_ANDROID_APP?: string;
    };
  }).env;
  const explicit = String(viteEnv?.VITE_AGENTIC_ANDROID_APP ?? '').trim().toLowerCase();
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

function isPreparedActionTxStatus(value: string): value is PreparedActionTxStatus {
  return value === 'pending' || value === 'confirmed' || value === 'failed';
}

function isAiMode(value: string): value is AiSettings['mode'] {
  return value === 'hosted' || value === 'session' || value === 'bridge';
}

function isWorkflowModePreference(value: string): value is WorkflowModePreference {
  return value === 'auto' || value === 'local-bridge';
}

function isAiApiFormat(value: string): value is AiSettings['apiFormat'] {
  return value === 'openai-compatible' || value === 'anthropic';
}

function isAiProviderId(value: string): value is AiSettings['provider'] {
  return AI_PROVIDER_PRESETS.some((preset) => preset.id === value);
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

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry !== undefined) output[key] = stripUndefined(entry);
    }
    return output;
  }
  return value;
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

function formatCopyToastMessage(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length > 12) {
    return `${trimmed.slice(0, 4)}....${trimmed.slice(-4)}`;
  }
  return trimmed;
}

function looksLikeJsonValue(value: string): boolean {
  const head = value.trimStart()[0];
  return head === '{' || head === '[';
}

function toastStack(): string {
  if (state.toasts.length === 0) return '';
  return `
    <div class="toast-stack" aria-live="polite">
      ${state.toasts
        .map(
          (toast) => `
            <div class="toast ${toast.kind}">
              <span class="toast-icon" aria-hidden="true">${toastIcon(toast.kind)}</span>
              <div>
                <strong>${escapeHtml(toast.title)}</strong>
                ${toast.message ? `<p>${escapeHtml(toast.message)}</p>` : ''}
                ${toast.linkHref ? `<a href="${escapeHtml(toast.linkHref)}" target="_blank" rel="noreferrer">${escapeHtml(toast.linkLabel ?? 'Open link')}</a>` : ''}
              </div>
              <button data-toast-dismiss="${toast.id}" aria-label="Dismiss notification">x</button>
            </div>
          `,
        )
        .join('')}
    </div>
  `;
}

function pushToast(
  kind: ToastKind,
  title: string,
  message: string,
  options: { linkHref?: string; linkLabel?: string } = {},
): number {
  const toast: Toast = { id: nextToastId, kind, title, message, ...options };
  nextToastId += 1;
  state.toasts = [toast, ...state.toasts].slice(0, 4);
  if (kind !== 'pending') {
    window.setTimeout(() => {
      dismissToast(toast.id);
    }, toast.linkHref ? 10_000 : 4000);
  }
  return toast.id;
}

function replaceToast(
  id: number,
  kind: ToastKind,
  title: string,
  message: string,
  options: { linkHref?: string; linkLabel?: string } = {},
): void {
  state.toasts = state.toasts.map((toast) => toast.id === id ? { ...toast, kind, title, message, ...options } : toast);
  if (kind !== 'pending') {
    window.setTimeout(() => {
      dismissToast(id);
    }, options.linkHref ? 10_000 : 4000);
  }
  render();
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

function errorIcon(): string {
  return '<svg viewBox="0 0 24 24" focusable="false"><path d="m12 10.6 4.1-4.1 1.4 1.4-4.1 4.1 4.1 4.1-1.4 1.4-4.1-4.1-4.1 4.1-1.4-1.4 4.1-4.1-4.1-4.1 1.4-1.4 4.1 4.1Z"></path></svg>';
}

function toastIcon(kind: ToastKind): string {
  if (kind === 'pending') return '<span class="toast-spinner"></span>';
  if (kind === 'error') return errorIcon();
  return checkIcon();
}

function buttonSpinner(): string {
  return '<span class="button-spinner" aria-hidden="true"></span>';
}

function short(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

function shortFirstRunWallet(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
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
      ...(isPersistedBrowserWalletSession(parsed.browserWalletSession) && { browserWalletSession: parsed.browserWalletSession }),
      ...(typeof parsed.selectedIosWalletId === 'string' &&
        isPersistedIosWalletId(parsed.selectedIosWalletId) && { selectedIosWalletId: parsed.selectedIosWalletId }),
      ...(typeof parsed.workflowModePreference === 'string' &&
        isWorkflowModePreference(parsed.workflowModePreference) && { workflowModePreference: parsed.workflowModePreference }),
      ...(typeof parsed.cluster === 'string' && isCluster(parsed.cluster) && { cluster: parsed.cluster }),
      ...(typeof parsed.bridgeUrl === 'string' && { bridgeUrl: parsed.bridgeUrl }),
      ...(typeof parsed.aiMode === 'string' && isAiMode(parsed.aiMode) && { aiMode: parsed.aiMode }),
      ...(typeof parsed.aiProvider === 'string' && isAiProviderId(parsed.aiProvider) && { aiProvider: parsed.aiProvider }),
      ...(typeof parsed.aiApiFormat === 'string' && isAiApiFormat(parsed.aiApiFormat) && { aiApiFormat: parsed.aiApiFormat }),
      ...(typeof parsed.aiBaseUrl === 'string' && { aiBaseUrl: parsed.aiBaseUrl }),
      ...(typeof parsed.aiModel === 'string' && { aiModel: parsed.aiModel }),
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
        browserWalletSession: state.browserWalletSession,
        selectedIosWalletId: state.selectedIosWalletId,
        workflowModePreference: state.workflowModePreference,
        cluster: state.cluster,
        bridgeUrl: state.bridgeUrl,
        aiMode: state.aiSettings.mode,
        aiProvider: state.aiSettings.provider,
        aiApiFormat: state.aiSettings.apiFormat,
        aiBaseUrl: state.aiSettings.baseUrl,
        aiModel: state.aiSettings.model,
      }),
    );
  } catch {
    // Best-effort browser persistence.
  }
}

function readLaunchParams(): { bridgeUrl?: string; bridgeToken?: string } {
  const params = new URLSearchParams(window.location.search);
  const bridgeUrl = params.get('bridgeUrl')?.trim();
  const bridgeToken = params.get('token')?.trim();
  if (bridgeToken) {
    saveSessionBridgeToken(bridgeToken);
  }
  return {
    ...(bridgeUrl && isLoopbackBridgeUrl(bridgeUrl) ? { bridgeUrl } : {}),
    ...(bridgeToken ? { bridgeToken } : {}),
  };
}

function sessionBridgeToken(): string | undefined {
  const value = window.sessionStorage.getItem(BRIDGE_TOKEN_SESSION_KEY)?.trim();
  return value || undefined;
}

function saveSessionBridgeToken(value: string): void {
  try {
    if (value) {
      window.sessionStorage.setItem(BRIDGE_TOKEN_SESSION_KEY, value);
    } else {
      window.sessionStorage.removeItem(BRIDGE_TOKEN_SESSION_KEY);
    }
  } catch {
    // Session-only convenience; local bridge can still be configured manually.
  }
}

function clearSensitiveLaunchParams(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('token')) return;
  url.searchParams.delete('token');
  window.history.replaceState(window.history.state, document.title, `${url.pathname}${url.search}${url.hash}`);
}

function loadGeneratedPlans(): GeneratedPlanRecord[] {
  try {
    const raw = window.localStorage.getItem(GENERATED_PLANS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? mergeGeneratedPlans(parsed.filter(isGeneratedPlanRecord).map((record) => ({
          ...record,
          workflowSource: record.workflowSource ?? 'browser',
        })))
      : [];
  } catch {
    return [];
  }
}

function saveGeneratedPlans(): void {
  try {
    state.generatedPlans = mergeGeneratedPlans(state.generatedPlans);
    window.localStorage.setItem(
      GENERATED_PLANS_STORAGE_KEY,
      JSON.stringify(state.generatedPlans.filter((record) => record.workflowSource !== 'cloud')),
    );
  } catch {
    // Best-effort browser persistence.
  }
}

function loadBrowserWorkflowState(): BrowserWorkflowState {
  try {
    const raw = window.localStorage.getItem(BROWSER_WORKFLOW_STORAGE_KEY);
    if (!raw) {
      return emptyBrowserWorkflowState();
    }
    const parsed = JSON.parse(raw) as Partial<BrowserWorkflowState>;
    return normalizeBrowserWorkflowState(parsed);
  } catch {
    return emptyBrowserWorkflowState();
  }
}

function emptyBrowserWorkflowState(): BrowserWorkflowState {
  return {
    preparedActions: [],
    recurringPayments: [],
    receipts: [],
  };
}

function normalizeBrowserWorkflowState(input: Partial<BrowserWorkflowState>): BrowserWorkflowState {
  return {
    preparedActions: mergePreparedActions((input.preparedActions ?? []).filter(isPreparedAction).map((action) => ({
      ...action,
      workflowSource: 'browser',
    }))),
    recurringPayments: mergeRecurringPayments(withRecurringPaymentSource(input.recurringPayments ?? [], 'browser')),
    receipts: mergeActionReceipts((input.receipts ?? []).filter(isActionReceipt)),
  };
}

function saveBrowserWorkflowState(): void {
  try {
    const workflow = normalizeBrowserWorkflowState({
      preparedActions: state.preparedActions.filter(isBrowserWorkflowId),
      recurringPayments: state.recurringPayments.filter((payment) => recurringPaymentWorkflowSource(payment) === 'browser'),
      receipts: state.receipts.filter((receipt) => isBrowserWorkflowId(receipt.actionId)),
    });
    window.localStorage.setItem(BROWSER_WORKFLOW_STORAGE_KEY, JSON.stringify(workflow));
  } catch {
    // Best-effort browser workflow persistence.
  }
}

function mergePreparedActions(...groups: PreparedAction[][]): PreparedAction[] {
  const byId = new Map<string, PreparedAction>();
  for (const actions of groups) {
    for (const action of actions) {
      const current = byId.get(action.id);
      if (!current || action.updatedAt.localeCompare(current.updatedAt) >= 0) {
        byId.set(action.id, action);
      }
    }
  }
  return [...byId.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function withPreparedActionSource(actions: PreparedAction[], workflowSource: WorkflowRecordSource): PreparedAction[] {
  return actions.filter(isPreparedAction).map((action) => ({ ...action, workflowSource }));
}

function withRecurringPaymentSource(payments: RecurringPayment[], workflowSource: WorkflowRecordSource): RecurringPayment[] {
  return payments.filter(isRecurringPayment).map((payment) => ({ ...payment, workflowSource }));
}

function mergeRecurringPayments(...groups: RecurringPayment[][]): RecurringPayment[] {
  const byId = new Map<string, RecurringPayment>();
  for (const payments of groups) {
    for (const payment of payments) {
      const current = byId.get(payment.id);
      if (!current || payment.updatedAt.localeCompare(current.updatedAt) >= 0) {
        byId.set(payment.id, payment);
      }
    }
  }
  return [...byId.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function mergeActionReceipts(...groups: ActionReceipt[][]): ActionReceipt[] {
  const byId = new Map<string, ActionReceipt>();
  for (const receipts of groups) {
    for (const receipt of receipts) {
      const current = byId.get(receipt.actionId);
      if (!current || receipt.completedAt.localeCompare(current.completedAt) >= 0) {
        byId.set(receipt.actionId, receipt);
      }
    }
  }
  return [...byId.values()].sort((left, right) => right.completedAt.localeCompare(left.completedAt));
}

function isPreparedAction(value: unknown): value is PreparedAction {
  if (!value || typeof value !== 'object') return false;
  const action = value as Partial<PreparedAction>;
  return (
    typeof action.id === 'string' &&
    isPreparedActionKind(action.kind) &&
    isPreparedActionStatus(action.status) &&
    typeof action.walletAddress === 'string' &&
    isCluster(action.cluster ?? '') &&
    typeof action.summary === 'string' &&
    Boolean(action.params) &&
    typeof action.params === 'object' &&
    !Array.isArray(action.params) &&
    typeof action.dueAt === 'string' &&
    typeof action.createdAt === 'string' &&
    typeof action.updatedAt === 'string'
  );
}

function isPreparedActionKind(value: unknown): value is PreparedActionKind {
  return value === 'transfer_sol' ||
    value === 'transfer_spl' ||
    value === 'swap' ||
    value === 'manual_review' ||
    value === 'read_only' ||
    value === 'custom_transaction' ||
    value === 'custom';
}

function isRecurringPayment(value: unknown): value is RecurringPayment {
  if (!value || typeof value !== 'object') return false;
  const payment = value as Partial<RecurringPayment>;
  return (
    typeof payment.id === 'string' &&
    (payment.status === 'active' || payment.status === 'paused') &&
    typeof payment.walletAddress === 'string' &&
    isCluster(payment.cluster ?? '') &&
    typeof payment.token === 'string' &&
    typeof payment.recipient === 'string' &&
    typeof payment.amount === 'string' &&
    isRecurringCadence(payment.cadence) &&
    typeof payment.createdAt === 'string' &&
    typeof payment.updatedAt === 'string'
  );
}

function isActionReceipt(value: unknown): value is ActionReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<ActionReceipt>;
  return (
    typeof receipt.actionId === 'string' &&
    isPreparedActionStatus(receipt.status) &&
    typeof receipt.summary === 'string' &&
    typeof receipt.walletAddress === 'string' &&
    isCluster(receipt.cluster ?? '') &&
    typeof receipt.createdAt === 'string' &&
    typeof receipt.completedAt === 'string' &&
    (receipt.proofSignature === undefined || typeof receipt.proofSignature === 'string')
  );
}

function isPreparedActionStatus(value: unknown): value is PreparedActionStatus {
  return (
    value === 'scheduled' ||
    value === 'ready' ||
    value === 'overdue' ||
    value === 'approval_pending' ||
    value === 'approved' ||
    value === 'rejected' ||
    value === 'cancelled' ||
    value === 'blocked' ||
    value === 'failed' ||
    value === 'expired'
  );
}

function isRecurringCadence(value: unknown): value is RecurringCadence {
  return (
    value === 'weekly' ||
    value === 'monthly' ||
    value === 'interval_days' ||
    value === 'interval_hours' ||
    value === 'interval_minutes'
  );
}

function isBrowserWorkflowId(value: { id: string } | string): boolean {
  const id = typeof value === 'string' ? value : value.id;
  return id.startsWith('browser-');
}

function recurringPaymentWorkflowSource(payment: RecurringPayment): WorkflowRecordSource {
  if (payment.workflowSource) return payment.workflowSource;
  return isBrowserWorkflowId(payment.id) ? 'browser' : 'local-bridge';
}

function mergeGeneratedPlans(...planGroups: unknown[][]): GeneratedPlanRecord[] {
  const byId = new Map<string, GeneratedPlanRecord>();
  for (const plans of planGroups) {
    for (const plan of plans) {
      if (!isGeneratedPlanRecord(plan)) continue;
      const current = byId.get(plan.id);
      if (!current || plan.updatedAt.localeCompare(current.updatedAt) >= 0) {
        byId.set(plan.id, plan);
      }
    }
  }
  return [...byId.values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, GENERATED_PLANS_LIMIT);
}

function isGeneratedPlanRecord(value: unknown): value is GeneratedPlanRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<GeneratedPlanRecord>;
  return (
    typeof record.id === 'string' &&
    isAgentPlan(record.plan) &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string' &&
    (record.source === 'template' || record.source === 'ai') &&
    typeof record.templateId === 'string' &&
    typeof record.templateTitle === 'string' &&
    typeof record.prompt === 'string' &&
    typeof record.walletAddress === 'string' &&
    isCluster(record.cluster ?? '') &&
    isGeneratedPlanStatus(record.status) &&
    (record.signature === undefined || typeof record.signature === 'string') &&
    (record.preparedActionId === undefined || typeof record.preparedActionId === 'string') &&
    (record.error === undefined || typeof record.error === 'string') &&
    (record.failureLabel === undefined || typeof record.failureLabel === 'string')
  );
}

function isAgentPlan(value: unknown): value is AgentPlan {
  if (!value || typeof value !== 'object') return false;
  const plan = value as Partial<AgentPlan>;
  return (
    typeof plan.intent === 'string' &&
    typeof plan.route === 'string' &&
    typeof plan.risk === 'string' &&
    typeof plan.approval === 'string' &&
    (plan.source === 'template' || plan.source === 'ai') &&
    typeof plan.category === 'string' &&
    typeof plan.actionType === 'string' &&
    typeof plan.templateTitle === 'string' &&
    (plan.userNotes === undefined || typeof plan.userNotes === 'string') &&
    Boolean(plan.parameters) &&
    typeof plan.parameters === 'object' &&
    !Array.isArray(plan.parameters) &&
    Object.values(plan.parameters).every((entry) => typeof entry === 'string') &&
    Array.isArray(plan.fields) &&
    plan.fields.every(isAgentPlanField) &&
    Array.isArray(plan.safeguards) &&
    plan.safeguards.every((entry) => typeof entry === 'string')
  );
}

function isAgentPlanField(value: unknown): value is AgentPlan['fields'][number] {
  if (!value || typeof value !== 'object') return false;
  const field = value as Partial<AgentPlan['fields'][number]>;
  return typeof field.label === 'string' && typeof field.value === 'string';
}

function isGeneratedPlanStatus(value: unknown): value is GeneratedPlanStatus {
  return value === 'draft' || value === 'signed' || value === 'queued' || value === 'archived' || value === 'failed';
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
  const mode = activeWorkflowMode();
  const cloud = mode === 'agentic-cloud'
    ? await loadCloudEvidenceArtifacts().catch((err) => {
        state.cloudEvidenceStatus = `Cloud evidence archive unavailable: ${err instanceof Error ? err.message : String(err)}`;
        return [] as LabArtifact[];
      })
    : [];
  state.labArtifacts = mergeLabArtifacts(state.labArtifacts, legacy, indexed, cloud);
  if (mode === 'agentic-cloud') {
    state.cloudEvidenceLastSyncAt = Date.now();
    state.cloudEvidenceStatus = cloud.length > 0
      ? `Cloud evidence archive synced (${cloud.length} receipt${cloud.length === 1 ? '' : 's'}).`
      : 'Cloud evidence archive ready (no receipts yet).';
  } else if (mode === 'local-bridge') {
    state.cloudEvidenceStatus = 'Private local mode: receipts stay off Agentic Cloud.';
  } else {
    state.cloudEvidenceStatus = 'Cloud evidence archive: sign in to also store receipts in Agentic Cloud.';
  }
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
  if (artifact.cloudReceiptId !== undefined && (typeof artifact.cloudReceiptId !== 'string' || artifact.cloudReceiptId.length === 0)) return false;
  if (artifact.bridgeArchived !== undefined && typeof artifact.bridgeArchived !== 'boolean') return false;
  if (artifact.metadata !== undefined && !isJsonObject(artifact.metadata)) return false;
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
    const clearRequest = store.clear();
    clearRequest.onsuccess = () => {
      for (const artifact of mergeLabArtifacts(artifacts)) {
        store.put(artifact);
      }
    };
    clearRequest.onerror = () => reject(clearRequest.error ?? new Error('Unable to clear lab artifact archive.'));
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
