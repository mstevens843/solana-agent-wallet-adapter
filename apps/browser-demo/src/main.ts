import { SolanaSigningClient, type AdapterCapabilities, type SigningResult } from '@solana-agent-wallet-adapter/core';
import {
  listAvailableWallets,
  WalletStandardWebBackend,
  type DiscoveredWallet,
} from '@solana-agent-wallet-adapter/wallet-standard-web';

import './styles.css';

type StepState = 'idle' | 'active' | 'done' | 'error';

const DEMO_MESSAGE = 'Approve this Solana agent action on devnet.';

interface DemoState {
  wallets: DiscoveredWallet[];
  selectedWalletName: string;
  address: string;
  signature: string;
  txSignature: string;
  customTransactionBase64: string;
  capabilities: AdapterCapabilities | null;
  error: string;
  busy: boolean;
  steps: Record<'discover' | 'connect' | 'sign' | 'transaction', StepState>;
}

const state: DemoState = {
  wallets: [],
  selectedWalletName: '',
  address: '',
  signature: '',
  txSignature: '',
  customTransactionBase64: '',
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

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('Missing #app');
}
const appRoot = app;

render();

function render(): void {
  appRoot.innerHTML = `
    <section class="shell">
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
          <div class="panel-header">
            <div>
              <h2>Approval Flow</h2>
              <p>Each signing call opens the selected wallet approval UI.</p>
            </div>
            <span class="cluster">devnet</span>
          </div>

          <ol class="timeline">
            ${step('discover', 'Discover Wallet Standard providers', state.wallets.length ? `${state.wallets.length} wallet(s) found` : 'No providers loaded yet')}
            ${step('connect', 'Connect selected wallet', state.address ? short(state.address) : 'Authorize account access')}
            ${step('sign', 'Sign agent message', state.signature ? short(state.signature) : DEMO_MESSAGE)}
            ${step('transaction', 'Optional transaction signing', state.txSignature ? short(state.txSignature) : 'Paste a base64 transaction to test')}
          </ol>

          <div class="action-grid">
            <button id="signMessage" class="primary" ${!state.address || state.busy ? 'disabled' : ''}>Sign message</button>
            <label class="field compact">
              <span>Transaction base64</span>
              <textarea id="txInput" placeholder="Paste a devnet transaction, base64 encoded" ${state.busy ? 'disabled' : ''}>${escapeHtml(state.customTransactionBase64)}</textarea>
            </label>
            <button id="signTx" ${!state.address || !state.customTransactionBase64 || state.busy ? 'disabled' : ''}>Sign transaction</button>
          </div>

          ${resultBlock()}
          ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
        </section>
      </section>
    </section>
  `;

  bind();
}

function bind(): void {
  document.querySelector<HTMLButtonElement>('#discover')?.addEventListener('click', runDiscover);
  document.querySelector<HTMLButtonElement>('#connect')?.addEventListener('click', runConnect);
  document.querySelector<HTMLButtonElement>('#signMessage')?.addEventListener('click', runSignMessage);
  document.querySelector<HTMLButtonElement>('#signTx')?.addEventListener('click', runSignTransaction);
  document.querySelector<HTMLSelectElement>('#walletSelect')?.addEventListener('change', (event) => {
    state.selectedWalletName = (event.currentTarget as HTMLSelectElement).value;
    client = null;
    state.address = '';
    state.signature = '';
    state.txSignature = '';
    state.capabilities = null;
    state.steps.connect = 'idle';
    state.steps.sign = 'idle';
    state.steps.transaction = 'idle';
    render();
  });
  document.querySelector<HTMLTextAreaElement>('#txInput')?.addEventListener('input', (event) => {
    state.customTransactionBase64 = (event.currentTarget as HTMLTextAreaElement).value.trim();
    render();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
    button.addEventListener('click', async () => {
      await navigator.clipboard.writeText(button.dataset.copy ?? '');
      button.textContent = 'Copied';
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
  });
}

async function runConnect(): Promise<void> {
  await run('connect', async () => {
    const selected = selectedWallet();
    const backend = new WalletStandardWebBackend({ wallet: selected, cluster: 'devnet' });
    client = new SolanaSigningClient({ backend });
    state.address = await client.getAddress();
    state.capabilities = await client.capabilities();
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
  });
}

async function runSignTransaction(): Promise<void> {
  await run('transaction', async () => {
    const signingClient = requireClient();
    const result: SigningResult = await signingClient.signTransaction(state.customTransactionBase64, {
      cluster: 'devnet',
      summary: 'Investor demo transaction signature',
    });
    state.txSignature = result.signature;
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

function resultBlock(): string {
  const rows = [
    state.address ? ['Address', state.address] : null,
    state.signature ? ['Message signature', state.signature] : null,
    state.txSignature ? ['Transaction signature', state.txSignature] : null,
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
