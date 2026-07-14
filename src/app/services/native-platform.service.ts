import { effect, inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { Keyboard } from '@capacitor/keyboard';
import { environment } from '../../environments/environment';
import { ThemeService } from './theme.service';

@Injectable({ providedIn: 'root' })
export class NativePlatformService {
  private readonly router = inject(Router);
  private readonly theme = inject(ThemeService);

  readonly isMobile = environment.isMobile && Capacitor.isNativePlatform();
  readonly platform = Capacitor.getPlatform();

  constructor() {
    if (!this.isMobile) return;
    document.documentElement.classList.add('native-mobile', `native-${this.platform}`);
    void Keyboard.addListener('keyboardWillShow', () => {
      document.documentElement.classList.add('keyboard-open');
    });
    void Keyboard.addListener('keyboardWillHide', () => {
      document.documentElement.classList.remove('keyboard-open');
    });
    void Keyboard.addListener('keyboardDidHide', () => {
      document.documentElement.classList.remove('keyboard-open');
    });
    void CapacitorApp.addListener('appUrlOpen', event => this.openDeepLink(event.url));
    void CapacitorApp.addListener('appStateChange', event => {
      if (event.isActive) window.dispatchEvent(new Event('splendide-app-resume'));
    });
    void CapacitorApp.getLaunchUrl().then(event => {
      if (event?.url) this.openDeepLink(event.url);
    });
    effect(() => {
      void SystemBars.setStyle({ style: this.theme.dark() ? SystemBarsStyle.Dark : SystemBarsStyle.Light });
    });
  }

  async dragStarted(): Promise<void> {
    if (!this.isMobile) return;
    await Haptics.impact({ style: ImpactStyle.Light });
  }

  async dropCompleted(): Promise<void> {
    if (!this.isMobile) return;
    await Haptics.impact({ style: ImpactStyle.Medium });
  }

  private openDeepLink(rawUrl: string): void {
    try {
      const url = new URL(rawUrl);
      const path = url.protocol === 'splendide:'
        ? `/${[url.host, ...url.pathname.split('/')].filter(Boolean).join('/')}`
        : url.pathname;
      if (path.startsWith('/share/')) {
        void this.router.navigateByUrl(path);
        return;
      }
      if (['/verify-email', '/reset-password'].includes(path)) {
        void this.router.navigate([path], { queryParams: Object.fromEntries(url.searchParams.entries()) });
      }
    } catch {
      // Ignore malformed external URLs.
    }
  }
}
