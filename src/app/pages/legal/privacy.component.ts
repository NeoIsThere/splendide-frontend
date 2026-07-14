import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { APP_VERSION } from '../../../environments/environment';

@Component({
  selector: 'app-privacy',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <div class="legal-page">
      <div class="legal-card">
        <a class="legal-back" routerLink="/">&larr; Back to Splendide</a>
        <h1>Privacy Policy</h1>
        <p class="legal-updated">Last updated: July 13, 2026</p>

        <h2>1. Introduction</h2>
        <p>This Privacy Policy explains how Splendide ("we", "us", "our") collects, uses, stores, and shares information when you use the Service. It applies to private local use, account sync features, and shared pages.</p>
        <p>It also explains optional Premium subscriptions.</p>

        <h2>2. Data Controller</h2>
        <p>Splendide is the data controller for personal data processed through the Service. For privacy requests or controller contact details, contact <strong>privacy&#64;email.splendide.app</strong>.</p>

        <h2>3. Data We Collect</h2>
        <h3>Private local use without an account</h3>
        <p>For private pages used without an account, your task content is stored in your browser's local storage and is not synced to our servers. Your browser may also store app settings such as theme preference. If you clear browser storage, this local data may be lost.</p>

        <h3>Shared pages</h3>
        <p>If you create, open, or edit a shared page, the page content is stored on our servers even if you are not logged in. Shared page data may include page identifiers, list titles, task and subtask text, completion status, done dates, ordering information, edit metadata, and activity timestamps. Anyone with the shared page URL can view and edit that page.</p>

        <h3>With an account</h3>
        <p>When you create an account, we collect:</p>
        <ul>
          <li><strong>Email address</strong> - for authentication and account recovery</li>
          <li><strong>Name</strong> (optional) - for personalization</li>
          <li><strong>Password hash</strong> - securely hashed, never stored in plain text</li>
          <li><strong>Google account ID</strong> - if you sign in with Google</li>
          <li><strong>Apple account ID</strong> - if you sign in with Apple</li>
          <li><strong>Theme preference</strong> - to apply your light or night mode preference when you sign in</li>
          <li><strong>Private synced task data</strong> - your sections, list names, tasks, subtasks, completion status, done dates, order, and sync metadata</li>
          <li><strong>Authentication data</strong> - access tokens stored in your browser and refresh tokens stored in secure cookies</li>
          <li><strong>Mobile notification data</strong> - your notification preference, platform, and Firebase device token if you enable shared-page notifications</li>
        </ul>

        <h3>Premium users</h3>
        <p>If you upgrade to Premium, we additionally process billing and subscription information:</p>
        <ul>
          <li><strong>Stripe data</strong> - customer ID, subscription status, billing interval, and payment status needed to manage Premium access. We do not store full card numbers; Stripe handles payment details.</li>
          <li><strong>App store data</strong> - subscription product, status, and entitlement information supplied by Apple, Google Play, and RevenueCat for subscriptions purchased in a mobile app. We do not receive full card details.</li>
        </ul>

        <h3>Technical and security data</h3>
        <p>We and our infrastructure providers may process basic technical data such as IP address, request timestamps, device/browser information, and security logs to operate the Service, prevent abuse, and enforce rate limits.</p>

        <h2>4. Notice for California Users</h2>
        <p>We do not sell personal information and we do not share personal information for cross-context behavioral advertising. In the last 12 months, the categories of personal information we may have collected are identifiers, account credentials, internet or network activity, commercial information for Premium subscriptions, and user-generated task content. The sources are you, your device/browser, Google Sign-In if used, Stripe if you subscribe, and service/security logs.</p>

        <h2>5. Legal Basis for Processing (GDPR)</h2>
        <ul>
          <li><strong>Contract performance</strong> - to provide accounts, authentication, account sync, shared pages, paid subscriptions, and support</li>
          <li><strong>Legitimate interests</strong> - to maintain security, prevent abuse, debug issues, and improve reliability</li>
          <li><strong>Legal obligations</strong> - to keep records required by tax, accounting, payment, or consumer protection laws</li>
          <li><strong>Consent</strong> - where required by law or for optional features that rely on consent</li>
        </ul>

        <h2>6. How We Use Your Data</h2>
        <ul>
          <li>Provide, maintain, sync, and secure the Service</li>
          <li>Authenticate your identity and manage account sessions</li>
          <li>Operate shared pages and allow anyone with the link to collaborate</li>
          <li>Process optional Premium subscriptions through Stripe, Apple, or Google Play</li>
          <li>Send shared-page notifications through Firebase only when you enable them</li>
          <li>Send verification, password reset, support, and service emails through Resend</li>
          <li>Prevent abuse, enforce rate limits, troubleshoot bugs, and comply with legal obligations</li>
        </ul>

        <h2>7. Data Sharing</h2>
        <p>We do not sell your personal data. We share data only as needed to operate the Service:</p>
        <ul>
          <li><strong>Stripe</strong> - for optional Premium subscription billing and subscription management (<a href="https://stripe.com/privacy" target="_blank" rel="noopener">Stripe Privacy Policy</a>)</li>
          <li><strong>Resend</strong> - for transactional emails such as verification and password reset messages, and for forwarding support emails to us (<a href="https://resend.com/legal/privacy-policy" target="_blank" rel="noopener">Resend Privacy Policy</a>)</li>
          <li><strong>Google</strong> - if you use Google Sign-In (<a href="https://policies.google.com/privacy" target="_blank" rel="noopener">Google Privacy Policy</a>)</li>
          <li><strong>Apple</strong> - for Sign in with Apple and App Store subscriptions (<a href="https://www.apple.com/legal/privacy/" target="_blank" rel="noopener">Apple Privacy Policy</a>)</li>
          <li><strong>Google Play and Firebase</strong> - for Android subscriptions and optional mobile push delivery (<a href="https://policies.google.com/privacy" target="_blank" rel="noopener">Google Privacy Policy</a>)</li>
          <li><strong>RevenueCat</strong> - to validate and synchronize App Store and Google Play subscription status (<a href="https://www.revenuecat.com/privacy/" target="_blank" rel="noopener">RevenueCat Privacy Policy</a>)</li>
          <li><strong>Hosting and infrastructure providers</strong> - for database hosting, application hosting, logging, security, and network delivery</li>
          <li><strong>Legal or safety recipients</strong> - if required by law or needed to protect rights, users, or the Service</li>
        </ul>

        <h2>8. Shared Pages Are Public by Link</h2>
        <p>Shared pages are not private. Anyone with the URL can view and edit the page, and there is no owner or admin role. Do not add sensitive, confidential, regulated, or secret information to a shared page. We generally cannot verify ownership of a shared page based only on the link.</p>

        <h2>9. Data Retention</h2>
        <ul>
          <li><strong>Private local data</strong> remains in your browser until you delete it, clear browser storage, or uninstall the app.</li>
          <li><strong>Account and private synced data</strong> are retained while your account is active. When you delete your account, account data and private synced data are deleted from active systems, except where limited retention is required for legal, security, backup, or payment records.</li>
          <li><strong>Shared pages</strong> may be deleted after six months without activity. They may also be removed for abuse, security, or legal reasons.</li>
          <li><strong>Done tasks</strong> are kept only temporarily in the app's done area and are purged as part of the app's normal sync and deletion behavior.</li>
          <li><strong>Pending signup records</strong> expire after 24 hours and are cleaned up automatically. Password reset tokens expire after 1 hour and are removed when used or when the account is updated or deleted.</li>
          <li><strong>Stripe records</strong> are retained by Stripe and may also be retained as needed for billing, tax, accounting, fraud prevention, and legal obligations.</li>
          <li><strong>Mobile device tokens</strong> are removed when invalidated, when your account is deleted, or during sign-out cleanup. Disabling notifications stops their use for delivery.</li>
          <li><strong>Security logs</strong> are retained only as long as reasonably needed for security, debugging, abuse prevention, and legal compliance.</li>
        </ul>

        <h2>10. Your Rights</h2>
        <p>Depending on your location, including under GDPR and California privacy laws where applicable, you may have the right to:</p>
        <ul>
          <li><strong>Access</strong> - request a copy of your personal data</li>
          <li><strong>Rectification</strong> - correct inaccurate data</li>
          <li><strong>Erasure</strong> ("right to be forgotten") - request deletion of your data</li>
          <li><strong>Data portability</strong> - receive your data in a structured, machine-readable format</li>
          <li><strong>Restrict processing</strong> - limit how we use your data</li>
          <li><strong>Object</strong> - object to processing based on legitimate interest</li>
          <li><strong>Withdraw consent</strong> - where processing is based on consent</li>
          <li><strong>Non-discrimination</strong> (California) - we will not discriminate against you for exercising your rights</li>
        </ul>
        <p>To exercise rights, contact <strong>privacy&#64;email.splendide.app</strong>. We may need to verify your identity before fulfilling a request. Some requests may be limited where we cannot verify ownership, where data belongs to a shared page, or where retention is required by law.</p>

        <h2>11. Cookies and Local Storage</h2>
        <p>We use essential authentication cookies, including an HTTP-only refresh token cookie. We also use browser local storage for private local task data, theme settings, access tokens, cached user information, and privacy-conscious analytics identifiers. Native apps store their refresh token in the iOS Keychain or Android encrypted storage. We do not use third-party advertising cookies.</p>
        <p>We use PostHog to understand basic product usage and monitor frontend errors. We disable broad interaction autocapture and session replay by default, and shared-page URLs are redacted before analytics events are sent.</p>

        <h2>12. Data Security</h2>
        <p>We implement appropriate technical and organizational measures to protect your data, including:</p>
        <ul>
          <li>Passwords hashed with bcrypt (12 rounds)</li>
          <li>HTTPS encryption in transit</li>
          <li>HTTP-only, secure cookies for refresh tokens</li>
          <li>Security headers and rate limits</li>
        </ul>
        <p>No online service can guarantee absolute security. Shared page links should be treated as access credentials for that page.</p>

        <h2>13. International Transfers</h2>
        <p>Your data may be processed in countries other than where you live, including the United States. Where required, we rely on appropriate safeguards such as provider data processing terms, Standard Contractual Clauses, or other lawful transfer mechanisms.</p>

        <h2>14. Children's Privacy</h2>
        <p>The Service is not directed to children under 16. We do not knowingly collect personal data from children. If you believe a child has provided us with personal data, contact us and we will delete it.</p>

        <h2>15. Changes to This Policy</h2>
        <p>We may update this Privacy Policy from time to time. We will notify registered users of material changes via email.</p>

        <h2>16. Contact and Complaints</h2>
        <p>For privacy inquiries: <strong>privacy&#64;email.splendide.app</strong></p>
        <p>EU users may also lodge a complaint with your local data protection authority.</p>
        <p class="legal-version">{{ version }}</p>
      </div>
    </div>
  `,
  styles: [`
    .legal-page {
      max-width: 680px;
      margin: 0 auto;
      padding: 48px 24px 80px;
    }
    .legal-card {
      color: var(--text);
    }
    .legal-back {
      font-size: 0.8125rem;
      color: var(--text-secondary);
      text-decoration: none;
      display: inline-block;
      margin-bottom: 24px;
      &:hover { color: var(--text); }
    }
    h1 {
      font-size: 1.75rem;
      font-weight: 700;
      margin: 0 0 8px;
    }
    .legal-updated {
      font-size: 0.8125rem;
      color: var(--text-muted);
      margin: 0 0 32px;
    }
    .legal-version {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 48px;
      text-align: center;
    }
    h2 {
      font-size: 1rem;
      font-weight: 600;
      margin: 28px 0 8px;
    }
    h3 {
      font-size: 0.9375rem;
      font-weight: 600;
      margin: 16px 0 6px;
    }
    p, li {
      font-size: 0.9375rem;
      line-height: 1.6;
      color: var(--text-secondary);
    }
    a {
      color: var(--text);
      text-decoration: underline;
    }
    ul {
      padding-left: 20px;
      margin: 8px 0;
    }
    li { margin-bottom: 4px; }
  `],
})
export class PrivacyComponent {
  protected readonly version = APP_VERSION;
}
