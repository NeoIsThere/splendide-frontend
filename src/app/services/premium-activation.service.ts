import { Injectable, OnDestroy, inject } from '@angular/core';
import { AuthService } from './auth.service';

const DESKTOP_PREMIUM_PENDING_KEY = 'splendide_desktop_premium_activation_pending';
const PREMIUM_POLL_INTERVAL_MS = 3_000;
const PREMIUM_POLL_LIMIT = 80;

@Injectable({ providedIn: 'root' })
export class PremiumActivationService implements OnDestroy {
  private readonly auth = inject(AuthService);

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollCount = 0;

  constructor() {
    if (this.hasPendingDesktopCheckout()) {
      this.startPolling();
    }
  }

  ngOnDestroy(): void {
    this.clearTimer();
  }

  markDesktopCheckoutPending(): void {
    if (!window.splendideDesktop?.isDesktop) return;

    try {
      localStorage.setItem(DESKTOP_PREMIUM_PENDING_KEY, '1');
    } catch {
      // The in-memory timer still covers this app session.
    }
    this.startPolling();
  }

  clearDesktopCheckoutPending(): void {
    try {
      localStorage.removeItem(DESKTOP_PREMIUM_PENDING_KEY);
    } catch {
      // Ignore storage errors.
    }
    this.clearTimer();
  }

  private hasPendingDesktopCheckout(): boolean {
    if (!window.splendideDesktop?.isDesktop) return false;
    try {
      return localStorage.getItem(DESKTOP_PREMIUM_PENDING_KEY) === '1';
    } catch {
      return false;
    }
  }

  private startPolling(): void {
    if (this.pollTimer !== null) return;
    this.pollCount = 0;
    this.pollTimer = setTimeout(() => void this.poll(), PREMIUM_POLL_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    this.pollTimer = null;
    this.pollCount += 1;

    if (this.pollCount > PREMIUM_POLL_LIMIT || !this.auth.isLoggedIn()) {
      this.clearDesktopCheckoutPending();
      return;
    }

    try {
      if (await this.auth.checkPremiumStatus()) {
        this.clearDesktopCheckoutPending();
        return;
      }
    } catch {
      // Keep polling while Stripe/webhook propagation is still settling.
    }

    this.pollTimer = setTimeout(() => void this.poll(), PREMIUM_POLL_INTERVAL_MS);
  }
  private clearTimer(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
