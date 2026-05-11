import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export function defaultAgentsStorePath(): string {
  return resolve(process.cwd(), '.agent-wallet', 'agents.json');
}

export type AgentTier = 'read_only' | 'capped' | 'full';

export interface RegisteredAgent {
  id: string;
  label: string;
  token: string;
  tier: AgentTier;
  enabled: boolean;
  createdAt: string;
  lastSeenAt?: string;
  notes?: string;
}

export interface PublicRegisteredAgent {
  id: string;
  label: string;
  tier: AgentTier;
  enabled: boolean;
  createdAt: string;
  lastSeenAt?: string;
  notes?: string;
  tokenHint: string;
}

export const AGENT_TIERS: readonly AgentTier[] = ['read_only', 'capped', 'full'] as const;

export function isAgentTier(value: unknown): value is AgentTier {
  return value === 'read_only' || value === 'capped' || value === 'full';
}

export function tierRank(tier: AgentTier): number {
  switch (tier) {
    case 'read_only':
      return 0;
    case 'capped':
      return 1;
    case 'full':
      return 2;
  }
}

export function tierMeetsMinimum(actual: AgentTier, required: AgentTier): boolean {
  return tierRank(actual) >= tierRank(required);
}

function tokenHint(token: string): string {
  if (!token) return '';
  if (token.length <= 8) return `${token.slice(0, 2)}…`;
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

export function publicizeAgent(agent: RegisteredAgent): PublicRegisteredAgent {
  return {
    id: agent.id,
    label: agent.label,
    tier: agent.tier,
    enabled: agent.enabled,
    createdAt: agent.createdAt,
    ...(agent.lastSeenAt ? { lastSeenAt: agent.lastSeenAt } : {}),
    ...(agent.notes ? { notes: agent.notes } : {}),
    tokenHint: tokenHint(agent.token),
  };
}

export interface AgentRegistryOptions {
  persistPath?: string;
  fallbackToken?: string;
}

export class AgentRegistry {
  private readonly persistPath?: string;
  private readonly fallbackToken: string;
  private byToken = new Map<string, RegisteredAgent>();
  private byId = new Map<string, RegisteredAgent>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: AgentRegistryOptions = {}) {
    if (options.persistPath) this.persistPath = resolve(options.persistPath);
    this.fallbackToken = options.fallbackToken ?? '';
  }

  static newToken(): string {
    return randomBytes(24).toString('base64url');
  }

  async load(): Promise<void> {
    if (!this.persistPath) return;
    let raw: string;
    try {
      raw = await readFile(this.persistPath, 'utf8');
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { agents?: unknown }).agents)) {
      return;
    }
    const agents = ((parsed as { agents: unknown[] }).agents)
      .map((entry) => parseAgent(entry))
      .filter((agent): agent is RegisteredAgent => Boolean(agent));
    this.byToken.clear();
    this.byId.clear();
    for (const agent of agents) {
      this.byToken.set(agent.token, agent);
      this.byId.set(agent.id, agent);
    }
  }

  isEmpty(): boolean {
    return this.byToken.size === 0;
  }

  list(): RegisteredAgent[] {
    return [...this.byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  lookupByToken(token: string): RegisteredAgent | null {
    if (!token) return null;
    return this.byToken.get(token) ?? null;
  }

  lookupById(id: string): RegisteredAgent | null {
    return this.byId.get(id) ?? null;
  }

  replaceAll(input: Array<Partial<RegisteredAgent>>): RegisteredAgent[] {
    const next = new Map<string, RegisteredAgent>();
    const byIdNext = new Map<string, RegisteredAgent>();
    const now = new Date().toISOString();
    for (const raw of input) {
      const agent = parseAgent({ ...raw }, now);
      if (!agent) continue;
      next.set(agent.token, agent);
      byIdNext.set(agent.id, agent);
    }
    this.byToken = next;
    this.byId = byIdNext;
    this.persist();
    return this.list();
  }

  upsert(agent: RegisteredAgent): RegisteredAgent {
    const previous = this.byId.get(agent.id);
    if (previous && previous.token !== agent.token) {
      this.byToken.delete(previous.token);
    }
    this.byToken.set(agent.token, agent);
    this.byId.set(agent.id, agent);
    this.persist();
    return agent;
  }

  remove(id: string): boolean {
    const agent = this.byId.get(id);
    if (!agent) return false;
    this.byId.delete(id);
    this.byToken.delete(agent.token);
    this.persist();
    return true;
  }

  issueAgent(input: { label: string; tier?: AgentTier; notes?: string }): RegisteredAgent {
    const now = new Date().toISOString();
    const agent: RegisteredAgent = {
      id: `agent_${randomBytes(8).toString('hex')}`,
      label: input.label.trim().slice(0, 64) || 'Unnamed agent',
      token: AgentRegistry.newToken(),
      tier: input.tier ?? 'capped',
      enabled: true,
      createdAt: now,
      ...(input.notes && input.notes.trim() ? { notes: input.notes.trim().slice(0, 200) } : {}),
    };
    this.byToken.set(agent.token, agent);
    this.byId.set(agent.id, agent);
    this.persist();
    return agent;
  }

  markSeen(token: string, when: string = new Date().toISOString()): void {
    const agent = this.byToken.get(token);
    if (!agent) return;
    agent.lastSeenAt = when;
    this.persist();
  }

  buildFallbackAgent(): RegisteredAgent {
    return {
      id: 'agent_default',
      label: 'Default',
      token: this.fallbackToken,
      tier: 'full',
      enabled: true,
      createdAt: '1970-01-01T00:00:00.000Z',
    };
  }

  private persist(): void {
    if (!this.persistPath) return;
    const snapshot = this.list();
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const path = this.persistPath as string;
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify({ agents: snapshot }, null, 2), 'utf8');
      })
      .catch(() => undefined);
  }
}

function parseAgent(value: unknown, fallbackNow: string = new Date().toISOString()): RegisteredAgent | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<RegisteredAgent>;
  if (typeof raw.token !== 'string' || !raw.token) return null;
  const tier: AgentTier = isAgentTier(raw.tier) ? raw.tier : 'capped';
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 64) : 'Unnamed agent';
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `agent_${randomBytes(8).toString('hex')}`,
    label,
    token: raw.token,
    tier,
    enabled: raw.enabled !== false,
    createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : fallbackNow,
    ...(typeof raw.lastSeenAt === 'string' && raw.lastSeenAt ? { lastSeenAt: raw.lastSeenAt } : {}),
    ...(typeof raw.notes === 'string' && raw.notes ? { notes: raw.notes.slice(0, 200) } : {}),
  };
}
