import { Injectable, inject, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { StorageService } from './storage.service';
import { ThemeService } from './theme.service';

export interface User {
  id: string;
  email: string;
  name: string | null;
  isPremium: boolean;
  hasPassword: boolean;
  syncGeneration: number;
  darkMode: boolean | null;
}

interface AuthResponse {
  accessToken: string;
  user: User;
  isNewUser?: boolean;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly storage = inject(StorageService);
  private readonly theme = inject(ThemeService);
  private readonly apiUrl = environment.apiUrl;

  private readonly _user = signal<User | null>(this.loadUser());
  private readonly _token = signal<string | null>(this.loadToken());
  private themePreferenceAppliedForUserId: string | null = null;

  readonly user = this._user.asReadonly();
  readonly isLoggedIn = computed(() => !!this._token());
  readonly isPremium = computed(() => this._user()?.isPremium ?? false);

  constructor() {
    if (this._token()) {
      void this.fetchUser();
    }
  }

  // ─── Email / Password ───────────────────────────────────

  async register(email: string, password: string, name?: string): Promise<{ status: 'VERIFY_EMAIL' }> {
    await firstValueFrom(this.http.post<{ message: string }>(`${this.apiUrl}/auth/register`, { email, password, name }, { withCredentials: true }));
    return { status: 'VERIFY_EMAIL' };
  }

  async verifyEmail(token: string): Promise<void> {
    const res = await firstValueFrom(this.http.post<AuthResponse>(`${this.apiUrl}/auth/verify-email`, { token }, { withCredentials: true }));
    this.setSession(res);
    if (res.isNewUser) {
      await this.copyAnonymousToNewUser(res.user.id);
    }
  }

  async resendVerification(email: string): Promise<void> {
    await firstValueFrom(this.http.post(`${this.apiUrl}/auth/resend-verification`, { email }));
  }

  async login(email: string, password: string): Promise<void> {
    const res = await firstValueFrom(this.http.post<AuthResponse>(`${this.apiUrl}/auth/login`, { email, password }, { withCredentials: true }));
    this.setSession(res);
  }

  // ─── Google ─────────────────────────────────────────────

  async googleAuth(idToken: string): Promise<{ isNewUser: boolean }> {
    const res = await firstValueFrom(this.http.post<AuthResponse>(`${this.apiUrl}/auth/google`, { idToken }, { withCredentials: true }));
    this.setSession(res);
    if (res.isNewUser) {
      await this.copyAnonymousToNewUser(res.user.id);
    }
    return { isNewUser: res.isNewUser ?? false };
  }

  async googleDesktopAuth(): Promise<{ isNewUser: boolean }> {
    const desktop = window.splendideDesktop;
    if (!desktop?.isDesktop) {
      throw new Error('desktop google sign-in is only available in the electron app');
    }

    const oauth = await desktop.startGoogleOAuth(environment.googleClientId);
    const res = await firstValueFrom(this.http.post<AuthResponse>(`${this.apiUrl}/auth/google/oauth`, oauth, { withCredentials: true }));
    this.setSession(res);
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
    this.themePreferenceAppliedForUserId = null;
    localStorage.removeItem('splendide_token');
    localStorage.removeItem('splendide_user');
    this.router.navigate(['/']);
  }

  // ─── Token Refresh ──────────────────────────────────────

  async refreshToken(): Promise<string | null> {
    try {
      const res = await firstValueFrom(this.http.post<{ accessToken: string }>(`${this.apiUrl}/auth/refresh`, {}, { withCredentials: true }));
      if (res.accessToken) {
        this._token.set(res.accessToken);
        localStorage.setItem('splendide_token', res.accessToken);
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
    if (user) localStorage.setItem('splendide_user', JSON.stringify(user));
    return isPremium;
  }

  async redeemVipCode(code: string): Promise<void> {
    await firstValueFrom(this.http.post(`${this.apiUrl}/payment/redeem-code`, { code }));
    this._user.update(u => u ? { ...u, isPremium: true } : u);
    const user = this._user();
    if (user) localStorage.setItem('splendide_user', JSON.stringify(user));
  }

  // ─── Session ────────────────────────────────────────────

  getToken(): string | null {
    return this._token();
  }

  logout(): void {
    this._user.set(null);
    this._token.set(null);
    this.themePreferenceAppliedForUserId = null;
    localStorage.removeItem('splendide_token');
    localStorage.removeItem('splendide_user');
    this.http.post(`${this.apiUrl}/auth/logout`, {}, { withCredentials: true }).subscribe();
    this.router.navigate(['/']);
  }

  private setSession(res: AuthResponse): void {
    this._token.set(res.accessToken);
    this._user.set(res.user);
    localStorage.setItem('splendide_token', res.accessToken);
    localStorage.setItem('splendide_user', JSON.stringify(res.user));
    this.applyUserThemePreference(res.user);
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
      return parsed ? { ...parsed, syncGeneration: parsed.syncGeneration ?? 0, darkMode: parsed.darkMode ?? null } : null;
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
}
