import { isDriftVaultConfigured, setDriftVaultClientFactory } from './adapters/drift/client.js';
import { buildDriftVaultClient } from './adapters/drift/sdkClient.js';
import { isKaminoConfigured, setKaminoClientFactory } from './adapters/kamino/client.js';
import { buildKaminoSdkClient } from './adapters/kamino/sdkClient.js';
import { isSaveConfigured, setSaveClientFactory } from './adapters/save/client.js';
import { buildSaveSdkClient } from './adapters/save/sdkClient.js';
import { isWormholeConfigured, setWormholeClientFactory } from './adapters/wormhole/client.js';
import { buildWormholeSdkClient } from './adapters/wormhole/sdkClient.js';
import type { AgentWalletConfig } from './config.js';

export interface HostConnectorBootstrapOptions {
  rpcUrl: string;
}

export function bootstrapHostConnectorFactories(options: HostConnectorBootstrapOptions): void {
  const { rpcUrl } = options;
  if (!isDriftVaultConfigured()) {
    setDriftVaultClientFactory(() => buildDriftVaultClient({ rpcUrl }));
  }
  if (!isKaminoConfigured()) {
    setKaminoClientFactory(() => buildKaminoSdkClient({ rpcUrl }));
  }
  if (!isSaveConfigured()) {
    setSaveClientFactory(() => buildSaveSdkClient({ rpcUrl }));
  }
  if (!isWormholeConfigured()) {
    setWormholeClientFactory(() => buildWormholeSdkClient({ rpcUrl }));
  }
}

export function bootstrapHostConnectorFactoriesFromConfig(config: AgentWalletConfig): void {
  bootstrapHostConnectorFactories({ rpcUrl: config.rpcUrl });
}
