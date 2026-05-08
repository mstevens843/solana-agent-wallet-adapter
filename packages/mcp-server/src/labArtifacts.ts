import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { Cluster } from '@solana-agent-wallet-adapter/core';

export interface LabArtifactMetric {
  label: string;
  value: string;
  tone: 'good' | 'warn' | 'danger' | 'neutral';
}

export interface LabArtifactEvidence {
  title: string;
  detail: string;
  tone: 'good' | 'warn' | 'danger' | 'neutral';
  hash: string;
}

export interface LabArtifactPayload {
  status: 'approved' | 'blocked' | 'warn' | 'observed';
  thesis: string;
  nextSignatureGate: string;
  metrics: LabArtifactMetric[];
  evidence: LabArtifactEvidence[];
}

export interface LabArtifact {
  id: string;
  labId: string;
  title: string;
  kind: string;
  createdAt: string;
  walletAddress: string;
  cluster: Cluster;
  input: string;
  payload: LabArtifactPayload;
  preSignatureHash: string;
  signingMessage: string;
  signature: string;
  verified: boolean;
  artifactHash: string;
}

interface LabArtifactState {
  artifacts: LabArtifact[];
}

export interface LabArtifactStore {
  upsertArtifact(artifact: LabArtifact): Promise<LabArtifact>;
  listArtifacts(): Promise<LabArtifact[]>;
  deleteArtifact(id: string): Promise<boolean>;
  getStoragePath?(): string;
}

export class JsonLabArtifactStore implements LabArtifactStore {
  private readonly path: string;
  private queue = Promise.resolve();

  constructor(path: string) {
    this.path = resolve(path);
  }

  async upsertArtifact(artifact: LabArtifact): Promise<LabArtifact> {
    return this.mutate((state) => {
      state.artifacts = [artifact, ...state.artifacts.filter((candidate) => candidate.id !== artifact.id)];
      return artifact;
    });
  }

  async listArtifacts(): Promise<LabArtifact[]> {
    const state = await this.read();
    return sortArtifacts(state.artifacts);
  }

  async deleteArtifact(id: string): Promise<boolean> {
    return this.mutate((state) => {
      const before = state.artifacts.length;
      state.artifacts = state.artifacts.filter((artifact) => artifact.id !== id);
      return state.artifacts.length !== before;
    });
  }

  getStoragePath(): string {
    return this.path;
  }

  private async mutate<T>(mutator: (state: LabArtifactState) => T): Promise<T> {
    const next = this.queue.then(async () => {
      const state = await this.read();
      const result = mutator(state);
      await this.write({
        artifacts: dedupeArtifacts(state.artifacts),
      });
      return result;
    });
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async read(): Promise<LabArtifactState> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<LabArtifactState>;
      return {
        artifacts: dedupeArtifacts(Array.isArray(parsed.artifacts) ? parsed.artifacts : []),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { artifacts: [] };
      }
      throw err;
    }
  }

  private async write(state: LabArtifactState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify({ artifacts: sortArtifacts(state.artifacts) }, null, 2)}\n`, 'utf8');
    await rename(tempPath, this.path);
  }
}

export function defaultLabArtifactStorePath(preparedActionStorePath?: string): string {
  if (preparedActionStorePath) {
    return resolve(dirname(resolve(preparedActionStorePath)), 'lab-artifacts.json');
  }
  return resolve(process.cwd(), '.agent-wallet', 'lab-artifacts.json');
}

function dedupeArtifacts(artifacts: LabArtifact[]): LabArtifact[] {
  const byId = new Map<string, LabArtifact>();
  for (const artifact of artifacts) {
    if (!isLabArtifact(artifact)) continue;
    const current = byId.get(artifact.id);
    if (!current || artifact.createdAt.localeCompare(current.createdAt) >= 0) {
      byId.set(artifact.id, artifact);
    }
  }
  return sortArtifacts([...byId.values()]);
}

function sortArtifacts(artifacts: LabArtifact[]): LabArtifact[] {
  return [...artifacts].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function isLabArtifact(value: unknown): value is LabArtifact {
  if (!value || typeof value !== 'object') return false;
  const artifact = value as Partial<LabArtifact>;
  return (
    typeof artifact.id === 'string' &&
    typeof artifact.labId === 'string' &&
    typeof artifact.title === 'string' &&
    typeof artifact.kind === 'string' &&
    typeof artifact.createdAt === 'string' &&
    typeof artifact.walletAddress === 'string' &&
    typeof artifact.cluster === 'string' &&
    typeof artifact.input === 'string' &&
    typeof artifact.preSignatureHash === 'string' &&
    typeof artifact.signingMessage === 'string' &&
    typeof artifact.signature === 'string' &&
    typeof artifact.verified === 'boolean' &&
    typeof artifact.artifactHash === 'string' &&
    Boolean(artifact.payload)
  );
}
