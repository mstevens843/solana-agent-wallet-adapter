export interface ChatProofActionLike {
  kind: string;
  params?: Record<string, unknown>;
  note?: string;
}

export function isChatSignProofAction(action: ChatProofActionLike): boolean {
  return action.kind === 'manual_review' && action.params?.proofKind === 'sign_proof';
}

export function chatSignProofStatement(action: ChatProofActionLike): string {
  if (!isChatSignProofAction(action)) return '';
  const raw = action.params?.statement ?? action.note ?? '';
  return typeof raw === 'string' ? raw.trim() : String(raw).trim();
}
