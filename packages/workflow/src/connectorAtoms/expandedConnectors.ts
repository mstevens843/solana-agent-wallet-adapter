import type { ConnectorActionAtom, ConnectorFactArgs } from './types.js';
import { asArray, compact, num, obj, shortMint, str } from './util.js';

const walletInput = (a: ConnectorFactArgs) => compact({
  ...(a.walletAddress ? { walletAddress: a.walletAddress } : {}),
});

const tokenScopedInput = (a: ConnectorFactArgs) => compact({
  ...(a.walletAddress ? { walletAddress: a.walletAddress } : {}),
  ...(a.token ?? a.query ?? a.mint ? { token: a.token ?? a.query ?? a.mint } : {}),
  ...(a.bankAddress ? { bankAddress: a.bankAddress } : {}),
  ...(a.bankMint ? { bankMint: a.bankMint } : {}),
});

const marginfiAccountInput = (a: ConnectorFactArgs) => compact({
  ...walletInput(a),
  ...(a.marginfiAccount ? { marginfiAccount: a.marginfiAccount } : {}),
});

const project0AccountInput = (a: ConnectorFactArgs) => compact({
  ...walletInput(a),
  ...(a.project0Account ? { project0Account: a.project0Account } : {}),
});

const magicedenMarketplaceInput = (a: ConnectorFactArgs) => compact({
  ...(a.collectionId ? { collectionId: a.collectionId } : {}),
  ...(a.collectionSymbol ?? a.query ? { collectionSymbol: a.collectionSymbol ?? a.query } : {}),
  ...(a.includeListings !== undefined ? { includeListings: a.includeListings } : { includeListings: true }),
  ...(a.includeBids !== undefined ? { includeBids: a.includeBids } : { includeBids: true }),
  ...(a.limit !== undefined ? { limit: a.limit } : {}),
});

const tensorMarketplaceInput = (a: ConnectorFactArgs) => compact({
  ...(a.collectionId ?? a.query ? { collectionId: a.collectionId ?? a.query } : {}),
  ...(a.includeListings !== undefined ? { includeListings: a.includeListings } : { includeListings: true }),
  ...(a.includeBids !== undefined ? { includeBids: a.includeBids } : { includeBids: true }),
  ...(a.limit !== undefined ? { limit: a.limit } : {}),
});

const nftWalletInput = (a: ConnectorFactArgs) => compact({
  ...walletInput(a),
  ...(a.collectionId ? { collectionId: a.collectionId } : {}),
  ...(a.collectionSymbol ?? a.query ? { collectionSymbol: a.collectionSymbol ?? a.query } : {}),
  ...(a.mintAddress ?? a.mint ? { mintAddress: a.mintAddress ?? a.mint } : {}),
  ...(a.assetId ? { assetId: a.assetId } : {}),
  ...(a.listedOnly !== undefined ? { listedOnly: a.listedOnly } : {}),
  ...(a.includeListings !== undefined ? { includeListings: a.includeListings } : { includeListings: true }),
  ...(a.includeBids !== undefined ? { includeBids: a.includeBids } : { includeBids: true }),
});

const sanctumMarketInput = (a: ConnectorFactArgs) => compact({
  ...(a.lstMint ?? a.mint ? { lstMint: a.lstMint ?? a.mint } : {}),
  ...(a.token ?? a.query ? { token: a.token ?? a.query } : {}),
});

const sanctumSwapInput = (a: ConnectorFactArgs) => compact({
  ...(a.inputMint ?? a.inputToken ? { inputMint: a.inputMint ?? a.inputToken } : {}),
  ...(a.outputMint ?? a.outputToken ?? a.lstMint ? { outputMint: a.outputMint ?? a.outputToken ?? a.lstMint } : {}),
  ...(a.amount ? { amount: a.amount } : {}),
});

const realmsInput = (a: ConnectorFactArgs) => compact({
  ...walletInput(a),
  ...(a.realmAddress ? { realmAddress: a.realmAddress } : {}),
  ...(a.governanceAddress ? { governanceAddress: a.governanceAddress } : {}),
  ...(a.proposalAddress ? { proposalAddress: a.proposalAddress } : {}),
});

const squadsInput = (a: ConnectorFactArgs) => compact({
  ...walletInput(a),
  ...(a.multisigAddress ? { multisigAddress: a.multisigAddress } : {}),
  ...(a.proposalAddress ? { proposalAddress: a.proposalAddress } : {}),
  ...(a.vaultIndex !== undefined ? { vaultIndex: a.vaultIndex } : {}),
  ...(a.transactionIndex !== undefined ? { transactionIndex: a.transactionIndex } : {}),
});

const phoenixInput = (a: ConnectorFactArgs) => compact({
  ...walletInput(a),
  ...(a.token ?? a.query ?? a.inputToken ?? a.mint ? { token: a.token ?? a.query ?? a.inputToken ?? a.mint } : {}),
  ...(a.subAccountId !== undefined ? { subAccountId: a.subAccountId } : {}),
});

function compactFactRows(raw: Record<string, unknown>): Array<Record<string, unknown>> {
  return asArray(raw.facts).slice(0, 8).map((fact) => compact({
    label: str(fact.label),
    value: str(fact.value),
    tone: str(fact.tone),
  }));
}

export function formatConnectorFactRows(raw: Record<string, unknown>, kind: string, emptyNote: string): Record<string, unknown> {
  const facts = compactFactRows(raw);
  if (!facts.length) {
    return compact({
      kind,
      count: 0,
      capability: str(raw.capability),
      source: str(raw.source),
      note: emptyNote,
    });
  }
  return compact({
    kind,
    count: facts.length,
    capability: str(raw.capability),
    source: str(raw.source),
    facts,
  });
}

export function formatLendingFacts(raw: Record<string, unknown>, connectorId: string): Record<string, unknown> {
  return formatConnectorFactRows(raw, `${connectorId}_lending`, `No ${connectorId} lending facts returned.`);
}

export function formatNftMarketplaceFacts(raw: Record<string, unknown>, connectorId: string): Record<string, unknown> {
  return formatConnectorFactRows(raw, `${connectorId}_nft_marketplace`, `No ${connectorId} marketplace facts returned.`);
}

export function formatSanctumFacts(raw: Record<string, unknown>): Record<string, unknown> {
  return formatConnectorFactRows(raw, 'sanctum_lst', 'No Sanctum LST facts returned.');
}

export function formatGovernanceFacts(raw: Record<string, unknown>, connectorId: string): Record<string, unknown> {
  return formatConnectorFactRows(raw, `${connectorId}_governance`, `No ${connectorId} governance facts returned.`);
}

export function formatPhoenixPerps(raw: Record<string, unknown>): Record<string, unknown> {
  const facts = compactFactRows(raw);
  if (facts.length) return { kind: 'phoenix_perps', count: facts.length, facts };
  const snapshot = obj(raw.snapshot) ?? raw;
  const catalog = obj(raw.catalog);
  const markets = asArray(catalog?.markets ?? raw.catalog);
  if (markets.length) {
    return compact({
      kind: 'phoenix_perps_markets',
      count: markets.length,
      markets: markets.slice(0, 8).map((m) => compact({
        symbol: str(m.symbol),
        markPriceUsd: str(m.markPriceUsd),
        fundingRateHourly: str(m.fundingRateHourly),
        openInterestUsd: str(m.openInterestUsd),
        maxLeverage: num(m.maxLeverage),
      })),
    });
  }
  const positions = asArray(snapshot.positions);
  const openOrders = asArray(snapshot.openOrders);
  const triggers = asArray(snapshot.triggers);
  if (positions.length || openOrders.length || triggers.length) {
    return compact({
      kind: 'phoenix_perps_positions',
      count: positions.length,
      freeCollateralUsd: str(snapshot.freeCollateralUsd),
      totalCollateralUsd: str(snapshot.totalCollateralUsd),
      openOrders: openOrders.length || undefined,
      triggers: triggers.length || undefined,
      positions: positions.slice(0, 6).map((p) => compact({
        symbol: str(p.symbol),
        side: str(p.side),
        size: str(p.baseSize),
        entry: str(p.entryPriceUsd),
        mark: str(p.markPriceUsd),
        pnl: str(p.unrealizedPnlUsd),
        liquidation: str(p.liquidationPriceUsd),
        health: num(p.healthPercent),
      })),
    });
  }
  return compact({
    kind: 'phoenix_perps',
    symbol: str(snapshot.symbol),
    markPriceUsd: str(snapshot.markPriceUsd),
    indexPriceUsd: str(snapshot.indexPriceUsd),
    fundingRateHourly: str(snapshot.fundingRateHourly),
    openInterestUsd: str(snapshot.openInterestUsd),
    maxLeverage: num(snapshot.maxLeverage),
    note: str(snapshot.symbol) ? undefined : 'No Phoenix perps positions or market facts returned.',
  });
}

export const EXPANDED_CONNECTOR_ATOMS: ConnectorActionAtom[] = [
  {
    connectorId: 'marginfi',
    action: 'markets',
    aliases: ['market', 'markets', 'bank', 'banks', 'rates', 'apy', 'apr', 'utilization'],
    knowledge: {
      title: 'MarginFi Markets',
      summary: 'Read MarginFi bank/rate facts: deposit APY, borrow APR, utilization, and remaining capacity.',
      capabilities: ['read bank APY/APR/utilization and capacity', 'scope by token, bank mint, or bank address'],
      requiredParams: ['optional token / bankMint / bankAddress'],
      constraints: ['Mainnet-only; writes remain prepare-only through Protocol Connectors'],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_marginfi_bank_snapshot',
      capability: 'markets',
      buildInput: tokenScopedInput,
      format: (raw) => formatLendingFacts(raw, 'marginfi'),
    },
  },
  {
    connectorId: 'marginfi',
    action: 'lend',
    aliases: ['lend', 'lending', 'earn', 'supply', 'deposit', 'withdraw', 'position', 'positions', 'account', 'accounts', 'balance'],
    knowledge: {
      title: 'MarginFi Lending',
      summary: 'Read MarginFi wallet accounts and supplied balances, including account health and active positions.',
      capabilities: ['read wallet MarginFi accounts', 'summarize supplied balances and account health'],
      requiredParams: ['walletAddress for wallet positions; optional marginfiAccount for one account'],
      constraints: ['Health-impact previews for deposits/withdrawals need an explicit amount and are handled by approval prep'],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_marginfi_wallet_accounts',
      capability: 'positions',
      buildInput: marginfiAccountInput,
      format: (raw) => formatLendingFacts(raw, 'marginfi'),
    },
  },
  {
    connectorId: 'marginfi',
    action: 'borrow',
    aliases: ['borrow', 'borrowing', 'debt', 'loan', 'loans', 'repay', 'health', 'liquidation', 'position', 'positions'],
    knowledge: {
      title: 'MarginFi Borrow',
      summary: 'Read MarginFi borrow/debt exposure from wallet accounts with account health and active balances.',
      capabilities: ['read borrowed balances and account health', 'identify debt-bearing MarginFi positions'],
      requiredParams: ['walletAddress for wallet positions; optional marginfiAccount for one account'],
      constraints: ['Borrow/repay health previews need explicit amount/token and remain prepare-only'],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_marginfi_wallet_accounts',
      capability: 'positions',
      buildInput: marginfiAccountInput,
      format: (raw) => formatLendingFacts(raw, 'marginfi'),
    },
  },
  {
    connectorId: 'project0',
    action: 'markets',
    aliases: ['market', 'markets', 'bank', 'banks', 'rates', 'apy', 'apr', 'utilization'],
    knowledge: {
      title: 'Project 0 Markets',
      summary: 'Read Project 0 bank/rate facts across venues, including deposit APY and borrow APY.',
      capabilities: ['read banks and rates', 'scope by token, bank mint, or bank address'],
      requiredParams: ['optional token / bankMint / bankAddress'],
      constraints: ['Mainnet-only; writes remain prepare-only through Protocol Connectors'],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_project0_banks',
      capability: 'markets',
      buildInput: tokenScopedInput,
      format: (raw) => formatLendingFacts(raw, 'project0'),
    },
  },
  {
    connectorId: 'project0',
    action: 'lend',
    aliases: ['lend', 'lending', 'earn', 'supply', 'deposit', 'withdraw', 'position', 'positions', 'account', 'accounts', 'balance'],
    knowledge: {
      title: 'Project 0 Lending',
      summary: 'Read Project 0 wallet/account positions and supplied balances with health context.',
      capabilities: ['read wallet holdings and Project 0 account positions', 'summarize supplied balances and health'],
      requiredParams: ['walletAddress for wallet positions; optional project0Account for one account'],
      constraints: ['Health-impact previews for deposits/withdrawals need an explicit amount and are handled by approval prep'],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_project0_wallet',
      capability: 'positions',
      buildInput: project0AccountInput,
      format: (raw) => formatLendingFacts(raw, 'project0'),
    },
  },
  {
    connectorId: 'project0',
    action: 'borrow',
    aliases: ['borrow', 'borrowing', 'debt', 'loan', 'loans', 'repay', 'health', 'liquidation', 'position', 'positions'],
    knowledge: {
      title: 'Project 0 Borrow',
      summary: 'Read Project 0 borrow/debt exposure from wallet/account positions with health context.',
      capabilities: ['read borrowed balances and account health', 'identify debt-bearing Project 0 positions'],
      requiredParams: ['walletAddress for wallet positions; optional project0Account for one account'],
      constraints: ['Borrow/repay health previews need explicit amount/token and remain prepare-only'],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_project0_wallet',
      capability: 'positions',
      buildInput: project0AccountInput,
      format: (raw) => formatLendingFacts(raw, 'project0'),
    },
  },
  {
    connectorId: 'project0',
    action: 'strategies',
    aliases: ['strategy', 'strategies', 'loop', 'spread', 'leverage', 'yield strategy', 'carry'],
    knowledge: {
      title: 'Project 0 Strategies',
      summary: 'Read Project 0 strategy ideas, projected APY/spread, leverage, and capacity.',
      capabilities: ['read strategy catalog', 'summarize projected APY, spread, leverage, and capacity'],
      requiredParams: ['none'],
      constraints: ['Strategy reads are informational; execution still requires explicit wallet approval'],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_project0_strategies',
      capability: 'strategies',
      buildInput: () => ({}),
      format: (raw) => formatLendingFacts(raw, 'project0'),
    },
  },
  {
    connectorId: 'save',
    action: 'markets',
    aliases: ['market', 'markets', 'reserve', 'reserves', 'rates', 'apy', 'apr', 'utilization'],
    knowledge: {
      title: 'Save Markets',
      summary: 'Read Save reserve/market facts: supply APY, borrow APY, utilization, collateral factor, and liquidity.',
      capabilities: ['read reserve rates and liquidity', 'scope by token or reserve mint'],
      requiredParams: ['optional token / reserveMint'],
      constraints: ['Mainnet-only; writes remain prepare-only through Protocol Connectors'],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_save_market_snapshot',
      capability: 'markets',
      buildInput: tokenScopedInput,
      format: (raw) => formatLendingFacts(raw, 'save'),
    },
  },
  {
    connectorId: 'save',
    action: 'lend',
    aliases: ['lend', 'lending', 'earn', 'supply', 'deposit', 'withdraw', 'obligation', 'position', 'positions', 'balance'],
    knowledge: {
      title: 'Save Lending',
      summary: 'Read a wallet Save obligation, including supplied balances, borrowed balances, and health factor.',
      capabilities: ['read wallet obligation', 'summarize deposits, borrows, and health factor'],
      requiredParams: ['walletAddress for wallet obligation'],
      constraints: ['Health-impact previews for withdrawals need an explicit amount and are handled by approval prep'],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_save_wallet_obligation',
      capability: 'positions',
      buildInput: walletInput,
      format: (raw) => formatLendingFacts(raw, 'save'),
    },
  },
  {
    connectorId: 'save',
    action: 'borrow',
    aliases: ['borrow', 'borrowing', 'debt', 'loan', 'loans', 'repay', 'health', 'liquidation', 'obligation', 'position', 'positions'],
    knowledge: {
      title: 'Save Borrow',
      summary: 'Read Save borrow/debt exposure from the wallet obligation with health factor.',
      capabilities: ['read borrowed balances and health factor', 'identify debt-bearing Save obligation state'],
      requiredParams: ['walletAddress for wallet obligation'],
      constraints: ['Borrow/repay health previews need explicit amount/token and remain prepare-only'],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_save_wallet_obligation',
      capability: 'positions',
      buildInput: walletInput,
      format: (raw) => formatLendingFacts(raw, 'save'),
    },
  },
  {
    connectorId: 'magiceden',
    action: 'marketplace',
    aliases: ['marketplace', 'market', 'markets', 'collection', 'collections', 'floor', 'listing', 'listings', 'bid', 'bids', 'activity'],
    knowledge: {
      title: 'Magic Eden Marketplace',
      summary: 'Read Magic Eden collection, floor, listing, bid, and recent marketplace facts.',
      capabilities: ['read top collections or one collection snapshot', 'include active listings and bids'],
      requiredParams: ['optional collectionSymbol / collectionId / query'],
      constraints: ['BYO Magic Eden API key may be required depending on runtime configuration'],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_magiceden_collection_snapshot',
      capability: 'marketplace',
      buildInput: magicedenMarketplaceInput,
      format: (raw) => formatNftMarketplaceFacts(raw, 'magiceden'),
    },
  },
  {
    connectorId: 'magiceden',
    action: 'wallet',
    aliases: ['wallet', 'nft', 'nfts', 'collectible', 'collectibles', 'owned', 'listing', 'listings', 'position', 'positions'],
    knowledge: {
      title: 'Magic Eden Wallet NFTs',
      summary: 'Read Magic Eden wallet NFT exposure, listed NFTs, or one NFT detail by mint.',
      capabilities: ['read wallet NFTs and listed NFTs', 'read one NFT detail by mint'],
      requiredParams: ['walletAddress for wallet NFTs; optional mintAddress / mint for one NFT'],
      constraints: ['BYO Magic Eden API key may be required depending on runtime configuration'],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_magiceden_wallet_nfts',
      capability: 'positions',
      buildInput: nftWalletInput,
      format: (raw) => formatNftMarketplaceFacts(raw, 'magiceden'),
    },
  },
  {
    connectorId: 'tensor',
    action: 'marketplace',
    aliases: ['marketplace', 'market', 'markets', 'collection', 'collections', 'floor', 'listing', 'listings', 'bid', 'bids', 'sale', 'sales'],
    knowledge: {
      title: 'Tensor Marketplace',
      summary: 'Read Tensor collection, floor, listing, bid, and marketplace facts.',
      capabilities: ['read supported collections or one collection snapshot', 'include active listings and bids'],
      requiredParams: ['optional collectionId / query'],
      constraints: ['BYO Tensor API key may be required depending on runtime configuration'],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_tensor_collection_snapshot',
      capability: 'marketplace',
      buildInput: tensorMarketplaceInput,
      format: (raw) => formatNftMarketplaceFacts(raw, 'tensor'),
    },
  },
  {
    connectorId: 'tensor',
    action: 'wallet',
    aliases: ['wallet', 'nft', 'nfts', 'collectible', 'collectibles', 'owned', 'listing', 'listings', 'position', 'positions'],
    knowledge: {
      title: 'Tensor Wallet NFTs',
      summary: 'Read Tensor wallet NFT exposure, listed NFTs, compressed NFTs, or one NFT detail by mint/asset id.',
      capabilities: ['read wallet NFTs and listed NFTs', 'read one NFT detail by mint or asset id'],
      requiredParams: ['walletAddress for wallet NFTs; optional mintAddress / assetId'],
      constraints: ['BYO Tensor API key may be required depending on runtime configuration'],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_tensor_wallet_nfts',
      capability: 'positions',
      buildInput: nftWalletInput,
      format: (raw) => formatNftMarketplaceFacts(raw, 'tensor'),
    },
  },
  {
    connectorId: 'sanctum',
    action: 'stake',
    aliases: ['stake', 'staking', 'lst', 'lsts', 'liquid stake', 'position', 'positions', 'balance', 'inf', 'infinity'],
    knowledge: {
      title: 'Sanctum LST Positions',
      summary: 'Read a wallet Sanctum LST and INF token positions.',
      capabilities: ['read wallet LST/INF balances', 'distinguish LST and Infinity positions'],
      requiredParams: ['walletAddress for wallet positions'],
      constraints: ['BYO Sanctum API key may be required depending on runtime configuration'],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_sanctum_wallet_positions',
      capability: 'positions',
      buildInput: walletInput,
      format: formatSanctumFacts,
    },
  },
  {
    connectorId: 'sanctum',
    action: 'liquidity',
    aliases: ['liquidity', 'inf', 'infinity', 'pool', 'markets', 'market', 'lst catalog', 'catalog'],
    knowledge: {
      title: 'Sanctum Infinity Liquidity',
      summary: 'Read Sanctum Infinity/LST market facts, including supported LSTs and pool metadata.',
      capabilities: ['read Infinity pool facts', 'read one LST snapshot or supported LST catalog'],
      requiredParams: ['optional lstMint / token / query'],
      constraints: ['BYO Sanctum API key may be required depending on runtime configuration'],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_sanctum_infinity_pool_snapshot',
      capability: 'markets',
      buildInput: sanctumMarketInput,
      format: formatSanctumFacts,
    },
  },
  {
    connectorId: 'sanctum',
    action: 'swap',
    aliases: ['swap', 'quote', 'route', 'unstake', 'withdraw', 'convert', 'lst swap'],
    knowledge: {
      title: 'Sanctum LST Swap',
      summary: 'Preview a Sanctum LST route/quote before preparing a stake, unstake, or LST swap approval.',
      capabilities: ['read quote facts for LST routes', 'summarize route sources, fee warnings, and expected output'],
      requiredParams: ['inputMint/inputToken, outputMint/outputToken, and amount for a quote'],
      constraints: ['Quote reads require input token, output token, and amount'],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_sanctum_quote',
      capability: 'swap',
      buildInput: sanctumSwapInput,
      format: formatSanctumFacts,
    },
  },
  {
    connectorId: 'realms',
    action: 'governance',
    aliases: ['governance', 'realm', 'realms', 'proposal', 'proposals', 'vote', 'votes', 'voting', 'dao', 'position', 'positions'],
    knowledge: {
      title: 'Realms Governance',
      summary: 'Read SPL Governance / Realms wallet governance, proposals, realm snapshots, voting power, and vote records.',
      capabilities: ['read wallet governance positions', 'read realm/governance/proposal snapshots when an address is supplied'],
      requiredParams: ['walletAddress for wallet governance; optional realmAddress/governanceAddress/proposalAddress'],
      constraints: ['Write actions are prepare-only; V1 does not auto-vote or construct arbitrary governance proposals'],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_realms_wallet_governance',
      capability: 'governance',
      buildInput: realmsInput,
      format: (raw) => formatGovernanceFacts(raw, 'realms'),
    },
  },
  {
    connectorId: 'squads',
    action: 'governance',
    aliases: ['governance', 'multisig', 'squad', 'squads', 'proposal', 'proposals', 'approve', 'reject', 'cancel', 'execute', 'position', 'positions'],
    knowledge: {
      title: 'Squads Multisig Governance',
      summary: 'Read Squads wallet authority, multisig snapshots, proposals, and member/voting context.',
      capabilities: ['read wallet authority across multisigs', 'read one multisig or proposal when an address/index is supplied'],
      requiredParams: ['walletAddress for wallet authority; optional multisigAddress/proposalAddress/transactionIndex'],
      constraints: ['Write actions are prepare-only and require wallet approval'],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_squads_wallet_authority',
      capability: 'governance',
      buildInput: squadsInput,
      format: (raw) => formatGovernanceFacts(raw, 'squads'),
    },
  },
  {
    connectorId: 'squads',
    action: 'treasury',
    aliases: ['treasury', 'vault', 'vaults', 'balance', 'balances', 'funds', 'assets'],
    knowledge: {
      title: 'Squads Treasury',
      summary: 'Read a Squads multisig vault/treasury snapshot when the multisig and vault index are known.',
      capabilities: ['read one Squads vault snapshot', 'summarize treasury balances when the adapter returns them'],
      requiredParams: ['multisigAddress and vaultIndex'],
      constraints: ['Treasury reads need a specific multisig and vault index'],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_squads_vault_snapshot',
      capability: 'treasury',
      buildInput: squadsInput,
      format: (raw) => formatGovernanceFacts(raw, 'squads'),
    },
  },
  {
    connectorId: 'phoenix',
    action: 'markets',
    aliases: ['market', 'markets', 'catalog', 'funding', 'open interest', 'oi', 'price'],
    knowledge: {
      title: 'Phoenix Perps Markets',
      summary: 'Read Phoenix perpetual market snapshots or the market catalog, including mark price, funding, open interest, and max leverage.',
      capabilities: ['read perps market catalog', 'read one market snapshot by symbol/token'],
      requiredParams: ['optional token / query symbol for one market'],
      constraints: ['Requires Phoenix configuration or BYO access code in runtimes that enforce it'],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_phoenix_market_snapshot',
      capability: 'markets',
      buildInput: phoenixInput,
      format: formatPhoenixPerps,
    },
  },
  {
    connectorId: 'phoenix',
    action: 'perps',
    aliases: ['perp', 'perps', 'perpetual', 'perpetuals', 'position', 'positions', 'order', 'orders', 'trigger', 'collateral', 'margin', 'leverage', 'pnl'],
    knowledge: {
      title: 'Phoenix Perps Positions',
      summary: 'Read Phoenix perpetual positions, open orders, trigger orders, collateral, margin, and PnL.',
      capabilities: ['read wallet perps positions', 'read one symbol position when token/query is supplied'],
      requiredParams: ['walletAddress for wallet positions; optional token/query symbol'],
      constraints: ['Requires Phoenix configuration or BYO access code; writes are policy-gated and prepare-only'],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_phoenix_wallet_positions',
      capability: 'perps',
      buildInput: phoenixInput,
      format: formatPhoenixPerps,
    },
  },
];
