import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-privacy',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <div class="legal-page">
      <div class="legal-card">
        <a class="legal-back" routerLink="/">&larr; Back to Splendide</a>
        <h1>Privacy Policy</h1>
        <p class="legal-updated">Last updated: March 24, 2026</p>

        <h2>1. Introduction</h2>
        <p>This Privacy Policy describes how Splendide ("we", "us", "our") collects, uses, and protects your personal data. We are committed to complying with the General Data Protection Regulation (GDPR), the California Consumer Privacy Act (CCPA), and other applicable data protection laws.</p>

        <h2>2. Data Controller</h2>
        <p>Splendide is the data controller for the personal data processed through this Service. Contact: <strong>privacy&#64;email.splendide.app</strong>.</p>

        <h2>3. Data We Collect</h2>
        <h3>Without an account (free tier)</h3>
        <p>We do <strong>not</strong> collect any personal data. All your tasks are stored exclusively in your browser's local storage and never leave your device.</p>

        <h3>With an account</h3>
        <p>When you create an account, we collect:</p>
        <ul>
          <li><strong>Email address</strong> — for authentication and account recovery</li>
          <li><strong>Name</strong> (optional) — for personalization</li>
          <li><strong>Password hash</strong> — securely hashed, never stored in plain text</li>
          <li><strong>Google account ID</strong> — if you sign in with Google</li>
        </ul>

        <h3>Premium users</h3>
        <p>If you upgrade to Premium, we additionally store:</p>
        <ul>
          <li><strong>Task data</strong> — your task lists, synced to our servers for cloud backup</li>
          <li><strong>Stripe customer ID</strong> — to manage your payment (we do not store credit card numbers; Stripe handles all payment data)</li>
        </ul>

        <h2>4. Legal Basis for Processing (GDPR)</h2>
        <ul>
          <li><strong>Contract performance</strong> — processing necessary to provide the Service you signed up for</li>
          <li><strong>Legitimate interest</strong> — to maintain security and improve the Service</li>
          <li><strong>Consent</strong> — where required (e.g., optional analytics, if added in the future)</li>
        </ul>

        <h2>5. How We Use Your Data</h2>
        <ul>
          <li>Provide, maintain, and improve the Service</li>
          <li>Authenticate your identity</li>
          <li>Process payments via Stripe</li>
          <li>Send password reset emails via Resend</li>
          <li>Comply with legal obligations</li>
        </ul>

        <h2>6. Data Sharing</h2>
        <p>We do not sell your personal data. We share data only with:</p>
        <ul>
          <li><strong>Stripe</strong> — for payment processing (<a href="https://stripe.com/privacy" target="_blank" rel="noopener">Stripe Privacy Policy</a>)</li>
          <li><strong>Resend</strong> — for transactional emails (<a href="https://resend.com/legal/privacy-policy" target="_blank" rel="noopener">Resend Privacy Policy</a>)</li>
          <li><strong>Google</strong> — if you use Google Sign-In (<a href="https://policies.google.com/privacy" target="_blank" rel="noopener">Google Privacy Policy</a>)</li>
        </ul>

        <h2>7. Data Retention</h2>
        <p>We retain your account data for as long as your account is active. If you delete your account, we will delete your personal data within 30 days, except where retention is required by law.</p>

        <h2>8. Your Rights</h2>
        <p>Under GDPR and CCPA, you have the right to:</p>
        <ul>
          <li><strong>Access</strong> — request a copy of your personal data</li>
          <li><strong>Rectification</strong> — correct inaccurate data</li>
          <li><strong>Erasure</strong> ("right to be forgotten") — request deletion of your data</li>
          <li><strong>Data portability</strong> — receive your data in a structured, machine-readable format</li>
          <li><strong>Restrict processing</strong> — limit how we use your data</li>
          <li><strong>Object</strong> — object to processing based on legitimate interest</li>
          <li><strong>Withdraw consent</strong> — where processing is based on consent</li>
          <li><strong>Non-discrimination</strong> (CCPA) — we will not discriminate against you for exercising your rights</li>
        </ul>
        <p>To exercise any of these rights, contact <strong>privacy&#64;email.splendide.app</strong>.</p>

        <h2>9. Cookies</h2>
        <p>We use only essential cookies required for authentication (HTTP-only refresh token cookie). We do not use tracking cookies, analytics cookies, or third-party advertising cookies.</p>

        <h2>10. Data Security</h2>
        <p>We implement appropriate technical and organizational measures to protect your data, including:</p>
        <ul>
          <li>Passwords hashed with bcrypt (12 rounds)</li>
          <li>HTTPS encryption in transit</li>
          <li>HTTP-only, secure cookies for refresh tokens</li>
          <li>Helmet security headers</li>
        </ul>

        <h2>11. International Transfers</h2>
        <p>Your data may be processed on servers located in the United States. For EU users, transfers are protected by appropriate safeguards in compliance with GDPR.</p>

        <h2>12. Children's Privacy</h2>
        <p>The Service is not directed to children under 16. We do not knowingly collect personal data from children. If you believe a child has provided us with personal data, contact us and we will delete it.</p>

        <h2>13. Changes to This Policy</h2>
        <p>We may update this Privacy Policy from time to time. We will notify registered users of material changes via email.</p>

        <h2>14. Contact & Complaints</h2>
        <p>For privacy inquiries: <strong>privacy&#64;email.splendide.app</strong></p>
        <p>EU users may also lodge a complaint with your local data protection authority.</p>
        <p class="legal-version">v1.0.0</p>
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
export class PrivacyComponent {}
