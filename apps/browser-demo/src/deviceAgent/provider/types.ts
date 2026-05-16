// Internal contract for the browser-native provider implementations. Mirrors
// DeviceAgentProvider.kt — each method returns the raw model JSON for
// generatePlan / reviewPlan, and `{ output_text: string }` for ask.

import type { HttpExecutor, HttpResponse } from './http.js';

export type { HttpExecutor, HttpResponse };

export interface DeviceAgentProvider {
  generatePlan(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
  reviewPlan(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
  ask(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
}
