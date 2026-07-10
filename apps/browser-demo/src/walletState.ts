let connectedAddress: string | undefined;
let connectedCluster: string | undefined;

export function getConnectedAddress(): string | undefined {
  return connectedAddress;
}

export function setConnectedAddress(address: string | undefined | null): void {
  connectedAddress = address && address.length > 0 ? address : undefined;
}

export function getConnectedCluster(): string | undefined {
  return connectedCluster;
}

export function setConnectedCluster(cluster: string | undefined | null): void {
  connectedCluster = cluster && cluster.length > 0 ? cluster : undefined;
}

// ---------------------------------------------------------------------------
// Cloud auth (shared with standalone dev-tab clients)
//
// The dev-tab cloud clients (streamingClient, mppClient, the AP2 inbound fetch,
// and the /api/session probe) must NOT import main.ts, but on native
// (iOS/Android/Tauri) the Agentic Cloud session is Bearer-token based — the
// same-origin session cookie is omitted (cloudFetchWithContext uses
// credentials:'omit'). main.ts pushes the current native cloud token + client
// id + signed-in flag here on every render so those standalone clients can
// authenticate. On web nothing is pushed, so the same-origin cookie keeps being
// used unchanged.
let cloudAuthToken: string | undefined;
let cloudClientHeader: string | undefined;
let cloudSignedIn = false;

export function setCloudAuth(input: {
  token?: string | null;
  clientHeader?: string | null;
  signedIn?: boolean;
}): void {
  if (input.token !== undefined) {
    cloudAuthToken = input.token && input.token.length > 0 ? input.token : undefined;
  }
  if (input.clientHeader !== undefined) {
    cloudClientHeader = input.clientHeader && input.clientHeader.length > 0 ? input.clientHeader : undefined;
  }
  if (input.signedIn !== undefined) {
    cloudSignedIn = input.signedIn;
  }
}

export function getCloudAuthToken(): string | undefined {
  return cloudAuthToken;
}

export function getCloudClientHeader(): string | undefined {
  return cloudClientHeader;
}

// True when the connected wallet has a usable Agentic Cloud session. Drives the
// "signed-out" UI states so cloud-gated tabs render a neutral sign-in prompt
// instead of an infinite spinner or a red 401 retry.
export function isCloudSignedIn(): boolean {
  return cloudSignedIn;
}

// Header entries to merge into an outgoing cloud request. Empty on web (cookie
// auth), so spreading it is always safe.
export function cloudAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (cloudClientHeader) headers['x-agentic-client'] = cloudClientHeader;
  if (cloudAuthToken) headers.authorization = `Bearer ${cloudAuthToken}`;
  return headers;
}
