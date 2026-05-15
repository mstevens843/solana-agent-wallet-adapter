/**
 * A2A AgentCard schema.
 *
 * Standard fields follow Google's A2A (Agent-to-Agent) v0.2.x spec. Agentic
 * extensions (`serviceEndpoint`, `supportedProtocols`, `supportedTokens`,
 * `paymentMethods`, `walletAddress`) live alongside spec fields so external
 * agents discover AP2/ACP entry points and the wallet pubkey in one fetch.
 */

export type AgenticProtocol = 'ap2' | 'acp' | 'a2a';

export type PaymentProtocol = 'ap2-inbound' | 'acp-outbound' | 'spl-transfer';

export interface AgentCardCapabilities {
  streaming: boolean;
  pushNotifications: boolean;
  stateTransitionHistory: boolean;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface AgentProvider {
  organization: string;
  url: string;
}

export interface PaymentMethod {
  protocol: PaymentProtocol;
  endpoint?: string;
  tokens?: string[];
  network?: string;
}

/**
 * A single capability the wallet advertises in its AgentCard. Maps 1:1 to an
 * A2A `AgentSkill` at build time. Use stable, dotted ids (e.g. `wallet.swap`)
 * so external discovery tools can filter or alias deterministically.
 */
export interface AgenticCapability {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

/**
 * Input shape accepted by `buildAgenticAgentCard`. Required fields are the
 * minimum needed to materialize a discoverable AgentCard; optional fields
 * override the package defaults (protocol version, payment methods, etc.).
 */
export interface BuildAgenticAgentCardInput {
  walletAddress: string;
  baseUrl: string;
  supportedTokens: string[];
  capabilities: AgenticCapability[];
  name?: string;
  description?: string;
  version?: string;
  protocolVersion?: string;
  documentationUrl?: string;
  contactEmail?: string;
  supportedProtocols?: AgenticProtocol[];
  paymentMethods?: PaymentMethod[];
  provider?: AgentProvider;
}

export interface AgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  version: string;
  documentationUrl?: string;
  provider?: AgentProvider;
  capabilities: AgentCardCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];

  serviceEndpoint: string;
  supportedProtocols: AgenticProtocol[];
  supportedTokens: string[];
  paymentMethods: PaymentMethod[];
  walletAddress: string;
  contactEmail?: string;
}
