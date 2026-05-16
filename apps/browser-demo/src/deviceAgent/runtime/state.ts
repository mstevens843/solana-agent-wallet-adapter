export type RuntimeStateWire = 'stopped' | 'starting' | 'running' | 'error';

export const RUNTIME_STATES: readonly RuntimeStateWire[] = Object.freeze([
  'stopped',
  'starting',
  'running',
  'error',
]);

export function isRuntimeStateWire(value: unknown): value is RuntimeStateWire {
  return typeof value === 'string' && (RUNTIME_STATES as readonly string[]).includes(value);
}

export interface RuntimeError {
  readonly code: string;
  readonly subcode?: string;
  readonly message: string;
}
