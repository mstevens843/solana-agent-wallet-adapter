import './sessions.css';

import { isDevWallet } from '../devGate.js';
import { registerDevTab } from '../devTabRegistry.js';
import { getConnectedAddress } from '../walletState.js';

// Phase 0 scaffolding — Phase 2C replaces this placeholder with the full
// Sessions tab (active sessions list + detail pane + create modal + revoke).
// Registration here ensures the tab appears in the More menu so Phase 2C can
// land changes without touching tab wiring.

function renderPlaceholder(): string {
  return `
    <div class="dev-tab-shell">
      <header class="dev-tab-header">
        <h2>Sessions</h2>
        <p>Non-custodial streaming payments for AI agents. SPL Token delegate sessions with off-chain voucher signing and on-demand settlement.</p>
      </header>
      <section class="sessions-placeholder">
        <p><strong>Coming soon (Phase 2).</strong></p>
        <p>This tab will let you grant a bounded spend cap to an agent for a fixed time window, monitor live spend in real time, and revoke at any time.</p>
      </section>
    </div>
  `;
}

registerDevTab({
  id: 'sessions',
  label: 'Sessions',
  mobileLabel: 'Sessions',
  guard: () => isDevWallet(getConnectedAddress()),
  render: renderPlaceholder,
});

export const __sessionsTabForTests = {
  renderPlaceholder,
};
