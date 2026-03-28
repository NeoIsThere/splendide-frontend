import { ChangeDetectionStrategy, Component, inject, signal, OnInit } from '@angular/core';
import { Router, ActivatedRoute, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';

interface PriceOption {
  currency: string;
  amount: number;
  symbol: string;
}

function guessCurrency(): string {
  // 1. Try Intl locale → currency mapping
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale ?? navigator.language;
    const region = locale.split('-').pop()?.toUpperCase();
    const regionMap: Record<string, string> = {
      US: 'usd', CA: 'cad', AU: 'aud', GB: 'gbp', JP: 'jpy',
      DE: 'eur', FR: 'eur', IT: 'eur', ES: 'eur', NL: 'eur',
      BE: 'eur', AT: 'eur', IE: 'eur', PT: 'eur', FI: 'eur',
      GR: 'eur', LU: 'eur', SK: 'eur', SI: 'eur', EE: 'eur',
      LV: 'eur', LT: 'eur', MT: 'eur', CY: 'eur', HR: 'eur',
    };
    if (region && regionMap[region]) return regionMap[region];
  } catch { /* ignore */ }

  // 2. Try navigator.language prefix
  const lang = (navigator.language || '').toLowerCase();
  if (lang.startsWith('en-us')) return 'usd';
  if (lang.startsWith('en-gb')) return 'gbp';
  if (lang.startsWith('en-au')) return 'aud';
  if (lang.startsWith('en-ca')) return 'cad';
  if (lang.startsWith('ja')) return 'jpy';
  if (lang.startsWith('fr') || lang.startsWith('de') || lang.startsWith('it') || lang.startsWith('es') || lang.startsWith('nl') || lang.startsWith('pt')) return 'eur';

  // 3. Try timezone
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz.startsWith('America/New_York') || tz.startsWith('America/Chicago') || tz.startsWith('America/Denver') || tz.startsWith('America/Los_Angeles') || tz.startsWith('US/')) return 'usd';
    if (tz.startsWith('America/Toronto') || tz.startsWith('America/Vancouver') || tz.startsWith('Canada/')) return 'cad';
    if (tz.startsWith('Australia/')) return 'aud';
    if (tz.startsWith('Europe/London')) return 'gbp';
    if (tz.startsWith('Asia/Tokyo')) return 'jpy';
    if (tz.startsWith('Europe/')) return 'eur';
  } catch { /* ignore */ }

  return 'usd';
}

@Component({
  selector: 'app-payment',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 100dvh;
    }
    .payment-page {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 48px 24px;
    }
    .logo {
      font-size: 2rem;
      font-weight: 700;
      letter-spacing: -0.03em;
      margin: 0 0 64px;
      color: var(--text-primary);
    }
    .content {
      width: 100%;
      max-width: 400px;
    }
    .title {
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--text);
      margin: 0 0 12px;
    }
    .description {
      font-size: 0.9375rem;
      color: var(--text-secondary);
      line-height: 1.6;
      margin: 0 0 32px;
    }
    .price-row {
      display: flex;
      align-items: baseline;
      gap: 12px;
      margin: 0 0 32px;
    }
    .price {
      font-size: 2.5rem;
      font-weight: 700;
      color: var(--text);
      margin: 0;
    }
    .price-label {
      font-size: 1rem;
      font-weight: 400;
      color: var(--text-secondary);
    }
    .currency-select {
      font-family: inherit;
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--text-secondary);
      background: transparent;
      border: 1px solid var(--border, #ddd);
      border-radius: 6px;
      padding: 4px 8px;
      cursor: pointer;
      appearance: none;
      -webkit-appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' fill='none'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23999' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 8px center;
      padding-right: 24px;
    }
    .currency-select:focus {
      outline: 1px solid var(--text-secondary);
    }
    .pay-btn {
      display: block;
      width: 100%;
      padding: 12px 20px;
      border: none;
      border-radius: 8px;
      background: var(--accent);
      color: var(--bg);
      font-size: 0.9375rem;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    .pay-btn:hover { opacity: 0.85; }
    .pay-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .error {
      font-size: 0.8125rem;
      color: #e53935;
      margin: 0 0 16px;
    }
    .back {
      display: block;
      text-align: center;
      margin-top: 24px;
      font-size: 0.875rem;
      color: var(--text-secondary);
      text-decoration: none;
    }
    .back:hover { color: var(--text); }
    .result-title {
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--text);
      margin: 0 0 8px;
    }
    .result-text {
      font-size: 0.9375rem;
      color: var(--text-secondary);
      margin: 0 0 32px;
    }
    .result-link {
      display: block;
      width: 100%;
      padding: 12px 20px;
      border-radius: 8px;
      background: var(--accent);
      color: var(--bg);
      font-size: 0.9375rem;
      font-weight: 600;
      font-family: inherit;
      text-align: center;
      text-decoration: none;
    }
    .result-link:hover { opacity: 0.85; }
    .price-loading {
      height: 48px;
      margin: 0 0 32px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .spinner {
      width: 20px;
      height: 20px;
      border: 2px solid var(--border, #ddd);
      border-top-color: var(--text, #1a1a1a);
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  `],
  template: `
    <div class="payment-page">
      <h1 class="logo">splendide.</h1>
      <div class="content">
        @if (mode() === 'success') {
          <h2 class="result-title">Welcome to Premium.</h2>
          <p class="result-text">Your subscription is active. Tasks now sync across all your devices.</p>
          <a class="result-link" routerLink="/">Go to your tasks</a>
        } @else if (mode() === 'cancel') {
          <h2 class="result-title">Payment cancelled</h2>
          <p class="result-text">No worries — you can upgrade anytime.</p>
          <a class="result-link" routerLink="/">Back to tasks</a>
        } @else {
          <h2 class="title">Your tasks, always with you.</h2>
          <p class="description">
            Keep your tasks saved, synced, and accessible across all your devices.
          </p>

          @if (currentPrice()) {
            <div class="price-row">
              <p class="price">{{ currentPrice()!.symbol }}{{ formatAmount(currentPrice()!.amount, selectedCurrency()) }} <span class="price-label">/month</span></p>
              @if (availableCurrencies().length > 1) {
                <select
                  class="currency-select"
                  [value]="selectedCurrency()"
                  (change)="onCurrencyChange($event)"
                  aria-label="Currency"
                >
                  @for (opt of availableCurrencies(); track opt) {
                    <option [value]="opt">{{ opt.toUpperCase() }}</option>
                  }
                </select>
              }
            </div>
          } @else {
            <div class="price-loading"><div class="spinner"></div></div>
          }

          @if (error()) {
            <p class="error" role="alert">{{ error() }}</p>
          }

          <button class="pay-btn" (click)="checkout()" [disabled]="loading() || !currentPrice()">
            @if (loading()) { Redirecting to checkout… } @else { Subscribe with Stripe }
          </button>

          <a class="back" routerLink="/">Maybe later</a>
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

  protected readonly prices = signal<Record<string, { amount: number; symbol: string }>>({});
  protected readonly selectedCurrency = signal<string>('usd');
  protected readonly availableCurrencies = signal<string[]>([]);
  protected readonly currentPrice = signal<{ amount: number; symbol: string } | null>(null);

  ngOnInit(): void {
    const url = this.router.url;
    if (url.includes('/payment/success')) {
      this.mode.set('success');
      this.auth.checkPremiumStatus();
    } else if (url.includes('/payment/cancel')) {
      this.mode.set('cancel');
    } else {
      this.loadPrices();
    }
  }

  protected onCurrencyChange(event: Event): void {
    const currency = (event.target as HTMLSelectElement).value;
    this.selectedCurrency.set(currency);
    this.currentPrice.set(this.prices()[currency] ?? null);
  }

  protected formatAmount(amount: number, currency: string): string {
    return currency === 'jpy' ? amount.toString() : amount.toFixed(2).replace(/\.00$/, '');
  }

  protected async checkout(): Promise<void> {
    this.loading.set(true);
    this.error.set('');

    try {
      const url = await this.auth.createCheckout(this.selectedCurrency());
      window.location.href = url;
    } catch (e: any) {
      this.error.set(e?.error?.error ?? 'Could not start checkout. Please try again.');
      this.loading.set(false);
    }
  }

  private async loadPrices(): Promise<void> {
    try {
      const prices = await this.auth.fetchPrices();
      this.prices.set(prices);

      const currencies = Object.keys(prices);
      this.availableCurrencies.set(currencies);

      // Pick the best currency for this user
      const guessed = guessCurrency();
      const selected = prices[guessed] ? guessed : currencies[0] ?? 'usd';
      this.selectedCurrency.set(selected);
      this.currentPrice.set(prices[selected] ?? null);
    } catch {
      this.error.set('Could not load pricing. Please refresh.');
    }
  }
}
