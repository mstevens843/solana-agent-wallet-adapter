import { SolanaSigningClient, type Cluster } from '@solana-agent-wallet-adapter/core';
import {
  listAvailableWallets,
  WalletStandardWebBackend,
  type DiscoveredWallet,
} from '@solana-agent-wallet-adapter/wallet-standard-web';

import './styles.css';

type DemoStage = 'idle' | 'wallets' | 'connected' | 'planned' | 'signed' | 'error';

interface AgentPlan {
  headline: string;
  steps: string[];
  risk: 'low' | 'medium' | 'high';
  summary: string;
}

interface PlanResponse {
  mode: 'llm' | 'fallback';
  warning?: string;
  plan: AgentPlan;
}

interface DemoState {
  stage: DemoStage;
  cluster: Cluster;
  wallets: DiscoveredWallet[];
  selectedWalletName: string;
  address: string;
  prompt: string;
  planMode: 'llm' | 'fallback';
  warning: string;
  plan: AgentPlan | null;
  signature: string;
  error: string;
  busy: boolean;
  raw: unknown;
}

const state: DemoState = {
  stage: 'idle',
  cluster: 'mainnet-beta',
  wallets: [],
  selectedWalletName: '',
  address: '',
  prompt:
    'Prove this agent can use my existing wallet without custody. Sign a devnet identity proof.',
  planMode: 'fallback',
  warning: '',
  plan: null,
  signature: '',
  error: '',
  busy: false,
  raw: null,
};

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('Missing app root.');
}
const appRoot = app;

render();

function render(): void {
  appRoot.innerHTML = `
    <main class="shell">
      <section class="workspace" aria-label="Solana agent wallet adapter demo">
        <div class="mast">
          <div>
            <p class="eyebrow">Real-wallet agent signing</p>
            <h1>Agent asks. Your wallet decides.</h1>
            <p class="lede">
              A live browser demo for Solana agents that sign through your installed wallet.
              No env-var private key, no embedded agent wallet, no custody.
            </p>
          </div>
          <div class="proof" aria-label="Differentiators">
            <span>Wallet Standard</span>
            <span>Phantom</span>
            <span>Solflare</span>
            <span>Backpack</span>
          </div>
        </div>

        <div class="flow">
          ${stepPanel()}
          ${walletPanel()}
          ${agentPanel()}
          ${resultPanel()}
        </div>
      </section>
    </main>
  `;
  bindEvents();
}

function stepPanel(): string {
  const steps = [
    ['1', 'Discover', 'Find installed Wallet Standard providers.'],
    ['2', 'Connect', 'Authorize the selected wallet account.'],
    ['3', 'Plan', 'Generate the agent request and summary.'],
    ['4', 'Approve', 'Sign in the real wallet popup.'],
  ];
  return `
    <aside class="panel rail">
      <div class="rail-visual" aria-hidden="true">
        <div class="node active"></div>
        <div class="line"></div>
        <div class="node ${state.address ? 'active' : ''}"></div>
        <div class="line"></div>
        <div class="node ${state.plan ? 'active' : ''}"></div>
        <div class="line"></div>
        <div class="node ${state.signature ? 'active' : ''}"></div>
      </div>
      <div class="rail-copy">
        ${steps
          .map(
            ([number, title, body]) => `
              <div class="rail-step">
                <span>${number}</span>
                <div>
                  <strong>${title}</strong>
                  <p>${body}</p>
                </div>
              </div>
            `,
          )
          .join('')}
      </div>
    </aside>
  `;
}

function walletPanel(): string {
  const options = state.wallets
    .map(
      (wallet) => `
        <option value="${escapeHtml(wallet.name)}" ${
          wallet.name === state.selectedWalletName ? 'selected' : ''
        }>${escapeHtml(wallet.name)}</option>
      `,
    )
    .join('');

  return `
    <section class="panel wallet-panel">
      <div class="panel-head">
        <div>
          <p class="label">Wallet</p>
          <h2>Select an installed wallet</h2>
        </div>
        <span class="status ${state.address ? 'good' : ''}">
          ${state.address ? 'connected' : state.wallets.length ? 'discovered' : 'waiting'}
        </span>
      </div>

      <div class="controls">
        <button id="discover" class="button primary" ${state.busy ? 'disabled' : ''}>
          Discover wallets
        </button>
        <select id="wallet" ${state.wallets.length === 0 ? 'disabled' : ''}>
          <option value="">Choose wallet</option>
          ${options}
        </select>
        <button id="connect" class="button" ${
          state.busy || !state.selectedWalletName ? 'disabled' : ''
        }>
          Connect
        </button>
      </div>

      <div class="wallet-grid">
        ${
          state.wallets.length
            ? state.wallets
                .map(
                  (wallet) => `
                    <button class="wallet-card ${
                      wallet.name === state.selectedWalletName ? 'selected' : ''
                    }" data-wallet="${escapeHtml(wallet.name)}">
                      <span class="wallet-icon">${walletIcon(wallet)}</span>
                      <span>
                        <strong>${escapeHtml(wallet.name)}</strong>
                        <small>${wallet.supportedChains.join(', ')}</small>
                      </span>
                    </button>
                  `,
                )
                .join('')
            : `<div class="empty">Open Phantom, Solflare, Backpack, or another Solana wallet extension, then discover wallets.</div>`
        }
      </div>

      ${
        state.address
          ? `<div class="address-row">
              <span>${escapeHtml(state.address)}</span>
              <button class="icon-button" data-copy="${escapeHtml(state.address)}" title="Copy address">Copy</button>
            </div>`
          : ''
      }
    </section>
  `;
}

function agentPanel(): string {
  const plan = state.plan;
  return `
    <section class="panel agent-panel">
      <div class="panel-head">
        <div>
          <p class="label">Agent request</p>
          <h2>Generate a signing plan</h2>
        </div>
        <span class="status ${plan ? 'good' : ''}">${plan ? state.planMode : 'ready'}</span>
      </div>

      <textarea id="prompt" ${state.busy ? 'disabled' : ''}>${escapeHtml(state.prompt)}</textarea>

      <div class="controls">
        <button id="plan" class="button primary" ${state.busy || !state.address ? 'disabled' : ''}>
          Generate plan
        </button>
        <button id="sign" class="button accent" ${
          state.busy || !state.address || !state.plan ? 'disabled' : ''
        }>
          Sign in wallet
        </button>
      </div>

      ${
        plan
          ? `<article class="plan-card risk-${plan.risk}">
              <div>
                <span class="risk">${plan.risk} risk</span>
                <h3>${escapeHtml(plan.headline)}</h3>
              </div>
              <ol>
                ${plan.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}
              </ol>
              <p class="summary">${escapeHtml(plan.summary)}</p>
            </article>`
          : `<div class="empty">Connect a wallet, then let the demo produce the exact message your wallet will approve.</div>`
      }

      ${state.warning ? `<p class="warning">${escapeHtml(state.warning)}</p>` : ''}
      ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ''}
    </section>
  `;
}

function resultPanel(): string {
  return `
    <section class="panel result-panel">
      <div class="panel-head">
        <div>
          <p class="label">Proof</p>
          <h2>Signature result</h2>
        </div>
        <span class="status ${state.signature ? 'good' : ''}">${
          state.signature ? 'signed' : 'pending'
        }</span>
      </div>

      <div class="signature-box">
        ${
          state.signature
            ? `<code>${escapeHtml(state.signature)}</code>
               <button class="button" data-copy="${escapeHtml(state.signature)}">Copy signature</button>`
            : `<span>No signature yet. The agent cannot sign until your wallet approves.</span>`
        }
      </div>

      <details ${state.raw ? 'open' : ''}>
        <summary>Raw demo state</summary>
        <pre>${escapeHtml(JSON.stringify(state.raw ?? {}, null, 2))}</pre>
      </details>
    </section>
  `;
}

function bindEvents(): void {
  document.querySelector('#discover')?.addEventListener('click', discoverWallets);
  document.querySelector('#connect')?.addEventListener('click', connectWallet);
  document.querySelector('#plan')?.addEventListener('click', generatePlan);
  document.querySelector('#sign')?.addEventListener('click', signMessage);
  document.querySelector('#wallet')?.addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement;
    state.selectedWalletName = target.value;
    state.address = '';
    state.plan = null;
    state.signature = '';
    state.error = '';
    render();
  });
  document.querySelector('#prompt')?.addEventListener('input', (event) => {
    state.prompt = (event.target as HTMLTextAreaElement).value;
  });
  document.querySelectorAll<HTMLButtonElement>('[data-wallet]').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedWalletName = button.dataset.wallet ?? '';
      state.address = '';
      state.plan = null;
      state.signature = '';
      state.error = '';
      render();
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      await navigator.clipboard.writeText(button.dataset.copy ?? '');
      button.textContent = 'Copied';
    });
  });
}

function discoverWallets(): void {
  runBusy(() => {
    state.wallets = [...listAvailableWallets()].filter((wallet) =>
      wallet.supportedChains.includes(`solana:${state.cluster}`),
    );
    state.selectedWalletName ||= preferredWalletName(state.wallets);
    state.stage = 'wallets';
    state.raw = { wallets: summarizeWallets(state.wallets) };
  });
}

async function connectWallet(): Promise<void> {
  await runBusy(async () => {
    const wallet = selectedWallet();
    if (!wallet) {
      throw new Error('Select a wallet first.');
    }
    const client = clientFor(wallet);
    state.address = await client.getAddress();
    state.stage = 'connected';
    state.plan = null;
    state.signature = '';
    state.raw = { wallet: wallet.name, address: state.address };
  });
}

async function generatePlan(): Promise<void> {
  await runBusy(async () => {
    const wallet = selectedWallet();
    if (!wallet || !state.address) {
      throw new Error('Connect a wallet first.');
    }
    const response = await fetch('/api/agent-plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: state.prompt,
        wallet: wallet.name,
        address: state.address,
        cluster: state.cluster,
      }),
    });
    if (!response.ok) {
      throw new Error(`Planner failed with HTTP ${response.status}.`);
    }
    const body = (await response.json()) as PlanResponse;
    state.plan = body.plan;
    state.planMode = body.mode;
    state.warning = body.warning ?? '';
    state.stage = 'planned';
    state.signature = '';
    state.raw = body;
  });
}

async function signMessage(): Promise<void> {
  await runBusy(async () => {
    const wallet = selectedWallet();
    if (!wallet || !state.plan) {
      throw new Error('Generate a plan before signing.');
    }
    const client = clientFor(wallet);
    const message = [
      'Solana Agent Wallet Adapter demo',
      `Wallet: ${wallet.name}`,
      `Address: ${state.address}`,
      `Cluster: ${state.cluster}`,
      `Summary: ${state.plan.summary}`,
      `Time: ${new Date().toISOString()}`,
    ].join('\n');
    const result = await client.signMessage(message, {
      cluster: state.cluster,
      summary: state.plan.summary,
    });
    state.signature = result.signature;
    state.stage = 'signed';
    state.raw = { message, result };
  });
}

async function runBusy(action: () => void | Promise<void>): Promise<void> {
  state.busy = true;
  state.error = '';
  render();
  try {
    await action();
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Unknown demo error.';
    state.stage = 'error';
  } finally {
    state.busy = false;
    render();
  }
}

function selectedWallet(): DiscoveredWallet | null {
  return state.wallets.find((wallet) => wallet.name === state.selectedWalletName) ?? null;
}

function clientFor(wallet: DiscoveredWallet): SolanaSigningClient {
  const backend = new WalletStandardWebBackend({ wallet, cluster: state.cluster });
  return new SolanaSigningClient({ backend });
}

function preferredWalletName(wallets: DiscoveredWallet[]): string {
  const preferred = ['Phantom', 'Solflare', 'Backpack'];
  return preferred.find((name) => wallets.some((wallet) => wallet.name === name)) ?? wallets[0]?.name ?? '';
}

function summarizeWallets(wallets: DiscoveredWallet[]) {
  return wallets.map((wallet) => ({
    name: wallet.name,
    chains: wallet.supportedChains,
    features: wallet.features,
  }));
}

function walletIcon(wallet: DiscoveredWallet): string {
  if (wallet.icon?.startsWith('data:image')) {
    return `<img src="${escapeHtml(wallet.icon)}" alt="" />`;
  }
  return escapeHtml(wallet.name.slice(0, 1).toUpperCase());
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return char;
    }
  });
}
