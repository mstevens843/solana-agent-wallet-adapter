import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import {
  getJupiterPredictionPolicy,
  type AgentWalletConfig,
  type JupiterPredictionPolicyConfig,
} from '../../config.js';

import { jupiterApiHost, jupiterFetchJson, redactJupiterSecrets } from './client.js';

export const JUPITER_PREDICTION_BETA_WARNING =
  'Jupiter Prediction API is in beta. Schemas, prices, and outcomes can change without notice.';

export const JUPITER_PREDICTION_EXTERNAL_PROVIDER_WARNING =
  'Markets and outcomes are sourced from external providers (e.g. Polymarket, Kalshi). Verify rules and resolution sources independently.';

export interface JupiterPredictionEnvelope<T = unknown> {
  connectorId: 'jupiter';
  product: 'prediction';
  beta: true;
  apiBaseUrlHost: string;
  asOf: string;
  data: T;
  warnings: string[];
}

export interface PredictionRequestOptions {
  searchParams?: Record<string, string | number | boolean | undefined>;
  extraWarnings?: string[];
}

export function assertPredictionEnabled(config: AgentWalletConfig): void {
  const policy = getJupiterPredictionPolicy(config);
  if (!policy.enabled) {
    throw new ProtocolError(
      'unauthorized',
      'Jupiter Prediction beta is disabled. Set connectors.jupiter.prediction.enabled=true to opt in.',
    );
  }
}

export function assertPredictionReadOnly(
  config: AgentWalletConfig,
  attemptedOperation: string,
): void {
  const policy = getJupiterPredictionPolicy(config);
  if (policy.readOnly) {
    throw new ProtocolError(
      'unsupported_method',
      `Jupiter Prediction v1 is read-only; ${attemptedOperation} is not exposed.`,
    );
  }
}

export function buildPredictionWarnings(extra?: string[]): string[] {
  const base = [JUPITER_PREDICTION_BETA_WARNING, JUPITER_PREDICTION_EXTERNAL_PROVIDER_WARNING];
  if (!extra || extra.length === 0) return base;
  return [...base, ...extra];
}

export function predictionEnvelope<T>(
  config: AgentWalletConfig,
  data: T,
  warnings?: string[],
): JupiterPredictionEnvelope<T> {
  return {
    connectorId: 'jupiter',
    product: 'prediction',
    beta: true,
    apiBaseUrlHost: jupiterApiHost(config, 'prediction'),
    asOf: new Date().toISOString(),
    data: redactJupiterSecrets(data) as T,
    warnings: buildPredictionWarnings(warnings),
  };
}

export async function predictionRequest(
  config: AgentWalletConfig,
  path: string,
  options: PredictionRequestOptions = {},
): Promise<Record<string, unknown>> {
  assertPredictionEnabled(config);
  return jupiterFetchJson(config, 'prediction', path, {
    ...(options.searchParams ? { searchParams: options.searchParams } : {}),
  });
}

export type { JupiterPredictionPolicyConfig };
