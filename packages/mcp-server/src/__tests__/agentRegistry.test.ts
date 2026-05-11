import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AgentRegistry,
  isAgentTier,
  publicizeAgent,
  tierMeetsMinimum,
} from '../agentRegistry.js';

describe('AgentRegistry', () => {
  it('issues an agent with a fresh secret token and capped tier by default', () => {
    const registry = new AgentRegistry();
    const agent = registry.issueAgent({ label: 'Codex devnet' });
    expect(agent.label).toBe('Codex devnet');
    expect(agent.tier).toBe('capped');
    expect(agent.enabled).toBe(true);
    expect(agent.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });

  it('looks up agents by token and id', () => {
    const registry = new AgentRegistry();
    const issued = registry.issueAgent({ label: 'Claude full', tier: 'full' });
    expect(registry.lookupByToken(issued.token)?.id).toBe(issued.id);
    expect(registry.lookupById(issued.id)?.token).toBe(issued.token);
    expect(registry.lookupByToken('missing')).toBeNull();
  });

  it('falls back to a synthetic Default agent when the registry is empty', () => {
    const registry = new AgentRegistry({ fallbackToken: 'master' });
    expect(registry.isEmpty()).toBe(true);
    const fallback = registry.buildFallbackAgent();
    expect(fallback.token).toBe('master');
    expect(fallback.tier).toBe('full');
  });

  it('rejects revoked agents on lookup', () => {
    const registry = new AgentRegistry();
    const issued = registry.issueAgent({ label: 'Temporary' });
    registry.remove(issued.id);
    expect(registry.lookupByToken(issued.token)).toBeNull();
  });

  it('persists agents to disk and reloads them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sawa-agents-'));
    const path = join(dir, 'agents.json');
    const registry = new AgentRegistry({ persistPath: path });
    const issued = registry.issueAgent({ label: 'Persisted', tier: 'read_only' });
    // Allow the queued write to flush.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const file = await readFile(path, 'utf8');
    expect(file).toContain(issued.token);

    const reloaded = new AgentRegistry({ persistPath: path });
    await reloaded.load();
    const restored = reloaded.lookupById(issued.id);
    expect(restored?.label).toBe('Persisted');
    expect(restored?.tier).toBe('read_only');
  });

  it('omits the secret token from the public projection', () => {
    const registry = new AgentRegistry();
    const issued = registry.issueAgent({ label: 'Public agent' });
    const view = publicizeAgent(issued);
    expect(view).not.toHaveProperty('token');
    expect(view.tokenHint).toMatch(/…/);
  });

  it('compares tiers correctly', () => {
    expect(tierMeetsMinimum('read_only', 'capped')).toBe(false);
    expect(tierMeetsMinimum('capped', 'capped')).toBe(true);
    expect(tierMeetsMinimum('full', 'capped')).toBe(true);
    expect(tierMeetsMinimum('full', 'read_only')).toBe(true);
  });

  it('recognizes the canonical agent tier strings', () => {
    expect(isAgentTier('read_only')).toBe(true);
    expect(isAgentTier('capped')).toBe(true);
    expect(isAgentTier('full')).toBe(true);
    expect(isAgentTier('admin')).toBe(false);
    expect(isAgentTier(undefined)).toBe(false);
  });
});
