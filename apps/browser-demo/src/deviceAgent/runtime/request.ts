import type { RuntimeError } from './state.js';

export type RuntimeMethodWire = 'generatePlan' | 'reviewPlan' | 'ask';

export const RUNTIME_METHODS: readonly RuntimeMethodWire[] = Object.freeze([
  'generatePlan',
  'reviewPlan',
  'ask',
]);

export function isRuntimeMethodWire(value: unknown): value is RuntimeMethodWire {
  return typeof value === 'string' && (RUNTIME_METHODS as readonly string[]).includes(value);
}

export interface RuntimeRequest {
  readonly requestId: string;
  readonly method: RuntimeMethodWire;
  readonly payload: Record<string, unknown>;
  readonly enqueuedAtMs: number;
}

export interface RuntimeResultOk {
  readonly kind: 'ok';
  readonly requestId: string;
  readonly method: RuntimeMethodWire;
  readonly data: unknown;
  readonly completedAtMs: number;
}

export interface RuntimeResultFailed {
  readonly kind: 'failed';
  readonly requestId: string;
  readonly method: RuntimeMethodWire;
  readonly error: RuntimeError;
  readonly completedAtMs: number;
}

export type RuntimeResult = RuntimeResultOk | RuntimeResultFailed;
