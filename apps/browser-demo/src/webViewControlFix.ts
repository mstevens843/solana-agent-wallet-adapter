// WebView native-control fix
// ---------------------------------------------------------------------------
// Android WebView (Chromium) and iOS WKWebView (WebKit) do not reliably fire
// the native tap->toggle gesture on <details>/<summary>, nor the native
// label->checkbox `change` event. Plain <button>s wired with addEventListener
// work; native disclosures/checkboxes don't. Rather than patch each of the ~48
// disclosures and the legacy checkboxes one by one, we install a single
// capture-phase delegate (once, in startApp) that owns the toggle in JS, plus a
// restore pass (called from render()) so an opened disclosure survives the
// wholesale innerHTML re-render the app performs (e.g. from background watchers).
//
// The pure helpers below carry the bug-prone logic (stable id derivation,
// exclusion detection, checkbox scoping) and are unit-tested; the thin DOM
// wrappers are exercised by the build typecheck and on-device verification.

// Disclosures whose `open` is authoritatively driven by the template — either
// state-backed via ${open} + a 'toggle' listener, hard-coded open, or a
// transient menu that should reset on re-render. The delegate still toggles
// these on tap (their own listeners/state keep working), but the restore pass
// must never fight the template, so we don't persist/restore them.
export const TEMPLATE_DRIVEN_DISCLOSURE_CLASSES = new Set<string>([
  'ai-settings-panel',
  'workspace-storage-panel',
  'guided-demo-policy-checks',
  'wallet-picker-details',
  'local-bridge-ai-setup-card',
  'workspace-more',
  // Transient "⋯" overflow popover on the compact chat action card — must reset (close) on re-render.
  'chat-action-menu',
]);

// Class tokens that flip across renders — stripped so the derived id is stable.
export const VOLATILE_DISCLOSURE_CLASS_TOKENS = new Set<string>([
  'busy', 'checked', 'open', 'enabled', 'disabled',
  'configured', 'optional', 'collapsed', 'has-active', 'active', 'selected',
]);

const DISCLOSURE_RECORD_ANCHOR =
  '[data-generated-plan-id],[data-action-id],[data-recurring-id],[data-audit-record-id],[data-position-id]';

// --- Pure logic (unit-tested) ----------------------------------------------

// Sorted, volatile-token-stripped class signature. Stable across renders even
// when state classes (open/active/busy/…) flip.
export function stableDisclosureClassName(classes: Iterable<string>): string {
  return Array.from(classes)
    .filter((token) => token.length > 0 && !VOLATILE_DISCLOSURE_CLASS_TOKENS.has(token))
    .sort()
    .join('.');
}

export function isTemplateDrivenDisclosureClasses(
  classes: Iterable<string>,
  isAuditRecord: boolean,
): boolean {
  if (isAuditRecord) return true;
  for (const token of classes) {
    if (TEMPLATE_DRIVEN_DISCLOSURE_CLASSES.has(token)) return true;
  }
  return false;
}

// Only checkbox/radio inputs are driven by the generic label handler — text and
// select labels must keep native focus behavior.
export function checkboxInputType(type: string | null | undefined): 'checkbox' | 'radio' | null {
  return type === 'checkbox' || type === 'radio' ? type : null;
}

// Ordinal of entry `index` among earlier entries sharing its (recordId,
// className). Keeps the derived id unique for repeated identical disclosures
// (e.g. two "More actions" menus) without depending on volatile summary text.
export function computeDisclosureOrdinal(
  entries: ReadonlyArray<{ recordId: string; className: string }>,
  index: number,
): number {
  const target = entries[index];
  if (!target) return 0;
  let ordinal = 0;
  for (let i = 0; i < index; i += 1) {
    const entry = entries[i];
    if (entry && entry.recordId === target.recordId && entry.className === target.className) {
      ordinal += 1;
    }
  }
  return ordinal;
}

export function formatDisclosureKey(recordId: string, className: string, ordinal: number): string {
  return `${recordId}|${className}|${ordinal}`;
}

// --- DOM wrappers -----------------------------------------------------------

export function disclosureRecordId(el: Element): string {
  const record = el.closest(DISCLOSURE_RECORD_ANCHOR);
  if (!(record instanceof HTMLElement)) return '';
  return (
    record.dataset.generatedPlanId
    ?? record.dataset.actionId
    ?? record.dataset.recurringId
    ?? record.dataset.auditRecordId
    ?? record.dataset.positionId
    ?? ''
  );
}

export function isTemplateDrivenDisclosure(details: HTMLDetailsElement): boolean {
  return isTemplateDrivenDisclosureClasses(
    details.classList,
    details.hasAttribute('data-audit-record-type'),
  );
}

// Stable id: nearest record id + stripped class list + ordinal among sibling
// <details> sharing that record id and class list. Excludes summary text, which
// carries dynamic counts like "Agent findings (3)".
export function disclosureKey(details: HTMLDetailsElement): string {
  const all = Array.from(document.querySelectorAll<HTMLDetailsElement>('details'));
  const entries = all.map((el) => ({
    recordId: disclosureRecordId(el),
    className: stableDisclosureClassName(el.classList),
  }));
  const index = all.indexOf(details);
  const entry = index >= 0 ? entries[index] : undefined;
  if (!entry) {
    return formatDisclosureKey(
      disclosureRecordId(details),
      stableDisclosureClassName(details.classList),
      0,
    );
  }
  const ordinal = computeDisclosureOrdinal(entries, index);
  return formatDisclosureKey(entry.recordId, entry.className, ordinal);
}

// Resolve the checkbox/radio a <label> drives (via for= or a nested input).
// Returns null for text/select labels so they keep native focus behavior.
export function resolveLabelCheckbox(label: HTMLLabelElement): HTMLInputElement | null {
  let input: HTMLInputElement | null = null;
  const forId = label.getAttribute('for');
  if (forId) {
    const byId = document.getElementById(forId);
    if (byId instanceof HTMLInputElement) input = byId;
  }
  if (!input) {
    input = label.querySelector<HTMLInputElement>(
      'input[type="checkbox"], input[type="radio"]',
    );
  }
  if (!input) return null;
  return checkboxInputType(input.type) ? input : null;
}

// Re-apply persisted open state after every render() (called from render()).
// Builds the entries list once (disclosureKey would otherwise re-query the DOM
// per element) and derives each key the same way disclosureKey does.
export function restoreDisclosureOpenState(openState: Map<string, boolean>): void {
  if (openState.size === 0) return;
  const all = Array.from(document.querySelectorAll<HTMLDetailsElement>('details'));
  const entries = all.map((el) => ({
    recordId: disclosureRecordId(el),
    className: stableDisclosureClassName(el.classList),
  }));
  for (let i = 0; i < all.length; i += 1) {
    const details = all[i];
    const entry = entries[i];
    if (!details || !entry || isTemplateDrivenDisclosure(details)) continue;
    const key = formatDisclosureKey(entry.recordId, entry.className, computeDisclosureOrdinal(entries, i));
    const desired = openState.get(key);
    if (desired === undefined) continue;
    if (details.open !== desired) details.open = desired;
  }
}

// Install the once-only, capture-phase delegates that make native disclosures
// and checkboxes respond to taps inside the WebView.
export function installWebViewControlDelegates(openState: Map<string, boolean>): void {
  const toggleSummary = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const summary = target.closest('summary');
    if (!summary) return;
    // Let interactive children inside the summary act normally (e.g. an
    // audit-refresh <button> or a data-tab item in a menu summary).
    if (target !== summary && target.closest('button, input, select, textarea, a[href]')) {
      return;
    }
    const details = summary.parentElement;
    if (!(details instanceof HTMLDetailsElement)) return;
    // preventDefault unconditionally: in capture phase this reliably suppresses
    // the native default toggle in both engines, so we never double-toggle on
    // devices where the native gesture *does* fire.
    event.preventDefault();
    const open = !details.open;
    details.open = open;
    if (!isTemplateDrivenDisclosure(details)) {
      openState.set(disclosureKey(details), open);
    }
  };
  // Capture-phase click covers tap, mouse, AND keyboard activation: a focused
  // <summary> activated by Enter/Space synthesizes a click, which this handler
  // toggles (preventDefault stops the native default). No separate keydown
  // handler — that would double-toggle on the synthesized click.
  document.addEventListener('click', toggleSummary, true);

  // label -> checkbox/radio: native label activation is unreliable in WebView.
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const label = target.closest('label');
    if (!label) return;
    // The Ask Agent toggle already owns its click in JS — don't double-handle.
    if (label.closest('[data-ask-agent-after-draft]')) return;
    const input = resolveLabelCheckbox(label);
    if (!input) return;
    if (target === input) return; // direct hit on the box — native handles it
    event.preventDefault();
    input.checked = !input.checked;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, true);
}
