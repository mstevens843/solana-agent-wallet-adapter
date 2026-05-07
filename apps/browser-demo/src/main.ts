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

import './styles.css';

type StepState = 'idle' | 'active' | 'done' | 'error';
type StepName = 'discover' | 'connect' | 'sign' | 'transaction' | 'bridge' | 'inbox' | 'lab';
type ActiveTab = 'wallet' | 'agent' | 'inbox' | 'labs';
type ToastKind = 'success' | 'error';
type RuntimePathId = 'exec' | 'install' | 'desktop' | 'android';
type AppRoute = (typeof ROUTE_PATHS)[number];
type InboxFilter = 'all' | 'ready' | 'scheduled' | 'approved' | 'failed' | 'rejected' | 'one-time' | 'recurring';
type InboxMode = 'inbox' | 'recurring';
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

const CLUSTERS: Cluster[] = ['mainnet-beta', 'devnet', 'testnet', 'localnet'];
const DEMO_MESSAGE = 'Approve this Solana agent action with user custody.';
const DEMO_MEMO = 'Solana Agent Wallet Adapter demo';
const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8787';
const DEFAULT_BRIDGE_TOKEN = 'local-agent-wallet';
const DEFAULT_AGENT_PROMPT =
  'Swap a tiny amount of SOL to USDC using my wallet, then show me what I am approving.';
const STORAGE_KEY = 'solana-agent-wallet-demo-v2';
const LAB_STORAGE_KEY = 'solana-agent-wallet-lab-artifacts-v1';
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const RELEASE_BASE_URL =
  'https://github.com/mstevens843/solana-agent-wallet-adapter/releases/latest/download';
const RELEASE_PAGE_URL =
  'https://github.com/mstevens843/solana-agent-wallet-adapter/releases/latest';
const NPM_GLOBAL_INSTALL_COMMAND = 'npm install -g @solana-agent-wallet-adapter/cli';
const NPM_EXEC_COMMAND = 'npm exec @solana-agent-wallet-adapter/cli -- app';
const INSTALLED_APP_COMMAND = 'solana-agent-wallet app';
const ROUTE_PATHS = ['/', '/docs', '/cli', '/desktop', '/android', '/demo'] as const;
const ROUTE_PATH_SET = new Set<string>(ROUTE_PATHS);
const HASH_ROUTE_MAP = new Map<string, AppRoute>([
  ['#top', '/'],
  ['#docs', '/docs'],
  ['#cli', '/cli'],
  ['#desktop', '/desktop'],
  ['#android', '/android'],
  ['#workspace', '/demo'],
]);
const NAV_ITEMS: ReadonlyArray<{ route: AppRoute; label: string; pill?: boolean }> = [
  { route: '/docs', label: 'Docs' },
  { route: '/cli', label: 'CLI' },
  { route: '/desktop', label: 'Desktop' },
  { route: '/android', label: 'Android' },
  { route: '/demo', label: 'Launch Demo', pill: true },
];
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
    label: 'Desktop app',
    detail: 'Use bundled controls, logs, and diagnostics.',
    command: '/desktop',
    terminalCommand: '/desktop',
    badge: 'App UI',
    actionLabel: 'View downloads',
    actionKind: 'link',
    href: '/desktop',
    bridgeLine: 'Desktop runtime manages the local bridge',
    walletLine: 'Browser wallet still approves every request',
  },
  {
    id: 'android',
    eyebrow: 'Mobile',
    label: 'Android app',
    detail: 'Install the hosted TWA for MWA approvals.',
    command: '/android',
    terminalCommand: '/android',
    badge: 'Android',
    actionLabel: 'View Android',
    actionKind: 'link',
    href: '/android',
    bridgeLine: 'Trusted Web Activity opens the hosted Agentic origin',
    walletLine: 'Android Chrome can expose Mobile Wallet Adapter',
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
const AGENTIC_MARK_LOGO = new URL('./assets/logos/saturn_4.png', import.meta.url).href;

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

interface AgentPlan {
  intent: string;
  route: string;
  risk: string;
  approval: string;
}

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
  cluster?: Cluster;
  bridgeUrl?: string;
  bridgeToken?: string;
}

interface DemoState {
  activeTab: ActiveTab;
  selectedRuntimePath: RuntimePathId;
  recentCopyId: string;
  inboxMode: InboxMode;
  inboxFilter: InboxFilter;
  wallets: DiscoveredWallet[];
  selectedWalletName: string;
  address: string;
  signature: string;
  txSignature: string;
  txid: string;
  customTransactionBase64: string;
  transactionStatus: string;
  agentPrompt: string;
  agentPlan: AgentPlan | null;
  agentSignature: string;
  agentPreparedActionId: string;
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

const state: DemoState = {
  activeTab: 'wallet',
  selectedRuntimePath: 'exec',
  recentCopyId: '',
  inboxMode: 'inbox',
  inboxFilter: 'all',
  wallets: [],
  selectedWalletName: persisted.selectedWalletName ?? '',
  address: '',
  signature: '',
  txSignature: '',
  txid: '',
  customTransactionBase64: '',
  transactionStatus: '',
  agentPrompt: DEFAULT_AGENT_PROMPT,
  agentPlan: null,
  agentSignature: '',
  agentPreparedActionId: '',
  toasts: [],
  capabilities: null,
  error: '',
  busy: false,
  cluster: persisted.cluster ?? 'mainnet-beta',
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
  steps: {
    discover: 'idle',
    connect: 'idle',
    sign: 'idle',
    transaction: 'idle',
    bridge: 'idle',
    inbox: 'idle',
    lab: 'idle',
  },
};

let client: SolanaSigningClient | null = null;
let walletBackend: WalletStandardWebBackend | null = null;
let nextToastId = 1;
let bridgePollTimer: number | null = null;
let bridgeRequestBusy = false;
let lastPassiveInboxRefresh = 0;
let copyResetTimer: number | null = null;

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
  await loadBridgeConfig(false);
  render();
}

function render(): void {
  const route = currentRoute();
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
  return `
    <section class="shell homepage-shell">
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
    case '/cli':
      return cliPage();
    case '/desktop':
      return desktopPage();
    case '/android':
      return androidPage();
    case '/demo':
      return demoPage();
    default:
      return notFoundPage();
  }
}

function homePage(): string {
  return `
    ${heroSection()}
    ${docsSection()}
    ${gapSection()}
    ${walletDirectorySection()}
    ${cliInstallSection()}
    ${desktopDownloadSection()}
    ${androidDownloadSection()}
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
  return appWorkspace();
}

function notFoundPage(): string {
  return `
    <section class="docs-section page-not-found" aria-labelledby="not-found-title">
      <div class="section-heading">
        <p class="eyebrow mini">Not found</p>
        <h2 id="not-found-title">This Agentic page does not exist.</h2>
        <p>Use the navigation bar to open docs, install paths, downloads, or the live approval demo.</p>
      </div>
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

function navLink(
  item: { route: AppRoute; label: string; pill?: boolean },
  activeRoute: AppRoute | null,
): string {
  const active = item.route === activeRoute;
  const className = item.pill ? 'nav-pill-link' : '';
  return `
    <a href="${escapeHtml(item.route)}" class="${className}" ${active ? 'aria-current="page"' : ''}>
      ${escapeHtml(item.label)}
    </a>
  `;
}

function heroSection(): string {
  return `
    <section id="top" class="homepage-hero" aria-labelledby="hero-title">
      <div class="hero-copy">
        <div class="chain-strip" aria-label="Network and signing layer">
          <span class="logo-chip solana-chip">${brandLogo('solana', 'logo-chip-icon')}<span>Solana</span></span>
          <span class="logo-chip">${brandLogo('solana', 'logo-chip-icon')}<span>Wallet Standard</span></span>
          <span class="logo-chip">${brandLogo('solanaMobile', 'logo-chip-icon')}<span>Mobile Wallet Adapter</span></span>
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
          <a class="button-link hero-demo-link" href="/demo">Launch Demo</a>
          <a class="button-link hero-android-link" href="/android">Android App</a>
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

function docsSection(): string {
  return `
    <section id="docs" class="docs-section" aria-labelledby="docs-title">
      <div class="section-heading">
        <p class="eyebrow mini">Docs</p>
        <h2 id="docs-title">A local signing boundary for agent runtimes.</h2>
        <p>
          Render serves this website, but Agentic's bridge, CLI, and desktop app run locally beside the user's wallet.
          Android users can install the Trusted Web Activity wrapper for the same hosted origin and Mobile Wallet
          Adapter path. Agents can ask for signatures, swaps, transfers, receipts, and inbox approvals without
          receiving a seed phrase, keypair file, or server-side private key.
        </p>
      </div>
      <div class="docs-grid">
        ${docsCard('1. Install a local runtime', 'Use the npm CLI, a standalone CLI binary, or the desktop app to run the bridge on your machine. Android installs the hosted mobile shell.')}
        ${docsCard('2. Connect an existing wallet', 'Open the browser wallet host and connect Phantom, Solflare, Backpack, Seed Vault, MWA, or a compatible Wallet Standard provider.')}
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
        <p class="eyebrow mini">CLI</p>
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
        <p class="eyebrow mini">Desktop</p>
        <h2 id="desktop-title">Download the Agentic desktop app.</h2>
        <p>
          The desktop app wraps the local bridge controls and diagnostics for users who want an app instead of a
          terminal. Browser extension wallets still approve through the external wallet host.
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
        <p class="eyebrow mini">Android</p>
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
        <p class="eyebrow mini">Live approval demo</p>
        <h2 id="homepage-demo-title">Open the wallet workspace when you are ready to test signing.</h2>
        <p>
          The demo route keeps the interactive Wallet Standard, Mobile Wallet Adapter, bridge, inbox, and artifact
          flows separate from the public download pages.
        </p>
      </div>
      <a class="button-link nav-pill-link" href="/demo">Launch Demo</a>
    </section>
  `;
}

function homepageFooter(): string {
  return `
    <footer class="homepage-footer" aria-label="Agentic footer">
      <div>
        <span class="footer-brand">${agenticMark('mini-mark')} Agentic</span>
        <p>Render hosts the static website. CLI, desktop, bridge, and wallet approvals run locally.</p>
      </div>
      <nav aria-label="Footer navigation">
        <a href="/docs">Docs</a>
        <a href="/cli">CLI</a>
        <a href="/desktop">Desktop</a>
        <a href="/android">Android</a>
        <a href="/demo">Demo</a>
        <a href="${RELEASE_PAGE_URL}" target="_blank" rel="noreferrer">Releases</a>
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
          <span class="runtime-kicker">Browser demo</span>
          <h3>Develop the website</h3>
          ${runtimeCommandRow('Browser dev server', 'pnpm demo:browser', 'Copy command')}
        </article>
        <article class="runtime-card">
          <span class="runtime-kicker">Repo fallback</span>
          <h3>Run unreleased local runtimes</h3>
          ${runtimeCommandRow('Desktop shell dev', 'pnpm desktop:dev', 'Copy command')}
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

function appWorkspace(): string {
  return `
    <section id="workspace" class="app-workspace-section" aria-labelledby="workspace-title">
      <div class="workspace-intro">
        <div>
          <p class="eyebrow mini">Live browser workspace</p>
          <h2 id="workspace-title">Try Agentic with installed Solana wallets.</h2>
        </div>
        ${systemSpine()}
      </div>
      ${missionStrip()}
      <header class="app-header command-bar">
        <div class="brand-lockup">
          <span class="brand-mark">${agenticMark('mini-mark')}</span>
          <div>
            <p class="eyebrow mini">Solana Agent Wallet Adapter</p>
            <h1>Interactive approval console</h1>
          </div>
        </div>
        ${systemSpine()}
      </header>

      <section class="workspace">
        ${walletRail()}
        <section class="panel main-panel">
          <div class="surface-topbar">
            <div>
              <h2>${surfaceTitle()}</h2>
            </div>
            <nav class="nav-cluster tabs workspace-tabs" aria-label="Workspace navigation">
              ${tabButton('wallet', 'Wallet')}
              ${tabButton('agent', 'Agent Plan')}
              ${tabButton('inbox', 'Approvals')}
              ${tabButton('labs', 'Artifacts')}
            </nav>
          </div>
          ${activePanel()}
        </section>
        ${contextPanel()}
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
  const showConnectionDetails = !state.address;
  const wallet = walletIdentity();
  return `
    <aside class="panel custody-panel custody-module">
      <div class="rail-heading custody-heading">
        <span class="rail-icon">${escapeHtml(wallet.icon)}</span>
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

      ${state.address ? `<button id="disconnect" class="text-button" ${state.busy ? 'disabled' : ''}>Disconnect wallet</button>` : ''}

      <details class="rail-details" ${showConnectionDetails ? 'open' : ''}>
        <summary>Manage connection</summary>
        <label class="field">
          <span>Cluster</span>
          <select id="clusterSelect" ${state.busy || state.bridgeActive ? 'disabled' : ''}>
            ${CLUSTERS.map((cluster) => `<option value="${cluster}" ${cluster === state.cluster ? 'selected' : ''}>${cluster}</option>`).join('')}
          </select>
        </label>

        <label class="field">
          <span>Selected wallet</span>
          <select id="walletSelect" ${state.wallets.length === 0 || state.busy ? 'disabled' : ''}>
            ${walletOptions()}
          </select>
        </label>

        ${state.capabilities ? capabilityBlock(state.capabilities) : ''}
      </details>

      ${state.address ? `
      <details class="rail-details bridge-details" ${state.bridgeActive ? 'open' : ''}>
        <summary>Bridge operations</summary>
        ${bridgeBox()}
      </details>` : ''}
      ${state.address ? `
      <details class="rail-details">
        <summary>Environment</summary>
        ${mobileWalletBox()}
      </details>` : ''}
    </aside>
  `;
}

function mobileWalletBox(): string {
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
  return `
    <section class="guided-start signature-stage stage-dormant">
      <div class="guided-start-copy">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(detail)}</p>
      </div>
      <div class="guided-path" aria-label="Wallet connection path">
        ${guidedStep('1', 'Discover', state.wallets.length ? `${state.wallets.length} provider(s) found` : 'Find installed Wallet Standard providers', state.wallets.length > 0)}
        ${guidedStep('2', 'Select', selectedProvider || (state.wallets.length ? 'Choose a discovered provider' : 'Choose a wallet provider'), Boolean(selectedProvider))}
        ${guidedStep('3', 'Connect', 'Authorize this app in the wallet', Boolean(state.address))}
      </div>
      <div class="guided-actions">
        <button data-start-action="discover" class="${state.wallets.length ? '' : 'primary'}" ${state.busy ? 'disabled' : ''}>Discover wallets</button>
        <button data-start-action="connect" class="${state.wallets.length ? 'primary' : ''}" ${state.wallets.length === 0 || !selectedProvider || state.busy ? 'disabled' : ''} title="${!selectedProvider ? 'Discover and select a wallet provider first.' : ''}">Connect wallet</button>
      </div>
      <p class="guided-note">Bridge review, scheduled approvals, audit artifacts, and transaction tools unlock after a wallet is connected.</p>
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
      return inboxPanel();
    case 'labs':
      return labsPanel();
  }
}

function walletFlowPanel(): string {
  if (!state.address) {
    return `
      ${guidedStartPanel('Wallet signing', 'Connect a browser wallet to open signing requests, approvals, and receipts.')}
      ${terminalCommandPanel()}
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

      <details class="advanced-section" ${state.customTransactionBase64 || state.txSignature || state.txid ? 'open' : ''}>
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
      </details>

      <div class="signature-floor">
        <div>
          <span>Status</span>
          <strong>${escapeHtml(walletStatus)}</strong>
        </div>
        <button id="airdrop" class="utility" ${!state.address || state.busy || state.cluster !== 'devnet' ? 'disabled' : ''}>
          Request devnet SOL
        </button>
      </div>

      ${resultBlock()}
      ${terminalCommandPanel()}
      ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
    </section>
  `;
}

function agentPlanPanel(): string {
  if (!state.address) {
    return guidedStartPanel('Agent plan', 'Connect a wallet before generating or signing an agent request.');
  }
  return `
    <section class="approval-object signature-stage stage-agent ${state.agentSignature ? 'stage-complete' : state.agentPlan ? 'stage-active' : 'stage-draft'}">
      <div class="signature-object-head">
        <div>
          <h2>Agent plan</h2>
          <p>Review the request, route, and risk before any prepared action can execute.</p>
        </div>
        <span class="signature-state ${state.agentSignature ? 'complete' : state.agentPlan ? 'active' : ''}">${state.agentSignature ? 'proof signed' : state.agentPlan ? 'plan ready' : 'draft'}</span>
      </div>

      <div class="intent-capsule intent-document-card ${state.agentPlan ? 'plan-linked' : 'draft'}">
        <div class="intent-document-head">
          <div>
            <span>Request</span>
            <h3>Agent request</h3>
          </div>
          <strong>${state.agentSignature ? 'Proof signed' : state.agentPlan ? 'Ready for proof' : 'Draft'}</strong>
        </div>
        <label class="intent-document">
          <span>User request</span>
          <textarea id="agentPrompt" ${state.busy ? 'disabled' : ''}>${escapeHtml(state.agentPrompt)}</textarea>
        </label>
        <div class="intent-policy-strip">
          <span>Approval rule</span>
          <p>Review route, risk, and approval constraints before signing.</p>
        </div>
        <div class="agent-actions signature-actions intent-document-actions">
          <button id="generatePlan" class="${state.agentPlan ? '' : 'primary'}" ${!state.address || state.busy ? 'disabled' : ''}>Generate plan</button>
          <button id="signAgentPlan" class="${state.agentPlan ? 'primary' : ''}" ${!state.address || !state.agentPlan || state.busy ? 'disabled' : ''} title="${!state.agentPlan ? 'Generate a plan before signing approval.' : ''}">Sign approval</button>
          <button id="queueAgentPlan" class="utility" ${!state.address || !state.agentPlan || !state.bridgeActive || state.busy ? 'disabled' : ''} title="${!state.bridgeActive ? 'Connect the bridge before queueing approvals.' : ''}">Queue approval</button>
        </div>
      </div>

      ${state.agentPlan ? agentPlanCard(state.agentPlan) : signaturePlaceholder('Plan details', 'Generate a plan to show route, risk, and approval constraints before signing.')}
      ${agentResultBlock()}
      ${state.agentPreparedActionId ? `<div class="notice">Queued prepared action: ${escapeHtml(state.agentPreparedActionId)}</div>` : ''}
      ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
    </section>
  `;
}

function inboxPanel(): string {
  if (!state.address) {
    return guidedStartPanel('Approval queue', 'Connect a wallet before reviewing prepared actions from the local bridge.');
  }
  const actions = filteredPreparedActions();
  return `
    <section class="approval-object signature-stage stage-inbox stage-anchor ${state.preparedActions.length ? 'stage-active' : 'stage-draft'}">
      <div class="signature-object-head">
        <div>
          <h2>Prepared approvals</h2>
          <p>Actions wait here until policy, intent, and wallet approval are all visible.</p>
        </div>
        <div class="inbox-toolbar signature-toolbar">
          <div class="segmented compact-tabs">
            <button data-inbox-mode="inbox" class="${state.inboxMode === 'inbox' ? 'active' : ''}">Inbox</button>
            <button data-inbox-mode="recurring" class="${state.inboxMode === 'recurring' ? 'active' : ''}">Schedule</button>
          </div>
          <select id="inboxFilter" ${state.inboxMode === 'recurring' ? 'disabled' : ''}>
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
      ${state.inboxMode === 'recurring' ? recurringComposer() : preparedActionsList(actions)}
      ${recurringList()}
      ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
    </section>
  `;
}

function labsPanel(): string {
  if (!state.address) {
    return guidedStartPanel('Audit artifacts', 'Connect a wallet before creating signed audit artifacts.');
  }
  const lab = activeLab();
  const artifact = latestLabArtifact(lab.id);
  return `
    <section class="approval-object signature-stage stage-labs stage-anchor ${artifact ? 'stage-complete' : 'stage-draft'}">
      <div class="signature-object-head">
        <div>
          <h2>Audit artifact</h2>
          <p>Create a signed record that binds request intent, policy interpretation, wallet identity, and local verification.</p>
        </div>
        <span class="signature-state">${escapeHtml(labIndexLabel())}</span>
      </div>

      <div class="lab-panel lab-workbench">
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
        ${labHistory()}
      </div>
      ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
    </section>
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

function bind(): void {
  bindRouteLinks();

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    button.addEventListener('click', () => {
      state.activeTab = button.dataset.tab as ActiveTab;
      state.error = '';
      render();
    });
  }

  document.querySelector<HTMLButtonElement>('#discover')?.addEventListener('click', runDiscover);
  document.querySelector<HTMLButtonElement>('#connect')?.addEventListener('click', runConnect);
  document.querySelector<HTMLButtonElement>('#disconnect')?.addEventListener('click', runDisconnect);
  document.querySelector<HTMLButtonElement>('#signMessage')?.addEventListener('click', runSignMessage);
  document.querySelector<HTMLButtonElement>('#airdrop')?.addEventListener('click', runAirdrop);
  document.querySelector<HTMLButtonElement>('#createTx')?.addEventListener('click', runCreateDemoTransaction);
  document.querySelector<HTMLButtonElement>('#signTx')?.addEventListener('click', runSignTransaction);
  document.querySelector<HTMLButtonElement>('#sendTx')?.addEventListener('click', runSignAndSendTransaction);
  document.querySelector<HTMLButtonElement>('#generatePlan')?.addEventListener('click', runGenerateAgentPlan);
  document.querySelector<HTMLButtonElement>('#signAgentPlan')?.addEventListener('click', runSignAgentPlan);
  document.querySelector<HTMLButtonElement>('#queueAgentPlan')?.addEventListener('click', runQueueAgentPlan);
  document.querySelector<HTMLButtonElement>('#connectBridge')?.addEventListener('click', runConnectBridge);
  document.querySelector<HTMLButtonElement>('#disconnectBridge')?.addEventListener('click', runDisconnectBridge);
  document.querySelector<HTMLButtonElement>('#refreshInbox')?.addEventListener('click', runRefreshInbox);
  document.querySelector<HTMLButtonElement>('#createRecurring')?.addEventListener('click', runCreateRecurring);
  document.querySelector<HTMLButtonElement>('#createLabArtifact')?.addEventListener('click', runCreateLabArtifact);

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

  document.querySelector<HTMLTextAreaElement>('#labInput')?.addEventListener('input', (event) => {
    state.labInputs[state.activeLab] = (event.currentTarget as HTMLTextAreaElement).value;
    saveLabArtifacts();
  });

  document.querySelector<HTMLSelectElement>('#labSelect')?.addEventListener('change', (event) => {
    state.activeLab = (event.currentTarget as HTMLSelectElement).value;
    state.error = '';
    render();
  });

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

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-inbox-mode]')) {
    button.addEventListener('click', () => {
      state.inboxMode = button.dataset.inboxMode as InboxMode;
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
      navigateTo(route);
    });
  }
}

async function runDiscover(): Promise<void> {
  await run('discover', async () => {
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
    await walletBackend?.disconnect().catch(() => undefined);
    resetWalletConnection();
    pushToast('success', 'Wallet disconnected', 'Local signing session cleared.');
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
    if (!state.address) {
      throw new Error('Connect a wallet before generating an agent plan.');
    }
    const intent = state.agentPrompt.trim() || DEFAULT_AGENT_PROMPT;
    state.agentPlan = {
      intent,
      route: 'SOL to USDC through the local bridge action service and Jupiter at approval time.',
      risk: 'Capped prepared action. It cannot execute until this wallet approves the inbox item.',
      approval: 'Wallet can sign an off-chain proof now or queue a prepared action for later review.',
    };
    state.agentSignature = '';
    state.agentPreparedActionId = '';
    pushToast('success', 'Agent plan generated', 'Approval plan ready.');
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
      `Intent: ${state.agentPlan.intent}`,
      `Route: ${state.agentPlan.route}`,
      `Risk: ${state.agentPlan.risk}`,
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
    const response = await bridgeRequest<{ preparedAction: PreparedAction }>('/bridge/action/prepare-swap', {
      method: 'POST',
      body: JSON.stringify({
        inputToken: 'SOL',
        outputToken: 'USDC',
        amount: '0.01',
        note: state.agentPlan.intent,
      }),
    });
    state.agentPreparedActionId = response.preparedAction.id;
    state.activeTab = 'inbox';
    state.inboxMode = 'inbox';
    state.inboxFilter = 'ready';
    await refreshInboxData();
    pushToast('success', 'Prepared action queued', response.preparedAction.id);
  });
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
    await Promise.all([refreshInboxData(), refreshHealth(), refreshBalances().catch(() => undefined)]);
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
    await Promise.all([refreshInboxData(), refreshHealth(), refreshBalances().catch(() => undefined)]);
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
    state.inboxMode = 'inbox';
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
    state.labArtifacts = [artifact, ...state.labArtifacts.filter((candidate) => candidate.id !== artifact.id)].slice(0, 20);
    saveLabArtifacts();
    pushToast('success', `${lab.title} signed`, verified ? 'Signature verified locally.' : 'Signature returned.');
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
    state.error = err instanceof Error ? err.message : String(err);
    pushToast('error', 'Action failed', state.error);
  } finally {
    state.busy = false;
    render();
  }
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
    if (state.activeTab === 'inbox' && now - lastPassiveInboxRefresh > 5000) {
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
  state.activeTab = 'wallet';
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

function walletIdentity(): { icon: string; title: string; summary: string; detail: string } {
  const liveSelectedName = discoveredSelectedWalletName();
  const providerCount = state.wallets.length;
  if (state.address) {
    const name = liveSelectedName || state.selectedWalletName || 'Connected wallet';
    return {
      icon: name.slice(0, 2).toUpperCase(),
      title: name,
      summary: short(state.address),
      detail: `${titleCaseCluster(state.cluster)} signer`,
    };
  }
  if (providerCount > 0 && liveSelectedName) {
    return {
      icon: liveSelectedName.slice(0, 2).toUpperCase(),
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

function tabButton(tab: ActiveTab, label: string): string {
  const locked = !state.address && tab !== 'wallet';
  return `<button data-tab="${tab}" class="${state.activeTab === tab ? 'active' : ''}" ${locked ? 'disabled title="Connect a wallet to unlock this workspace."' : ''}>${escapeHtml(label)}</button>`;
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
        <span class="workbench-kicker">Wallet approval</span>
        <h3>${escapeHtml(plan.intent)}</h3>
      </div>
      <dl class="proof-grid">
        ${definitionRow('Route', plan.route)}
        ${definitionRow('Risk', plan.risk)}
        ${definitionRow('Approval', plan.approval)}
      </dl>
    </article>
  `;
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
  const filter = state.inboxMode === 'recurring' ? 'Scheduling mode' : queueFilterLabel(state.inboxFilter);
  return `
    <div class="queue-status">
      <span>${escapeHtml(bridge)}</span>
      <strong>${visibleCount} awaiting review</strong>
      <span>${total} in queue</span>
      <span>${escapeHtml(filter)}</span>
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
          <span>Schedule</span>
          <h3>Recurring approval</h3>
          <p class="recurring-help">Define the schedule. Each occurrence still requires wallet approval.</p>
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
        <button id="createRecurring" class="primary" ${createDisabled ? 'disabled' : ''}>Create schedule</button>
        ${createDisabled ? '<span class="contract-helper">Bridge required before scheduling.</span>' : '<span class="contract-helper">Schedule will create reviewable inbox items.</span>'}
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
      return 'Showing scheduled approvals';
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
  if (state.activeTab === 'labs') {
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
  if (state.activeTab === 'labs') {
    return {
      status: 'Local verification',
      detail: 'Audit artifacts bind payload hash, wallet, cluster, and signature for review.',
      meta: state.labArtifacts.length ? `${state.labArtifacts.length} artifact(s)` : 'No artifacts yet',
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
      state.activeTab === 'inbox'
        ? 'Receipts appear after an inbox approval is approved, rejected, or archived.'
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
  const hasReceipt = Boolean(state.txid || state.txSignature || state.agentSignature || state.receipts.length);
  return `
    <div class="trust-chain" aria-label="Approval trust chain">
      ${trustNode('Intent', Boolean(state.agentPlan || state.signature || state.customTransactionBase64), state.activeTab === 'agent')}
      ${trustNode('Policy', Boolean(state.bridgeActive || state.preparedActions.length), state.activeTab === 'inbox')}
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
      return 'Approval operations';
    case 'labs':
      return 'Audit artifacts';
  }
}

function surfaceTitle(): string {
  switch (state.activeTab) {
    case 'wallet':
      return 'Wallet signing';
    case 'agent':
      return 'Agent Plan';
    case 'inbox':
      return 'Approvals';
    case 'labs':
      return 'Audit Artifacts';
  }
}

function emptyInboxText(): string {
  if (state.inboxFilter === 'one-time') {
    return 'No one-time actions. Ask the MCP agent to prepare a payment or swap.';
  }
  if (state.inboxFilter === 'recurring') {
    return 'No recurring actions yet. Create a recurring approval schedule above.';
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

function bridgeModeLabel(): string {
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

function isCluster(value: string): value is Cluster {
  return value === 'mainnet-beta' || value === 'devnet' || value === 'testnet' || value === 'localnet';
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
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object' && 'message' in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
    return stableJson(error);
  }
  return stableJson(payload);
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
    return Array.isArray(parsed) ? (parsed as LabArtifact[]) : [];
  } catch {
    return [];
  }
}

function saveLabArtifacts(): void {
  try {
    window.localStorage.setItem(LAB_STORAGE_KEY, JSON.stringify(state.labArtifacts.slice(0, 20)));
  } catch {
    // Best-effort browser persistence.
  }
}
