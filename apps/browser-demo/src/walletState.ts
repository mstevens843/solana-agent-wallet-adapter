let connectedAddress: string | undefined;

export function getConnectedAddress(): string | undefined {
  return connectedAddress;
}

export function setConnectedAddress(address: string | undefined | null): void {
  connectedAddress = address && address.length > 0 ? address : undefined;
}
