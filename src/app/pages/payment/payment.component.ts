import { ChangeDetectionStrategy, Component, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { Router, ActivatedRoute, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { StorageService } from '../../services/storage.service';
import { SyncService } from '../../services/sync.service';
import { openExternalUrl } from '../../utils/external-link';

interface PriceOption {
  currency: string;
  amount: number;
  symbol: string;
}

type BillingInterval = 'monthly' | 'yearly';
type PriceMap = Record<string, Omit<PriceOption, 'currency'>>;
type PriceCatalog = Partial<Record<BillingInterval, PriceMap>>;

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
      margin: 0 0 24px;
    }
    .billing-toggle {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 4px;
      padding: 4px;
      border: 1px solid var(--border, #ddd);
      border-radius: 8px;
      margin: 0 0 24px;
    }
    .billing-option {
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
      font-family: inherit;
      font-size: 0.875rem;
      font-weight: 600;
      padding: 8px 12px;
      transition: background 0.2s, color 0.2s;
    }
    .billing-option.active {
      background: var(--accent);
      color: var(--bg);
    }
    .billing-option:focus-visible {
      outline: 2px solid var(--text);
      outline-offset: 2px;
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
    .checkout-note {
      font-size: 0.8125rem;
      color: var(--text-secondary);
      line-height: 1.5;
      margin: 12px 0 0;
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
    .code-link {
      display: block;
      text-align: center;
      margin-top: 16px;
      font-size: 0.7rem;
      color: var(--text-muted);
      background: none;
      border: none;
      cursor: pointer;
      font-family: inherit;
      transition: color 0.2s;
    }
    .code-link:hover { color: var(--text-secondary); }
    .code-form {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }
    .code-input {
      flex: 1;
      padding: 8px 12px;
      border: 1px solid var(--border, #ddd);
      border-radius: 6px;
      background: transparent;
      color: var(--text);
      font-size: 0.8125rem;
      font-family: inherit;
    }
    .code-input:focus { outline: 1px solid var(--text-secondary); }
    .code-btn {
      padding: 8px 16px;
      border: none;
      border-radius: 6px;
      background: var(--accent);
      color: var(--bg);
      font-size: 0.8125rem;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    .code-btn:hover { opacity: 0.85; }
    .code-btn:disabled { opacity: 0.4; cursor: not-allowed; }
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
          <h2 class="result-title">welcome to premium</h2>
          @if (premiumActivationPending()) {
            <p class="result-text">activating your subscription and syncing your tasks</p>
            <div class="price-loading"><div class="spinner"></div></div>
          } @else {
            <p class="result-text">your subscription is active. tasks now sync across all your devices</p>
            <a class="result-link" routerLink="/" (click)="onEnjoyIt()">enjoy it</a>
          }
        } @else if (mode() === 'cancel') {
          <h2 class="result-title">payment cancelled</h2>
          <p class="result-text">no worries - you can upgrade anytime</p>
          <a class="result-link" routerLink="/">back to tasks</a>
        } @else {
          <h2 class="title">Upgrade for cloud save</h2>
          <p class="description">
            Keep your tasks saved in the cloud and synced across all your devices
          </p>

          @if (availableBillingIntervals().length > 1) {
            <div class="billing-toggle" role="group" aria-label="billing period">
              @for (interval of availableBillingIntervals(); track interval) {
                <button
                  type="button"
                  class="billing-option"
                  [class.active]="selectedBillingInterval() === interval"
                  (click)="onBillingIntervalChange(interval)"
                >
                  {{ billingIntervalLabel(interval) }}
                </button>
              }
            </div>
          }

          @if (currentPrice()) {
            <div class="price-row">
              <p class="price">{{ currentPrice()!.symbol }}{{ formatAmount(currentPrice()!.amount, selectedCurrency()) }} <span class="price-label">{{ billingPeriodLabel() }}</span></p>
              @if (availableCurrencies().length > 1) {
                <select
                  class="currency-select"
                  [value]="selectedCurrency()"
                  (change)="onCurrencyChange($event)"
                  aria-label="currency"
                >
                  @for (opt of availableCurrencies(); track opt) {
                    <option [value]="opt">{{ opt }}</option>
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
            @if (loading()) { redirecting to checkout } @else { subscribe with stripe }
          </button>

          @if (externalCheckoutPending()) {
            <p class="checkout-note">checkout is open in your browser. keep splendide open and it will update when payment is complete</p>
          }

          <a class="back" routerLink="/">maybe later</a>

          @if (!showCodeInput()) {
            <button class="code-link" (click)="showCodeInput.set(true)">i have a code</button>
          } @else {
            <div class="code-form">
              <input
                class="code-input"
                type="text"
                placeholder="enter your code"
                [value]="codeValue()"
                (input)="codeValue.set($any($event.target).value)"
                (keydown.enter)="redeemCode()"
                maxlength="64"
              />
              <button class="code-btn" (click)="redeemCode()" [disabled]="codeLoading() || !codeValue().trim()">redeem</button>
            </div>
          }
        }
      </div>
    </div>
  `,
})
export class PaymentComponent implements OnInit, OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly storage = inject(StorageService);
  private readonly sync = inject(SyncService);

  protected readonly mode = signal<'upgrade' | 'success' | 'cancel'>('upgrade');
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly externalCheckoutPending = signal(false);
  protected readonly premiumActivationPending = signal(false);

  protected readonly prices = signal<PriceCatalog>({});
  protected readonly selectedBillingInterval = signal<BillingInterval>('monthly');
  protected readonly availableBillingIntervals = signal<BillingInterval[]>([]);
  protected readonly selectedCurrency = signal<string>('usd');
  protected readonly availableCurrencies = signal<string[]>([]);
  protected readonly currentPrice = signal<{ amount: number; symbol: string } | null>(null);

  protected readonly showCodeInput = signal(false);
  protected readonly codeValue = signal('');
  protected readonly codeLoading = signal(false);
  private paymentPollTimer: ReturnType<typeof setTimeout> | null = null;
  private paymentPollCount = 0;

  async ngOnInit(): Promise<void> {
    const url = this.router.url;
    if (url.includes('/payment/success')) {
      this.mode.set('success');
      this.pollPremiumUntilActive();
    } else if (url.includes('/payment/cancel')) {
      this.mode.set('cancel');
    } else {
      this.loadPrices();
    }
  }

  ngOnDestroy(): void {
    this.clearPaymentPoll();
  }

  private ensureSignedInPartition(): void {
    const userId = this.auth.user()?.id;
    if (userId) {
      this.storage.setActivePartition(userId);
    }
  }

  private async syncSignedInPartition(): Promise<void> {
    this.ensureSignedInPartition();
    const sections = await this.sync.syncSections();
    for (const section of sections) {
      const lists = await this.sync.syncSectionLists(section.id);
      for (const list of lists) {
        await this.sync.syncListItems(section.id, list.id);
      }
    }
  }

  protected onCurrencyChange(event: Event): void {
    const currency = (event.target as HTMLSelectElement).value;
    this.selectedCurrency.set(currency);
    this.currentPrice.set(this.priceMapForSelectedInterval()[currency] ?? null);
  }

  protected onBillingIntervalChange(interval: BillingInterval): void {
    this.selectedBillingInterval.set(interval);
    this.refreshAvailableCurrencies();
  }

  protected billingIntervalLabel(interval: BillingInterval): string {
    return interval === 'yearly' ? 'yearly' : 'monthly';
  }

  protected billingPeriodLabel(): string {
    return this.selectedBillingInterval() === 'yearly' ? '/year' : '/month';
  }

  protected formatAmount(amount: number, currency: string): string {
    return currency === 'jpy' ? amount.toString() : amount.toFixed(2).replace(/\.00$/, '');
  }

  protected async checkout(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    this.externalCheckoutPending.set(false);

    try {
      const url = await this.auth.createCheckout(this.selectedCurrency(), this.selectedBillingInterval());
      const openedExternally = await openExternalUrl(url);
      if (openedExternally) {
        this.loading.set(false);
        this.externalCheckoutPending.set(true);
        this.pollPremiumAfterExternalCheckout();
      }
    } catch (e: any) {
      this.error.set(e?.error?.error ?? 'could not start checkout. please try again');
      this.loading.set(false);
    }
  }

  private pollPremiumAfterExternalCheckout(): void {
    this.pollPremiumUntilActive({ successModeOnActivation: true, initialDelayMs: 3000 });
  }

  private pollPremiumUntilActive(options?: { successModeOnActivation?: boolean; initialDelayMs?: number }): void {
    this.clearPaymentPoll();
    this.paymentPollCount = 0;
    this.premiumActivationPending.set(true);

    const poll = async () => {
      this.paymentPollCount += 1;
      if (this.paymentPollCount > 80) {
        this.externalCheckoutPending.set(false);
        this.premiumActivationPending.set(false);
        this.error.set('premium activation is taking longer than expected. please refresh in a moment');
        return;
      }

      try {
        const isPremium = await this.auth.checkPremiumStatus(this.checkoutSessionId());
        if (isPremium) {
          await this.syncSignedInPartition();
          this.externalCheckoutPending.set(false);
          this.premiumActivationPending.set(false);
          if (options?.successModeOnActivation) {
            this.mode.set('success');
          }
          return;
        }
      } catch {
        // Keep polling while the external checkout may still be in progress.
      }

      this.paymentPollTimer = setTimeout(poll, 3000);
    };

    this.paymentPollTimer = setTimeout(poll, options?.initialDelayMs ?? 0);
  }

  private clearPaymentPoll(): void {
    if (this.paymentPollTimer) {
      clearTimeout(this.paymentPollTimer);
      this.paymentPollTimer = null;
    }
  }

  private checkoutSessionId(): string | undefined {
    const value = this.router.parseUrl(this.router.url).queryParams['session_id'];
    return typeof value === 'string' && value ? value : undefined;
  }

  protected onEnjoyIt(): void {
    // sync already happened in ngOnInit / redeemCode
  }

  protected async redeemCode(): Promise<void> {
    const code = this.codeValue().trim();
    if (!code) return;
    this.codeLoading.set(true);
    this.error.set('');
    try {
      await this.auth.redeemVipCode(code);
      await this.syncSignedInPartition();
      this.mode.set('success');
    } catch (e: any) {
      this.error.set(e?.error?.error ?? 'invalid or expired code');
      this.codeLoading.set(false);
    }
  }

  private async loadPrices(): Promise<void> {
    try {
      const prices = await this.auth.fetchPrices();
      this.prices.set(prices);

      const intervals = (['monthly', 'yearly'] as BillingInterval[]).filter(interval => {
        const priceMap = prices[interval];
        return priceMap && Object.keys(priceMap).length > 0;
      });
      this.availableBillingIntervals.set(intervals);
      this.selectedBillingInterval.set(intervals.includes('monthly') ? 'monthly' : intervals[0] ?? 'monthly');
      this.refreshAvailableCurrencies();
    } catch {
      this.error.set('could not load pricing. please refresh');
    }
  }

  private priceMapForSelectedInterval(): PriceMap {
    return this.prices()[this.selectedBillingInterval()] ?? {};
  }

  private refreshAvailableCurrencies(): void {
    const priceMap = this.priceMapForSelectedInterval();
    const currencies = Object.keys(priceMap);
    this.availableCurrencies.set(currencies);

    const guessed = guessCurrency();
    const previous = this.selectedCurrency();
    const selected = priceMap[previous] ? previous : priceMap[guessed] ? guessed : currencies[0] ?? 'usd';
    this.selectedCurrency.set(selected);
    this.currentPrice.set(priceMap[selected] ?? null);
  }
}
