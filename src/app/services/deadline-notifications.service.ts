import { effect, inject, Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { FirebaseMessaging, type Notification as FirebaseNotification } from '@capacitor-firebase/messaging';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';
import { type StoredItem, type StoredSection } from './storage.service';

export type DeadlineNotificationPermission = 'unsupported' | 'prompt' | 'granted' | 'denied';
export type DeadlineNotificationRegistration = 'idle' | 'ready' | 'retrying';

export interface DeadlineNotificationTarget {
  pageId: string;
  taskId: string;
  shareToken?: string;
}

interface DeadlineNotificationSchedule extends DeadlineNotificationTarget {
  eventId: string;
  pageTitle: string;
  taskText: string;
  deadlineAt: string;
}

interface WebPushKeyResponse {
  publicKey: string;
}

interface DeadlineSnapshotResponse {
  schedules: DeadlineNotificationSchedule[];
}

interface PendingNotificationRevocations {
  mobileTokens: PendingNotificationRevocation[];
  webEndpoints: PendingNotificationRevocation[];
}

interface PendingNotificationRevocation {
  value: string;
  userId: string;
}

interface AndroidDeadlineNotificationsPlugin {
  createChannels(): Promise<void>;
  show(options: {
    id: string;
    channelId: 'deadlines' | 'shared-pages';
    title: string;
    body: string;
    pageId?: string;
    taskId?: string;
    shareToken?: string;
  }): Promise<void>;
}

const AndroidDeadlineNotifications = registerPlugin<AndroidDeadlineNotificationsPlugin>('DeadlineNotifications');
const NOTIFICATION_INTENT_KEY = 'splendide_notification_intent';
const WEB_DELIVERED_EVENTS_KEY = 'splendide_web_deadline_events';
const WEB_PUSH_ENDPOINT_KEY = 'splendide_web_push_endpoint';
const WEB_PUSH_USER_KEY = 'splendide_web_push_user';
const MOBILE_PUSH_USER_KEY = 'splendide_push_token_user';
const PENDING_REVOCATIONS_KEY = 'splendide_pending_notification_revocations';
const PUSH_WORKER_PATH = '/push-sw.js';
const MAX_TIMER_DELAY_MS = 2_147_000_000;

@Injectable({ providedIn: 'root' })
export class DeadlineNotificationsService {
  private readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly apiUrl = environment.apiUrl;
  private readonly nativeMobile = environment.isMobile && Capacitor.isNativePlatform();
  private readonly _permissionState = signal<DeadlineNotificationPermission>('prompt');
  private readonly _registrationState = signal<DeadlineNotificationRegistration>('idle');
  private readonly _openedDeadline = signal<DeadlineNotificationTarget | null>(null);
  private nativeListenersInitialized = false;
  private webListenerInitialized = false;
  private electronListenerInitialized = false;
  private registrationPromise: Promise<void> | null = null;
  private registrationUserId: string | null = null;
  private installationTransition: Promise<void> = Promise.resolve();
  private revocationFlushPromise: Promise<void> | null = null;
  private electronSnapshotPromise: Promise<void> | null = null;
  private electronSnapshotUserId: string | null = null;
  private registeredInstallationKey: string | null = null;
  private readonly webDeadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private electronReconciliationDeferrals = 0;
  private deferredElectronSchedules: DeadlineNotificationSchedule[] | null = null;
  private notificationIntent = false;
  private previousUserId: string | null = null;

  readonly permissionState = this._permissionState.asReadonly();
  readonly registrationState = this._registrationState.asReadonly();
  readonly openedDeadline = this._openedDeadline.asReadonly();

  constructor() {
    this.notificationIntent = this.readNotificationIntent();
    void this.initializePlatform().catch(() => {
      // A transient platform/plugin failure should not interrupt app startup.
    });
    queueMicrotask(() => void this.flushPendingRevocations());

    effect(() => {
      const user = this.auth.user();
      const userId = user?.id ?? null;
      const previousUserId = this.previousUserId;
      if (previousUserId && previousUserId !== userId) {
        this.forgetNotificationIntent();
        void this.queueInstallationOperation(
          () => this.clearInstallationAfterSessionEnd(previousUserId),
        );
      }
      this.previousUserId = userId;

      if (!user) return;
      if (user.sharedNotificationsEnabled) this.rememberNotificationIntent();
      if (user.sharedNotificationsEnabled || this.hasNotificationIntent()) {
        void this.ensureRegistrationWithoutPrompt().catch(() => undefined);
      }
    });
  }

  /**
   * Requests notification access only in response to an explicit user action.
   * Saving a deadline must not depend on this returning true.
   */
  async requestPermission(): Promise<boolean> {
    this.rememberNotificationIntent();

    if (environment.isElectron) {
      try {
        const state = await window.splendideDesktop?.requestNotificationPermission();
        this._permissionState.set(this.normalizePermission(state));
        this._registrationState.set(this._permissionState() === 'granted' ? 'ready' : 'idle');
        return this._permissionState() === 'granted';
      } catch {
        return false;
      }
    }

    if (this.nativeMobile) {
      try {
        await this.initializeNativeListeners();
        const supported = await FirebaseMessaging.isSupported();
        if (!supported.isSupported) {
          this._permissionState.set('unsupported');
          return false;
        }
        let permission = await FirebaseMessaging.checkPermissions();
        if (permission.receive !== 'granted') {
          permission = await FirebaseMessaging.requestPermissions();
        }
        const state = this.normalizePermission(permission.receive);
        this._permissionState.set(state);
        if (state === 'granted') {
          // Permission and registration are separate: an offline registration
          // failure must not make the granted OS permission look denied.
          await this.ensureRegistrationWithoutPrompt().catch(() => undefined);
        }
        return state === 'granted';
      } catch {
        return false;
      }
    }

    if (!this.webPushSupported()) {
      this._permissionState.set('unsupported');
      return false;
    }

    try {
      const permission = await Notification.requestPermission();
      const state = this.normalizePermission(permission);
      this._permissionState.set(state);
      if (state === 'granted') {
        await this.ensureRegistrationWithoutPrompt().catch(() => undefined);
      }
      return state === 'granted';
    } catch {
      this._permissionState.set(this.normalizePermission(Notification.permission));
      return false;
    }
  }

  /**
   * Reconciles the complete visible task snapshot. It never opens an OS prompt.
   * Electron persists local schedules. Native and web background delivery is
   * server-driven; web also has a foreground timer fallback when push delivery
   * is late or unavailable.
   */
  async reconcileDeadlines(sections: StoredSection[]): Promise<void> {
    const schedules = this.deadlineSchedules(sections);

    if (environment.isElectron) {
      if (this.electronReconciliationDeferrals > 0) {
        this.deferredElectronSchedules = schedules;
        return;
      }
      await this.reconcileElectronSchedules(schedules);
      return;
    }

    if (!this.nativeMobile) this.reconcileWebForegroundTimers(schedules);

    if (schedules.length > 0 && this.hasNotificationIntent()) {
      await this.ensureRegistrationWithoutPrompt().catch(() => undefined);
    }
  }

  /**
   * Holds Electron schedule updates while the renderer refreshes task data.
   * Calls to reconcileDeadlines keep only the newest complete snapshot, which
   * is sent once every overlapping refresh has finished.
   */
  deferElectronReconciliation(): () => Promise<void> {
    if (!environment.isElectron) return async () => undefined;

    this.electronReconciliationDeferrals += 1;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      this.electronReconciliationDeferrals = Math.max(0, this.electronReconciliationDeferrals - 1);
      if (this.electronReconciliationDeferrals > 0 || !this.deferredElectronSchedules) return;

      const schedules = this.deferredElectronSchedules;
      this.deferredElectronSchedules = null;
      await this.reconcileElectronSchedules(schedules);
    };
  }

  electronBackgroundSyncEnabled(): boolean {
    return environment.isElectron && this._permissionState() === 'granted';
  }

  async refreshElectronDeadlineSnapshot(): Promise<void> {
    const requestedUserId = this.auth.user()?.id ?? null;
    if (!this.electronBackgroundSyncEnabled() || !requestedUserId) return;
    if (this.electronSnapshotPromise) {
      const inFlightUserId = this.electronSnapshotUserId;
      await this.electronSnapshotPromise;
      if (this.auth.user()?.id === requestedUserId && inFlightUserId !== requestedUserId) {
        return this.refreshElectronDeadlineSnapshot();
      }
      return;
    }

    const run = this.loadElectronDeadlineSnapshot(requestedUserId);
    const tracked = run.finally(() => {
      if (this.electronSnapshotPromise === tracked) {
        this.electronSnapshotPromise = null;
        this.electronSnapshotUserId = null;
      }
    });
    this.electronSnapshotPromise = tracked;
    this.electronSnapshotUserId = requestedUserId;
    return tracked;
  }

  private async loadElectronDeadlineSnapshot(expectedUserId: string): Promise<void> {
    const response = await firstValueFrom(
      this.http.get<DeadlineSnapshotResponse>(`${this.apiUrl}/notifications/deadlines`),
    );
    if (this.auth.user()?.id !== expectedUserId || !this.electronBackgroundSyncEnabled()) return;
    const schedules = Array.isArray(response.schedules) ? response.schedules : [];
    if (this.electronReconciliationDeferrals > 0) {
      this.deferredElectronSchedules = schedules;
      return;
    }
    await this.reconcileElectronSchedules(schedules);
  }

  async cancelAll(): Promise<void> {
    return this.queueInstallationOperation(() => this.cancelAllNow());
  }

  private async cancelAllNow(): Promise<void> {
    const sessionUserId = this.auth.user()?.id;
    this._openedDeadline.set(null);
    this.forgetNotificationIntent();
    this.registeredInstallationKey = null;
    this._registrationState.set('idle');
    if (environment.isElectron) {
      await window.splendideDesktop?.cancelAllDeadlineNotifications().catch(() => undefined);
      this._permissionState.set('prompt');
      return;
    }

    if (this.nativeMobile) {
      const token = this.storedPushToken();
      const userId = this.storedPushTokenUserId() ?? sessionUserId;
      if (token && userId) await this.revokeMobileToken(token, userId);
      await FirebaseMessaging.deleteToken().catch(() => undefined);
      this.removeStoredPushToken();
      return;
    }

    if (this.webPushSupported()) {
      this.clearWebDeadlineTimers();
      const registration = await navigator.serviceWorker.getRegistration('/').catch(() => undefined);
      const subscription = await registration?.pushManager.getSubscription().catch(() => null);
      const endpoint = subscription?.endpoint ?? this.storedWebPushEndpoint();
      const userId = this.storedWebPushUserId() ?? sessionUserId;
      if (endpoint && userId) await this.revokeWebEndpoint(endpoint, userId);
      await subscription?.unsubscribe().catch(() => false);
    }
  }

  clearOpenedDeadline(): void {
    this._openedDeadline.set(null);
  }

  private async reconcileElectronSchedules(schedules: DeadlineNotificationSchedule[]): Promise<void> {
    await window.splendideDesktop?.reconcileDeadlineNotifications(schedules).catch(() => undefined);
  }

  private async clearInstallationAfterSessionEnd(previousUserId: string): Promise<void> {
    this._openedDeadline.set(null);
    this.registeredInstallationKey = null;
    this._registrationState.set('idle');
    if (environment.isElectron) {
      this._permissionState.set('prompt');
      await window.splendideDesktop?.cancelAllDeadlineNotifications().catch(() => undefined);
      return;
    }
    if (this.nativeMobile) {
      const token = this.storedPushToken();
      const userId = this.storedPushTokenUserId() ?? previousUserId;
      if (token) await this.revokeMobileToken(token, userId);
      await FirebaseMessaging.deleteToken().catch(() => undefined);
      this.removeStoredPushToken();
      return;
    }
    if (this.webPushSupported()) {
      this.clearWebDeadlineTimers();
      const registration = await navigator.serviceWorker.getRegistration('/').catch(() => undefined);
      const subscription = await registration?.pushManager.getSubscription().catch(() => null);
      const endpoint = subscription?.endpoint ?? this.storedWebPushEndpoint();
      const userId = this.storedWebPushUserId() ?? previousUserId;
      if (endpoint) await this.revokeWebEndpoint(endpoint, userId);
      await subscription?.unsubscribe().catch(() => false);
    }
  }

  async ensureRegistrationWithoutPrompt(): Promise<void> {
    return this.queueInstallationOperation(() => this.ensureRegistrationNow());
  }

  private async ensureRegistrationNow(): Promise<void> {
    const requestedUserId = this.auth.user()?.id;
    if (!requestedUserId || !this.hasNotificationIntent()) return;
    if (this.registrationPromise) {
      const inFlightUserId = this.registrationUserId;
      try {
        await this.registrationPromise;
      } catch (error) {
        if (inFlightUserId === requestedUserId) throw error;
      }
      if (
        this.auth.user()?.id === requestedUserId &&
        (
          inFlightUserId !== requestedUserId ||
          !this.registeredInstallationKey?.startsWith(`${requestedUserId}:`)
        )
      ) {
        return this.ensureRegistrationNow();
      }
      return;
    }

    const registration = this.registerCurrentPlatform(requestedUserId);
    this.registrationPromise = registration;
    this.registrationUserId = requestedUserId;
    try {
      await registration;
      if (this.auth.user()?.id === requestedUserId) this._registrationState.set('ready');
    } catch (error) {
      if (this.auth.user()?.id === requestedUserId) this._registrationState.set('retrying');
      throw error;
    } finally {
      if (this.registrationPromise === registration) {
        this.registrationPromise = null;
        this.registrationUserId = null;
      }
    }
  }

  private queueInstallationOperation(operation: () => Promise<void>): Promise<void> {
    const queued = this.installationTransition
      .catch(() => undefined)
      .then(operation);
    this.installationTransition = queued.catch(() => undefined);
    return queued;
  }

  private async initializePlatform(): Promise<void> {
    if (environment.isElectron) {
      await this.initializeElectronListener();
      const state = await window.splendideDesktop?.notificationPermissionStatus();
      this._permissionState.set(this.normalizePermission(state));
      return;
    }

    if (this.nativeMobile) {
      await this.initializeNativeListeners();
      const supported = await FirebaseMessaging.isSupported();
      if (!supported.isSupported) {
        this._permissionState.set('unsupported');
        return;
      }
      const permission = await FirebaseMessaging.checkPermissions();
      this._permissionState.set(this.normalizePermission(permission.receive));
      return;
    }

    if (!this.webPushSupported()) {
      this._permissionState.set('unsupported');
      return;
    }
    this._permissionState.set(this.normalizePermission(Notification.permission));
    this.initializeWebListener();
    this.captureTargetFromUrl();
  }

  private async registerCurrentPlatform(expectedUserId: string): Promise<void> {
    if (environment.isElectron) return;

    if (this.nativeMobile) {
      const supported = await FirebaseMessaging.isSupported();
      if (!supported.isSupported) return;
      const permission = await FirebaseMessaging.checkPermissions();
      const state = this.normalizePermission(permission.receive);
      this._permissionState.set(state);
      if (state !== 'granted') return;

      const platform = Capacitor.getPlatform();
      if (this.auth.user()?.id !== expectedUserId) return;
      if (this.registeredInstallationKey?.startsWith(`${expectedUserId}:${platform}:`)) return;
      await this.createNativeChannels();
      const { token } = await FirebaseMessaging.getToken();
      await this.registerNativeToken(token, expectedUserId);
      return;
    }

    if (!this.webPushSupported()) {
      this._permissionState.set('unsupported');
      return;
    }
    const state = this.normalizePermission(Notification.permission);
    this._permissionState.set(state);
    if (state !== 'granted') return;
    await this.registerWebSubscription(expectedUserId);
  }

  private async initializeNativeListeners(): Promise<void> {
    if (this.nativeListenersInitialized) return;
    this.nativeListenersInitialized = true;

    await FirebaseMessaging.addListener('tokenReceived', event => {
      const userId = this.auth.user()?.id;
      if (userId && this.hasNotificationIntent() && this._permissionState() === 'granted') {
        void this.queueInstallationOperation(
          () => this.registerNativeToken(event.token, userId),
        ).catch(() => undefined);
      }
    });
    await FirebaseMessaging.addListener('notificationActionPerformed', event => {
      this.openNotification(event.notification);
    });
    await FirebaseMessaging.addListener('notificationReceived', event => {
      if (Capacitor.getPlatform() === 'android') {
        void this.showAndroidForegroundNotification(event.notification).catch(() => undefined);
      }
    });
    await CapacitorApp.addListener('appUrlOpen', event => this.captureTargetFromRawUrl(event.url));
    await CapacitorApp.addListener('appStateChange', event => {
      if (event.isActive) {
        void this.ensureRegistrationWithoutPrompt().catch(() => undefined);
      }
    });
    window.addEventListener('online', () => {
      void this.flushPendingRevocations()
        .then(() => this.ensureRegistrationWithoutPrompt())
        .catch(() => undefined);
    });
    const launch = await CapacitorApp.getLaunchUrl();
    if (launch?.url) this.captureTargetFromRawUrl(launch.url);
  }

  private async initializeElectronListener(): Promise<void> {
    if (this.electronListenerInitialized) return;
    this.electronListenerInitialized = true;
    window.splendideDesktop?.onDeadlineNotificationOpened(target => {
      this.openTarget(target);
    });
    this.captureTargetFromUrl();
  }

  private initializeWebListener(): void {
    if (this.webListenerInitialized) return;
    this.webListenerInitialized = true;
    navigator.serviceWorker.addEventListener('message', event => {
      const message = this.asRecord(event.data);
      if (message['type'] !== 'splendide-notification-opened') return;
      this.openTarget(this.notificationTarget(message['data']));
    });
    window.addEventListener('online', () => {
      void this.flushPendingRevocations()
        .then(() => this.ensureRegistrationWithoutPrompt())
        .catch(() => undefined);
    });
  }

  private async createNativeChannels(): Promise<void> {
    if (Capacitor.getPlatform() !== 'android') return;
    await AndroidDeadlineNotifications.createChannels();
  }

  private reconcileWebForegroundTimers(schedules: DeadlineNotificationSchedule[]): void {
    this.clearWebDeadlineTimers();
    if (!this.hasNotificationIntent() || this._permissionState() !== 'granted') return;
    for (const schedule of schedules) {
      if (!this.webDeadlineWasDelivered(schedule.eventId)) {
        this.armWebDeadlineTimer(schedule);
      }
    }
  }

  private armWebDeadlineTimer(schedule: DeadlineNotificationSchedule): void {
    const remaining = Date.parse(schedule.deadlineAt) - Date.now();
    if (remaining <= 0) return;
    const delay = Math.min(remaining, MAX_TIMER_DELAY_MS);
    const timer = setTimeout(() => {
      this.webDeadlineTimers.delete(schedule.eventId);
      if (remaining > MAX_TIMER_DELAY_MS) {
        this.armWebDeadlineTimer(schedule);
        return;
      }
      // Always ask the service worker to provide the foreground fallback. Its
      // serialized event marker deduplicates this against a simultaneous push,
      // including when the browser reports online but registration or the push
      // provider is unavailable.
      if (this.webDeadlineWasDelivered(schedule.eventId)) return;
      void this.showWebDeadlineFallback(schedule);
    }, delay);
    this.webDeadlineTimers.set(schedule.eventId, timer);
  }

  private async showWebDeadlineFallback(schedule: DeadlineNotificationSchedule): Promise<void> {
    try {
      const registration = await navigator.serviceWorker.ready;
      const worker = registration.active;
      if (!worker) throw new Error('The notification service worker is not active.');
      const result = await new Promise<{ ok: boolean }>((resolve, reject) => {
        const channel = new MessageChannel();
        const timeout = setTimeout(() => reject(new Error('Notification worker timed out.')), 5_000);
        channel.port1.onmessage = event => {
          clearTimeout(timeout);
          resolve(this.asRecord(event.data) as { ok: boolean });
        };
        worker.postMessage({
          type: 'splendide-show-offline-deadline',
          schedule,
        }, [channel.port2]);
      });
      if (!result.ok) throw new Error('The notification worker could not display the deadline.');
      this.markWebDeadlineDelivered(schedule.eventId);
    } catch {
      // Server push remains the fallback after connectivity returns.
    }
  }

  private clearWebDeadlineTimers(): void {
    for (const timer of this.webDeadlineTimers.values()) clearTimeout(timer);
    this.webDeadlineTimers.clear();
  }

  private async registerNativeToken(token: string, expectedUserId: string): Promise<void> {
    if (!token || this.auth.user()?.id !== expectedUserId) return;
    const installationKey = `${expectedUserId}:${Capacitor.getPlatform()}:${token}`;
    if (this.registeredInstallationKey === installationKey) return;
    await firstValueFrom(this.http.post(`${this.apiUrl}/user/devices`, {
      token,
      platform: Capacitor.getPlatform(),
    }));
    if (this.auth.user()?.id !== expectedUserId || !this.hasNotificationIntent()) {
      await this.revokeMobileToken(token, expectedUserId);
      this.registeredInstallationKey = null;
      if (this.auth.user() && this.hasNotificationIntent()) {
        queueMicrotask(() => void this.ensureRegistrationWithoutPrompt().catch(() => undefined));
      }
      return;
    }
    this.registeredInstallationKey = installationKey;
    this.storePushToken(token, expectedUserId);
    this.removePendingMobileRevocation(token, expectedUserId);
  }

  private async registerWebSubscription(expectedUserId: string): Promise<void> {
    const registration = await navigator.serviceWorker.register(PUSH_WORKER_PATH, { scope: '/' });
    await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (this.auth.user()?.id !== expectedUserId) return;
    const existingInstallationKey = subscription
      ? `${expectedUserId}:web:${subscription.endpoint}`
      : null;
    if (existingInstallationKey && this.registeredInstallationKey === existingInstallationKey) return;

    const response = await firstValueFrom(
      this.http.get<WebPushKeyResponse>(`${this.apiUrl}/notifications/vapid-public-key`),
    );
    if (!response.publicKey) throw new Error('web push is not configured');
    const applicationServerKey = this.urlBase64ToUint8Array(response.publicKey);
    if (subscription && !this.sameBytes(subscription.options.applicationServerKey, applicationServerKey)) {
      await subscription.unsubscribe();
      subscription = null;
    }

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
    }

    if (this.auth.user()?.id !== expectedUserId) return;
    const installationKey = `${expectedUserId}:web:${subscription.endpoint}`;
    if (this.registeredInstallationKey === installationKey) return;
    const p256dh = this.pushKey(subscription, 'p256dh');
    const auth = this.pushKey(subscription, 'auth');
    await firstValueFrom(this.http.post(`${this.apiUrl}/user/notification-subscriptions`, {
      endpoint: subscription.endpoint,
      keys: { p256dh, auth },
      platform: 'web',
    }));
    if (this.auth.user()?.id !== expectedUserId || !this.hasNotificationIntent()) {
      await this.revokeWebEndpoint(subscription.endpoint, expectedUserId);
      await subscription.unsubscribe().catch(() => false);
      this.registeredInstallationKey = null;
      if (this.auth.user() && this.hasNotificationIntent()) {
        queueMicrotask(() => void this.ensureRegistrationWithoutPrompt().catch(() => undefined));
      }
      return;
    }
    this.registeredInstallationKey = installationKey;
    this.storeWebPushEndpoint(subscription.endpoint, expectedUserId);
    this.removePendingWebRevocation(subscription.endpoint, expectedUserId);
  }

  private async showAndroidForegroundNotification(notification: FirebaseNotification): Promise<void> {
    const data = this.asRecord(notification.data);
    const target = this.notificationTarget(data);
    await AndroidDeadlineNotifications.show({
      id: String(data['eventId'] ?? notification.id ?? crypto.randomUUID()),
      channelId: data['type'] === 'task-deadline' ? 'deadlines' : 'shared-pages',
      title: notification.title || 'Splendide',
      body: notification.body || 'A task needs your attention',
      ...(target?.pageId ? { pageId: target.pageId } : {}),
      ...(target?.taskId ? { taskId: target.taskId } : {}),
      ...(target?.shareToken ? { shareToken: target.shareToken } : {}),
    });
  }

  private openNotification(notification: FirebaseNotification): void {
    const target = this.notificationTarget(notification.data);
    if (target) {
      this.openTarget(target);
      return;
    }
    const data = this.asRecord(notification.data);
    const shareToken = String(data['shareToken'] ?? '').trim();
    void this.router.navigate(shareToken ? ['/share', shareToken] : ['/']);
  }

  private openTarget(target: DeadlineNotificationTarget | null): void {
    if (!target) {
      void this.router.navigate(['/']);
      return;
    }
    this._openedDeadline.set(target);
    if (target.shareToken) {
      void this.router.navigate(['/share', target.shareToken], {
        queryParams: { pageId: target.pageId, taskId: target.taskId, notification: 'deadline' },
      });
      return;
    }
    void this.router.navigate(['/'], {
      queryParams: { pageId: target.pageId, taskId: target.taskId, notification: 'deadline' },
    });
  }

  private captureTargetFromUrl(): void {
    this.captureTargetFromRawUrl(window.location.href);
  }

  private captureTargetFromRawUrl(rawUrl: string): void {
    try {
      const url = new URL(rawUrl);
      if (url.protocol === 'splendide:' && url.host !== 'deadline') return;
      const values = Object.fromEntries(url.searchParams.entries());
      if (!values['shareToken']) {
        const sharedRoute = url.pathname.match(/^\/share\/([^/]+)/);
        if (sharedRoute?.[1]) values['shareToken'] = decodeURIComponent(sharedRoute[1]);
      }
      const target = this.notificationTarget(values);
      if (target) {
        this.openTarget(target);
        return;
      }
      const shareToken = String(values['shareToken'] ?? '').trim();
      if (shareToken) void this.router.navigate(['/share', shareToken]);
    } catch {
      // Ignore malformed operating-system deep links.
    }
  }

  private deadlineSchedules(sections: StoredSection[]): DeadlineNotificationSchedule[] {
    const schedules: DeadlineNotificationSchedule[] = [];
    for (const section of sections) {
      if (section.deleted) continue;
      for (const list of section.lists) {
        for (const item of list.items) {
          const schedule = this.deadlineSchedule(section, item);
          if (schedule) schedules.push(schedule);
        }
      }
    }
    return schedules;
  }

  private deadlineSchedule(section: StoredSection, item: StoredItem): DeadlineNotificationSchedule | null {
    if (item.deleted) return null;
    const content = this.asRecord(item.content);
    const notificationEnabled = 'deadlineNotificationEnabled' in content
      ? content['deadlineNotificationEnabled'] === true
      : item.deadlineNotificationEnabled === true;
    if (content['done'] === true || !notificationEnabled) return null;
    const deadlineAt = typeof content['deadlineAt'] === 'string'
      ? content['deadlineAt']
      : typeof item.deadlineAt === 'string' ? item.deadlineAt : '';
    const deadlineMs = Date.parse(deadlineAt);
    if (!deadlineAt || !Number.isFinite(deadlineMs)) return null;

    const normalizedDeadlineAt = new Date(deadlineMs).toISOString();
    const scheduleId = typeof content['deadlineScheduleId'] === 'string'
      ? content['deadlineScheduleId'].trim()
      : '';
    return {
      // The client-generated schedule id remains stable through the first sync
      // and changes when a deadline is deliberately rescheduled, even when it
      // is changed back to the exact same timestamp.
      eventId: scheduleId
        ? `${item.id}:${scheduleId}`
        : `${item.id}:${normalizedDeadlineAt}`,
      pageId: section.id,
      taskId: item.id,
      pageTitle: section.title.trim() || 'Splendide',
      taskText: String(content['text'] ?? '').trim() || 'Task deadline',
      deadlineAt: normalizedDeadlineAt,
      ...(section.shareToken ? { shareToken: section.shareToken } : {}),
    };
  }

  private notificationTarget(value: unknown): DeadlineNotificationTarget | null {
    const record = this.asRecord(value);
    const pageId = String(record['pageId'] ?? record['sectionId'] ?? '').trim();
    const taskId = String(record['taskId'] ?? record['itemId'] ?? '').trim();
    const shareToken = String(record['shareToken'] ?? '').trim();
    if (!pageId || !taskId) return null;
    return { pageId, taskId, ...(shareToken ? { shareToken } : {}) };
  }

  private webPushSupported(): boolean {
    return !environment.isElectron &&
      !this.nativeMobile &&
      window.isSecureContext &&
      'Notification' in window &&
      'serviceWorker' in navigator &&
      'PushManager' in window;
  }

  private rememberNotificationIntent(): void {
    this.notificationIntent = true;
    try {
      localStorage.setItem(NOTIFICATION_INTENT_KEY, 'true');
    } catch {
      // Keep the explicit choice for this app session when storage is blocked.
    }
  }

  private hasNotificationIntent(): boolean {
    return this.notificationIntent || this.readNotificationIntent();
  }

  private readNotificationIntent(): boolean {
    try {
      return localStorage.getItem(NOTIFICATION_INTENT_KEY) === 'true';
    } catch {
      return false;
    }
  }

  private forgetNotificationIntent(): void {
    this.notificationIntent = false;
    try {
      localStorage.removeItem(NOTIFICATION_INTENT_KEY);
    } catch {
      // The in-memory preference is already cleared.
    }
  }

  private storedPushToken(): string | null {
    try {
      return localStorage.getItem('splendide_push_token');
    } catch {
      return null;
    }
  }

  private storedPushTokenUserId(): string | null {
    try {
      return localStorage.getItem(MOBILE_PUSH_USER_KEY);
    } catch {
      return null;
    }
  }

  private storePushToken(token: string, userId: string): void {
    try {
      localStorage.setItem('splendide_push_token', token);
      localStorage.setItem(MOBILE_PUSH_USER_KEY, userId);
    } catch {
      // Token rotation still remains registered for this app session.
    }
  }

  private removeStoredPushToken(): void {
    try {
      localStorage.removeItem('splendide_push_token');
      localStorage.removeItem(MOBILE_PUSH_USER_KEY);
    } catch {
      // The native token has already been deleted.
    }
  }

  private storedWebPushEndpoint(): string | null {
    try {
      return localStorage.getItem(WEB_PUSH_ENDPOINT_KEY);
    } catch {
      return null;
    }
  }

  private storedWebPushUserId(): string | null {
    try {
      return localStorage.getItem(WEB_PUSH_USER_KEY);
    } catch {
      return null;
    }
  }

  private storeWebPushEndpoint(endpoint: string, userId: string): void {
    try {
      localStorage.setItem(WEB_PUSH_ENDPOINT_KEY, endpoint);
      localStorage.setItem(WEB_PUSH_USER_KEY, userId);
    } catch {
      // The active subscription still works for this app session.
    }
  }

  private removeStoredWebPushEndpoint(endpoint: string, userId: string): void {
    try {
      if (
        localStorage.getItem(WEB_PUSH_ENDPOINT_KEY) === endpoint &&
        localStorage.getItem(WEB_PUSH_USER_KEY) === userId
      ) {
        localStorage.removeItem(WEB_PUSH_ENDPOINT_KEY);
        localStorage.removeItem(WEB_PUSH_USER_KEY);
      }
    } catch {
      // Backend revocation has already completed.
    }
  }

  private pendingRevocations(): PendingNotificationRevocations {
    try {
      const parsed = JSON.parse(localStorage.getItem(PENDING_REVOCATIONS_KEY) ?? '{}') as Record<string, unknown>;
      return {
        mobileTokens: this.validPendingRevocations(parsed['mobileTokens']),
        webEndpoints: this.validPendingRevocations(parsed['webEndpoints']),
      };
    } catch {
      return { mobileTokens: [], webEndpoints: [] };
    }
  }

  private validPendingRevocations(value: unknown): PendingNotificationRevocation[] {
    if (!Array.isArray(value)) return [];
    return value
      .map(entry => this.asRecord(entry))
      .filter((entry): entry is Record<string, string> =>
        typeof entry['value'] === 'string' &&
        entry['value'].length > 0 &&
        typeof entry['userId'] === 'string' &&
        entry['userId'].length > 0,
      )
      .map(entry => ({ value: entry['value'], userId: entry['userId'] }))
      .slice(-20);
  }

  private storePendingRevocations(revocations: PendingNotificationRevocations): void {
    try {
      if (revocations.mobileTokens.length === 0 && revocations.webEndpoints.length === 0) {
        localStorage.removeItem(PENDING_REVOCATIONS_KEY);
      } else {
        localStorage.setItem(PENDING_REVOCATIONS_KEY, JSON.stringify(revocations));
      }
    } catch {
      // Keep the provider-level unsubscribe/delete as a second privacy barrier.
    }
  }

  private async revokeMobileToken(token: string, userId: string): Promise<void> {
    const pending = this.pendingRevocations();
    if (!pending.mobileTokens.some(entry => entry.value === token && entry.userId === userId)) {
      pending.mobileTokens.push({ value: token, userId });
    }
    this.storePendingRevocations(pending);
    await this.flushPendingRevocations();
  }

  private async revokeWebEndpoint(endpoint: string, userId: string): Promise<void> {
    const pending = this.pendingRevocations();
    if (!pending.webEndpoints.some(entry => entry.value === endpoint && entry.userId === userId)) {
      pending.webEndpoints.push({ value: endpoint, userId });
    }
    this.storePendingRevocations(pending);
    await this.flushPendingRevocations();
  }

  private removePendingMobileRevocation(token: string, userId: string): void {
    const pending = this.pendingRevocations();
    pending.mobileTokens = pending.mobileTokens.filter(
      entry => entry.value !== token || entry.userId !== userId,
    );
    this.storePendingRevocations(pending);
  }

  private removePendingWebRevocation(endpoint: string, userId: string): void {
    const pending = this.pendingRevocations();
    pending.webEndpoints = pending.webEndpoints.filter(
      entry => entry.value !== endpoint || entry.userId !== userId,
    );
    this.storePendingRevocations(pending);
  }

  private flushPendingRevocations(): Promise<void> {
    if (this.revocationFlushPromise) return this.revocationFlushPromise;
    this.revocationFlushPromise = this.performPendingRevocations().finally(() => {
      this.revocationFlushPromise = null;
    });
    return this.revocationFlushPromise;
  }

  private async performPendingRevocations(): Promise<void> {
    const snapshot = this.pendingRevocations();
    for (const revocation of snapshot.mobileTokens) {
      try {
        await firstValueFrom(this.http.delete(`${this.apiUrl}/user/devices`, {
          body: { token: revocation.value, userId: revocation.userId },
        }));
        this.removePendingMobileRevocation(revocation.value, revocation.userId);
      } catch {
        // Retry on the next reconnect/app launch.
      }
    }
    for (const revocation of snapshot.webEndpoints) {
      try {
        await firstValueFrom(this.http.delete(`${this.apiUrl}/user/notification-subscriptions`, {
          body: { endpoint: revocation.value, userId: revocation.userId },
        }));
        this.removeStoredWebPushEndpoint(revocation.value, revocation.userId);
        this.removePendingWebRevocation(revocation.value, revocation.userId);
      } catch {
        // Retry on the next reconnect/app launch.
      }
    }
  }

  private webDeadlineWasDelivered(eventId: string): boolean {
    return this.webDeliveredDeadlineEvents().includes(eventId);
  }

  private markWebDeadlineDelivered(eventId: string): void {
    try {
      const events = this.webDeliveredDeadlineEvents().filter(value => value !== eventId);
      events.push(eventId);
      localStorage.setItem(WEB_DELIVERED_EVENTS_KEY, JSON.stringify(events.slice(-200)));
    } catch {
      // The service worker's event marker still limits duplicate delivery.
    }
  }

  private webDeliveredDeadlineEvents(): string[] {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(WEB_DELIVERED_EVENTS_KEY) ?? '[]');
      return Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === 'string').slice(-200)
        : [];
    } catch {
      return [];
    }
  }

  private normalizePermission(value: unknown): DeadlineNotificationPermission {
    if (value === 'granted') return 'granted';
    if (value === 'denied') return 'denied';
    if (value === 'unsupported') return 'unsupported';
    return 'prompt';
  }

  private pushKey(subscription: PushSubscription, name: PushEncryptionKeyName): string {
    const key = subscription.getKey(name);
    if (!key) throw new Error('web push subscription is missing encryption keys');
    return this.uint8ArrayToUrlBase64(new Uint8Array(key));
  }

  private urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(base64);
    return Uint8Array.from(decoded, character => character.charCodeAt(0));
  }

  private uint8ArrayToUrlBase64(value: Uint8Array): string {
    let binary = '';
    for (const byte of value) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  private sameBytes(left: ArrayBuffer | null, right: Uint8Array): boolean {
    if (!left) return false;
    const leftBytes = new Uint8Array(left);
    return leftBytes.length === right.length && leftBytes.every((byte, index) => byte === right[index]);
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }
}
