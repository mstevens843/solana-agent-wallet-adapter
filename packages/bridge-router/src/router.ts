import type {
  QuoteSource,
  RouterOptions,
  RouterResult,
  SettlementRequest,
  SettlementRoute,
  SourceDiagnostic,
  SourceStatus,
} from './types.js';

const DEFAULT_PER_SOURCE_TIMEOUT_MS = 5000;

export async function findOptimalSettlement(
  request: SettlementRequest,
  sources: QuoteSource[],
  options: RouterOptions = {},
): Promise<RouterResult> {
  const timeoutMs = options.perSourceTimeoutMs ?? DEFAULT_PER_SOURCE_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const candidates: SettlementRoute[] = [];
  const diagnostics: SourceDiagnostic[] = [];

  await Promise.all(
    sources.map(async (source) => {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const route = await source.quote({ request, signal: controller.signal, now });
        const latencyMs = Date.now() - startedAt;
        if (route) {
          candidates.push(route);
          diagnostics.push({ sourceId: source.id, status: 'ok', latencyMs });
        } else {
          diagnostics.push({ sourceId: source.id, status: 'no_route', latencyMs });
        }
      } catch (err) {
        const latencyMs = Date.now() - startedAt;
        const status: SourceStatus = controller.signal.aborted ? 'timeout' : 'error';
        diagnostics.push({
          sourceId: source.id,
          status,
          latencyMs,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  candidates.sort((a, b) => compareDecimalStrings(a.estimatedCostUsd, b.estimatedCostUsd));
  const best = candidates[0];
  return {
    ...(best !== undefined && { best }),
    candidates,
    diagnostics,
  };
}

// All current sources emit valid finite decimal strings, so the localeCompare
// fallback is defensive only — it would only fire if a future source returned
// 'NaN' / 'Infinity' / non-numeric content.
function compareDecimalStrings(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a.localeCompare(b);
}
