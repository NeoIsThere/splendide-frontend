import { effect, inject, Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Capacitor } from '@capacitor/core';
import { FirebaseMessaging, Importance, type Notification } from '@capacitor-firebase/messaging';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';

@Injectable({ providedIn: 'root' })
export class MobileNotificationsService {
  private readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly apiUrl = environment.apiUrl;
  private initialized = false;
  private enabling = false;

  readonly permission = signal<'unknown' | 'granted' | 'denied'>('unknown');

  constructor() {
    if (!environment.isMobile) return;
    effect(() => {
      const user = this.auth.user();
      if (user?.sharedNotificationsEnabled) {
        void this.activate(false);
      }
    });
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (!environment.isMobile) return;
    if (!enabled) {
      await this.auth.updateSharedNotifications(false);
      return;
    }
    await this.activate(true);
  }

  private async activate(requestPermission: boolean): Promise<void> {
    if (this.enabling || !this.auth.user()) return;
    this.enabling = true;
    try {
      const supported = await FirebaseMessaging.isSupported();
      if (!supported.isSupported) throw new Error('push notifications are not supported on this device');

      await this.initializeListeners();
      let status = await FirebaseMessaging.checkPermissions();
      if (requestPermission && status.receive !== 'granted') {
        status = await FirebaseMessaging.requestPermissions();
      }
      if (status.receive !== 'granted') {
        this.permission.set('denied');
        if (this.auth.user()?.sharedNotificationsEnabled) {
          await this.auth.updateSharedNotifications(false);
        }
        if (requestPermission) throw new Error('notification permission was not granted');
        return;
      }

      this.permission.set('granted');
      if (Capacitor.getPlatform() === 'android') {
        await FirebaseMessaging.createChannel({
          id: 'shared-pages',
          name: 'Shared pages',
          description: 'Updates when an item is added to a shared page',
          importance: Importance.High,
          vibration: true,
        });
      }

      const { token } = await FirebaseMessaging.getToken();
      await this.registerToken(token);
      if (!this.auth.user()?.sharedNotificationsEnabled) {
        await this.auth.updateSharedNotifications(true);
      }
    } finally {
      this.enabling = false;
    }
  }

  private async initializeListeners(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await FirebaseMessaging.addListener('tokenReceived', event => {
      if (this.auth.user()?.sharedNotificationsEnabled) void this.registerToken(event.token);
    });
    await FirebaseMessaging.addListener('notificationActionPerformed', event => {
      this.openNotification(event.notification);
    });
  }

  private async registerToken(token: string): Promise<void> {
    await firstValueFrom(this.http.post(`${this.apiUrl}/user/devices`, {
      token,
      platform: Capacitor.getPlatform(),
    }));
    localStorage.setItem('splendide_push_token', token);
  }

  private openNotification(notification: Notification): void {
    const data = typeof notification.data === 'object' && notification.data !== null
      ? notification.data as Record<string, unknown>
      : {};
    const shareToken = typeof data['shareToken'] === 'string' ? data['shareToken'] : '';
    void this.router.navigate(shareToken ? ['/share', shareToken] : ['/']);
  }
}
