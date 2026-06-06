import { Injectable, signal, effect, inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly doc = inject(DOCUMENT);
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;
  readonly dark = signal(this.loadDark());
  private pendingRemoteDark: boolean | null = null;
  private remoteSaveInProgress = false;

  constructor() {
    effect(() => {
      const isDark = this.dark();
      try { localStorage.setItem('splendide_dark', JSON.stringify(isDark)); } catch {}
      this.doc.body.classList.toggle('dark', isDark);
    });
  }

  toggle(): void {
    const next = !this.dark();
    this.setDark(next);
    this.saveCurrentPreferenceToAccount();
  }

  setDark(value: boolean): void {
    this.dark.set(value);
  }

  saveCurrentPreferenceToAccount(): void {
    if (!this.hasSignedInSession()) return;
    const darkMode = this.dark();
    this.pendingRemoteDark = darkMode;
    this.updateCachedUserTheme(darkMode);
    if (!this.remoteSaveInProgress) {
      void this.flushRemoteSave();
    }
  }

  private loadDark(): boolean {
    try {
      const raw = localStorage.getItem('splendide_dark') ?? localStorage.getItem('chiaro_dark');
      return raw === 'true';
    } catch { return false; }
  }

  private hasSignedInSession(): boolean {
    try {
      return Boolean(localStorage.getItem('splendide_token'));
    } catch {
      return false;
    }
  }

  private async flushRemoteSave(): Promise<void> {
    this.remoteSaveInProgress = true;

    try {
      while (this.pendingRemoteDark !== null) {
        const darkMode = this.pendingRemoteDark;
        this.pendingRemoteDark = null;
        await firstValueFrom(this.http.patch(`${this.apiUrl}/user/preferences`, { darkMode }));
      }
    } catch {
      // Keep the local preference even if the account preference cannot be saved right now.
    } finally {
      this.remoteSaveInProgress = false;
      if (this.pendingRemoteDark !== null) {
        void this.flushRemoteSave();
      }
    }
  }

  private updateCachedUserTheme(darkMode: boolean): void {
    try {
      const raw = localStorage.getItem('splendide_user');
      if (!raw) return;
      const user = JSON.parse(raw) as Record<string, unknown>;
      localStorage.setItem('splendide_user', JSON.stringify({ ...user, darkMode }));
    } catch {
      // Ignore malformed cached user data.
    }
  }
}
