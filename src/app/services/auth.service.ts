import { Injectable, inject, signal, computed } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { StorageService } from './storage.service';
import {
  BackgroundThemeId,
  isBackgroundThemeId,
  ThemeService,
} from './theme.service';
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
  backgroundTheme: BackgroundThemeId | null;
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
    window.addEventListener('storage', event => this.syncSessionFromStorage(event));
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
    localStorage.removeItem('splendide_token');
    localStorage.removeItem('splendide_user');
    await this.clearNativeRefreshToken();
    this.router.navigate(['/']);
  }

  // ─── Token Refresh ──────────────────────────────────────

  async refreshToken(): Promise<string> {
    const refreshToken = await this.getNativeRefreshToken();
    const res = await firstValueFrom(this.http.post<{ accessToken: string; refreshToken?: string }>(
      `${this.apiUrl}/auth/refresh`,
      refreshToken ? { refreshToken } : {},
      { withCredentials: true },
    ));
    if (!res.accessToken) {
      throw new Error('The refresh response did not include an access token');
    }

    this._token.set(res.accessToken);
    localStorage.setItem('splendide_token', res.accessToken);
    if (res.refreshToken) {
      // The previous refresh token belongs to the same revocable session, so a
      // transient Keychain/Keystore write failure must not discard the active
      // access token or force the user through sign-in again.
      await this.saveNativeRefreshToken(res.refreshToken).catch(() => undefined);
    }
    return res.accessToken;
  }

  // ─── Fetch user profile ─────────────────────────────────

  async fetchUser(): Promise<User | null> {
    try {
      const response = await firstValueFrom(this.http.get<User>(`${this.apiUrl}/user/me`));
      const user = this.normalizeUserPreferences(response);
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
    const token = this.getToken();
    void this.unregisterCurrentDevice();
    this.clearLocalSession();
    this.http.post(`${this.apiUrl}/auth/logout`, {}, {
      withCredentials: true,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).subscribe({ error: () => undefined });
    this.router.navigate(['/']);
  }

  /**
   * Clears a session only after the refresh credential has been rejected.
   * Unlike an explicit logout, this deliberately performs no authenticated
   * cleanup request: retrying one with an expired access token would recurse
   * through the interceptor and can turn a single 401 into a logout loop.
   */
  expireSession(): void {
    this.clearLocalSession();
    this.router.navigate(['/']);
  }

  private async setSession(res: AuthResponse): Promise<void> {
    const user = this.normalizeUserPreferences(res.user);
    this._token.set(res.accessToken);
    this._user.set(user);
    localStorage.setItem('splendide_token', res.accessToken);
    localStorage.setItem('splendide_user', JSON.stringify(user));
    if (res.refreshToken) {
      await this.saveNativeRefreshToken(res.refreshToken).catch(() => undefined);
    }
    this.applyUserThemePreference(user);
    this.posthog.identifyUser(user);
  }

  private async restoreNativeSession(): Promise<void> {
    try {
      if (!await this.getNativeRefreshToken()) return;
      await this.refreshToken();
      await this.fetchUser();
    } catch (error) {
      if (this.isRejectedRefreshCredential(error)) {
        this.clearLocalSession();
      }
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
      return parsed ? this.normalizeUserPreferences({
        ...parsed,
        syncGeneration: parsed.syncGeneration ?? 0,
        sharedNotificationsEnabled: parsed.sharedNotificationsEnabled ?? false,
        hasStripeSubscription: parsed.hasStripeSubscription ?? false,
        hasMobileSubscription: parsed.hasMobileSubscription ?? false,
      }) : null;
    } catch { return null; }
  }

  private syncSessionFromStorage(event: StorageEvent): void {
    if (event.storageArea !== localStorage) return;
    if (event.key === 'splendide_token') {
      if (event.newValue === this._token()) return;
      this._token.set(event.newValue);
      if (!event.newValue) {
        this._user.set(null);
        this.posthog.reset();
        this.storage.setActivePartition();
        return;
      }
      // Never keep the former account paired with a token written by another
      // tab. The matching user storage event or this refresh establishes the
      // new identity and triggers notification/session reconciliation.
      this._user.set(null);
      void this.fetchUser();
      return;
    }
    if (event.key !== 'splendide_user' || !this._token()) return;
    const user = this.loadUser();
    if (!user) return;
    this._user.set(user);
    this.applyUserThemePreference(user);
    this.posthog.identifyUser(user);
  }

  private normalizeUserPreferences(user: User): User {
    return {
      ...user,
      darkMode: typeof user.darkMode === 'boolean' ? user.darkMode : null,
      backgroundTheme: isBackgroundThemeId(user.backgroundTheme) ? user.backgroundTheme : null,
    };
  }

  private applyUserThemePreference(user: User): void {
    const pending = this.theme.pendingPreferenceForUser(user.id);
    const needsDarkPreference = !pending && typeof user.darkMode !== 'boolean';
    const needsBackgroundPreference = !pending && !isBackgroundThemeId(user.backgroundTheme);
    const darkMode = pending?.darkMode
      ?? (typeof user.darkMode === 'boolean' ? user.darkMode : this.theme.dark());
    const backgroundTheme = pending?.backgroundTheme
      ?? (isBackgroundThemeId(user.backgroundTheme)
        ? user.backgroundTheme
        : this.theme.backgroundTheme());

    this.theme.setDark(darkMode);
    this.theme.setBackgroundTheme(backgroundTheme);
    if (
      pending ||
      needsDarkPreference ||
      needsBackgroundPreference ||
      user.darkMode !== darkMode ||
      user.backgroundTheme !== backgroundTheme
    ) {
      this._user.update(current => current ? { ...current, darkMode, backgroundTheme } : current);
      const current = this._user();
      if (current) {
        localStorage.setItem('splendide_user', JSON.stringify(current));
      }
      if (!pending && (needsDarkPreference || needsBackgroundPreference)) {
        this.theme.saveCurrentPreferenceToAccount();
      }
    }
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

  private clearLocalSession(): void {
    this._user.set(null);
    this._token.set(null);
    this.posthog.reset();
    localStorage.removeItem('splendide_token');
    localStorage.removeItem('splendide_user');
    void this.clearNativeRefreshToken().catch(() => undefined);
  }

  private isRejectedRefreshCredential(error: unknown): boolean {
    return error instanceof HttpErrorResponse &&
      (error.status === 400 || error.status === 401 || error.status === 403);
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
