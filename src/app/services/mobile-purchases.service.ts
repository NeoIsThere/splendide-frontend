import { effect, inject, Injectable, signal } from '@angular/core';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import {
  Purchases,
  type PurchasesPackage,
} from '@revenuecat/purchases-capacitor';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';

@Injectable({ providedIn: 'root' })
export class MobilePurchasesService {
  private readonly auth = inject(AuthService);
  private configured = false;
  private configuredUserId: string | null = null;

  readonly packages = signal<readonly PurchasesPackage[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');

  constructor() {
    if (!environment.isMobile) return;
    effect(() => {
      const userId = this.auth.user()?.id ?? null;
      if (userId) {
        void this.configureForUser(userId).catch(() => undefined);
      } else {
        this.configuredUserId = null;
        this.packages.set([]);
      }
    });
  }

  packageFor(interval: 'monthly' | 'yearly'): PurchasesPackage | null {
    const expectedType = interval === 'monthly' ? 'MONTHLY' : 'ANNUAL';
    return this.packages().find(item => item.packageType === expectedType) ?? null;
  }

  async purchase(interval: 'monthly' | 'yearly'): Promise<void> {
    const userId = this.auth.user()?.id;
    if (!userId) throw new Error('sign in before subscribing');
    await this.configureForUser(userId);
    const selectedPackage = this.packageFor(interval);
    if (!selectedPackage) throw new Error(`${interval} subscription is not configured`);

    const result = await Purchases.purchasePackage({ aPackage: selectedPackage });
    const entitlement = result.customerInfo.entitlements.active[environment.revenueCatPremiumEntitlementId];
    if (!entitlement?.isActive) throw new Error('the store has not activated this subscription yet');
    await this.auth.syncMobilePremiumStatus();
  }

  async restore(): Promise<boolean> {
    const userId = this.auth.user()?.id;
    if (!userId) throw new Error('sign in before restoring purchases');
    await this.configureForUser(userId);
    const { customerInfo } = await Purchases.restorePurchases();
    const active = Boolean(customerInfo.entitlements.active[environment.revenueCatPremiumEntitlementId]?.isActive);
    await this.auth.syncMobilePremiumStatus();
    return active;
  }

  async openManagement(): Promise<void> {
    const userId = this.auth.user()?.id;
    if (!userId) return;
    await this.configureForUser(userId);
    const { customerInfo } = await Purchases.getCustomerInfo();
    const fallback = Capacitor.getPlatform() === 'ios'
      ? 'https://apps.apple.com/account/subscriptions'
      : 'https://play.google.com/store/account/subscriptions?package=app.splendide.mobile';
    await Browser.open({ url: customerInfo.managementURL || fallback });
  }

  private async configureForUser(userId: string): Promise<void> {
    if (!this.hasConfiguration()) {
      this.error.set('store subscriptions still need their public RevenueCat key');
      return;
    }
    if (this.configured && this.configuredUserId === userId) return;

    this.loading.set(true);
    this.error.set('');
    try {
      if (!this.configured) {
        const apiKey = Capacitor.getPlatform() === 'ios'
          ? environment.revenueCatAppleApiKey
          : environment.revenueCatGoogleApiKey;
        await Purchases.configure({ apiKey, appUserID: userId });
        this.configured = true;
      } else {
        await Purchases.logIn({ appUserID: userId });
      }
      this.configuredUserId = userId;
      const offerings = await Purchases.getOfferings();
      this.packages.set(offerings.current?.availablePackages ?? []);
      await this.auth.syncMobilePremiumStatus().catch(() => undefined);
    } catch (error) {
      this.error.set(this.message(error, 'could not load store subscriptions'));
      throw error;
    } finally {
      this.loading.set(false);
    }
  }

  private hasConfiguration(): boolean {
    const key = Capacitor.getPlatform() === 'ios'
      ? environment.revenueCatAppleApiKey
      : environment.revenueCatGoogleApiKey;
    return Boolean(key && !key.startsWith('REPLACE_WITH_'));
  }

  message(error: unknown, fallback: string): string {
    if (typeof error === 'object' && error !== null) {
      const record = error as Record<string, unknown>;
      if (record['userCancelled'] === true || record['code'] === 'PURCHASE_CANCELLED_ERROR') return '';
      if (typeof record['message'] === 'string') return record['message'];
    }
    return fallback;
  }
}
