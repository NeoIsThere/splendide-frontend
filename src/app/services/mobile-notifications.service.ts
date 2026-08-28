import { inject, Injectable } from '@angular/core';
import { AuthService } from './auth.service';
import { DeadlineNotificationsService } from './deadline-notifications.service';

/**
 * Compatibility facade for the existing shared-page notification setting.
 * Device/browser registration is owned by DeadlineNotificationsService so it
 * is not coupled to any single notification feature.
 */
@Injectable({ providedIn: 'root' })
export class MobileNotificationsService {
  private readonly auth = inject(AuthService);
  private readonly notifications = inject(DeadlineNotificationsService);

  readonly permission = this.notifications.permissionState;

  async setEnabled(enabled: boolean): Promise<void> {
    if (!enabled) {
      await this.auth.updateSharedNotifications(false);
      return;
    }

    const granted = await this.notifications.requestPermission();
    if (!granted) {
      throw new Error(this.notifications.permissionState() === 'unsupported'
        ? 'push notifications are not supported on this device'
        : 'notification permission was not granted');
    }

    await this.auth.updateSharedNotifications(true);
  }
}
