import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MobilePurchasesService } from '../../services/mobile-purchases.service';

@Component({
  selector: 'app-mobile-payment',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <main class="mobile-payment-page">
      <a class="back" routerLink="/" aria-label="back to tasks">←</a>
      <div class="content">
        @if (complete()) {
          <h1>welcome to premium</h1>
          <p>your subscription is active. you have more room for tasks and pages</p>
          <a class="primary" routerLink="/">enjoy it</a>
        } @else {
          <p class="eyebrow">splendide premium</p>
          <h1>more room for larger work sessions</h1>
          <p>Unlimited tasks and pages, on every device where you use your account.</p>

          <div class="plans" role="radiogroup" aria-label="billing period">
            @for (interval of intervals; track interval) {
              @if (purchases.packageFor(interval); as plan) {
                <button
                  type="button"
                  class="plan"
                  [class.selected]="selected() === interval"
                  [attr.aria-checked]="selected() === interval"
                  role="radio"
                  (click)="selected.set(interval)"
                >
                  <span>{{ interval }}</span>
                  <strong>{{ plan.product.priceString }} / {{ interval === 'monthly' ? 'month' : 'year' }}</strong>
                </button>
              }
            }
          </div>

          @if (error() || purchases.error()) {
            <p class="error" role="alert">{{ error() || purchases.error() }}</p>
          }

          <button class="primary" type="button" [disabled]="loading() || !purchases.packageFor(selected())" (click)="subscribe()">
            {{ loading() ? 'working' : 'subscribe' }}
          </button>
          <button class="restore" type="button" [disabled]="loading()" (click)="restore()">restore purchases</button>
          <p class="fine-print">
            Payment renews through your App Store or Google Play account until cancelled in store settings.
            <a routerLink="/terms">terms</a> · <a routerLink="/privacy">privacy</a>
          </p>
        }
      </div>
    </main>
  `,
  styles: `
    :host { display: block; min-height: var(--app-viewport-height, 100dvh); }
    .mobile-payment-page {
      min-height: var(--app-viewport-height, 100dvh);
      padding: calc(20px + var(--app-safe-top, 0px)) calc(20px + var(--app-safe-right, 0px)) calc(32px + var(--app-safe-bottom, 0px)) calc(20px + var(--app-safe-left, 0px));
    }
    .content { width: min(100%, 440px); margin: 48px auto 0; }
    .back { color: var(--text); text-decoration: none; font-size: 1.4rem; }
    .eyebrow { margin: 0 0 10px; color: var(--text-muted); font-size: .8rem; text-transform: uppercase; letter-spacing: .12em; }
    h1 { margin: 0 0 14px; font-size: clamp(1.8rem, 8vw, 2.6rem); line-height: 1.08; }
    p { color: var(--text-secondary); line-height: 1.55; }
    .plans { display: grid; gap: 10px; margin: 28px 0 20px; }
    .plan { display: flex; justify-content: space-between; gap: 16px; width: 100%; padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--card); color: var(--text); font: inherit; text-align: left; }
    .plan.selected { border-color: var(--text); box-shadow: 0 0 0 1px var(--text); }
    .plan span { text-transform: capitalize; }
    .primary { display: block; width: 100%; border: 0; border-radius: 10px; padding: 13px 18px; background: var(--accent); color: var(--bg); font: inherit; font-weight: 650; text-align: center; text-decoration: none; }
    .primary:disabled { opacity: .45; }
    .restore { display: block; margin: 18px auto 0; border: 0; background: none; color: var(--text-secondary); font: inherit; font-size: .84rem; }
    .fine-print { margin-top: 20px; font-size: .75rem; text-align: center; }
    .fine-print a { color: inherit; }
    .error { color: #d53f3f; font-size: .84rem; }
  `,
})
export class MobilePaymentComponent {
  protected readonly purchases = inject(MobilePurchasesService);
  protected readonly intervals = ['monthly', 'yearly'] as const;
  protected readonly selected = signal<'monthly' | 'yearly'>('yearly');
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly complete = signal(false);

  protected async subscribe(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      await this.purchases.purchase(this.selected());
      this.complete.set(true);
    } catch (error) {
      this.error.set(this.purchases.message(error, 'the subscription could not be completed'));
    } finally {
      this.loading.set(false);
    }
  }

  protected async restore(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const restored = await this.purchases.restore();
      this.complete.set(restored);
      if (!restored) this.error.set('no active purchases were found for this store account');
    } catch (error) {
      this.error.set(this.purchases.message(error, 'purchases could not be restored'));
    } finally {
      this.loading.set(false);
    }
  }
}
