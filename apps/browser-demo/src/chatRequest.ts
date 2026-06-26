import type { AgentChatRequest } from './planner.js';
import type { WalletBalanceSnapshot } from './walletBalanceSummary.js';

export interface ChatRequestMessageLike {
  role: string;
  content: string;
}

export interface ChatRequestSessionLike {
  messages: ChatRequestMessageLike[];
}

export interface ChatRequestWalletState {
  address?: string;
  cluster: string;
  uiLanguage: string;
  walletBalance?: WalletBalanceSnapshot | null;
  walletBalanceError?: string;
  // Reasoning depth carried into the request context so the SERVER paths (Hosted BYOK
  // + Local Bridge) can apply it (client paths read it from the profile directly).
  reasoningEffort?: string;
  // Compact connector capability index (+ selected card) so the chat agent knows the
  // DeFi connector surface without a discovery round-trip. Built via buildConnectorContext
  // (workflow). Flows to every path's system prompt via chatReadOnlyWalletContext.
  connectorContext?: Record<string, unknown>;
}

export interface ChatBrowserWalletContext {
  connected: boolean;
  source: 'browser_wallet';
  cluster: string;
  address?: string;
}

function normalizeAddress(address: string | undefined): string {
  return typeof address === 'string' ? address.trim() : '';
}

function walletBalanceMatches(
  snapshot: WalletBalanceSnapshot | null | undefined,
  address: string,
  cluster: string,
): snapshot is WalletBalanceSnapshot {
  return Boolean(
    snapshot &&
    address &&
    snapshot.walletAddress.trim() === address &&
    snapshot.cluster === cluster,
  );
}

// Round a USD value to 6 dp so float noise (0.1*3 = 0.30000000000000004) doesn't leak
// into the model context (H8-F). Token AMOUNTS keep full precision (they need it).
function roundUsd(v: number | undefined): number | undefined {
  return v === undefined ? undefined : Math.round(v * 1e6) / 1e6;
}

function chatWalletBalanceContext(snapshot: WalletBalanceSnapshot): Record<string, unknown> {
  // Top holdings by USD value (incl. SOL/USDC) so the agent can answer
  // "what's my biggest holding / portfolio" from the user's live wallet.
  const holdings = [snapshot.sol, snapshot.usdc, ...snapshot.others]
    .filter((asset) => asset.amount > 0)
    .sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0))
    .slice(0, 15)
    .map((asset) => ({
      symbol: asset.symbol,
      mint: asset.mint,
      amount: asset.amount,
      ...(asset.priceUsd !== undefined ? { priceUsd: roundUsd(asset.priceUsd) } : {}),
      ...(asset.valueUsd !== undefined ? { valueUsd: roundUsd(asset.valueUsd) } : {}),
    }));
  return {
    walletAddress: snapshot.walletAddress,
    cluster: snapshot.cluster,
    loadedAt: snapshot.loadedAt,
    coverage: snapshot.coverage,
    priceStatus: snapshot.priceStatus,
    totalUsd: roundUsd(snapshot.totalUsd),
    hasMissingPrices: snapshot.hasMissingPrices,
    holdings,
    sol: {
      amount: snapshot.sol.amount,
      ...(snapshot.sol.priceUsd !== undefined ? { priceUsd: roundUsd(snapshot.sol.priceUsd) } : {}),
      ...(snapshot.sol.valueUsd !== undefined ? { valueUsd: roundUsd(snapshot.sol.valueUsd) } : {}),
    },
    usdc: {
      amount: snapshot.usdc.amount,
      ...(snapshot.usdc.priceUsd !== undefined ? { priceUsd: roundUsd(snapshot.usdc.priceUsd) } : {}),
      ...(snapshot.usdc.valueUsd !== undefined ? { valueUsd: roundUsd(snapshot.usdc.valueUsd) } : {}),
    },
    otherAssetCount: snapshot.others.length,
  };
}

export function buildChatRequestContext(input: ChatRequestWalletState): Record<string, unknown> {
  const address = normalizeAddress(input.address);
  const browserWallet: ChatBrowserWalletContext = address
    ? { connected: true, source: 'browser_wallet', address, cluster: input.cluster }
    : { connected: false, source: 'browser_wallet', cluster: input.cluster };
  const balanceError = input.walletBalanceError?.trim();

  return {
    connectedWallet: Boolean(address),
    ...(address ? { walletAddress: address } : {}),
    browserWallet,
    cluster: input.cluster,
    uiLanguage: input.uiLanguage,
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.connectorContext && Object.keys(input.connectorContext).length > 0
      ? { connectorContext: input.connectorContext }
      : {}),
    ...(walletBalanceMatches(input.walletBalance, address, input.cluster)
      ? { walletBalance: chatWalletBalanceContext(input.walletBalance) }
      : {}),
    ...(balanceError
      ? { walletBalanceStatus: { status: 'unavailable', error: balanceError.slice(0, 240) } }
      : {}),
  };
}

export function buildAgentChatRequest(
  session: ChatRequestSessionLike,
  walletState: ChatRequestWalletState,
): AgentChatRequest {
  const messages = session.messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  return {
    messages,
    cluster: walletState.cluster,
    context: buildChatRequestContext(walletState),
  };
}

export function chatMentionsWalletBalance(session: ChatRequestSessionLike): boolean {
  const lastUser = [...session.messages].reverse()
    .find((message) => message.role === 'user' && message.content.trim());
  const text = lastUser?.content.toLowerCase() ?? '';
  if (!text) return false;
  return /\b(balance|balances|portfolio|holdings?|worth|value)\b/.test(text) &&
    /\b(my|wallet|current|sol|usdc|token|tokens|portfolio)\b/.test(text);
}

// True when the text asks about the user's OWN wallet — balances/holdings (via
// chatMentionsWalletBalance) OR address/account/activity/history/positions/NFTs. Used to
// short-circuit with a "connect a wallet first" reply when no wallet is connected, instead
// of streaming to the agent with empty wallet context. Stays conservative: a general
// question (price of SOL, what is a token) does not match.
export function chatMentionsOwnWallet(text: string): boolean {
  if (chatMentionsWalletBalance({ messages: [{ role: 'user', content: text }] })) return true;
  const lower = text.toLowerCase();
  return /\b(my|wallet)\b/.test(lower) &&
    /\b(address|account|history|activity|transactions?|positions?|holdings?|nfts?)\b/.test(lower);
}
