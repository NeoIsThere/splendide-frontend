import { ChangeDetectionStrategy, Component, inject, signal, OnInit } from '@angular/core';
import { Router, ActivatedRoute, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-payment',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <div class="auth-page">
      <div class="auth-card">
        <h1 class="auth-logo">fusione.</h1>

        @if (mode() === 'success') {
          <div class="payment-result">
            <h2 class="auth-title">Welcome to Premium!</h2>
            <p class="auth-subtitle">Your payment was successful. You now have cloud sync for your tasks.</p>
            <a class="auth-btn" routerLink="/" style="display:block;text-align:center;text-decoration:none;">
              Go to your tasks
            </a>
          </div>
        } @else if (mode() === 'cancel') {
          <div class="payment-result">
            <h2 class="auth-title">Payment cancelled</h2>
            <p class="auth-subtitle">No worries — you can upgrade anytime.</p>
            <a class="auth-btn" routerLink="/" style="display:block;text-align:center;text-decoration:none;">
              Back to tasks
            </a>
          </div>
        } @else {
          <h2 class="auth-title">Upgrade to Premium</h2>
          <div class="premium-card">
            <p class="premium-price">$7<span class="premium-once"> one-time</span></p>
            <ul class="premium-features">
              <li>Cloud sync across devices</li>
              <li>Auto-save & auto-retrieve your lists</li>
              <li>Never lose your tasks again</li>
            </ul>
          </div>

          @if (error()) {
            <p class="auth-error" role="alert">{{ error() }}</p>
          }

          <button class="auth-btn" (click)="checkout()" [disabled]="loading()">
            @if (loading()) { Redirecting to checkout… } @else { Pay with Stripe }
          </button>

          <p class="auth-switch">
            <a routerLink="/">Maybe later</a>
          </p>
        }
      </div>
    </div>
  `,
})
export class PaymentComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly mode = signal<'upgrade' | 'success' | 'cancel'>('upgrade');
  protected readonly loading = signal(false);
  protected readonly error = signal('');

  ngOnInit(): void {
    // Check URL path for success/cancel
    const url = this.router.url;
    if (url.includes('/payment/success')) {
      this.mode.set('success');
      // Refresh user premium status
      this.auth.checkPremiumStatus();
    } else if (url.includes('/payment/cancel')) {
      this.mode.set('cancel');
    }
  }

  protected async checkout(): Promise<void> {
    this.loading.set(true);
    this.error.set('');

    try {
      const url = await this.auth.createCheckout();
      window.location.href = url;
    } catch (e: any) {
      this.error.set(e?.error?.error ?? 'Could not start checkout. Please try again.');
      this.loading.set(false);
    }
  }
}
