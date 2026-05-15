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
