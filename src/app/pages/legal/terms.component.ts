import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { APP_VERSION } from '../../../environments/environment';

@Component({
  selector: 'app-terms',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <div class="legal-page">
      <div class="legal-card">
        <a class="legal-back" routerLink="/">&larr; Back to Splendide</a>
        <h1>Terms of Use</h1>
        <p class="legal-updated">Last updated: May 27, 2026</p>

        <h2>1. Acceptance of Terms</h2>
        <p>By accessing or using Splendide ("the Service"), you agree to be bound by these Terms of Use. If you do not agree, do not use the Service.</p>

        <h2>2. Description of Service</h2>
        <p>Splendide is a task management application for organizing work sessions. You can use private local pages without payment. Optional Premium features add cloud sync for private pages. The Service also includes shared pages that can be opened and edited by anyone with the page URL.</p>

        <h2>3. User Accounts</h2>
        <p>Account creation is optional. If you use private pages without an account, your private task data is stored in your browser's local storage. If you create an account, you are responsible for maintaining the confidentiality of your credentials and for activity under your account.</p>

        <h2>4. Premium Subscriptions</h2>
        <p>Payment is not required to use the basic private local features of the Service. Premium is optional and is offered as a paid subscription processed through Stripe. The current price, currency, billing period, renewal terms, and any taxes are shown during checkout.</p>
        <p>Premium subscriptions renew until canceled. You can manage or cancel your subscription from your account settings. Refunds are handled case by case unless a refund is required by applicable law. If there is a conflict between these Terms and the checkout page about price or billing period, the checkout page controls for that purchase.</p>

        <h2>5. Shared Pages</h2>
        <p>Shared pages are public-by-link collaboration spaces. Anyone who knows or receives the URL can view, edit, reorder, complete, or delete content on that page. There is no owner, admin, or permission difference between the person who created a shared page and anyone who later joins it.</p>
        <p>Do not put passwords, secrets, confidential information, regulated personal data, or sensitive content in shared pages. You are responsible for deciding who receives a shared page link. Shared pages may be deleted after six months without activity, and we may remove shared pages that violate these Terms or create legal, security, or abuse risks.</p>

        <h2>6. User Content</h2>
        <p>Your task data remains yours. You grant Splendide the limited permission needed to store, process, sync, transmit, display, and otherwise operate the Service for your content. For shared pages, you understand that other people with the link may change or delete the content.</p>

        <h2>7. User Conduct</h2>
        <p>You agree not to:</p>
        <ul>
          <li>Use the Service for any unlawful purpose</li>
          <li>Attempt to gain unauthorized access to the Service or its systems</li>
          <li>Interfere with or disrupt the Service</li>
          <li>Use shared pages to publish unlawful, abusive, infringing, or sensitive personal content</li>
          <li>Reverse engineer, decompile, or disassemble any part of the Service</li>
        </ul>

        <h2>8. Intellectual Property</h2>
        <p>All content, design, and code of the Service are owned by Splendide and protected by applicable intellectual property laws. Your task data remains yours.</p>

        <h2>9. Disclaimer of Warranties</h2>
        <p>The Service is provided "as is" and "as available" without warranties of any kind, either express or implied. We do not guarantee that the Service will be uninterrupted, secure, or error-free.</p>

        <h2>10. Limitation of Liability</h2>
        <p>To the maximum extent permitted by law, Splendide shall not be liable for any indirect, incidental, special, consequential, or punitive damages, or any loss of data, profits, or goodwill.</p>

        <h2>11. Termination and Account Deletion</h2>
        <p>We may suspend or terminate access to the Service for violation of these Terms, security risk, abuse, or legal reasons. You may delete your account from settings. If you have an active Premium subscription, you must cancel the subscription before deleting your account.</p>

        <h2>12. Changes to Terms</h2>
        <p>We reserve the right to modify these Terms at any time. Continued use of the Service after changes constitutes acceptance of the modified Terms.</p>

        <h2>13. Governing Law</h2>
        <p>These Terms are governed by the laws of the United States. For users in the European Union, mandatory consumer protection laws of your country of residence apply.</p>

        <h2>14. Contact</h2>
        <p>For questions about these Terms, contact us at <strong>support&#64;email.splendide.app</strong>.</p>
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
export class TermsComponent {
  protected readonly version = APP_VERSION;
}
