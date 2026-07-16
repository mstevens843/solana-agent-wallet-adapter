import { describe, expect, it } from 'vitest';

import {
  NOTIFICATION_CATEGORIES,
  hasAnyPushCategory,
  notificationCardBlurbKey,
  notificationSurface,
  pushAvailability,
  pushCategoryMapForRegistration,
  surfaceIsNativeApp,
} from '../pushNotifications.js';

describe('notification surface detection', () => {
  it('resolves the surface from the runtime shell flags', () => {
    expect(notificationSurface({ isIosApp: true, isAndroidApp: false })).toBe('ios-app');
    expect(notificationSurface({ isIosApp: false, isAndroidApp: true })).toBe('android-app');
    expect(notificationSurface({ isIosApp: false, isAndroidApp: false })).toBe('web');
    // A shell can't be both; iOS wins deterministically.
    expect(notificationSurface({ isIosApp: true, isAndroidApp: true })).toBe('ios-app');
  });

  it('classifies native vs web', () => {
    expect(surfaceIsNativeApp('ios-app')).toBe(true);
    expect(surfaceIsNativeApp('android-app')).toBe(true);
    expect(surfaceIsNativeApp('web')).toBe(false);
  });
});

describe('push category → server event mapping', () => {
  it('registers a device only for the events whose category is ON', () => {
    const map = pushCategoryMapForRegistration({ confirmed: true, failed: false, borrowAtRisk: true });
    expect(map).toEqual({ 'tx.confirmed': true, 'lend.borrow.at_risk': true });
  });

  it('expands "due" to both the ready and overdue events', () => {
    expect(pushCategoryMapForRegistration({ due: true })).toEqual({
      'recurring.occurrence.ready': true,
      'recurring.occurrence.overdue': true,
    });
  });

  it('NEVER registers a local-only category for push (pending has no server event)', () => {
    // "still pending after 60s" is a client timer; the server can't source it, so a push device must
    // not claim to want it.
    expect(pushCategoryMapForRegistration({ pending: true })).toEqual({});
    expect(hasAnyPushCategory({ pending: true })).toBe(false);
  });

  it('hasAnyPushCategory is true only when a push-capable category is on', () => {
    expect(hasAnyPushCategory({})).toBe(false);
    expect(hasAnyPushCategory({ confirmed: true })).toBe(true);
    expect(hasAnyPushCategory({ limitFilled: true })).toBe(true);
  });

  it('every category label is a non-empty i18n key, and every push event is namespaced', () => {
    for (const def of NOTIFICATION_CATEGORIES) {
      expect(def.labelKey.length).toBeGreaterThan(0);
      for (const event of def.pushEvents) expect(event).toMatch(/\./);
    }
  });
});

describe('push availability — the "two flags must agree" gate', () => {
  const base = { surface: 'ios-app' as const, serverEnabled: true, bridgeAvailable: true, signedIn: true };

  it('is available only when surface is native AND server-on AND binary-capable AND signed-in', () => {
    expect(pushAvailability(base)).toEqual({ available: true });
  });

  it('web never gets push (it has local Web Notifications instead)', () => {
    expect(pushAvailability({ ...base, surface: 'web' })).toEqual({ available: false, blockedReason: 'web-surface' });
  });

  it('an OLD binary lacking the bridge stays local-only, not a broken button', () => {
    expect(pushAvailability({ ...base, bridgeAvailable: false })).toEqual({ available: false, blockedReason: 'old-binary' });
  });

  it('the server kill-switch disables push without a new build', () => {
    expect(pushAvailability({ ...base, serverEnabled: false })).toEqual({ available: false, blockedReason: 'server-disabled' });
  });

  it('signed-out gets local alerts only (push binds device→wallet via the session)', () => {
    expect(pushAvailability({ ...base, signedIn: false })).toEqual({ available: false, blockedReason: 'signed-out' });
  });

  it('checks in priority order: surface before server before binary before sign-in', () => {
    // A web build that is also signed-out reports the web reason, not signed-out — the surface is the
    // more fundamental fact.
    expect(pushAvailability({ surface: 'web', serverEnabled: false, bridgeAvailable: false, signedIn: false }))
      .toEqual({ available: false, blockedReason: 'web-surface' });
  });
});

describe('honest card copy (the original bug was a lying string)', () => {
  it('never tells a phone the browser lacks the Notification API', () => {
    for (const surface of ['ios-app', 'android-app'] as const) {
      for (const reason of ['server-disabled', 'old-binary', 'signed-out', undefined] as const) {
        const key = notificationCardBlurbKey(surface, reason ? { available: false, blockedReason: reason } : { available: true });
        expect(key).not.toMatch(/does not expose|browser/i);
      }
    }
  });

  it('signed-out copy explicitly says sign in for closed-app delivery', () => {
    expect(notificationCardBlurbKey('ios-app', { available: false, blockedReason: 'signed-out' })).toMatch(/[Ss]ign in/);
  });

  it('available copy promises closed-app delivery', () => {
    expect(notificationCardBlurbKey('android-app', { available: true })).toMatch(/closed/);
  });
});
