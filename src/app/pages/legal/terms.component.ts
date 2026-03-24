import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-terms',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <div class="legal-page">
      <div class="legal-card">
        <a class="legal-back" routerLink="/">&larr; Back to Splendide</a>
        <h1>Terms of Use</h1>
        <p class="legal-updated">Last updated: March 24, 2026</p>

        <h2>1. Acceptance of Terms</h2>
        <p>By accessing or using Splendide ("the Service"), you agree to be bound by these Terms of Use. If you do not agree, do not use the Service.</p>

        <h2>2. Description of Service</h2>
        <p>Splendide is a task management application. The Service is available as a free tier (local browser storage only) and a paid Premium tier (cloud sync, $7 one-time payment).</p>

        <h2>3. User Accounts</h2>
        <p>Account creation is optional. You may use the Service without an account, in which case your data is stored only in your browser's local storage. If you create an account, you are responsible for maintaining the confidentiality of your credentials.</p>

        <h2>4. Premium Purchases</h2>
        <p>Premium access is a one-time payment of $7 USD processed through Stripe. All payments are final. Refund requests may be considered on a case-by-case basis within 14 days of purchase by contacting support.</p>

        <h2>5. User Conduct</h2>
        <p>You agree not to:</p>
        <ul>
          <li>Use the Service for any unlawful purpose</li>
          <li>Attempt to gain unauthorized access to the Service or its systems</li>
          <li>Interfere with or disrupt the Service</li>
          <li>Reverse engineer, decompile, or disassemble any part of the Service</li>
        </ul>

        <h2>6. Intellectual Property</h2>
        <p>All content, design, and code of the Service are owned by Splendide and protected by applicable intellectual property laws. Your task data remains yours.</p>

        <h2>7. Disclaimer of Warranties</h2>
        <p>The Service is provided "as is" and "as available" without warranties of any kind, either express or implied. We do not guarantee that the Service will be uninterrupted, secure, or error-free.</p>

        <h2>8. Limitation of Liability</h2>
        <p>To the maximum extent permitted by law, Splendide shall not be liable for any indirect, incidental, special, consequential, or punitive damages, or any loss of data, profits, or goodwill.</p>

        <h2>9. Termination</h2>
        <p>We may suspend or terminate your access to the Service at any time for violation of these Terms. You may delete your account at any time.</p>

        <h2>10. Changes to Terms</h2>
        <p>We reserve the right to modify these Terms at any time. Continued use of the Service after changes constitutes acceptance of the modified Terms.</p>

        <h2>11. Governing Law</h2>
        <p>These Terms are governed by the laws of the United States. For users in the European Union, mandatory consumer protection laws of your country of residence apply.</p>

        <h2>12. Contact</h2>
        <p>For questions about these Terms, contact us at <strong>support&#64;splendide.app</strong>.</p>
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
    h2 {
      font-size: 1rem;
      font-weight: 600;
      margin: 28px 0 8px;
    }
    p, li {
      font-size: 0.9375rem;
      line-height: 1.6;
      color: var(--text-secondary);
    }
    ul {
      padding-left: 20px;
      margin: 8px 0;
    }
    li { margin-bottom: 4px; }
  `],
})
export class TermsComponent {}
