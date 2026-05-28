export function researchTargetsForPayload(payload: Record<string, unknown>): ReadonlyArray<Record<string, unknown>> {
  const context = payload.context;
  if (!context || typeof context !== 'object' || Array.isArray(context)) return [];
  const targets = (context as Record<string, unknown>).researchTargets;
  if (!Array.isArray(targets)) return [];
  return targets.filter((target): target is Record<string, unknown> => (
    Boolean(target) && typeof target === 'object' && !Array.isArray(target)
  ));
}
