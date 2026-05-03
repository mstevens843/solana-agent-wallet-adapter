import { SolanaSigningClient, type AdapterCapabilities, type SigningResult } from '@solana-agent-wallet-adapter/core';
import {
  listAvailableWallets,
  WalletStandardWebBackend,
  type DiscoveredWallet,
} from '@solana-agent-wallet-adapter/wallet-standard-web';
import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';

import './styles.css';

type StepState = 'idle' | 'active' | 'done' | 'error';
type InstructionData = ConstructorParameters<typeof TransactionInstruction>[0]['data'];
type ActiveTab = 'wallet' | 'agent';
type ToastKind = 'success' | 'error';

const DEMO_MESSAGE = 'Approve this Solana agent action on devnet.';
const DEMO_MEMO = 'Solana Agent Wallet Adapter demo';
const DEVNET_RPC_URL = 'https://api.devnet.solana.com';
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const DEFAULT_AGENT_PROMPT =
  'Swap a tiny amount of SOL to USDC using my wallet, then show me what I am approving.';

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

interface DemoState {
  activeTab: ActiveTab;
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
  toasts: Toast[];
  capabilities: AdapterCapabilities | null;
  error: string;
  busy: boolean;
  steps: Record<'discover' | 'connect' | 'sign' | 'transaction', StepState>;
}

const state: DemoState = {
  activeTab: 'wallet',
  wallets: [],
  selectedWalletName: '',
  address: '',
  signature: '',
  txSignature: '',
  txid: '',
  customTransactionBase64: '',
  transactionStatus: '',
  agentPrompt: DEFAULT_AGENT_PROMPT,
  agentPlan: null,
  agentSignature: '',
  toasts: [],
  capabilities: null,
  error: '',
  busy: false,
  steps: {
    discover: 'idle',
    connect: 'idle',
    sign: 'idle',
    transaction: 'idle',
  },
};

let client: SolanaSigningClient | null = null;
let nextToastId = 1;

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('Missing #app');
}
const appRoot = app;

render();

function render(): void {
  appRoot.innerHTML = `
    <section class="shell">
      ${toastStack()}
      <header class="hero">
        <div>
          <p class="eyebrow">Live browser wallet demo</p>
          <h1>Agent signing, user custody.</h1>
          <p class="lede">
            Route an AI-agent signing request through Phantom, Solflare, Backpack, or any Wallet Standard Solana wallet. The model never sees a private key.
          </p>
        </div>
        <div class="status-card">
          <span class="status-dot ${state.address ? 'online' : ''}"></span>
          <div>
            <strong>${state.address ? 'Wallet connected' : 'Waiting for wallet'}</strong>
            <span>${state.address ? short(state.address) : 'Devnet browser flow'}</span>
          </div>
        </div>
      </header>

      <section class="workspace">
        <aside class="panel">
          <h2>Wallet</h2>
          <button id="discover" class="primary" ${state.busy ? 'disabled' : ''}>Discover wallets</button>
          <label class="field">
            <span>Selected wallet</span>
            <select id="walletSelect" ${state.wallets.length === 0 || state.busy ? 'disabled' : ''}>
              ${walletOptions()}
            </select>
          </label>
          <button id="connect" ${state.wallets.length === 0 || state.busy ? 'disabled' : ''}>Connect</button>
          ${state.capabilities ? capabilityBlock(state.capabilities) : ''}
        </aside>

        <section class="panel main-panel">
          <div class="tabs">
            <button id="tabWallet" class="${state.activeTab === 'wallet' ? 'active' : ''}">Wallet Flow</button>
            <button id="tabAgent" class="${state.activeTab === 'agent' ? 'active' : ''}">Agent Plan</button>
          </div>
          ${state.activeTab === 'wallet' ? walletFlowPanel() : agentPlanPanel()}
        </section>
      </section>
    </section>
  `;

  bind();
}

function walletFlowPanel(): string {
  return `
          <div class="panel-header">
            <div>
              <h2>Approval Flow</h2>
              <p>Each signing call opens the selected wallet approval UI.</p>
            </div>
            <div class="panel-actions">
              <span class="cluster">devnet</span>
              <button id="airdrop" class="utility" ${!state.address || state.busy ? 'disabled' : ''}>Request devnet SOL</button>
            </div>
          </div>

          <ol class="timeline">
            ${step('discover', 'Discover Wallet Standard providers', state.wallets.length ? `${state.wallets.length} wallet(s) found` : 'No providers loaded yet')}
            ${step('connect', 'Connect selected wallet', state.address ? short(state.address) : 'Authorize account access')}
            ${step('sign', 'Sign agent message', state.signature ? short(state.signature) : DEMO_MESSAGE)}
            ${step('transaction', 'Optional transaction signing', transactionStepDetail())}
          </ol>

          <div class="actions">
            <div class="message-actions">
              <button id="signMessage" class="primary" ${!state.address || state.busy ? 'disabled' : ''}>Sign message</button>
            </div>

            <div class="transaction-actions">
              <div class="transaction-action-row">
                <button id="createTx" ${!state.address || state.busy ? 'disabled' : ''}>Create demo transaction</button>
                <button id="signTx" ${!state.address || !state.customTransactionBase64 || state.busy ? 'disabled' : ''}>Sign transaction</button>
                <button id="sendTx" ${!canSignAndSend() ? 'disabled' : ''}>Sign and send</button>
              </div>
              <label class="field compact transaction-field">
                <span>Transaction base64</span>
                <textarea id="txInput" placeholder="Create a demo transaction or paste a devnet transaction, base64 encoded" ${state.busy ? 'disabled' : ''}>${escapeHtml(state.customTransactionBase64)}</textarea>
              </label>
            </div>
          </div>

          ${state.transactionStatus ? `<div class="notice">${escapeHtml(state.transactionStatus)}</div>` : ''}
          ${resultBlock()}
          ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
  `;
}

function agentPlanPanel(): string {
  return `
    <div class="panel-header">
      <div>
        <h2>Agent Plan</h2>
        <p>Generate a simulated agent request, then approve the plan with your wallet.</p>
      </div>
      <span class="cluster">simulated</span>
    </div>

    <div class="agent-grid">
      <label class="field agent-prompt">
        <span>Agent request</span>
        <textarea id="agentPrompt" ${state.busy ? 'disabled' : ''}>${escapeHtml(state.agentPrompt)}</textarea>
      </label>
      <div class="agent-actions">
        <button id="generatePlan" class="primary" ${!state.address || state.busy ? 'disabled' : ''}>Generate plan</button>
        <button id="signAgentPlan" ${!state.address || !state.agentPlan || state.busy ? 'disabled' : ''}>Sign agent approval</button>
      </div>
    </div>

    ${state.agentPlan ? agentPlanCard(state.agentPlan) : '<div class="empty">Connect a wallet, then generate a simulated SOL to USDC plan.</div>'}
    ${agentResultBlock()}
    ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
  `;
}

function bind(): void {
  document.querySelector<HTMLButtonElement>('#tabWallet')?.addEventListener('click', () => {
    state.activeTab = 'wallet';
    state.error = '';
    render();
  });
  document.querySelector<HTMLButtonElement>('#tabAgent')?.addEventListener('click', () => {
    state.activeTab = 'agent';
    state.error = '';
    render();
  });
  document.querySelector<HTMLButtonElement>('#discover')?.addEventListener('click', runDiscover);
  document.querySelector<HTMLButtonElement>('#connect')?.addEventListener('click', runConnect);
  document.querySelector<HTMLButtonElement>('#signMessage')?.addEventListener('click', runSignMessage);
  document.querySelector<HTMLButtonElement>('#airdrop')?.addEventListener('click', runAirdrop);
  document.querySelector<HTMLButtonElement>('#createTx')?.addEventListener('click', runCreateDemoTransaction);
  document.querySelector<HTMLButtonElement>('#signTx')?.addEventListener('click', runSignTransaction);
  document.querySelector<HTMLButtonElement>('#sendTx')?.addEventListener('click', runSignAndSendTransaction);
  document.querySelector<HTMLButtonElement>('#generatePlan')?.addEventListener('click', runGenerateAgentPlan);
  document.querySelector<HTMLButtonElement>('#signAgentPlan')?.addEventListener('click', runSignAgentPlan);
  document.querySelector<HTMLTextAreaElement>('#agentPrompt')?.addEventListener('input', (event) => {
    state.agentPrompt = (event.currentTarget as HTMLTextAreaElement).value;
    state.agentPlan = null;
    state.agentSignature = '';
  });
  document.querySelector<HTMLSelectElement>('#walletSelect')?.addEventListener('change', (event) => {
    state.selectedWalletName = (event.currentTarget as HTMLSelectElement).value;
    client = null;
    state.address = '';
    state.signature = '';
    state.txSignature = '';
    state.txid = '';
    state.transactionStatus = '';
    state.agentPlan = null;
    state.agentSignature = '';
    state.capabilities = null;
    state.steps.connect = 'idle';
    state.steps.sign = 'idle';
    state.steps.transaction = 'idle';
    render();
  });
  document.querySelector<HTMLTextAreaElement>('#txInput')?.addEventListener('input', (event) => {
    state.customTransactionBase64 = (event.currentTarget as HTMLTextAreaElement).value.trim();
    state.txSignature = '';
    state.txid = '';
    render();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
    button.addEventListener('click', async () => {
      await navigator.clipboard.writeText(button.dataset.copy ?? '');
      button.textContent = 'Copied';
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-toast-dismiss]')) {
    button.addEventListener('click', () => {
      dismissToast(Number(button.dataset.toastDismiss));
    });
  }
}

async function runDiscover(): Promise<void> {
  await run('discover', async () => {
    state.wallets = [...listAvailableWallets()];
    state.selectedWalletName = state.wallets[0]?.name ?? '';
    if (state.wallets.length === 0) {
      throw new Error('No Wallet Standard Solana wallets are registered in this browser.');
    }
    pushToast('success', 'Wallets discovered', `${state.wallets.length} provider(s) found.`);
  });
}

async function runConnect(): Promise<void> {
  await run('connect', async () => {
    const selected = selectedWallet();
    const backend = new WalletStandardWebBackend({ wallet: selected, cluster: 'devnet' });
    client = new SolanaSigningClient({ backend });
    state.address = await client.getAddress();
    state.capabilities = await client.capabilities();
    state.transactionStatus = 'Wallet connected on devnet. If transaction signing says fees are missing, request devnet SOL here before signing.';
    pushToast('success', 'Wallet connected', short(state.address));
  });
}

async function runSignMessage(): Promise<void> {
  await run('sign', async () => {
    const signingClient = requireClient();
    const result = await signingClient.signMessage(DEMO_MESSAGE, {
      cluster: 'devnet',
      summary: 'Investor demo message signature',
    });
    state.signature = result.signature;
    pushToast('success', 'Message signed', short(result.signature));
  });
}

async function runAirdrop(): Promise<void> {
  await run('transaction', async () => {
    if (!state.address) {
      throw new Error('Connect a wallet before requesting devnet SOL.');
    }
    const publicKey = publicKeyFromConnectedWallet();
    state.transactionStatus = 'Requesting 1 devnet SOL from the Solana devnet faucet...';

    const connection = new Connection(DEVNET_RPC_URL, 'confirmed');
    const signature = await connection.requestAirdrop(publicKey, 1_000_000_000);
    await connection.confirmTransaction(signature, 'confirmed');

    state.transactionStatus = `Airdrop confirmed: ${short(signature)}. Create and sign a demo transaction now.`;
    pushToast('success', 'Devnet SOL requested', short(signature));
  });
}

async function runCreateDemoTransaction(): Promise<void> {
  await run('transaction', async () => {
    if (!state.address) {
      throw new Error('Connect a wallet before creating a demo transaction.');
    }

    const feePayer = publicKeyFromConnectedWallet();

    const connection = new Connection(DEVNET_RPC_URL, 'confirmed');
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

    state.customTransactionBase64 = encodeBase64(tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }));
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
    const result: SigningResult = await signingClient.signTransaction(state.customTransactionBase64, {
      cluster: 'devnet',
      summary: 'Investor demo transaction signature',
    });
    state.txSignature = result.signature;
    state.txid = '';
    state.transactionStatus = 'Transaction signed by wallet. The signed transaction is shown below and was not broadcast.';
    pushToast('success', 'Transaction signed', 'Signed bytes returned.');
  });
}

async function runSignAndSendTransaction(): Promise<void> {
  await run('transaction', async () => {
    const signingClient = requireClient();
    if (!state.capabilities?.supports.signAndSendTransaction) {
      throw new Error('Selected wallet does not support sign and send.');
    }

    state.transactionStatus = 'Opening wallet approval to sign and send the devnet transaction...';
    const result: SigningResult = await signingClient.signAndSendTransaction(state.customTransactionBase64, {
      cluster: 'devnet',
      summary: 'Demo transaction broadcast',
    });
    state.txid = result.txid ?? result.signature;
    state.txSignature = '';
    state.transactionStatus = 'Transaction sent on devnet. The transaction id is shown below.';
    pushToast('success', 'Transaction sent', short(state.txid));
  });
}

async function runGenerateAgentPlan(): Promise<void> {
  await run('sign', async () => {
    if (!state.address) {
      throw new Error('Connect a wallet before generating an agent plan.');
    }
    state.agentPlan = {
      intent: state.agentPrompt.trim() || DEFAULT_AGENT_PROMPT,
      route: 'SOL to USDC through a future Jupiter quote',
      risk: 'Simulated plan only. No swap transaction is built or sent.',
      approval: 'Wallet signs an off-chain approval proof for this plan.',
    };
    state.agentSignature = '';
    pushToast('success', 'Agent plan generated', 'Simulated approval plan ready.');
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
      'Cluster: devnet',
      `Intent: ${state.agentPlan.intent}`,
      `Route: ${state.agentPlan.route}`,
      `Risk: ${state.agentPlan.risk}`,
      `Time: ${new Date().toISOString()}`,
    ].join('\n');
    const result = await signingClient.signMessage(message, {
      cluster: 'devnet',
      summary: 'Agent plan approval proof',
    });
    state.agentSignature = result.signature;
    pushToast('success', 'Agent approval signed', short(result.signature));
  });
}

async function run(stepName: keyof DemoState['steps'], action: () => Promise<void>): Promise<void> {
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

function walletOptions(): string {
  if (state.wallets.length === 0) {
    return '<option>No wallets discovered</option>';
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
      <span>${capabilities.cluster.join(', ')}</span>
      <span>message ${support.signMessage ? 'yes' : 'no'}</span>
      <span>transaction ${support.signTransaction ? 'yes' : 'no'}</span>
      <span>send ${support.signAndSendTransaction ? 'yes' : 'no'}</span>
    </div>
  `;
}

function step(name: keyof DemoState['steps'], title: string, detail: string): string {
  return `
    <li class="${state.steps[name]}">
      <span class="step-dot"></span>
      <div>
        <strong>${title}</strong>
        <p>${escapeHtml(detail)}</p>
      </div>
    </li>
  `;
}

function transactionStepDetail(): string {
  if (state.txSignature) return short(state.txSignature);
  if (state.customTransactionBase64) return `Ready to sign: ${short(state.customTransactionBase64)}`;
  return 'Create or paste a base64 transaction to test';
}

function resultBlock(): string {
  const rows = [
    state.address ? ['Address', state.address] : null,
    state.signature ? ['Message signature', state.signature] : null,
    state.customTransactionBase64 && !state.txSignature
      ? ['Generated transaction', state.customTransactionBase64]
      : null,
    state.txSignature ? ['Signed transaction', state.txSignature] : null,
    state.txid ? ['Devnet transaction id', state.txid] : null,
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
              <span>${label}</span>
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
    <article class="plan-card">
      <span class="risk-badge">simulated</span>
      <h3>${escapeHtml(plan.intent)}</h3>
      <dl>
        <div>
          <dt>Route</dt>
          <dd>${escapeHtml(plan.route)}</dd>
        </div>
        <div>
          <dt>Risk</dt>
          <dd>${escapeHtml(plan.risk)}</dd>
        </div>
        <div>
          <dt>Approval</dt>
          <dd>${escapeHtml(plan.approval)}</dd>
        </div>
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
  state.toasts = [toast, ...state.toasts].slice(0, 4);
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
