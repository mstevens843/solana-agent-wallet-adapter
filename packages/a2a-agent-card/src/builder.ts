import type {
  AgentCard,
  AgenticProtocol,
  BuildAgenticAgentCardInput,
  PaymentMethod,
  AgentSkill,
  AgenticCapability,
} from './schema.js';

const DEFAULT_PROTOCOL_VERSION = '0.2.5';
const DEFAULT_VERSION = '0.0.1-dev';
const DEFAULT_NAME = 'Agentic Wallet';
const DEFAULT_DESCRIPTION =
  'Solana-native A2A-compatible wallet adapter. Receives AP2 mandates, pays ACP carts, and signs every action through explicit user approval — no auto-signing.';
const DEFAULT_SUPPORTED_PROTOCOLS: ReadonlyArray<AgenticProtocol> = ['ap2', 'acp', 'a2a'];
const DEFAULT_INPUT_MODES: ReadonlyArray<string> = ['application/json', 'text/plain'];
const DEFAULT_OUTPUT_MODES: ReadonlyArray<string> = ['application/json'];

function trimTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function capabilityToSkill(c: AgenticCapability): AgentSkill {
  const skill: AgentSkill = {
    id: c.id,
    name: c.name,
    description: c.description,
    tags: [...c.tags],
  };
  if (c.examples !== undefined) skill.examples = [...c.examples];
  if (c.inputModes !== undefined) skill.inputModes = [...c.inputModes];
  if (c.outputModes !== undefined) skill.outputModes = [...c.outputModes];
  return skill;
}

function defaultPaymentMethods(baseUrl: string, supportedTokens: string[]): PaymentMethod[] {
  return [
    { protocol: 'ap2-inbound', endpoint: `${baseUrl}/api/ap2/inbound` },
    { protocol: 'acp-outbound', endpoint: `${baseUrl}/api/acp/cart/preview` },
    { protocol: 'spl-transfer', tokens: [...supportedTokens], network: 'solana-mainnet' },
  ];
}

/**
 * Build an A2A-compliant `AgentCard` from caller-supplied wallet identity and
 * capabilities. Pure: no fetches, no clocks, no global state. Output is safe
 * to JSON-serialize as-is and serve at `/.well-known/agent.json`.
 *
 * The result is *not* validated by this function — pair with `validateAgentCard`
 * if you need a runtime guarantee.
 */
export function buildAgenticAgentCard(input: BuildAgenticAgentCardInput): AgentCard {
  const url = trimTrailingSlash(input.baseUrl);
  const skills = input.capabilities.map(capabilityToSkill);
  const paymentMethods = input.paymentMethods
    ? input.paymentMethods.map((m) => ({ ...m, ...(m.tokens ? { tokens: [...m.tokens] } : {}) }))
    : defaultPaymentMethods(url, input.supportedTokens);

  const card: AgentCard = {
    protocolVersion: input.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
    name: input.name ?? DEFAULT_NAME,
    description: input.description ?? DEFAULT_DESCRIPTION,
    url,
    version: input.version ?? DEFAULT_VERSION,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: [...DEFAULT_INPUT_MODES],
    defaultOutputModes: [...DEFAULT_OUTPUT_MODES],
    skills,
    serviceEndpoint: url,
    supportedProtocols: input.supportedProtocols
      ? [...input.supportedProtocols]
      : [...DEFAULT_SUPPORTED_PROTOCOLS],
    supportedTokens: [...input.supportedTokens],
    paymentMethods,
    walletAddress: input.walletAddress,
  };
  if (input.documentationUrl !== undefined) card.documentationUrl = input.documentationUrl;
  if (input.provider !== undefined) card.provider = { ...input.provider };
  if (input.contactEmail !== undefined) card.contactEmail = input.contactEmail;
  return card;
}
