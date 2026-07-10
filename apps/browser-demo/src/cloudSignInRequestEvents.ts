// Lightweight CustomEvent bridge so standalone dev-tab modules (which must not
// import main.ts) can ask the host app to start the Agentic Cloud sign-in flow.
// main.ts registers a single listener that calls runCloudSignIn(). Mirrors the
// ap2InboundDemoEvents.ts pattern. Window-level so it survives dev-tab
// patchPanel re-renders.

export const CLOUD_SIGN_IN_REQUEST_EVENT = 'agentic:cloud-sign-in-request';

export function dispatchCloudSignInRequested(): boolean {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return false;
  window.dispatchEvent(new CustomEvent(CLOUD_SIGN_IN_REQUEST_EVENT));
  return true;
}

export function addCloudSignInRequestedListener(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (): void => handler();
  window.addEventListener(CLOUD_SIGN_IN_REQUEST_EVENT, listener);
  return () => window.removeEventListener(CLOUD_SIGN_IN_REQUEST_EVENT, listener);
}
