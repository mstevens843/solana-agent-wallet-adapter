export interface ApprovalErrorFields {
  error?: string;
  txError?: string;
}

export function approvalErrorMessages(record: ApprovalErrorFields): string[] {
  const messages: string[] = [];
  const seen = new Set<string>();
  for (const value of [record.error, record.txError]) {
    const message = typeof value === 'string' ? value.trim() : '';
    if (!message) continue;
    const key = message.replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    messages.push(message);
  }
  return messages;
}
