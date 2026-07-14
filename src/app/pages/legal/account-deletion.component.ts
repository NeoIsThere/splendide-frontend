import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-account-deletion',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <main class="legal-page">
      <a class="back" routerLink="/">← splendide</a>
      <h1>delete your Splendide account</h1>
      <p>Deleting your account permanently removes your account, private pages, tasks, sharing access, and registered mobile notification tokens.</p>

      <h2>delete online</h2>
      @if (auth.isLoggedIn()) {
        <p>Open settings, then choose <strong>Delete my account</strong>.</p>
        <a class="action" routerLink="/settings">open settings</a>
      } @else {
        <p>Sign in on the web, open settings, then choose <strong>Delete my account</strong>.</p>
        <a class="action" routerLink="/sign-in">sign in</a>
      }

      <h2>request help</h2>
      <p>If you cannot sign in, email <a href="mailto:privacy&#64;email.splendide.app?subject=Splendide%20account%20deletion%20request">privacy&#64;email.splendide.app</a> from the address on your account. We may ask you to verify ownership.</p>

      <h2>active subscriptions</h2>
      <p>Cancel active App Store, Google Play, or web subscriptions before deletion. Deleting an account does not cancel a store subscription automatically.</p>
    </main>
  `,
  styles: `
    :host { display: block; min-height: var(--app-viewport-height, 100dvh); }
    .legal-page {
      width: min(100%, 680px);
      margin: 0 auto;
      padding: calc(32px + var(--app-safe-top, 0px)) 0 calc(56px + var(--app-safe-bottom, 0px));
    }
    .back { color: var(--text-secondary); text-decoration: none; }
    h1 { margin: 42px 0 20px; font-size: clamp(2rem, 8vw, 3.2rem); line-height: 1.05; }
    h2 { margin: 32px 0 8px; font-size: 1rem; }
    p { color: var(--text-secondary); line-height: 1.65; }
    a { color: var(--text); }
    .action { display: inline-block; padding: 10px 16px; border-radius: 8px; background: var(--text); color: var(--bg); text-decoration: none; }
  `,
})
export class AccountDeletionComponent {
  protected readonly auth = inject(AuthService);
}
