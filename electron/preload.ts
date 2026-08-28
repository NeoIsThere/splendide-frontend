import { contextBridge, ipcRenderer } from 'electron';

const DEADLINE_OPENED_CHANNEL = 'deadline-notification-opened';

contextBridge.exposeInMainWorld('splendideDesktop', {
  isDesktop: true,
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  startGoogleOAuth: (clientId: string) => ipcRenderer.invoke('google-oauth-start', clientId),
  notificationPermissionStatus: () => ipcRenderer.invoke('notification-permission-status'),
  requestNotificationPermission: () => ipcRenderer.invoke('notification-request-permission'),
  reconcileDeadlineNotifications: (schedules: unknown[]) => ipcRenderer.invoke('notification-reconcile-deadlines', schedules),
  cancelAllDeadlineNotifications: () => ipcRenderer.invoke('notification-cancel-all-deadlines'),
  onDeadlineNotificationOpened: (listener: (target: unknown) => void) => {
    ipcRenderer.removeAllListeners(DEADLINE_OPENED_CHANNEL);
    ipcRenderer.on(DEADLINE_OPENED_CHANNEL, (_event, target) => listener(target));
  },
});
