import { Injectable, OnDestroy, inject } from '@angular/core';
import { AuthService } from './auth.service';
import { StorageService } from './storage.service';
import { SyncService } from './sync.service';

const DESKTOP_PREMIUM_PENDING_KEY = 'splendide_desktop_premium_activation_pending';
const PREMIUM_POLL_INTERVAL_MS = 3_000;
const PREMIUM_POLL_LIMIT = 80;

@Injectable({ providedIn: 'root' })
export class PremiumActivationService implements OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly storage = inject(StorageService);
  private readonly sync = inject(SyncService);

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollCount = 0;
  private syncInProgress = false;

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
        await this.syncSignedInPartition();
        this.clearDesktopCheckoutPending();
        return;
      }
    } catch {
      // Keep polling while Stripe/webhook propagation is still settling.
    }

    this.pollTimer = setTimeout(() => void this.poll(), PREMIUM_POLL_INTERVAL_MS);
  }

  private async syncSignedInPartition(): Promise<void> {
    if (this.syncInProgress) return;
    const userId = this.auth.user()?.id;
    if (!userId) return;

    this.syncInProgress = true;
    try {
      this.storage.setActivePartition(userId);
      this.storage.markCloudReplacePending(this.auth.user()?.syncGeneration ?? 0);
      const sections = await this.sync.syncSections();
      for (const section of sections) {
        const lists = await this.sync.syncSectionLists(section.id);
        for (const list of lists) {
          await this.sync.syncListItems(section.id, list.id);
        }
      }
    } finally {
      this.syncInProgress = false;
    }
  }

  private clearTimer(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
