import type { GlobalOptions } from '../shared/types.js';
import { renderWebRequest, bridgeRequest } from '../http/index.js';
import { select, input, confirm, header, kv, badge, divider, spinner } from '../tui/index.js';
import { readJsonFile } from '../shared/util.js';

type RootAction = 'profile' | 'pay' | 'incoming' | 'back';

interface InboundRequest {
  id?: string;
  approvalId?: string;
  status?: string;
  amount?: string;
  token?: string;
  recipient?: string;
  description?: string;
  requestedAt?: string;
  cluster?: string;
}

// `/agent-payments` — bundles the cards under the web's "More → Agent Payments"
// page. Three sub-flows: Profile (A2A discovery card, read-only), Pay Merchant
// (sign an ACP cart), Incoming Requests (approve / reject MPP inbound items).
export async function runAgentPaymentsMenu(options: GlobalOptions): Promise<void> {
  while (true) {
    console.log();
    console.log(header('Agent Payments'));
    console.log(badge('Profile · Pay Merchant · Incoming Requests', 'muted'));

    const choice = await select<RootAction>({
      message: 'What next?',
      choices: [
        { name: 'Profile (your agent payment card)', value: 'profile',  description: 'How merchants discover this wallet' },
        { name: 'Pay Merchant (sign an ACP cart)',   value: 'pay',      description: 'Review and sign a payment cart JSON' },
        { name: 'Incoming Requests',                 value: 'incoming', description: 'Inbound MPP payment proposals waiting for you' },
        { name: '← Back to main menu',               value: 'back' },
      ],
    });
    if (choice === 'back') return;
    if (choice === 'profile')  { await showProfile(options); continue; }
    if (choice === 'pay')      { await payMerchant(options); continue; }
    if (choice === 'incoming') { await incomingRequests(options); continue; }
  }
}

async function showProfile(options: GlobalOptions): Promise<void> {
  console.log();
  console.log(header('Agent payment profile'));
  const spin = spinner('Loading profile…');
  try {
    const raw = await renderWebRequest<unknown>(options, '/api/preferences/agent-payment-profile', undefined, {
      label: 'Render-web profile',
      requireAuth: true,
    });
    spin.succeed('Loaded.');
    const profile = extractPayload(raw);
    if (!profile || Object.keys(profile).length === 0) {
      console.log(badge('No agent payment profile published yet.', 'muted'));
      console.log(badge('Run "solana-agent-wallet profile publish <agent-card.json>" to publish one.', 'muted'));
      return;
    }
    renderProfile(profile);
  } catch (err) {
    spin.fail(`Could not load: ${err instanceof Error ? err.message : String(err)}`);
    console.log(badge('Tip: run /sign-in first.', 'muted'));
  }
}

async function payMerchant(options: GlobalOptions): Promise<void> {
  console.log();
  console.log(header('Pay merchant - sign an ACP cart'));
  const filePath = await input({
    message: 'Path to cart JSON',
    default: './cart.json',
  });
  let cart: unknown;
  try {
    cart = await readJsonFile(filePath.trim(), 'cart');
  } catch (err) {
    console.log(badge(`Could not read cart: ${err instanceof Error ? err.message : String(err)}`, 'err'));
    return;
  }
  renderCart(cart);

  const proceed = await confirm({ message: 'Sign and submit this cart?', default: false });
  if (!proceed) return;

  const spin = spinner('Submitting payment…');
  try {
    const result = await bridgeRequest(options, '/bridge/acp/approve', {
      method: 'POST',
      body: JSON.stringify({ cart }),
    });
    spin.succeed('Cart approved.');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    spin.fail(`Payment failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function incomingRequests(options: GlobalOptions): Promise<void> {
  console.log();
  console.log(header('Incoming payment requests'));
  const list = await loadInbound(options);
  if (list.length === 0) {
    console.log(badge('No inbound requests.', 'muted'));
    return;
  }
  const choice = await select<string>({
    message: 'Pick a request',
    pageSize: Math.min(20, list.length + 1),
    choices: [
      ...list.map((r, i) => ({ name: rowLabel(i + 1, r), value: r.id ?? r.approvalId ?? String(i) })),
      { name: '← Back', value: '__back__' },
    ],
  });
  if (choice === '__back__') return;
  const picked = list.find((r) => (r.id ?? r.approvalId) === choice);
  if (!picked) return;

  console.log();
  console.log(header(`Request ${picked.id ?? picked.approvalId}`));
  const rows: Array<[string, string]> = [];
  if (picked.amount) rows.push(['Amount', `${picked.amount}${picked.token ? ` ${picked.token}` : ''}`]);
  if (picked.recipient) rows.push(['Recipient', picked.recipient]);
  if (picked.description) rows.push(['Description', picked.description]);
  if (picked.requestedAt) rows.push(['Requested', picked.requestedAt]);
  if (picked.cluster) rows.push(['Network', picked.cluster]);
  if (picked.status) rows.push(['Status', picked.status]);
  console.log(kv(rows));
  console.log(divider());

  const action = await select<'pay' | 'reject' | 'back'>({
    message: 'What next?',
    choices: [
      { name: 'Pay (approve)', value: 'pay' },
      { name: 'Reject',        value: 'reject' },
      { name: '← Back',        value: 'back' },
    ],
  });
  if (action === 'back') return;
  const approvalId = picked.approvalId ?? picked.id;
  if (!approvalId) {
    console.log(badge('Request is missing an approval id; cannot act.', 'err'));
    return;
  }
  const spin = spinner(`${action === 'pay' ? 'Approving' : 'Rejecting'}…`);
  try {
    const path = action === 'pay' ? '/bridge/mpp/pay' : '/bridge/mpp/reject';
    await bridgeRequest(options, path, {
      method: 'POST',
      body: JSON.stringify({ approvalId }),
    });
    spin.succeed(action === 'pay' ? 'Payment sent.' : 'Request rejected.');
  } catch (err) {
    spin.fail(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function loadInbound(options: GlobalOptions): Promise<InboundRequest[]> {
  try {
    const raw = await renderWebRequest<unknown>(options, '/api/mpp/inbound', undefined, {
      label: 'Render-web MPP',
      requireAuth: true,
    });
    if (Array.isArray(raw)) return raw as InboundRequest[];
    if (raw && typeof raw === 'object') {
      const items = (raw as { requests?: unknown }).requests ?? (raw as { items?: unknown }).items;
      if (Array.isArray(items)) return items as InboundRequest[];
    }
    return [];
  } catch (err) {
    console.log(badge(`Could not load inbound: ${err instanceof Error ? err.message : String(err)}`, 'err'));
    return [];
  }
}

function rowLabel(n: number, r: InboundRequest): string {
  const row = String(n).padStart(2, ' ');
  const status = r.status?.toLowerCase() ?? 'pending';
  const statusChip = status === 'pending' ? badge(status, 'warn') : badge(status, 'muted');
  const amount = r.amount ? `${r.amount}${r.token ? ` ${r.token}` : ''}` : '';
  const desc = r.description ? ` · ${r.description.slice(0, 40)}` : '';
  return `${row}.  ${statusChip}  ${amount}${desc}`;
}

function extractPayload(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') {
    const payload = (raw as { payload?: unknown }).payload;
    if (payload && typeof payload === 'object') return payload as Record<string, unknown>;
    return raw as Record<string, unknown>;
  }
  return {};
}

function renderProfile(profile: Record<string, unknown>): void {
  const rows: Array<[string, string]> = [];
  for (const key of Object.keys(profile)) {
    const value = profile[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      rows.push([key, JSON.stringify(value)]);
    } else {
      rows.push([key, String(value)]);
    }
  }
  console.log(kv(rows));
  console.log(divider());
}

function renderCart(cart: unknown): void {
  console.log();
  console.log(header('Cart preview'));
  if (cart && typeof cart === 'object') {
    const obj = cart as Record<string, unknown>;
    const rows: Array<[string, string]> = [];
    for (const k of ['cartId', 'merchant', 'total', 'currency', 'expiresAt', 'description']) {
      if (typeof obj[k] === 'string' || typeof obj[k] === 'number') rows.push([k, String(obj[k])]);
    }
    if (rows.length > 0) console.log(kv(rows));
    const lineItems = obj.lineItems ?? obj.items;
    if (Array.isArray(lineItems) && lineItems.length > 0) {
      console.log('\n' + badge('Line items', 'info'));
      lineItems.forEach((li, i) => {
        if (li && typeof li === 'object') {
          const item = li as Record<string, unknown>;
          console.log(`  ${i + 1}. ${item['name'] ?? '?'}  ×${item['quantity'] ?? 1}  ${item['amount'] ?? ''} ${item['currency'] ?? ''}`);
        }
      });
    }
  }
  console.log(divider());
}
