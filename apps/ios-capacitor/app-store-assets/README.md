# App Store assets

Mirror of `apps/android-twa/play-assets/` for the iOS App Store submission.
Generated artifacts (screenshots, ipa) land in `build/` and `app-store-assets/screenshots/`;
hand-curated marketing assets live here.

## Files

- `listing.md` — human-readable App Store description source.
- `../fastlane/metadata/en-US/` — Fastlane `deliver` metadata files uploaded by the release lane.
- `keywords.txt` — comma-separated keywords (max 100 chars).
- `promotional_text.txt` — what's-new text (max 170 chars).
- `release_notes.txt` — version-specific release notes.
- `support_url.txt`, `marketing_url.txt`, `privacy_url.txt` — required URLs.
- `icon-1024.png` — marketing icon, 1024×1024, no alpha.
- `screenshots/` — Fastlane `snapshot` output for required device sizes:
  - 6.7" (iPhone 15 Pro Max, 1290×2796)
  - 6.5" (iPhone 11 Pro Max, 1242×2688)
  - 5.5" (iPhone 8 Plus, 1242×2208) — required by App Store for older app
    historical compatibility on some submissions.

## Refreshing screenshots

```
cd apps/ios-capacitor
bundle install
bundle exec fastlane screenshots
```

This drives the AppUITests target in headless simulators across the device
matrix above and dumps PNGs into `app-store-assets/screenshots/`. The
`release` lane refuses App Store submission until at least one PNG exists
under that directory.

## Submitting

The Fastlane `release` lane uploads metadata from `fastlane/metadata/en-US`,
screenshots from `app-store-assets/screenshots/`, plus the .ipa built from the
workspace. See `../fastlane/Fastfile`.
