export interface NativeAppBackControlLabels {
  ariaLabel: string;
  label: string;
}

export interface NativeAppBackControlDeps {
  bindOnce: (
    element: EventTarget | null | undefined,
    type: string,
    handler: (event: Event) => void,
  ) => void;
  trackNavClick: (route: '/demo', area: 'native_app_back') => void;
  navigateTo: (route: '/demo') => void;
}

export function renderNativeAppBackControl(labels: NativeAppBackControlLabels): string {
  return `
    <button class="native-app-back-control" type="button" data-native-app-back-control aria-label="${escapeHtml(labels.ariaLabel)}">
      <span class="native-app-back-control-chevron" aria-hidden="true">&#8249;</span>
      <span class="native-app-back-control-label">${escapeHtml(labels.label)}</span>
    </button>
  `;
}

export function bindNativeAppBackControl(root: ParentNode, deps: NativeAppBackControlDeps): boolean {
  const button = root.querySelector<HTMLButtonElement>('[data-native-app-back-control]');
  if (!button) return false;
  deps.bindOnce(button, 'click', (event) => {
    event.preventDefault();
    deps.trackNavClick('/demo', 'native_app_back');
    deps.navigateTo('/demo');
  });
  return true;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch] ?? ch));
}
