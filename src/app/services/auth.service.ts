import { Injectable, inject, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { StorageService } from './storage.service';
import { ThemeService } from './theme.service';
import { PosthogService } from './posthog.service';
import { Capacitor } from '@capacitor/core';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { SocialLogin } from '@capgo/capacitor-social-login';

export interface User {
  id: string;
  email: string;
  name: string | null;
  isPremium: boolean;
  hasPassword: boolean;
  syncGeneration: number;
  darkMode: boolean | null;
  sharedNotificationsEnabled: boolean;
  hasStripeSubscription: boolean;
  hasMobileSubscription: boolean;
}

interface AuthResponse {
  accessToken: string;
  refreshToken?: string;
  user: User;
  isNewUser?: boolean;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly storage = inject(StorageService);
  private readonly theme = inject(ThemeService);
  private readonly posthog = inject(PosthogService);
  private readonly apiUrl = environment.apiUrl;

  private readonly _user = signal<User | null>(this.loadUser());
  private readonly _token = signal<string | null>(this.loadToken());
  private themePreferenceAppliedForUserId: string | null = null;
  private readonly sessionReady: Promise<void>;

  readonly user = this._user.asReadonly();
  readonly isLoggedIn = computed(() => !!this._token());
  readonly isPremium = computed(() => this._user()?.isPremium ?? false);

  constructor() {
    const cachedUser = this._user();
    if (cachedUser) {
      this.posthog.identifyUser(cachedUser);
    }
    if (this._token()) {
      this.sessionReady = this.fetchUser().then(() => undefined);
    } else if (environment.isMobile) {
      this.sessionReady = this.restoreNativeSession();
    } else {
      this.sessionReady = Promise.resolve();
    }
  }

  async waitForSessionReady(): Promise<void> {
    await this.sessionReady;
  }

  // ─── Email / Password ───────────────────────────────────

  async register(email: string, password: string, name?: string): Promise<{ status: 'VERIFY_EMAIL' }> {
    await firstValueFrom(this.http.post<{ message: string }>(`${this.apiUrl}/auth/register`, { email, password, name }, { withCredentials: true }));
    return { status: 'VERIFY_EMAIL' };
  }

  async verifyEmail(token: string): Promise<void> {
    const res = await firstValueFrom(this.http.post<AuthResponse>(`${this.apiUrl}/auth/verify-email`, { token }, { withCredentials: true }));
    await this.setSession(res);
    if (res.isNewUser) {
      await this.copyAnonymousToNewUser(res.user.id);
    }
  }

  async resendVerification(email: string): Promise<void> {
    await firstValueFrom(this.http.post(`${this.apiUrl}/auth/resend-verification`, { email }));
  }

  async login(email: string, password: string): Promise<void> {
    const res = await firstValueFrom(this.http.post<AuthResponse>(`${this.apiUrl}/auth/login`, { email, password }, { withCredentials: true }));
    await this.setSession(res);
  }

  // ─── Google ─────────────────────────────────────────────

  async googleAuth(idToken: string): Promise<{ isNewUser: boolean }> {
    const res = await firstValueFrom(this.http.post<AuthResponse>(`${this.apiUrl}/auth/google`, { idToken }, { withCredentials: true }));
    await this.setSession(res);
    if (res.isNewUser) {
      await this.copyAnonymousToNewUser(res.user.id);
    }
    return { isNewUser: res.isNewUser ?? false };
  }

  async googleDesktopAuth(): Promise<{ isNewUser: boolean }> {
    if (environment.isMobile) {
      await this.initializeMobileSocialLogin('google');
      const login = await SocialLogin.login({
        provider: 'google',
        options: { scopes: ['profile', 'email'] },
      });
      const result = login.result;
      if (result.responseType !== 'online' || !result.idToken) {
        throw new Error('google did not return an identity token');
      }
      return this.googleAuth(result.idToken);
    }

    const desktop = window.splendideDesktop;
    if (!desktop?.isDesktop) {
      throw new Error('desktop google sign-in is only available in the electron app');
    }

    const oauth = await desktop.startGoogleOAuth(environment.googleClientId);
    const res = await firstValueFrom(this.http.post<AuthResponse>(`${this.apiUrl}/auth/google/oauth`, oauth, { withCredentials: true }));
    await this.setSession(res);
    if (res.isNewUser) {
      await this.copyAnonymousToNewUser(res.user.id);
    }
    return { isNewUser: res.isNewUser ?? false };
  }

  async appleMobileAuth(): Promise<{ isNewUser: boolean }> {
    if (!environment.isMobile || Capacitor.getPlatform() !== 'ios') {
      throw new Error('apple sign in is only available in the iOS app');
    }
    await this.initializeMobileSocialLogin('apple');
    const login = await SocialLogin.login({
      provider: 'apple',
      options: { scopes: ['name', 'email'] },
    });
    if (!login.result.idToken) {
      throw new Error('apple did not return an identity token');
    }
    const name = [login.result.profile.givenName, login.result.profile.familyName].filter(Boolean).join(' ') || undefined;
    const res = await firstValueFrom(this.http.post<AuthResponse>(
      `${this.apiUrl}/auth/apple`,
      { identityToken: login.result.idToken, name },
      { withCredentials: true },
    ));
    await this.setSession(res);
    if (res.isNewUser) {
      await this.copyAnonymousToNewUser(res.user.id);
    }
    return { isNewUser: res.isNewUser ?? false };
  }

  // ─── Forgot / Reset Password ────────────────────────────

  async forgotPassword(email: string): Promise<void> {
    await firstValueFrom(this.http.post(`${this.apiUrl}/auth/forgot-password`, { email }));
  }

  async resetPassword(token: string, password: string): Promise<void> {
    await firstValueFrom(this.http.post(`${this.apiUrl}/auth/reset-password`, { token, password }));
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await firstValueFrom(this.http.post(`${this.apiUrl}/auth/change-password`, { currentPassword, newPassword }));
  }

  async deleteAccount(): Promise<void> {
    const userId = this._user()?.id ?? this.storage.getActiveUserId();
    await firstValueFrom(this.http.delete(`${this.apiUrl}/user`, { withCredentials: true }));
    if (userId) {
      this.storage.removeUserPartition(userId);
    }
    this.storage.setActivePartition();
    this._user.set(null);
    this._token.set(null);
    this.posthog.reset();
    this.themePreferenceAppliedForUserId = null;
    localStorage.removeItem('splendide_token');
    localStorage.removeItem('splendide_user');
    await this.clearNativeRefreshToken();
    this.router.navigate(['/']);
  }

  // ─── Token Refresh ──────────────────────────────────────

  async refreshToken(): Promise<string | null> {
    try {
      const refreshToken = await this.getNativeRefreshToken();
      const res = await firstValueFrom(this.http.post<{ accessToken: string; refreshToken?: string }>(
        `${this.apiUrl}/auth/refresh`,
        refreshToken ? { refreshToken } : {},
        { withCredentials: true },
      ));
      if (res.accessToken) {
        this._token.set(res.accessToken);
        localStorage.setItem('splendide_token', res.accessToken);
        if (res.refreshToken) await this.saveNativeRefreshToken(res.refreshToken);
        return res.accessToken;
      }
    } catch {
      // Let the caller (interceptor) handle logout
    }
    return null;
  }

  // ─── Fetch user profile ─────────────────────────────────

  async fetchUser(): Promise<User | null> {
    try {
      const user = await firstValueFrom(this.http.get<User>(`${this.apiUrl}/user/me`));
      this._user.set(user);
      localStorage.setItem('splendide_user', JSON.stringify(user));
      this.applyUserThemePreference(user);
      this.posthog.identifyUser(user);
      return user;
    } catch {
      // ignore — user may not be logged in
      return null;
    }
  }

  // ─── Payment ────────────────────────────────────────────

  async fetchPrices(): Promise<Partial<Record<'monthly' | 'yearly', Record<string, { amount: number; symbol: string }>>>> {
    const res = await firstValueFrom(this.http.get<{ prices: Partial<Record<'monthly' | 'yearly', Record<string, { amount: number; symbol: string }>>> }>(`${this.apiUrl}/payment/price`));
    return res.prices;
  }

  async createCheckout(currency?: string, billingInterval: 'monthly' | 'yearly' = 'monthly'): Promise<string> {
    const res = await firstValueFrom(this.http.post<{ url: string }>(`${this.apiUrl}/payment/create-checkout`, { currency, billingInterval }));
    return res.url;
  }

  async manageSubscription(): Promise<string> {
    const res = await firstValueFrom(this.http.post<{ url: string }>(`${this.apiUrl}/payment/manage`, {}));
    return res.url;
  }

  async checkPremiumStatus(sessionId?: string): Promise<boolean> {
    const url = sessionId
      ? `${this.apiUrl}/payment/status?session_id=${encodeURIComponent(sessionId)}`
      : `${this.apiUrl}/payment/status`;
    const res = await firstValueFrom(this.http.get<{ isPremium: boolean }>(url));
    const isPremium = res.isPremium;
    this._user.update(u => u ? { ...u, isPremium } : u);
    const user = this._user();
    if (user) {
      localStorage.setItem('splendide_user', JSON.stringify(user));
      this.posthog.identifyUser(user);
    }
    return isPremium;
  }

  async syncMobilePremiumStatus(): Promise<boolean> {
    const res = await firstValueFrom(this.http.post<{ isPremium: boolean; hasMobileSubscription: boolean }>(`${this.apiUrl}/mobile-billing/sync`, {}));
    this._user.update(user => user ? {
      ...user,
      isPremium: res.isPremium,
      hasMobileSubscription: res.hasMobileSubscription,
    } : user);
    this.persistCurrentUser();
    return res.isPremium;
  }

  async updateSharedNotifications(enabled: boolean): Promise<void> {
    const res = await firstValueFrom(this.http.patch<{ sharedNotificationsEnabled: boolean }>(
      `${this.apiUrl}/user/preferences`,
      { sharedNotificationsEnabled: enabled },
    ));
    this._user.update(user => user ? { ...user, sharedNotificationsEnabled: res.sharedNotificationsEnabled } : user);
    this.persistCurrentUser();
  }

  async redeemVipCode(code: string): Promise<void> {
    await firstValueFrom(this.http.post(`${this.apiUrl}/payment/redeem-code`, { code }));
    this._user.update(u => u ? { ...u, isPremium: true } : u);
    const user = this._user();
    if (user) {
      localStorage.setItem('splendide_user', JSON.stringify(user));
      this.posthog.identifyUser(user);
    }
  }

  // ─── Session ────────────────────────────────────────────

  getToken(): string | null {
    return this._token();
  }

  logout(): void {
    void this.unregisterCurrentDevice();
    this._user.set(null);
    this._token.set(null);
    this.posthog.reset();
    this.themePreferenceAppliedForUserId = null;
    localStorage.removeItem('splendide_token');
    localStorage.removeItem('splendide_user');
    void this.clearNativeRefreshToken();
    this.http.post(`${this.apiUrl}/auth/logout`, {}, { withCredentials: true }).subscribe();
    this.router.navigate(['/']);
  }

  private async setSession(res: AuthResponse): Promise<void> {
    this._token.set(res.accessToken);
    this._user.set(res.user);
    localStorage.setItem('splendide_token', res.accessToken);
    localStorage.setItem('splendide_user', JSON.stringify(res.user));
    if (res.refreshToken) await this.saveNativeRefreshToken(res.refreshToken);
    this.applyUserThemePreference(res.user);
    this.posthog.identifyUser(res.user);
  }

  private async restoreNativeSession(): Promise<void> {
    try {
      if (!await this.getNativeRefreshToken()) return;
      if (!await this.refreshToken()) return;
      await this.fetchUser();
    } catch {
      await this.clearNativeRefreshToken().catch(() => undefined);
    }
  }

  private async copyAnonymousToNewUser(userId: string): Promise<void> {
    this.storage.copyAnonymousToUser(userId);
  }

  private loadToken(): string | null {
    try { return localStorage.getItem('splendide_token'); } catch { return null; }
  }

  private loadUser(): User | null {
    try {
      const raw = localStorage.getItem('splendide_user');
      const parsed = raw ? JSON.parse(raw) as User : null;
      return parsed ? {
        ...parsed,
        syncGeneration: parsed.syncGeneration ?? 0,
        darkMode: parsed.darkMode ?? null,
        sharedNotificationsEnabled: parsed.sharedNotificationsEnabled ?? false,
        hasStripeSubscription: parsed.hasStripeSubscription ?? false,
        hasMobileSubscription: parsed.hasMobileSubscription ?? false,
      } : null;
    } catch { return null; }
  }

  private applyUserThemePreference(user: User): void {
    if (this.themePreferenceAppliedForUserId === user.id) return;
    this.themePreferenceAppliedForUserId = user.id;

    if (user.darkMode === null || user.darkMode === undefined) {
      const darkMode = this.theme.dark();
      this._user.update(current => current ? { ...current, darkMode } : current);
      const current = this._user();
      if (current) {
        localStorage.setItem('splendide_user', JSON.stringify(current));
      }
      this.theme.saveCurrentPreferenceToAccount();
      return;
    }

    this.theme.setDark(user.darkMode);
  }

  private readonly mobileSocialLoginInitializations = new Map<'google' | 'apple', Promise<void>>();

  private initializeMobileSocialLogin(provider: 'google' | 'apple'): Promise<void> {
    const existing = this.mobileSocialLoginInitializations.get(provider);
    if (existing) return existing;

    const initialization = this.initializeMobileSocialProvider(provider).catch(error => {
      // A transient native/plugin error must not make future attempts no-ops.
      this.mobileSocialLoginInitializations.delete(provider);
      throw error;
    });
    this.mobileSocialLoginInitializations.set(provider, initialization);
    return initialization;
  }

  private async initializeMobileSocialProvider(provider: 'google' | 'apple'): Promise<void> {
    if (provider === 'google') {
      if (Capacitor.getPlatform() === 'ios') {
        await SocialLogin.initialize({
          google: {
            iOSClientId: environment.googleIosClientId,
            iOSServerClientId: environment.googleClientId,
            mode: 'online',
          },
        });
        return;
      }

      await SocialLogin.initialize({
        google: {
          webClientId: environment.googleClientId,
          mode: 'online',
        },
      });
      return;
    }

    if (Capacitor.getPlatform() !== 'ios') {
      throw new Error('apple sign in is only available in the iOS app');
    }
    await SocialLogin.initialize({
      apple: {
        clientId: 'app.splendide.mobile',
      },
    });
  }

  private async getNativeRefreshToken(): Promise<string | null> {
    if (!environment.isMobile) return null;
    const value = await SecureStorage.get('refreshToken');
    return typeof value === 'string' ? value : null;
  }

  private async saveNativeRefreshToken(token: string): Promise<void> {
    if (!environment.isMobile) return;
    await SecureStorage.set('refreshToken', token);
  }

  private async clearNativeRefreshToken(): Promise<void> {
    if (!environment.isMobile) return;
    await SecureStorage.remove('refreshToken');
  }

  private persistCurrentUser(): void {
    const user = this._user();
    if (user) localStorage.setItem('splendide_user', JSON.stringify(user));
  }

  private async unregisterCurrentDevice(): Promise<void> {
    if (!environment.isMobile) return;
    const token = localStorage.getItem('splendide_push_token');
    if (!token) return;
    try {
      await firstValueFrom(this.http.delete(`${this.apiUrl}/user/devices`, { body: { token } }));
    } catch {
      // The token is reassigned safely on the next login even if this best-effort cleanup fails.
    }
    localStorage.removeItem('splendide_push_token');
  }
}
