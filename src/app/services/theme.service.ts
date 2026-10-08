import { DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { effect, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

export type BackgroundThemeId = 'neutral' | 'linen' | 'mist' | 'sage' | 'dawn' | 'lilac';

export interface BackgroundThemeOption {
  id: BackgroundThemeId;
  label: string;
  lightGradient: string;
  darkGradient: string;
  lightChromeColor: string;
  darkChromeColor: string;
}

interface RemoteThemePreferences {
  userId: string;
  darkMode: boolean;
  backgroundTheme: BackgroundThemeId;
}

export const BACKGROUND_THEME_OPTIONS: readonly BackgroundThemeOption[] = [
  {
    id: 'neutral',
    label: 'neutral',
    lightGradient: '#fafafa',
    darkGradient: '#111111',
    lightChromeColor: '#fafafa',
    darkChromeColor: '#111111',
  },
  {
    id: 'linen',
    label: 'linen',
    lightGradient: 'linear-gradient(135deg, #f4c27b 0%, #e09a58 52%, #c67b59 100%)',
    darkGradient: 'linear-gradient(135deg, #6a4424 0%, #3d2817 52%, #120b07 100%)',
    lightChromeColor: '#f4c27b',
    darkChromeColor: '#6a4424',
  },
  {
    id: 'mist',
    label: 'mist',
    lightGradient: 'linear-gradient(135deg, #99dcef 0%, #63b9d8 52%, #4e93b2 100%)',
    darkGradient: 'linear-gradient(135deg, #20647f 0%, #113f53 52%, #05141b 100%)',
    lightChromeColor: '#99dcef',
    darkChromeColor: '#20647f',
  },
  {
    id: 'sage',
    label: 'sage',
    lightGradient: 'linear-gradient(135deg, #b5df9c 0%, #78bc82 52%, #5a936d 100%)',
    darkGradient: 'linear-gradient(135deg, #306b42 0%, #183f28 52%, #05120b 100%)',
    lightChromeColor: '#b5df9c',
    darkChromeColor: '#306b42',
  },
  {
    id: 'dawn',
    label: 'dawn',
    lightGradient: 'linear-gradient(135deg, #f6ab80 0%, #e77b70 52%, #cb6478 100%)',
    darkGradient: 'linear-gradient(135deg, #7c3b32 0%, #4a211e 52%, #160807 100%)',
    lightChromeColor: '#f6ab80',
    darkChromeColor: '#7c3b32',
  },
  {
    id: 'lilac',
    label: 'lilac',
    lightGradient: 'linear-gradient(135deg, #d7abea 0%, #ac7dd4 52%, #9072ba 100%)',
    darkGradient: 'linear-gradient(135deg, #64377c 0%, #3b214a 52%, #110716 100%)',
    lightChromeColor: '#d7abea',
    darkChromeColor: '#64377c',
  },
];

const BACKGROUND_THEME_IDS = new Set<BackgroundThemeId>(
  BACKGROUND_THEME_OPTIONS.map(option => option.id),
);
const DARK_STORAGE_KEY = 'splendide_dark';
const BACKGROUND_STORAGE_KEY = 'splendide_background_theme';
const PENDING_REMOTE_STORAGE_KEY = 'splendide_pending_theme_preferences';

export function isBackgroundThemeId(value: unknown): value is BackgroundThemeId {
  return typeof value === 'string' && BACKGROUND_THEME_IDS.has(value as BackgroundThemeId);
}

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly doc = inject(DOCUMENT);
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;
  readonly dark = signal(this.loadDark());
  readonly backgroundTheme = signal<BackgroundThemeId>(this.loadBackgroundTheme());
  private readonly pendingRemotePreferences = this.loadPendingRemotePreferences();
  private remoteSaveInProgress = false;

  constructor() {
    effect(() => {
      const isDark = this.dark();
      const backgroundTheme = this.backgroundTheme();
      try {
        localStorage.setItem(DARK_STORAGE_KEY, JSON.stringify(isDark));
        localStorage.setItem(BACKGROUND_STORAGE_KEY, backgroundTheme);
      } catch {
        // The active theme still applies when storage is unavailable.
      }

      // Keep saved color preferences for later; appearance currently offers only light/dark.
      this.doc.documentElement.dataset['backgroundTheme'] = 'neutral';
      this.doc.documentElement.classList.toggle('dark', isDark);
      this.doc.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
      this.doc.body.dataset['backgroundTheme'] = 'neutral';
      this.doc.body.classList.toggle('dark', isDark);
      this.doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
        'content',
        this.chromeColor(isDark),
      );
    });

    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        if (this.pendingRemotePreferences.size > 0 && !this.remoteSaveInProgress) {
          void this.flushRemoteSave();
        }
      });
    }

  }

  toggle(): void {
    this.setDark(!this.dark());
    this.saveCurrentPreferenceToAccount();
  }

  setDark(value: boolean): void {
    this.dark.set(value);
  }

  setBackgroundTheme(value: BackgroundThemeId): void {
    this.backgroundTheme.set(isBackgroundThemeId(value) ? value : 'neutral');
  }

  chromeColor(dark = this.dark()): string {
    const option = BACKGROUND_THEME_OPTIONS[0];
    return dark ? option.darkChromeColor : option.lightChromeColor;
  }

  saveCurrentPreferenceToAccount(): void {
    const userId = this.signedInUserId();
    if (!userId) return;
    const preferences = {
      userId,
      darkMode: this.dark(),
      backgroundTheme: this.backgroundTheme(),
    };
    this.pendingRemotePreferences.set(userId, preferences);
    this.persistPendingRemotePreferences();
    this.updateCachedUserTheme(preferences);
    if (!this.remoteSaveInProgress) {
      void this.flushRemoteSave();
    }
  }

  pendingPreferenceForUser(
    userId: string,
  ): { darkMode: boolean; backgroundTheme: BackgroundThemeId } | null {
    const pending = this.pendingRemotePreferences.get(userId);
    if (!pending) return null;
    if (!this.remoteSaveInProgress && this.signedInUserId() === userId) {
      queueMicrotask(() => {
        if (!this.remoteSaveInProgress && this.signedInUserId() === userId) {
          void this.flushRemoteSave();
        }
      });
    }
    return { darkMode: pending.darkMode, backgroundTheme: pending.backgroundTheme };
  }

  private loadDark(): boolean {
    try {
      const raw = localStorage.getItem(DARK_STORAGE_KEY) ?? localStorage.getItem('chiaro_dark');
      return raw === 'true';
    } catch {
      return false;
    }
  }

  private loadBackgroundTheme(): BackgroundThemeId {
    try {
      const value = localStorage.getItem(BACKGROUND_STORAGE_KEY);
      return isBackgroundThemeId(value) ? value : 'neutral';
    } catch {
      return 'neutral';
    }
  }

  private loadPendingRemotePreferences(): Map<string, RemoteThemePreferences> {
    const preferences = new Map<string, RemoteThemePreferences>();
    try {
      const raw = localStorage.getItem(PENDING_REMOTE_STORAGE_KEY);
      if (!raw) return preferences;
      const parsed: unknown = JSON.parse(raw);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const candidate of candidates) {
        if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) continue;
        const value = candidate as Record<string, unknown>;
        if (
          typeof value['userId'] === 'string' &&
          value['userId'].length > 0 &&
          typeof value['darkMode'] === 'boolean' &&
          isBackgroundThemeId(value['backgroundTheme'])
        ) {
          preferences.set(value['userId'], {
            userId: value['userId'],
            darkMode: value['darkMode'],
            backgroundTheme: value['backgroundTheme'],
          });
        }
      }
      if (preferences.size === 0) localStorage.removeItem(PENDING_REMOTE_STORAGE_KEY);
      return preferences;
    } catch {
      return preferences;
    }
  }

  private persistPendingRemotePreferences(): void {
    try {
      if (this.pendingRemotePreferences.size > 0) {
        localStorage.setItem(
          PENDING_REMOTE_STORAGE_KEY,
          JSON.stringify([...this.pendingRemotePreferences.values()]),
        );
      } else {
        localStorage.removeItem(PENDING_REMOTE_STORAGE_KEY);
      }
    } catch {
      // Keep the in-memory retry even when durable storage is unavailable.
    }
  }

  private signedInUserId(): string | null {
    try {
      if (!localStorage.getItem('splendide_token')) return null;
      const rawUser = localStorage.getItem('splendide_user');
      if (!rawUser) return null;
      const id = (JSON.parse(rawUser) as Record<string, unknown>)['id'];
      return typeof id === 'string' && id.length > 0 ? id : null;
    } catch {
      return null;
    }
  }

  private async flushRemoteSave(): Promise<void> {
    this.remoteSaveInProgress = true;
    let failed = false;

    try {
      const userId = this.signedInUserId();
      if (!userId) return;
      while (this.pendingRemotePreferences.has(userId)) {
        const preferences = this.pendingRemotePreferences.get(userId)!;
        if (this.signedInUserId() !== userId) break;
        const { userId: _userId, ...payload } = preferences;
        try {
          await firstValueFrom(this.http.patch(`${this.apiUrl}/user/preferences`, payload));
          if (
            this.pendingRemotePreferences.get(userId)?.darkMode === preferences.darkMode &&
            this.pendingRemotePreferences.get(userId)?.backgroundTheme === preferences.backgroundTheme
          ) {
            this.pendingRemotePreferences.delete(userId);
            this.persistPendingRemotePreferences();
          }
        } catch {
          failed = true;
          break;
        }
      }
    } finally {
      this.remoteSaveInProgress = false;
      const currentUserId = this.signedInUserId();
      if (
        !failed &&
        currentUserId !== null &&
        this.pendingRemotePreferences.has(currentUserId)
      ) {
        void this.flushRemoteSave();
      }
    }
  }

  private updateCachedUserTheme(
    preferences: { darkMode: boolean; backgroundTheme: BackgroundThemeId },
  ): void {
    try {
      const raw = localStorage.getItem('splendide_user');
      if (!raw) return;
      const user = JSON.parse(raw) as Record<string, unknown>;
      localStorage.setItem('splendide_user', JSON.stringify({ ...user, ...preferences }));
    } catch {
      // Ignore malformed cached user data.
    }
  }
}
