export type Cluster = 'mainnet-beta' | 'testnet' | 'devnet' | 'localnet';

export type JsonRecord = Record<string, unknown>;

export interface ParsedArgs {
  options: GlobalOptions;
  positionals: string[];
}

export interface GlobalOptions {
  bridgeUrl: string;
  renderWebUrl: string;
  token: string;
  walletHostUrl: string;
  repoRoot: string | null;
  runtimeDir: string;
  envPath: string;
  configPath: string;
  preparedActionsPath: string;
  labArtifactsPath: string;
  walletHostDir: string;
  json: boolean;
  color: boolean;
  help: boolean;
}

export type RiskLevel = 'low' | 'medium' | 'high';

export const NO_OUTPUT: unique symbol = Symbol('no-output');

export const REQUEST_TIMEOUT_MS = 120_000;
