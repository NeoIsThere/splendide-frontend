# Splendide mobile release setup

The mobile app uses the existing Angular application inside Capacitor 8. Android and iOS share the same UI and sync code. Native integrations provide secure refresh-token storage, Google/Apple sign-in, StoreKit/Google Play Billing through RevenueCat, Firebase Cloud Messaging, deep links, status-bar/safe-area handling, and haptic drag feedback.

The identifiers are already fixed in the projects:

- Display name: `Splendide`
- iOS bundle ID: `app.splendide.mobile`
- Android package: `app.splendide.mobile`
- RevenueCat entitlement: `premium`
- RevenueCat current offering packages: monthly and annual

Do not create store records under a different identifier unless the code and both native projects are changed first.

## 1. Accounts and local tools

Create or verify these accounts:

- Apple Developer Program and App Store Connect
- Google Play Console
- Firebase/Google Cloud
- RevenueCat

For Android builds, install Node 22, Android Studio with Android SDK 36, and JDK 21. For iOS builds, use a Mac with a current Xcode release and Node 22. Run `npm install` in `frontend` before either build.

## 2. Deploy the backend migration and environment

Deploy the backend before distributing a mobile build. Building the frontend or a new APK does not update the API: the backend image must contain the mobile CORS and native refresh-token code.

```bash
cd backend
npm install
npm run db:deploy
npm run build
```

For the production Docker deployment, push/build the new backend image, set `BACKEND_IMAGE_SHA` on the server to that image's commit SHA, then run:

```bash
docker compose pull backend backend-migrate
docker compose up -d backend-migrate backend
```

Verify the deployed API from a checkout of `backend`:

```bash
npm run verify:mobile-auth -- https://api.splendide.app/api
```

The check covers Android's localhost origins, iOS's `capacitor://localhost` origin, the `X-Splendide-Client` preflight header, and a route-level login response. Do not work around a failed check by removing the mobile header: the same backend contract returns refresh tokens to native secure storage so sessions survive app restarts.

Add these production environment variables to the backend host:

```dotenv
APPLE_CLIENT_IDS=app.splendide.mobile
FIREBASE_PROJECT_ID=your-firebase-project-id
GOOGLE_APPLICATION_CREDENTIALS=/absolute/secure/path/firebase-service-account.json
REVENUECAT_SECRET_API_KEY=sk_your_revenuecat_secret_key
REVENUECAT_PREMIUM_ENTITLEMENT_ID=premium
REVENUECAT_WEBHOOK_AUTHORIZATION=Bearer a-long-random-value
```

Notes:

- Keep the Firebase service-account JSON and RevenueCat secret key outside Git.
- `GOOGLE_APPLICATION_CREDENTIALS` can be omitted when the server already has Google Application Default Credentials with Firebase Messaging permission.
- The RevenueCat webhook is recommended for immediate cancellation/refund updates. The backend also reconciles active mobile subscriptions every six hours and whenever the mobile app starts, so access does not depend only on webhook delivery.
- The webhook authorization value is compared exactly, including the `Bearer ` prefix if you use one.

The migration adds notification preferences, device tokens, and separate Stripe/mobile/VIP premium sources. This separation prevents one billing provider from revoking access granted by another.

## 3. Firebase notifications

In one Firebase project, add:

1. An Android app with package `app.splendide.mobile`.
2. An iOS app with bundle ID `app.splendide.mobile`.

Download and place the configuration files here:

- `frontend/android/app/google-services.json`
- `frontend/ios/App/App/GoogleService-Info.plist`

For iOS, create an APNs authentication key in the Apple Developer portal and upload it in Firebase under Project settings > Cloud Messaging. In Xcode, enable the Push Notifications capability for the App target.

For the backend, create a Firebase Admin service account, store its JSON securely on the server, and point `GOOGLE_APPLICATION_CREDENTIALS` to it. The app only requests notification permission after the user enables **Shared page notifications** in settings.

The server notification has no body. Its visible title is exactly:

```text
<page title>: an item has been added
```

It is sent to the owner and signed-in collaborators who have enabled the global setting, excluding the signed-in user who added the item.

Firebase setup reference: https://firebase.google.com/docs/cloud-messaging

## 4. Google and Apple sign-in

### Google

Keep the existing web OAuth client ID as `googleClientId`. In Google Cloud Console, add:

- An Android OAuth client in the same Google Cloud project as the web client, with package `app.splendide.mobile` and the signing SHA-1 of each build you install. The current debug APK uses `E7:74:96:85:B7:FB:A0:E0:3D:0B:98:9C:2E:0D:72:20:68:C8:BA:5C`.
- Separate Android OAuth clients for the release/upload signing certificate and the Google Play App Signing certificate once those builds exist. Confirm the fingerprints with `gradlew signingReport` or Play Console rather than reusing the debug value.
- An iOS OAuth client for `app.splendide.mobile`.

The Web OAuth client ID goes in `googleClientId` and remains the backend token audience. Android OAuth client IDs stay in Google Cloud Console; do not put an Android client ID into `webClientId`. If the Google OAuth consent screen is in Testing, add every account used on a test device under **Audience > Test users**.

Then edit `frontend/src/environments/environment.mobile.ts`:

```ts
googleIosClientId: 'YOUR_IOS_CLIENT_ID.apps.googleusercontent.com',
```

Open `GoogleService-Info.plist`, copy its `REVERSED_CLIENT_ID`, and add that value as a second URL scheme in `frontend/ios/App/App/Info.plist` next to `splendide`. Re-run `npm run mobile:sync` on the Mac afterward.

Google sign-in and Apple sign-in are initialized independently. The app does not offer Apple sign-in on Android, so no `apple.android.redirectUrl` or Apple web callback is required for the Android build.

### Apple

In Certificates, Identifiers & Profiles:

1. Register or open the App ID `app.splendide.mobile`.
2. Enable Sign in with Apple, Push Notifications, and Associated Domains.
3. Regenerate signing profiles if you are not using automatic signing.

In Xcode, select your development team and confirm these capabilities on the App target:

- Sign in with Apple
- Push Notifications
- Associated Domains with `applinks:splendide.app`
- In-App Purchase

The backend accepts `app.splendide.mobile` as the Apple identity-token audience through `APPLE_CLIENT_IDS`.

## 5. App Store and Google Play subscriptions

Create monthly and yearly auto-renewing subscriptions in both stores. Suggested product IDs are:

- `premium_monthly`
- `premium_yearly`

In RevenueCat:

1. Add the iOS and Android apps to one project and connect their store credentials.
2. Import both products from each store.
3. Create entitlement `premium` and attach all four platform products.
4. Create a current offering with a monthly package and an annual package. Use RevenueCat's standard `$rc_monthly` and `$rc_annual` package identifiers so the app recognizes them as `MONTHLY` and `ANNUAL`.
5. Copy each app's public SDK key into `frontend/src/environments/environment.mobile.ts`:

```ts
revenueCatAppleApiKey: 'appl_...',
revenueCatGoogleApiKey: 'goog_...',
```

6. Create a server secret key and set `REVENUECAT_SECRET_API_KEY` only on the backend.
7. If your RevenueCat plan supports webhooks, create one for:

```text
https://api.splendide.app/api/mobile-billing/webhook
```

Set its Authorization header to the exact value in `REVENUECAT_WEBHOOK_AUTHORIZATION` and send both sandbox and production events while testing.

RevenueCat key and webhook references:

- https://www.revenuecat.com/docs/projects/authentication
- https://www.revenuecat.com/docs/integrations/webhooks

The custom VIP-code redemption UI intentionally remains web-only. Apple prohibits an app from using its own license/code mechanism to unlock digital functionality, and Google Play requires Play Billing for in-app digital upgrades. Existing VIP and Stripe premium access still works after the same user signs in on mobile.

## 6. Universal links and Android App Links

Deploy these files without redirects and with `application/json` content:

- `https://splendide.app/.well-known/apple-app-site-association`
- `https://splendide.app/.well-known/assetlinks.json`

Start from:

- `frontend/mobile-config/apple-app-site-association.template.json`
- `frontend/mobile-config/assetlinks.template.json`

Replace the Apple Team ID and the Google Play App Signing SHA-256 fingerprint. Do not include the `.template.json` filename or a `.json` suffix on `apple-app-site-association` when deploying it.

The app handles `/share/*`, `/verify-email`, and `/reset-password`, plus the fallback `splendide://` URL scheme.

## 7. Build and test

Replace every `REPLACE_WITH_...` value in `environment.mobile.ts` before a release build.

### Android

```bash
cd frontend
npm install
npm run mobile:sync
cd android
./gradlew bundleRelease
```

On Windows use `gradlew.bat bundleRelease`. Configure Android Studio to use JDK 21. In Android Studio, use Build > Generate Signed App Bundle, create or select an upload key, and keep the keystore/passwords outside Git. Enroll in Google Play App Signing and upload the generated `.aab` to an internal test track first.

For local debug validation:

```bash
./gradlew assembleDebug
```

### iOS

Run this on the Mac so Swift Package Manager paths and symlinks are generated for macOS:

```bash
cd frontend
npm install
npm run mobile:sync
npx cap open ios
```

In Xcode:

1. Select the App target and your Apple team.
2. Verify the four capabilities from section 4.
3. Confirm `GoogleService-Info.plist` belongs to the App target.
4. Set the marketing version and increment the build number.
5. Test on a physical iPhone, including Sign in with Apple, notifications, purchase/restore, deep links, background/resume sync, and drag/drop.
6. Product > Archive, then distribute to App Store Connect and TestFlight.

## 8. Store-console information you must provide

### App Store Connect

- App record for bundle `app.splendide.mobile`
- Paid Apps agreement, tax, and banking information for subscriptions
- App name, subtitle, description, keywords, category, support URL, marketing URL, and privacy URL
- Screenshots for every required iPhone/iPad size you choose to support
- App Privacy answers covering account email/name, user content, purchase/subscription status, and the Firebase device token
- Subscription group, localized names/descriptions, prices, and review screenshots
- A working review account with premium access or clear sandbox purchase steps
- Review notes explaining shared-page collaboration, the opt-in notification, and where purchase/restore/account deletion are located

Apple requires in-app account deletion when account creation is supported; it is already available in Settings.

### Google Play Console

- App record for package `app.splendide.mobile` and Play App Signing
- Store listing, phone/tablet screenshots, feature graphic, category, contact email, support site, and privacy URL
- App content declarations: Data safety, content rating, ads, target audience, and app access
- Subscription/base-plan configuration matching the RevenueCat products
- License testers and an internal/closed testing release before production
- A working review account and instructions for shared pages and subscriptions
- Account deletion URL: `https://splendide.app/delete-account`

Google requires both in-app deletion and a web deletion/request resource for apps that create accounts. The `/delete-account` page provides the web flow and privacy contact.

Store policy references:

- Apple App Review Guidelines: https://developer.apple.com/app-store/review/guidelines/
- Apple account deletion: https://developer.apple.com/support/offering-account-deletion-in-your-app
- Google Play payments: https://support.google.com/googleplay/android-developer/answer/9858738
- Google Play account deletion: https://support.google.com/googleplay/android-developer/answer/13327111

## 9. Final pre-submission checks

- Test purchases with App Store sandbox and Google Play license testers, never real product credentials in development.
- Confirm purchase, restore, cancellation, expiration, grace period, and cross-platform premium access.
- Verify notification off/on, denied permission, token rotation, sign-out, and multiple devices.
- Add an item as a second collaborator and verify the actor gets no notification while other opted-in members do.
- Test the exact notification text with an empty page title and a long page title.
- Verify shared links from Messages/Mail and email verification/reset links from a cold launch.
- Test drag reorder and cross-list moves on physical Android and iOS devices.
- Confirm the privacy policy and store Data Safety/App Privacy answers match the production SDK configuration.
- Increment Android `versionCode` and iOS build number for every uploaded build.
