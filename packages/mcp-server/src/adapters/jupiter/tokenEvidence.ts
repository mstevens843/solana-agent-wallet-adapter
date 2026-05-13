import type { AgentWalletConfig } from '../../config.js';
import { getJupiterPrice, type JupiterPriceSnapshot } from './prices.js';
import { getJupiterTokenSearch, type JupiterTokenInfo, type JupiterTokenStats } from './tokens.js';

export interface JupiterTokenRiskEvidenceInput {
  mint: string;
  includePrice?: boolean;
  includeSearchFallback?: boolean;
}

export interface JupiterTokenRiskEvidence {
  connectorId: 'jupiter';
  product: 'tokens_price';
  mint: string;
  tokenFound: boolean;
  symbol?: string;
  name?: string;
  decimals?: number;
  tokenProgram?: string;
  isVerified?: boolean | null;
  tags?: string[];
  organicScore?: number;
  organicScoreLabel?: string;
  audit?: Record<string, unknown>;
  holderCount?: number;
  topHoldersPercentage?: number;
  liquidity?: number;
  mcap?: number;
  fdv?: number;
  usdPrice?: number;
  priceBlockId?: number;
  priceChange24h?: number;
  stats?: {
    stats5m?: JupiterTokenStats;
    stats1h?: JupiterTokenStats;
    stats6h?: JupiterTokenStats;
    stats24h?: JupiterTokenStats;
  };
  riskLabels: string[];
  warnings: string[];
  asOf: string;
}

export async function getJupiterTokenRiskEvidence(
  config: AgentWalletConfig,
  input: JupiterTokenRiskEvidenceInput,
): Promise<JupiterTokenRiskEvidence> {
  const mint = input.mint.trim();
  const includePrice = input.includePrice ?? true;
  const includeSearchFallback = input.includeSearchFallback ?? true;
  const tokenRead = await getJupiterTokenSearch(config, { query: mint, limit: includeSearchFallback ? 20 : 1 });
  const token = selectToken(mint, tokenRead.tokens, includeSearchFallback);
  const price = includePrice ? await getJupiterPrice(config, { mint }) : undefined;
  return buildTokenRiskEvidence(mint, token, price);
}

export function buildTokenRiskEvidence(
  mint: string,
  token: JupiterTokenInfo | undefined,
  price: JupiterPriceSnapshot | undefined,
  asOf = new Date().toISOString(),
): JupiterTokenRiskEvidence {
  const riskLabels: string[] = [];
  const warnings: string[] = [];
  const audit = token?.audit;
  const topHoldersPercentage = numberField(audit?.topHoldersPercentage);
  const liquidity = price?.liquidity ?? token?.liquidity;
  const usdPrice = price?.usdPrice ?? token?.usdPrice;
  const priceBlockId = price?.blockId ?? token?.priceBlockId;
  const priceChange24h = price?.priceChange24h ?? token?.stats24h?.priceChange;

  if (!token) {
    riskLabels.push('token_metadata_missing');
    warnings.push('Jupiter Token API did not return metadata for this mint.');
  } else {
    if (token.isVerified !== true) {
      riskLabels.push('unverified');
      warnings.push('Jupiter does not mark this token as verified.');
    }
    if (booleanField(audit?.isSus) === true) {
      riskLabels.push('suspicious_audit');
      warnings.push('Jupiter audit flags mark this token as suspicious.');
    }
    if (token.mintAuthority || booleanField(audit?.mintAuthorityDisabled) === false) {
      riskLabels.push('mint_authority_present');
      warnings.push('Mint authority appears enabled or present.');
    }
    if (token.freezeAuthority || booleanField(audit?.freezeAuthorityDisabled) === false) {
      riskLabels.push('freeze_authority_present');
      warnings.push('Freeze authority appears enabled or present.');
    }
    if (typeof topHoldersPercentage === 'number' && topHoldersPercentage >= 50) {
      riskLabels.push('holder_concentration_high');
      warnings.push(`Top holders control ${topHoldersPercentage}% of supply.`);
    }
    if (typeof liquidity === 'number' && liquidity < 1_000) {
      riskLabels.push('very_low_liquidity');
      warnings.push('Jupiter reports very low token liquidity.');
    } else if (typeof liquidity === 'number' && liquidity < 10_000) {
      riskLabels.push('low_liquidity');
      warnings.push('Jupiter reports low token liquidity.');
    }
    if (token.organicScoreLabel === 'low' || (typeof token.organicScore === 'number' && token.organicScore < 40)) {
      riskLabels.push('organic_score_low');
      warnings.push('Jupiter organic score is low.');
    } else if (token.organicScore === undefined) {
      riskLabels.push('organic_score_missing');
      warnings.push('Jupiter did not report an organic score.');
    }
  }

  if (price?.status === 'missing') {
    riskLabels.push('price_missing');
    warnings.push(price.reason ?? 'Jupiter Price API did not return a reliable price.');
  }
  riskLabels.push('price_evidence_not_oracle');
  warnings.push('Jupiter price is evidence, not an oracle guarantee.');

  return {
    connectorId: 'jupiter',
    product: 'tokens_price',
    mint,
    tokenFound: token !== undefined,
    ...(token?.symbol !== undefined && { symbol: token.symbol }),
    ...(token?.name !== undefined && { name: token.name }),
    ...(token?.decimals !== undefined && { decimals: token.decimals }),
    ...(token?.tokenProgram !== undefined && { tokenProgram: token.tokenProgram }),
    ...(token?.isVerified !== undefined && { isVerified: token.isVerified }),
    ...(token?.tags !== undefined && { tags: token.tags }),
    ...(token?.organicScore !== undefined && { organicScore: token.organicScore }),
    ...(token?.organicScoreLabel !== undefined && { organicScoreLabel: token.organicScoreLabel }),
    ...(audit !== undefined && { audit }),
    ...(token?.holderCount !== undefined && { holderCount: token.holderCount }),
    ...(topHoldersPercentage !== undefined && { topHoldersPercentage }),
    ...(liquidity !== undefined && { liquidity }),
    ...(token?.mcap !== undefined && { mcap: token.mcap }),
    ...(token?.fdv !== undefined && { fdv: token.fdv }),
    ...(usdPrice !== undefined && { usdPrice }),
    ...(priceBlockId !== undefined && { priceBlockId }),
    ...(priceChange24h !== undefined && { priceChange24h }),
    ...(token !== undefined && {
      stats: {
        ...(token.stats5m !== undefined && { stats5m: token.stats5m }),
        ...(token.stats1h !== undefined && { stats1h: token.stats1h }),
        ...(token.stats6h !== undefined && { stats6h: token.stats6h }),
        ...(token.stats24h !== undefined && { stats24h: token.stats24h }),
      },
    }),
    riskLabels: [...new Set(riskLabels)],
    warnings: [...new Set(warnings)],
    asOf,
  };
}

function selectToken(
  mint: string,
  tokens: JupiterTokenInfo[],
  includeSearchFallback: boolean,
): JupiterTokenInfo | undefined {
  const exact = tokens.find((token) => token.id === mint);
  return exact ?? (includeSearchFallback ? tokens[0] : undefined);
}

function numberField(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
