export interface ApprovalBadgeSpec<T = unknown> {
  id: string;
  match: (action: T) => boolean;
  render: (action: T) => string;
}

const badges: ApprovalBadgeSpec[] = [];

export function registerApprovalBadge<T>(spec: ApprovalBadgeSpec<T>): void {
  if (badges.some((existing) => existing.id === spec.id)) return;
  badges.push(spec as ApprovalBadgeSpec);
}

export function renderApprovalBadges(action: unknown): string {
  return badges
    .filter((badge) => {
      try {
        return badge.match(action);
      } catch {
        return false;
      }
    })
    .map((badge) => {
      try {
        return badge.render(action);
      } catch {
        return '';
      }
    })
    .join('');
}

export function listApprovalBadges(): readonly ApprovalBadgeSpec[] {
  return badges;
}
