# Platform release checklist

Splendide 1.1.0 introduces the one-list page model, deadline alerts, cross-page desktop drag, and synchronized background themes.

## Firebase client configuration

- Android uses `android/app/google-services.json` for the Firebase app whose package is `app.splendide.mobile`.
- iOS uses `ios/App/App/GoogleService-Info.plist` for the Firebase app and the Xcode project includes it in Copy Bundle Resources.
- The Firebase project must have an APNs authentication key or certificate configured for the iOS app. That credential belongs in Firebase/Apple infrastructure, not in this repository.
- The backend service-account JSON is separate private server material and must never be copied into either native application.

## Required verification

Run:

```text
npm ci
npm run build
npm run electron:build
npm run mobile:sync
```

Run the final iOS sync on macOS before opening Xcode. It creates the ignored
SwiftPM symlink required by `@capacitor-firebase/messaging`; the committed
`Package.swift` keeps portable forward-slash paths for the remaining packages.

Then verify on physical/release-capable targets:

- desktop web and mobile web install the push service worker, ask permission only after explicit opt-in, and show a banner with sound; signed-out reminders register an anonymous, content-free deadline snapshot so background delivery does not require an account, while an in-app timer deduplicates foreground delivery;
- Electron persists future schedules, refreshes the authenticated deadline snapshot while hidden, starts in the background at login after notification opt-in, cancels remote edits after synchronization, and opens the correct page/task;
- Android creates the `deadlines` notification channel, uses local OS schedules for signed-out deadlines, receives FCM for signed-in deadlines in foreground/background/terminated states, and opens the correct task; local reminders are inexact and may be delayed by Doze;
- iOS uses local OS schedules for signed-out deadlines and receives APNs-through-FCM for signed-in deadlines in foreground/background/terminated states with banner, sound, badge, and notification-list presentation;
- sign out, rapid account switching, denied permission, offline deadline editing, rescheduling, completion, and deletion do not leave stale alerts.

Android `versionCode` and iOS `CURRENT_PROJECT_VERSION` must increase for every store submission. The human-facing version must remain aligned with `package.json`.

## Data-model release

All section requests declare `dataModel=single-list-v3`. After the backend migration, earlier clients receive HTTP 426 and cannot overwrite the one-list model. Ship the signed 1.1.0 native binaries before activating the migration, and deploy the new web bundle with the migrated backend.

## Session and checkout update (October 2026)

Apply backend migration `20261008120000_revocable_sessions_and_checkout` before starting the updated API. It adds revocable sign-in sessions and durable checkout coordination; it does not rewrite task data. Existing tokens require one sign-in after deployment because they have no session identifier.

Release the accompanying client change on web, Electron, Android, and iOS: logout must send the captured access token before clearing its local credential. Older native clients do not send that credential on logout. Browser refresh cookies now use `/api/auth`, and the API clears both the old and new cookie paths. Password reset revokes every session; password change preserves only the current session.

The backend Docker runtime is Node 22, matching the minimum already required by Firebase Admin 14. Security updates keep the direct dependencies on their existing major versions. Scoped overrides update `deepmerge-ts` for Prisma configuration, `uuid` for gaxios 6, and `esbuild` for tsx. Recheck these overrides when upgrading their parent packages.

The integration suite creates and removes an isolated MySQL database. Its Stripe calls are mocked, including concurrency, lost responses, checkout expiry, and subscription recovery; run the normal Stripe test-mode release check before a billing rollout. Native Gradle/Xcode builds and a Docker image build still require their respective toolchains.
