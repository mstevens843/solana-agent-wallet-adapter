// Pure, testable notification logic — extracted from main.ts (which isn't importable) so the
// surface/capability/category rules can be unit-tested. main.ts owns the DOM + state + bridge calls.
//
// Two delivery models, deliberately distinct:
//  - LOCAL alerts: the Web Notification API (web) or the native showNotification bridge (app). Fire
//    while the app's JS is alive. No sign-in.
//  - PUSH: server-sent (FCM/APNs), reaches a CLOSED app. Requires sign-in, because the device→wallet
//    binding is the cloud session.
// The card must tell the user which one they're getting rather than silently doing nothing — the
// original bug was a card that said "browser doesn't expose the Notification API" on a phone.

/** Where notifications are being delivered, which decides copy AND whether push is possible. */
export type NotificationSurface = 'web' | 'ios-app' | 'android-app';

export interface NotificationSurfaceInput {
  isIosApp: boolean;
  isAndroidApp: boolean;
}

export function notificationSurface(input: NotificationSurfaceInput): NotificationSurface {
  if (input.isIosApp) return 'ios-app';
  if (input.isAndroidApp) return 'android-app';
  return 'web';
}

export function surfaceIsNativeApp(surface: NotificationSurface): boolean {
  return surface !== 'web';
}

/**
 * The categories a user can toggle. Each maps to the server PushEventType(s) it enables for push, and
 * to the local-fire predicate main.ts already runs. `pending` is LOCAL-ONLY: "still pending after 60s"
 * is a client-side timer with no server event, so it never registers for push.
 */
export type NotificationCategory =
  | 'due'
  | 'confirmed'
  | 'failed'
  | 'limitFilled'
  | 'dcaFilled'
  | 'borrowAtRisk'
  | 'pending';

export type PushEventType =
  | 'recurring.occurrence.ready'
  | 'recurring.occurrence.overdue'
  | 'jupiter.trigger.filled'
  | 'jupiter.recurring.filled'
  | 'tx.confirmed'
  | 'tx.failed'
  | 'lend.borrow.at_risk';

export interface NotificationCategoryDef {
  id: NotificationCategory;
  /** i18n key for the toggle label (added to all 11 catalogs). */
  labelKey: string;
  /** Server events this category enables. Empty ⇒ local-only (never sent to register-device). */
  pushEvents: PushEventType[];
}

export const NOTIFICATION_CATEGORIES: readonly NotificationCategoryDef[] = [
  { id: 'confirmed', labelKey: 'Transaction confirmed', pushEvents: ['tx.confirmed'] },
  { id: 'failed', labelKey: 'Transaction failed', pushEvents: ['tx.failed'] },
  { id: 'due', labelKey: 'Repeat payment due', pushEvents: ['recurring.occurrence.ready', 'recurring.occurrence.overdue'] },
  { id: 'limitFilled', labelKey: 'Limit order filled', pushEvents: ['jupiter.trigger.filled'] },
  { id: 'dcaFilled', labelKey: 'DCA order filled', pushEvents: ['jupiter.recurring.filled'] },
  { id: 'borrowAtRisk', labelKey: 'Borrow position at risk', pushEvents: ['lend.borrow.at_risk'] },
  { id: 'pending', labelKey: 'Pending transactions (>60s)', pushEvents: [] },
];

/** Per-category on/off. Absent ⇒ off. */
export type NotificationCategoryMap = Partial<Record<NotificationCategory, boolean>>;

/**
 * The device-registration category map the server stores (PushEventType → enabled). Built from the
 * user's toggles: an event is enabled iff its owning category is on. Local-only categories contribute
 * nothing, so a push device is never registered for an event the server can't source.
 */
export function pushCategoryMapForRegistration(categories: NotificationCategoryMap): Partial<Record<PushEventType, boolean>> {
  const out: Partial<Record<PushEventType, boolean>> = {};
  for (const def of NOTIFICATION_CATEGORIES) {
    if (categories[def.id] !== true) continue;
    for (const event of def.pushEvents) out[event] = true;
  }
  return out;
}

/** Any push-capable category enabled? If not, there's nothing to register a device for. */
export function hasAnyPushCategory(categories: NotificationCategoryMap): boolean {
  return NOTIFICATION_CATEGORIES.some((def) => def.pushEvents.length > 0 && categories[def.id] === true);
}

/**
 * Whether the PUSH path (server-sent, closed-app) is available on this surface right now.
 * Deliberately the "two flags must agree" shape used elsewhere (iosPlanConnectorAvailable): a server
 * kill-switch flag AND the binary actually exposing the bridge. An old app binary that lacks the
 * bridge stays local-only rather than showing a button that can't work.
 */
export interface PushAvailabilityInput {
  surface: NotificationSurface;
  /** Server flag (remote config / build) — the kill switch. */
  serverEnabled: boolean;
  /** This binary exposes the native push bridge (iOS: always on a Capacitor build; Android: the capability bit). */
  bridgeAvailable: boolean;
  /** Push binds device→wallet through the session, so it needs sign-in. */
  signedIn: boolean;
}

export interface PushAvailability {
  /** Push can be offered/toggled. */
  available: boolean;
  /** Why not, for honest card copy. */
  blockedReason?: 'web-surface' | 'server-disabled' | 'old-binary' | 'signed-out';
}

export function pushAvailability(input: PushAvailabilityInput): PushAvailability {
  if (input.surface === 'web') return { available: false, blockedReason: 'web-surface' };
  if (!input.serverEnabled) return { available: false, blockedReason: 'server-disabled' };
  if (!input.bridgeAvailable) return { available: false, blockedReason: 'old-binary' };
  if (!input.signedIn) return { available: false, blockedReason: 'signed-out' };
  return { available: true };
}

/**
 * The card's explanatory line, per surface + push state. Returns an i18n KEY (main.ts runs it through
 * t()). This is the string that was lying — never claim "browser doesn't expose the API" on a phone.
 */
export function notificationCardBlurbKey(surface: NotificationSurface, push: PushAvailability): string {
  if (surface === 'web') {
    return 'Notifications fire only when this tab is in the background. Tab title also shows the pending count.';
  }
  if (push.available) {
    return 'Get notified on this device — even when the app is closed — for the events you turn on below.';
  }
  if (push.blockedReason === 'signed-out') {
    return 'Sign in to receive notifications when the app is closed. While signed out, alerts show only while the app is open.';
  }
  if (push.blockedReason === 'old-binary') {
    return 'Update the app to receive notifications when it is closed. Alerts still show while the app is open.';
  }
  // server-disabled: local alerts still work.
  return 'Notifications show while the app is open.';
}
