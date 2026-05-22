# shared-test-fixtures

Cross-platform JSON fixtures that Android JVM tests, iOS XCTest tests, and JS
vitest tests all consume. Any change to a fixture must keep all three platforms
green; drift fails CI.

## Layout

- `fixtures/system-prompts.json` — verbatim PLAN / REVIEW / ASK system prompts.
  Loaded by Android `DeviceAgentSystemPromptsTest.kt`, iOS
  `DeviceAgentSystemPromptsTests.swift`, and JS planner tests.
- `fixtures/secret-redactor-cases.json` — `{ input, expected }[]` for redactor
  parity. Patterns must match across Android `SecretRedactorTest.kt`, iOS
  `SecretRedactorTests.swift`, and JS `secretRedactor.test.ts`.
- `fixtures/memo-router-cases.json` — memo envelope hashing + decision tree
  parity inputs. Used by Android `MemoProofRouterTest.kt` and (future) iOS
  `MemoRouterTests.swift`. iOS does not ship MWA, so the decision-tree cases
  only apply to Android, but the memo-envelope hashing applies to both.
- `fixtures/voucher-fixtures.json` — `{ voucher, canonicalJson, sha256Hex,
  ed25519Signature }` keyed by a fixed test seed. Both Android
  `StreamingSessionControllerInstrumentedTest.kt` and iOS `StreamingSessionTests.swift`
  must produce identical hashes + signatures.
- `fixtures/base58-vectors.json` — known Base58 encode/decode vectors. Used by
  both platforms' Base58 tests.

## Updating a fixture

1. Edit the JSON.
2. Run Android JVM tests: `pnpm -F apps/android-twa test` (or via gradle).
3. Run iOS XCTest: from Xcode or `xcodebuild test -scheme ...`.
4. Run JS tests: `pnpm -F apps/browser-demo test`.

If any platform diverges, the fix is usually one of:
- Add the missing case to the platform's port.
- Fix the platform's implementation to match the canonical fixture.
- (Rare) Update the fixture and all platforms together.

Never branch the fixture per platform — the whole point is single source of truth.
