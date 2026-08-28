declare global {
  type DesktopGoogleOAuthResult = {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  };

  type DesktopNotificationPermission = 'unsupported' | 'prompt' | 'granted' | 'denied';

  type DesktopDeadlineNotificationTarget = {
    pageId: string;
    taskId: string;
    shareToken?: string;
  };

  type DesktopDeadlineNotificationSchedule = DesktopDeadlineNotificationTarget & {
    eventId: string;
    pageTitle: string;
    taskText: string;
    deadlineAt: string;
  };

  interface Window {
    splendideDesktop?: {
      isDesktop: boolean;
      openExternal(url: string): Promise<void>;
      startGoogleOAuth(clientId: string): Promise<DesktopGoogleOAuthResult>;
      notificationPermissionStatus(): Promise<DesktopNotificationPermission>;
      requestNotificationPermission(): Promise<DesktopNotificationPermission>;
      reconcileDeadlineNotifications(schedules: DesktopDeadlineNotificationSchedule[]): Promise<void>;
      cancelAllDeadlineNotifications(): Promise<void>;
      onDeadlineNotificationOpened(listener: (target: DesktopDeadlineNotificationTarget) => void): void;
    };
  }
}

import { Browser } from '@capacitor/browser';
import { environment } from '../../environments/environment';

export async function openExternalUrl(url: string): Promise<boolean> {
  if (environment.isMobile) {
    await Browser.open({ url });
    return true;
  }
  if (window.splendideDesktop?.isDesktop) {
    await window.splendideDesktop.openExternal(url);
    return true;
  }

  window.location.href = url;
  return false;
}
