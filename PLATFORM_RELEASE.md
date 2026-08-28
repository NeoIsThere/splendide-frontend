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

- desktop web and mobile web install the push service worker, ask permission only after the deadline alert toggle is selected, and show a banner with sound;
- Electron persists future schedules, refreshes the authenticated deadline snapshot while hidden, starts in the background at login after notification opt-in, cancels remote edits after synchronization, and opens the correct page/task;
- Android creates the `deadlines` notification channel, receives FCM in foreground/background/terminated states, and opens the correct task;
- iOS receives APNs-through-FCM in foreground/background/terminated states with alert, sound, and badge presentation;
- sign out, rapid account switching, denied permission, offline deadline editing, rescheduling, completion, and deletion do not leave stale alerts.

Android `versionCode` and iOS `CURRENT_PROJECT_VERSION` must increase for every store submission. The human-facing version must remain aligned with `package.json`.

## Data-model release

All section requests declare `dataModel=single-list-v3`. After the backend migration, earlier clients receive HTTP 426 and cannot overwrite the one-list model. Ship the signed 1.1.0 native binaries before activating the migration, and deploy the new web bundle with the migrated backend.
