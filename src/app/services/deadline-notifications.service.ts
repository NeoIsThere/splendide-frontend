import { effect, inject, Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { FirebaseMessaging, type Notification as FirebaseNotification } from '@capacitor-firebase/messaging';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';
import { StorageService, type StoredItem, type StoredSection } from './storage.service';
import {
  NATIVE_DEADLINE_NOTIFICATION_TYPE,
  planNativeDeadlineNotifications,
} from '../utils/native-deadline-scheduling';

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

interface AnonymousNotificationCredentials {
  installationId: string;
  secret: string;
  snapshotRevision: number;
}

interface AnonymousDeadlineSchedule {
  eventId: string;
  pageId: string;
  taskId: string;
  deadlineAt: string;
  shareToken?: string;
}

interface DeadlineSnapshotResponse {
  schedules: DeadlineNotificationSchedule[];
}

interface DeadlineReconciliationSnapshot {
  userId: string | null;
  schedules: DeadlineNotificationSchedule[];
  epoch: number;
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
const ANONYMOUS_NOTIFICATION_CREDENTIALS_KEY = 'splendide_anonymous_notification_credentials';
const ANONYMOUS_NOTIFICATION_ACTIVE_KEY = 'splendide_anonymous_notification_active';
const ANONYMOUS_INSTALLATION_ID_HEADER = 'X-Splendide-Anonymous-Installation-Id';
const ANONYMOUS_INSTALLATION_SECRET_HEADER = 'X-Splendide-Anonymous-Installation-Secret';
const ANONYMOUS_SNAPSHOT_REVISION_HEADER = 'X-Splendide-Anonymous-Snapshot-Revision';
const ANONYMOUS_MAX_SCHEDULES = 60;
const ANONYMOUS_MAX_FUTURE_MS = 366 * 24 * 60 * 60 * 1000;
const ANONYMOUS_DELIVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const PUSH_WORKER_PATH = '/push-sw.js';
const MAX_TIMER_DELAY_MS = 2_147_000_000;

@Injectable({ providedIn: 'root' })
export class DeadlineNotificationsService {
  private readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly storage = inject(StorageService);
  private readonly apiUrl = environment.apiUrl;
  private readonly nativeMobile = environment.isMobile && Capacitor.isNativePlatform();
  private readonly _permissionState = signal<DeadlineNotificationPermission>('prompt');
  private readonly _registrationState = signal<DeadlineNotificationRegistration>('idle');
  private readonly _openedDeadline = signal<DeadlineNotificationTarget | null>(null);
  private readonly _deviceNotificationsEnabled = signal(this.readNotificationIntent());
  private nativeListenersPromise: Promise<void> | null = null;
  private webListenerInitialized = false;
  private electronListenerInitialized = false;
  private registrationPromise: Promise<boolean> | null = null;
  private registrationUserId: string | null = null;
  private installationTransition: Promise<void> = Promise.resolve();
  private revocationFlushPromise: Promise<void> | null = null;
  private electronSnapshotPromise: Promise<void> | null = null;
  private electronSnapshotUserId: string | null = null;
  private registeredInstallationKey: string | null = null;
  private lastAnonymousSnapshotFingerprint: string | null = null;
  private anonymousCredentialsMemory: AnonymousNotificationCredentials | null = null;
  private readonly webDeadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private electronReconciliationDeferrals = 0;
  private deferredElectronSnapshot: DeadlineReconciliationSnapshot | null = null;
  private latestDeadlineSnapshot: DeadlineReconciliationSnapshot = { userId: null, schedules: [], epoch: 0 };
  private hasDeadlineSnapshot = false;
  private reconciliationEpoch = 0;
  private notificationChoiceEpoch = 0;
  private permissionStateEpoch = 0;
  private previousUserId: string | null = null;
  private observedInitialSession = false;

  readonly permissionState = this._permissionState.asReadonly();
  readonly registrationState = this._registrationState.asReadonly();
  readonly openedDeadline = this._openedDeadline.asReadonly();
  readonly deviceNotificationsEnabled = this._deviceNotificationsEnabled.asReadonly();

  constructor() {
    void this.initializePlatform().catch(() => {
      // A transient platform/plugin failure should not interrupt app startup.
    });
    queueMicrotask(() => void this.flushPendingRevocations());

    effect(() => {
      const user = this.auth.user();
      const userId = user?.id ?? null;
      const previousUserId = this.previousUserId;
      const initialSession = !this.observedInitialSession;
      this.observedInitialSession = true;
      const sessionChanged = initialSession || previousUserId !== userId;
      if (sessionChanged) {
        this.invalidateDeadlineSnapshot();
        void this.queueInstallationOperation(async () => {
          if (previousUserId) await this.clearInstallationAfterSessionEnd(previousUserId);
          if ((this.auth.user()?.id ?? null) !== userId) return;
          if (userId) await this.prepareSignedInSession(userId);
          else await this.prepareAnonymousSession();
        });
      }
      this.previousUserId = userId;

      if (!user) return;
      if (!sessionChanged && this.hasNotificationIntent()) {
        void this.ensureRegistrationWithoutPrompt().catch(() => undefined);
      }
    });
  }

  /**
   * Requests notification access only in response to an explicit user action.
   * Saving a deadline must not depend on this returning true.
   */
  async requestPermission(rememberIntent = true): Promise<boolean> {
    if (rememberIntent) this.rememberNotificationIntent();
    const permissionEpoch = ++this.permissionStateEpoch;

    if (environment.isElectron) {
      try {
        const state = await window.splendideDesktop?.requestNotificationPermission();
        const permission = this.normalizePermission(state);
        if (permissionEpoch === this.permissionStateEpoch) {
          this._permissionState.set(permission);
          this._registrationState.set(permission === 'granted' ? 'ready' : 'idle');
        }
        return permission === 'granted';
      } catch {
        return false;
      }
    }

    if (this.nativeMobile) {
      try {
        await this.initializeNativeListeners();
        if (!this.auth.user()) {
          let permission = await LocalNotifications.checkPermissions();
          if (permission.display !== 'granted') {
            permission = await LocalNotifications.requestPermissions();
          }
          const state = this.normalizePermission(permission.display);
          if (permissionEpoch === this.permissionStateEpoch) {
            this._permissionState.set(state);
            this._registrationState.set(state === 'granted' ? 'ready' : 'idle');
          }
          if (state === 'granted') await this.createNativeChannels();
          return state === 'granted';
        }
        const supported = await FirebaseMessaging.isSupported();
        if (!supported.isSupported) {
          if (permissionEpoch === this.permissionStateEpoch) this._permissionState.set('unsupported');
          return false;
        }
        let permission = await FirebaseMessaging.checkPermissions();
        if (permission.receive !== 'granted') {
          permission = await FirebaseMessaging.requestPermissions();
        }
        const state = this.normalizePermission(permission.receive);
        if (permissionEpoch === this.permissionStateEpoch) this._permissionState.set(state);
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
      if (permissionEpoch === this.permissionStateEpoch) this._permissionState.set('unsupported');
      return false;
    }

    try {
      const permission = await Notification.requestPermission();
      const state = this.normalizePermission(permission);
      if (permissionEpoch === this.permissionStateEpoch) this._permissionState.set(state);
      if (state === 'granted') {
        await this.ensureRegistrationWithoutPrompt().catch(() => undefined);
      }
      return state === 'granted';
    } catch {
      if (permissionEpoch === this.permissionStateEpoch) {
        this._permissionState.set(this.normalizePermission(Notification.permission));
      }
      return false;
    }
  }

  /**
   * Stores the user's device-level notification choice independently from any
   * signed-in account preference. Enabling is always an explicit user action,
   * while disabling removes this installation and its local schedules.
   */
  async setDeviceNotificationsEnabled(enabled: boolean): Promise<boolean> {
    const choiceEpoch = ++this.notificationChoiceEpoch;
    if (!enabled) {
      await this.cancelAll();
      return false;
    }
    this.rememberNotificationIntent();
    this.invalidateDeadlineSnapshot();
    const granted = await this.requestPermission(false);
    if (
      choiceEpoch !== this.notificationChoiceEpoch ||
      !this.hasNotificationIntent() ||
      !granted
    ) return false;
    if (environment.isElectron && this.auth.user()) {
      await this.refreshElectronDeadlineSnapshot().catch(() => undefined);
    } else if (!this.auth.user()) {
      await this.reconcileDeadlines(this.storage.loadSectionsForPartition());
    } else if (this.hasDeadlineSnapshot) {
      await this.reconcileLatestDeadlineSnapshot();
    }
    return granted;
  }

  /**
   * Reconciles the complete visible task snapshot. It never opens an OS prompt.
   * Electron persists local schedules. Native and web background delivery is
   * server-driven; web also has a foreground timer fallback when push delivery
   * is late or unavailable.
   */
  async reconcileDeadlines(sections: StoredSection[]): Promise<void> {
    const snapshot: DeadlineReconciliationSnapshot = {
      userId: this.auth.user()?.id ?? null,
      schedules: this.deadlineSchedules(sections),
      epoch: ++this.reconciliationEpoch,
    };
    this.latestDeadlineSnapshot = snapshot;
    this.hasDeadlineSnapshot = true;

    if (environment.isElectron) {
      if (this.electronReconciliationDeferrals > 0) {
        this.deferredElectronSnapshot = snapshot;
        return;
      }
    }

    await this.queueInstallationOperation(() => this.reconcileDeadlineSnapshotNow(snapshot));
  }

  private async reconcileDeadlineSnapshotNow(snapshot: DeadlineReconciliationSnapshot): Promise<void> {
    if (!this.deadlineSnapshotIsCurrent(snapshot)) return;
    const schedules = this.hasNotificationIntent() ? snapshot.schedules : [];

    if (environment.isElectron) {
      await this.reconcileElectronSchedules(schedules);
      return;
    }

    if (this.nativeMobile) {
      if (this.auth.user()) {
        await this.cancelNativeLocalDeadlines();
      } else {
        await this.reconcileNativeLocalDeadlines(schedules, snapshot);
        return;
      }
    } else {
      this.reconcileWebForegroundTimers(schedules, snapshot);
      if (!this.auth.user()) {
        await this.reconcileAnonymousWebPush(schedules, snapshot).catch(() => undefined);
        return;
      }
    }

    if (
      this.deadlineSnapshotIsCurrent(snapshot) &&
      this.hasNotificationIntent() &&
      this.auth.user() !== null
    ) {
      await this.ensureRegistrationNow().catch(() => undefined);
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
      if (this.electronReconciliationDeferrals > 0 || !this.deferredElectronSnapshot) return;

      const snapshot = this.deferredElectronSnapshot;
      this.deferredElectronSnapshot = null;
      await this.queueInstallationOperation(() => this.reconcileDeadlineSnapshotNow(snapshot));
    };
  }

  electronBackgroundSyncEnabled(): boolean {
    return environment.isElectron &&
      this.hasNotificationIntent() &&
      this._permissionState() === 'granted';
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
    const snapshot = {
      userId: expectedUserId,
      schedules,
      epoch: ++this.reconciliationEpoch,
    };
    this.latestDeadlineSnapshot = snapshot;
    this.hasDeadlineSnapshot = true;
    if (this.electronReconciliationDeferrals > 0) {
      this.deferredElectronSnapshot = snapshot;
      return;
    }
    await this.queueInstallationOperation(() => this.reconcileDeadlineSnapshotNow(snapshot));
  }

  async cancelAll(): Promise<void> {
    this.forgetNotificationIntent();
    this.invalidateDeadlineSnapshot();
    return this.queueInstallationOperation(() => this.cancelAllNow());
  }

  async detachCurrentAccountNotifications(): Promise<void> {
    const userId = this.auth.user()?.id ?? this.previousUserId;
    if (!userId) return;
    if (this.previousUserId === userId) this.previousUserId = null;
    return this.queueInstallationOperation(() => this.clearInstallationAfterSessionEnd(userId));
  }

  private async cancelAllNow(): Promise<void> {
    const permissionEpoch = this.permissionStateEpoch;
    const sessionUserId = this.auth.user()?.id;
    this._openedDeadline.set(null);
    this.registeredInstallationKey = null;
    this._registrationState.set('idle');
    if (environment.isElectron) {
      await window.splendideDesktop?.cancelAllDeadlineNotifications().catch(() => undefined);
      const state = await window.splendideDesktop?.notificationPermissionStatus().catch(() => undefined);
      if (permissionEpoch === this.permissionStateEpoch) {
        this._permissionState.set(this.normalizePermission(state));
      }
      return;
    }

    if (this.nativeMobile) {
      await this.cancelNativeLocalDeadlines();
      const token = this.storedPushToken();
      const userId = this.storedPushTokenUserId() ?? sessionUserId;
      if (token && userId) await this.revokeMobileToken(token, userId);
      await FirebaseMessaging.deleteToken().catch(() => undefined);
      this.removeStoredPushToken();
      return;
    }

    if (this.webPushSupported()) {
      this.clearWebDeadlineTimers();
      await this.setAccountWorkerUser(null).catch(() => undefined);
      await this.deactivateAnonymousWebInstallation(true).catch(() => undefined);
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

  private deadlineSnapshotIsCurrent(snapshot: DeadlineReconciliationSnapshot): boolean {
    return this.latestDeadlineSnapshot.epoch === snapshot.epoch &&
      (this.auth.user()?.id ?? null) === snapshot.userId;
  }

  private anonymousWebSnapshotCanApply(snapshot: DeadlineReconciliationSnapshot): boolean {
    return snapshot.userId === null &&
      this.deadlineSnapshotIsCurrent(snapshot) &&
      !this.auth.user() &&
      !this.browserHasAccountSession() &&
      this.hasNotificationIntent();
  }

  private invalidateDeadlineSnapshot(): void {
    this.latestDeadlineSnapshot = {
      ...this.latestDeadlineSnapshot,
      epoch: ++this.reconciliationEpoch,
    };
    this.deferredElectronSnapshot = null;
  }

  private async reconcileLatestDeadlineSnapshot(): Promise<void> {
    const snapshot = this.latestDeadlineSnapshot;
    if ((this.auth.user()?.id ?? null) !== snapshot.userId) return;
    await this.queueInstallationOperation(() => this.reconcileDeadlineSnapshotNow(snapshot));
  }

  private async refreshCurrentNotificationState(): Promise<void> {
    await this.flushPendingRevocations();
    if (this.nativeMobile && !this.auth.user()) {
      const permission = await LocalNotifications.checkPermissions().catch(() => null);
      if (permission) {
        const state = this.normalizePermission(permission.display);
        this._permissionState.set(state);
        if (state === 'granted') await this.createNativeChannels().catch(() => undefined);
      }
    }
    if (this.auth.user() && this.hasNotificationIntent()) {
      await this.queueInstallationOperation(
        () => this.deactivateAnonymousWebInstallation(false),
      ).catch(() => undefined);
      await this.ensureRegistrationWithoutPrompt();
    } else if (this.auth.user()) {
      await this.queueInstallationOperation(
        () => this.setAccountWorkerUser(null),
      ).catch(() => undefined);
    } else if (!this.auth.user() && !this.hasNotificationIntent()) {
      await this.queueInstallationOperation(
        () => this.deactivateAnonymousWebInstallation(false),
      ).catch(() => undefined);
    }
    await this.reconcileLatestDeadlineSnapshot();
  }

  private async prepareAnonymousSession(): Promise<void> {
    if (this.auth.user()) return;
    this.registeredInstallationKey = null;
    if (environment.isElectron) {
      await window.splendideDesktop?.reconcileDeadlineNotifications([]).catch(() => undefined);
    } else if (this.nativeMobile) {
      await this.cancelNativeLocalDeadlines();
    } else {
      this.clearWebDeadlineTimers();
      await this.setAccountWorkerUser(null).catch(() => undefined);
      await this.setAnonymousWorkerInstallation(null).catch(() => undefined);
    }
    if (!this.hasNotificationIntent()) {
      await this.deactivateAnonymousWebInstallation(false).catch(() => undefined);
      return;
    }
    if (!this.hasDeadlineSnapshot) {
      this.latestDeadlineSnapshot = {
        userId: null,
        schedules: this.deadlineSchedules(this.storage.loadSectionsForPartition()),
        epoch: ++this.reconciliationEpoch,
      };
      this.hasDeadlineSnapshot = true;
    }
    if (!this.auth.user() && this.latestDeadlineSnapshot.userId === null) {
      await this.reconcileDeadlineSnapshotNow(this.latestDeadlineSnapshot);
    }
  }

  private async prepareSignedInSession(userId: string): Promise<void> {
    if (this.auth.user()?.id !== userId) return;
    this.registeredInstallationKey = null;

    if (environment.isElectron) {
      await window.splendideDesktop?.reconcileDeadlineNotifications([]).catch(() => undefined);
    } else if (this.nativeMobile) {
      await this.cancelNativeLocalDeadlines();
    } else {
      this.clearWebDeadlineTimers();
      await this.setAccountWorkerUser(null).catch(() => undefined);
      await this.deactivateAnonymousWebInstallation(false).catch(() => undefined);
    }

    if (this.auth.user()?.id !== userId) return;
    if (this.hasNotificationIntent()) await this.ensureRegistrationNow().catch(() => undefined);
    if (this.latestDeadlineSnapshot.userId === userId) {
      await this.reconcileDeadlineSnapshotNow(this.latestDeadlineSnapshot);
    }
  }

  private async clearInstallationAfterSessionEnd(previousUserId: string): Promise<void> {
    const permissionEpoch = this.permissionStateEpoch;
    this._openedDeadline.set(null);
    this.registeredInstallationKey = null;
    this._registrationState.set('idle');
    if (environment.isElectron) {
      // A session boundary clears account-owned schedules without changing the
      // device-level notification choice. The following session reconciliation
      // repopulates the appropriate signed-in or anonymous schedules.
      await window.splendideDesktop?.reconcileDeadlineNotifications([]).catch(() => undefined);
      const state = await window.splendideDesktop?.notificationPermissionStatus().catch(() => undefined);
      if (permissionEpoch === this.permissionStateEpoch) {
        this._permissionState.set(this.normalizePermission(state));
      }
      return;
    }
    if (this.nativeMobile) {
      await this.cancelNativeLocalDeadlines();
      const token = this.storedPushToken();
      const userId = this.storedPushTokenUserId() ?? previousUserId;
      if (token) await this.revokeMobileToken(token, userId);
      await FirebaseMessaging.deleteToken().catch(() => undefined);
      this.removeStoredPushToken();
      return;
    }
    if (this.webPushSupported()) {
      this.clearWebDeadlineTimers();
      await this.setAccountWorkerUser(null).catch(() => undefined);
      await this.setAnonymousWorkerInstallation(null).catch(() => undefined);
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
      const ready = await registration;
      if (this.auth.user()?.id === requestedUserId) {
        this._registrationState.set(ready ? 'ready' : 'idle');
      }
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

  private withAnonymousWebLock<T>(operation: () => Promise<T>): Promise<T> {
    if (typeof navigator === 'undefined') return operation();
    const lockManager = (navigator as unknown as {
      locks?: { request<R>(name: string, callback: () => Promise<R>): Promise<R> };
    }).locks;
    return lockManager
      ? lockManager.request('splendide-anonymous-notifications', operation)
      : operation();
  }

  private async initializePlatform(): Promise<void> {
    const permissionEpoch = this.permissionStateEpoch;
    if (environment.isElectron) {
      await this.initializeElectronListener();
      const state = await window.splendideDesktop?.notificationPermissionStatus();
      if (permissionEpoch === this.permissionStateEpoch) {
        this._permissionState.set(this.normalizePermission(state));
      }
      return;
    }

    if (this.nativeMobile) {
      await this.initializeNativeListeners();
      const permission = await LocalNotifications.checkPermissions();
      if (permissionEpoch === this.permissionStateEpoch) {
        this._permissionState.set(this.normalizePermission(permission.display));
      }
      return;
    }

    if (!this.webPushSupported()) {
      if (permissionEpoch === this.permissionStateEpoch) this._permissionState.set('unsupported');
      return;
    }
    if (permissionEpoch === this.permissionStateEpoch) {
      this._permissionState.set(this.normalizePermission(Notification.permission));
    }
    this.initializeWebListener();
    this.captureTargetFromUrl();
  }

  private async registerCurrentPlatform(expectedUserId: string): Promise<boolean> {
    if (environment.isElectron) return this._permissionState() === 'granted';

    if (this.nativeMobile) {
      const supported = await FirebaseMessaging.isSupported();
      if (!supported.isSupported) return false;
      const permission = await FirebaseMessaging.checkPermissions();
      const state = this.normalizePermission(permission.receive);
      this._permissionState.set(state);
      if (state !== 'granted') return false;

      const platform = Capacitor.getPlatform();
      if (this.auth.user()?.id !== expectedUserId) return false;
      if (this.registeredInstallationKey?.startsWith(`${expectedUserId}:${platform}:`)) return true;
      await this.createNativeChannels();
      const { token } = await FirebaseMessaging.getToken();
      await this.registerNativeToken(token, expectedUserId);
      return this.registeredInstallationKey === `${expectedUserId}:${platform}:${token}`;
    }

    if (!this.webPushSupported()) {
      this._permissionState.set('unsupported');
      return false;
    }
    const state = this.normalizePermission(Notification.permission);
    this._permissionState.set(state);
    if (state !== 'granted') return false;
    await this.registerWebSubscription(expectedUserId);
    return this.auth.user()?.id === expectedUserId &&
      this.registeredInstallationKey?.startsWith(`${expectedUserId}:web:`) === true;
  }

  private initializeNativeListeners(): Promise<void> {
    if (this.nativeListenersPromise) return this.nativeListenersPromise;
    const setup = this.addNativeListeners();
    const tracked = setup.catch(error => {
      if (this.nativeListenersPromise === tracked) this.nativeListenersPromise = null;
      throw error;
    });
    this.nativeListenersPromise = tracked;
    return tracked;
  }

  private async addNativeListeners(): Promise<void> {
    await FirebaseMessaging.addListener('tokenReceived', event => {
      const userId = this.auth.user()?.id;
      if (userId && this.hasNotificationIntent() && this._permissionState() === 'granted') {
        void this.queueInstallationOperation(
          () => this.registerNativeToken(event.token, userId),
        ).catch(() => undefined);
      }
    });
    await FirebaseMessaging.addListener('notificationActionPerformed', event => {
      if (!this.accountRemoteNotificationIsCurrent(event.notification)) return;
      this.openNotification(event.notification);
    });
    await FirebaseMessaging.addListener('notificationReceived', event => {
      if (!this.accountRemoteNotificationIsCurrent(event.notification)) return;
      if (Capacitor.getPlatform() === 'android') {
        void this.showAndroidForegroundNotification(event.notification).catch(() => undefined);
      }
    });
    await LocalNotifications.addListener('localNotificationActionPerformed', event => {
      const extra = this.asRecord(event.notification.extra);
      if (extra['type'] === NATIVE_DEADLINE_NOTIFICATION_TYPE) {
        this.openTarget(this.notificationTarget(extra));
      }
    });
    await CapacitorApp.addListener('appUrlOpen', event => this.captureTargetFromRawUrl(event.url));
    await CapacitorApp.addListener('appStateChange', event => {
      if (event.isActive) {
        void this.refreshCurrentNotificationState().catch(() => undefined);
      }
    });
    window.addEventListener('online', () => {
      void this.refreshCurrentNotificationState().catch(() => undefined);
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
      void this.refreshCurrentNotificationState().catch(() => undefined);
    });
    window.addEventListener('storage', event => {
      if (event.key === NOTIFICATION_INTENT_KEY) {
        const enabled = event.newValue === 'true';
        this._deviceNotificationsEnabled.set(enabled);
        this.invalidateDeadlineSnapshot();
        if (!enabled) {
          this.clearWebDeadlineTimers();
          void this.queueInstallationOperation(
            async () => {
              await this.setAccountWorkerUser(null).catch(() => undefined);
              await this.deactivateAnonymousWebInstallation(true);
            },
          ).catch(() => undefined);
        } else if (!this.auth.user() && !this.browserHasAccountSession()) {
          void this.reconcileDeadlines(this.storage.loadSectionsForPartition()).catch(() => undefined);
        } else if (this.auth.user()) {
          void this.ensureRegistrationWithoutPrompt().catch(() => undefined);
        }
      }
      if (event.key === 'splendide_token') {
        this.invalidateDeadlineSnapshot();
        this.clearWebDeadlineTimers();
        this.registeredInstallationKey = null;
        void this.queueInstallationOperation(
          async () => {
            await this.setAccountWorkerUser(null).catch(() => undefined);
            if (event.newValue) {
              await this.deactivateAnonymousWebInstallation(false);
            } else {
              await this.setAnonymousWorkerInstallation(null).catch(() => undefined);
            }
          },
        ).catch(() => undefined);
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void this.refreshCurrentNotificationState().catch(() => undefined);
      }
    });
  }

  private async createNativeChannels(): Promise<void> {
    if (Capacitor.getPlatform() !== 'android') return;
    await AndroidDeadlineNotifications.createChannels();
  }

  private async reconcileNativeLocalDeadlines(
    schedules: DeadlineNotificationSchedule[],
    snapshot: DeadlineReconciliationSnapshot,
  ): Promise<void> {
    if (!this.hasNotificationIntent() || this._permissionState() !== 'granted') {
      await this.cancelNativeLocalDeadlines();
      return;
    }
    await this.createNativeChannels();
    const { notifications } = await LocalNotifications.getPending();
    if (!this.deadlineSnapshotIsCurrent(snapshot) || !this.hasNotificationIntent()) return;
    const plan = planNativeDeadlineNotifications(schedules, notifications);
    if (plan.cancelIds.length > 0) {
      await LocalNotifications.cancel({
        notifications: plan.cancelIds.map(id => ({ id })),
      });
    }
    if (!this.deadlineSnapshotIsCurrent(snapshot) || !this.hasNotificationIntent()) return;
    if (plan.schedule.length > 0) {
      await LocalNotifications.schedule({
        notifications: plan.schedule.map(schedule => ({
          id: schedule.id,
          title: schedule.pageTitle,
          body: schedule.taskText,
          channelId: 'deadlines',
          smallIcon: 'ic_stat_splendide',
          largeIcon: 'ic_notification_splendide',
          iconColor: '#789db4',
          sound: 'default',
          foreground: true,
          autoCancel: true,
          isExactNotification: false,
          schedule: {
            at: new Date(schedule.deadlineAt),
            allowWhileIdle: true,
          },
          extra: {
            type: NATIVE_DEADLINE_NOTIFICATION_TYPE,
            eventId: schedule.eventId,
            deadlineAt: schedule.deadlineAt,
            pageId: schedule.pageId,
            taskId: schedule.taskId,
            shareToken: schedule.shareToken ?? '',
          },
        })),
      });
    }
    if (this.deadlineSnapshotIsCurrent(snapshot)) this._registrationState.set('ready');
  }

  private async cancelNativeLocalDeadlines(): Promise<void> {
    const { notifications } = await LocalNotifications.getPending().catch(() => ({ notifications: [] }));
    const owned = notifications.filter(notification =>
      this.asRecord(notification.extra)['type'] === NATIVE_DEADLINE_NOTIFICATION_TYPE,
    );
    if (owned.length > 0) {
      await LocalNotifications.cancel({
        notifications: owned.map(notification => ({ id: notification.id })),
      }).catch(() => undefined);
    }
  }

  private async reconcileAnonymousWebPush(
    schedules: DeadlineNotificationSchedule[],
    snapshot: DeadlineReconciliationSnapshot,
  ): Promise<void> {
    if (
      !this.webPushSupported() ||
      !this.anonymousWebSnapshotCanApply(snapshot)
    ) return;

    const anonymousSchedules = this.anonymousWebSchedules(schedules);
    const permission = this.normalizePermission(Notification.permission);
    this._permissionState.set(permission);
    if (permission !== 'granted') {
      await this.deactivateAnonymousWebInstallation(false).catch(() => undefined);
      return;
    }
    if (anonymousSchedules.length === 0) {
      await this.deactivateAnonymousWebInstallation(false);
      if (this.deadlineSnapshotIsCurrent(snapshot)) this._registrationState.set('ready');
      return;
    }

    const fingerprint = JSON.stringify(anonymousSchedules);
    if (
      this.registeredInstallationKey?.startsWith('anonymous:') &&
      this.lastAnonymousSnapshotFingerprint === fingerprint
    ) {
      this._registrationState.set('ready');
      return;
    }

    try {
      await this.saveAnonymousWebSnapshot(anonymousSchedules, snapshot, false);
    } catch (error) {
      const errorCode = this.httpErrorCode(error);
      if (this.httpStatus(error) === 409 && errorCode === 'ANONYMOUS_SNAPSHOT_REVISION_CONFLICT') {
        this.adoptAnonymousServerRevision(error);
        if (this.anonymousWebSnapshotCanApply(snapshot)) {
          await this.saveAnonymousWebSnapshot(anonymousSchedules, snapshot, false);
          return;
        }
      } else if (
        this.httpStatus(error) === 401 ||
        errorCode === 'ANONYMOUS_PUSH_ENDPOINT_INVALID' ||
        errorCode === 'ANONYMOUS_PUSH_ENDPOINT_CONFLICT'
      ) {
        await this.recoverAnonymousWebInstallation();
        if (this.anonymousWebSnapshotCanApply(snapshot)) {
          await this.saveAnonymousWebSnapshot(anonymousSchedules, snapshot, true);
          return;
        }
      }
      if (this.deadlineSnapshotIsCurrent(snapshot)) this._registrationState.set('retrying');
      throw error;
    }
  }

  private async saveAnonymousWebSnapshot(
    schedules: AnonymousDeadlineSchedule[],
    snapshot: DeadlineReconciliationSnapshot,
    forceFreshSubscription: boolean,
  ): Promise<void> {
    return this.withAnonymousWebLock(
      () => this.saveAnonymousWebSnapshotNow(schedules, snapshot, forceFreshSubscription),
    );
  }

  private async saveAnonymousWebSnapshotNow(
    schedules: AnonymousDeadlineSchedule[],
    snapshot: DeadlineReconciliationSnapshot,
    forceFreshSubscription: boolean,
  ): Promise<void> {
    if (!this.anonymousWebSnapshotCanApply(snapshot)) return;
    const registration = await navigator.serviceWorker.register(PUSH_WORKER_PATH, { scope: '/' });
    await navigator.serviceWorker.ready;
    if (!this.anonymousWebSnapshotCanApply(snapshot)) return;

    let subscription = await registration.pushManager.getSubscription();
    const response = await firstValueFrom(
      this.http.get<WebPushKeyResponse>(`${this.apiUrl}/notifications/vapid-public-key`),
    );
    if (!response.publicKey) throw new Error('web push is not configured');
    const applicationServerKey = this.urlBase64ToUint8Array(response.publicKey);
    if (
      subscription &&
      (forceFreshSubscription || !this.sameBytes(subscription.options.applicationServerKey, applicationServerKey))
    ) {
      await subscription.unsubscribe();
      subscription = null;
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
    }
    if (!this.anonymousWebSnapshotCanApply(snapshot)) return;

    const credentials = this.nextAnonymousNotificationCredentials();
    // Switch the worker to the prospective revision before publishing it.
    // The backend cannot emit this revision before the PUT commits, while an
    // immediately-due push accepted during the response trip is already
    // authorized locally. Old queued revisions stop matching at this point.
    await this.setAnonymousWorkerInstallation(
      credentials.installationId,
      credentials.snapshotRevision,
      schedules.map(schedule => schedule.eventId),
    );
    if (!this.anonymousWebSnapshotCanApply(snapshot)) {
      await this.setAnonymousWorkerInstallation(null).catch(() => undefined);
      return;
    }
    try {
      await firstValueFrom(this.http.put(
        `${this.apiUrl}/notifications/anonymous-deadlines`,
        {
          subscription: {
            endpoint: subscription.endpoint,
            keys: {
              p256dh: this.pushKey(subscription, 'p256dh'),
              auth: this.pushKey(subscription, 'auth'),
            },
          },
          schedules,
        },
        { headers: this.anonymousNotificationHeaders(credentials) },
      ));
    } catch (error) {
      // A failed or ambiguous publish must not leave an unacknowledged local
      // authority active. The revision-conflict recovery path will install a
      // fresh marker before its retry.
      await this.setAnonymousWorkerInstallation(null).catch(() => undefined);
      throw error;
    }
    this.storeAnonymousNotificationActive(true);
    if (!this.anonymousWebSnapshotCanApply(snapshot)) {
      await this.deactivateAnonymousWebInstallationNow(false).catch(() => undefined);
      return;
    }
    this.registeredInstallationKey = `anonymous:${credentials.installationId}:web:${subscription.endpoint}`;
    this.lastAnonymousSnapshotFingerprint = JSON.stringify(schedules);
    this._registrationState.set('ready');
  }

  private async deactivateAnonymousWebInstallation(unsubscribe: boolean): Promise<void> {
    return this.withAnonymousWebLock(() => this.deactivateAnonymousWebInstallationNow(unsubscribe));
  }

  private async deactivateAnonymousWebInstallationNow(unsubscribe: boolean): Promise<void> {
    if (environment.isElectron || this.nativeMobile) return;
    await this.setAnonymousWorkerInstallation(null).catch(() => undefined);
    const credentials = this.readAnonymousNotificationCredentials();
    if (credentials && this.readAnonymousNotificationActive() !== false) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const revised = this.nextAnonymousNotificationCredentials();
        try {
          await firstValueFrom(this.http.delete(
            `${this.apiUrl}/notifications/anonymous-deadlines`,
            { headers: this.anonymousNotificationHeaders(revised) },
          ));
          this.storeAnonymousNotificationActive(false);
          break;
        } catch (error) {
          if (
            attempt === 0 &&
            this.httpStatus(error) === 409 &&
            this.httpErrorCode(error) === 'ANONYMOUS_SNAPSHOT_REVISION_CONFLICT'
          ) {
            this.adoptAnonymousServerRevision(error);
            continue;
          }
          throw error;
        }
      }
    }
    if (this.registeredInstallationKey?.startsWith('anonymous:')) {
      this.registeredInstallationKey = null;
    }
    this.lastAnonymousSnapshotFingerprint = null;
    if (unsubscribe && this.webPushSupported()) {
      const registration = await navigator.serviceWorker.getRegistration('/').catch(() => undefined);
      const subscription = await registration?.pushManager.getSubscription().catch(() => null);
      await subscription?.unsubscribe().catch(() => false);
    }
  }

  private async recoverAnonymousWebInstallation(): Promise<void> {
    return this.withAnonymousWebLock(() => this.recoverAnonymousWebInstallationNow());
  }

  private async recoverAnonymousWebInstallationNow(): Promise<void> {
    await this.setAnonymousWorkerInstallation(null).catch(() => undefined);
    const credentials = this.readAnonymousNotificationCredentials();
    if (credentials) {
      const revised = this.nextAnonymousNotificationCredentials(credentials);
      await firstValueFrom(this.http.delete(
        `${this.apiUrl}/notifications/anonymous-deadlines`,
        { headers: this.anonymousNotificationHeaders(revised) },
      )).catch(() => undefined);
    }
    const registration = await navigator.serviceWorker.getRegistration('/').catch(() => undefined);
    const subscription = await registration?.pushManager.getSubscription().catch(() => null);
    await subscription?.unsubscribe().catch(() => false);
    this.removeAnonymousNotificationCredentials();
    this.removeAnonymousNotificationActive();
    if (this.registeredInstallationKey?.startsWith('anonymous:')) {
      this.registeredInstallationKey = null;
    }
    this.lastAnonymousSnapshotFingerprint = null;
  }

  private async setAnonymousWorkerInstallation(
    installationId: string | null,
    snapshotRevision: number | null = null,
    activeEventIds: string[] = [],
  ): Promise<void> {
    if (environment.isElectron || this.nativeMobile || !('serviceWorker' in navigator)) return;
    let registration = await navigator.serviceWorker.getRegistration('/').catch(() => undefined);
    if (!registration && installationId) {
      registration = await navigator.serviceWorker.register(PUSH_WORKER_PATH, { scope: '/' });
      await navigator.serviceWorker.ready;
    }
    const worker = registration?.active;
    if (!worker) return;
    await new Promise<void>((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => reject(new Error('Notification worker timed out.')), 5_000);
      channel.port1.onmessage = event => {
        clearTimeout(timeout);
        const result = this.asRecord(event.data);
        if (result['ok'] === true) resolve();
        else reject(new Error('Notification worker rejected the installation state.'));
      };
      worker.postMessage({
        type: 'splendide-set-anonymous-installation',
        installationId,
        snapshotRevision,
        activeEventIds,
      }, [channel.port2]);
    });
  }

  private async setAccountWorkerUser(userId: string | null): Promise<void> {
    if (environment.isElectron || this.nativeMobile || !('serviceWorker' in navigator)) return;
    let registration = await navigator.serviceWorker.getRegistration('/').catch(() => undefined);
    if (!registration && userId) {
      registration = await navigator.serviceWorker.register(PUSH_WORKER_PATH, { scope: '/' });
      await navigator.serviceWorker.ready;
    }
    const worker = registration?.active;
    if (!worker) return;
    await new Promise<void>((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => reject(new Error('Notification worker timed out.')), 5_000);
      channel.port1.onmessage = event => {
        clearTimeout(timeout);
        const result = this.asRecord(event.data);
        if (result['ok'] === true) resolve();
        else reject(new Error('Notification worker rejected the account state.'));
      };
      worker.postMessage({
        type: 'splendide-set-account-notification-user',
        userId,
      }, [channel.port2]);
    });
  }

  private anonymousWebSchedules(schedules: DeadlineNotificationSchedule[]): AnonymousDeadlineSchedule[] {
    const now = Date.now();
    const maximumDeadline = now + ANONYMOUS_MAX_FUTURE_MS;
    const identifiers = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
    const shareTokens = /^[A-Za-z0-9_-]+$/;
    const seen = new Set<string>();
    return schedules
      .filter(schedule => {
        const deadline = Date.parse(schedule.deadlineAt);
        return Number.isFinite(deadline) &&
          deadline + ANONYMOUS_DELIVERY_WINDOW_MS > now &&
          deadline <= maximumDeadline &&
          schedule.eventId.length <= 191 && identifiers.test(schedule.eventId) &&
          schedule.pageId.length <= 191 && identifiers.test(schedule.pageId) &&
          schedule.taskId.length <= 191 && identifiers.test(schedule.taskId) &&
          (!schedule.shareToken || (schedule.shareToken.length <= 191 && shareTokens.test(schedule.shareToken))) &&
          !seen.has(schedule.eventId) && Boolean(seen.add(schedule.eventId));
      })
      .sort((left, right) =>
        Date.parse(left.deadlineAt) - Date.parse(right.deadlineAt) ||
        left.eventId.localeCompare(right.eventId),
      )
      .slice(0, ANONYMOUS_MAX_SCHEDULES)
      .map(schedule => ({
        eventId: schedule.eventId,
        pageId: schedule.pageId,
        taskId: schedule.taskId,
        deadlineAt: schedule.deadlineAt,
        ...(schedule.shareToken ? { shareToken: schedule.shareToken } : {}),
      }));
  }

  private reconcileWebForegroundTimers(
    schedules: DeadlineNotificationSchedule[],
    snapshot: DeadlineReconciliationSnapshot,
  ): void {
    this.clearWebDeadlineTimers();
    if (
      !this.hasNotificationIntent() ||
      this._permissionState() !== 'granted' ||
      !this.deadlineSnapshotIsCurrent(snapshot)
    ) return;
    for (const schedule of schedules) {
      if (!this.webDeadlineWasDelivered(schedule.eventId)) {
        this.armWebDeadlineTimer(schedule, snapshot);
      }
    }
  }

  private armWebDeadlineTimer(
    schedule: DeadlineNotificationSchedule,
    snapshot: DeadlineReconciliationSnapshot,
  ): void {
    const remaining = Date.parse(schedule.deadlineAt) - Date.now();
    if (remaining <= 0) return;
    const delay = Math.min(remaining, MAX_TIMER_DELAY_MS);
    const timer = setTimeout(() => {
      this.webDeadlineTimers.delete(schedule.eventId);
      if (!this.deadlineSnapshotIsCurrent(snapshot) || !this.hasNotificationIntent()) return;
      if (remaining > MAX_TIMER_DELAY_MS) {
        this.armWebDeadlineTimer(schedule, snapshot);
        return;
      }
      // Always ask the service worker to provide the foreground fallback. Its
      // serialized event marker deduplicates this against a simultaneous push,
      // including when the browser reports online but registration or the push
      // provider is unavailable.
      if (this.webDeadlineWasDelivered(schedule.eventId)) return;
      void this.showWebDeadlineFallback(schedule, snapshot);
    }, delay);
    this.webDeadlineTimers.set(schedule.eventId, timer);
  }

  private async showWebDeadlineFallback(
    schedule: DeadlineNotificationSchedule,
    snapshot: DeadlineReconciliationSnapshot,
  ): Promise<void> {
    try {
      const registration = await navigator.serviceWorker.ready;
      if (!this.deadlineSnapshotIsCurrent(snapshot) || !this.hasNotificationIntent()) return;
      const worker = registration.active;
      if (!worker) throw new Error('The notification service worker is not active.');
      const anonymousCredentials = snapshot.userId === null
        ? this.readAnonymousNotificationCredentials()
        : null;
      if (snapshot.userId === null && !anonymousCredentials) return;
      const result = await new Promise<{ ok: boolean }>((resolve, reject) => {
        const channel = new MessageChannel();
        const timeout = setTimeout(() => reject(new Error('Notification worker timed out.')), 5_000);
        channel.port1.onmessage = event => {
          clearTimeout(timeout);
          resolve(this.asRecord(event.data) as { ok: boolean });
        };
        worker.postMessage({
          type: 'splendide-show-offline-deadline',
          notificationScope: snapshot.userId === null ? 'anonymous' : 'account',
          ...(anonymousCredentials ? {
            anonymousInstallationId: anonymousCredentials.installationId,
            anonymousSnapshotRevision: anonymousCredentials.snapshotRevision,
          } : {}),
          ...(snapshot.userId ? { accountNotificationUserId: snapshot.userId } : {}),
          schedule,
        }, [channel.port2]);
      });
      if (!result.ok) throw new Error('The notification worker could not display the deadline.');
      if (this.deadlineSnapshotIsCurrent(snapshot) && this.hasNotificationIntent()) {
        this.markWebDeadlineDelivered(schedule.eventId);
      }
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
    if (this.auth.user()?.id !== expectedUserId || !this.hasNotificationIntent()) return;
    // Authorize this account before refreshing the server registration so a
    // deadline already accepted by the push provider cannot land in an
    // activation gap. Session end and disable both clear this marker first.
    await this.setAccountWorkerUser(expectedUserId);
    let subscription = await registration.pushManager.getSubscription();
    if (this.auth.user()?.id !== expectedUserId || !this.hasNotificationIntent()) {
      await this.setAccountWorkerUser(null).catch(() => undefined);
      return;
    }
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

    if (this.auth.user()?.id !== expectedUserId || !this.hasNotificationIntent()) {
      await this.setAccountWorkerUser(null).catch(() => undefined);
      return;
    }
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
      await this.setAccountWorkerUser(null).catch(() => undefined);
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

  private accountRemoteNotificationIsCurrent(notification: FirebaseNotification): boolean {
    const data = this.asRecord(notification.data);
    const accountScoped = data['type'] === 'task-deadline' ||
      data['type'] === 'shared-page-item-added' ||
      typeof data['sectionId'] === 'string';
    if (!accountScoped) return true;
    const recipientUserId = String(data['accountNotificationUserId'] ?? '');
    return Boolean(recipientUserId) &&
      recipientUserId === this.auth.user()?.id &&
      this.hasNotificationIntent();
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

  private browserHasAccountSession(): boolean {
    try {
      return Boolean(localStorage.getItem('splendide_token'));
    } catch {
      return Boolean(this.auth.user());
    }
  }

  private rememberNotificationIntent(): void {
    this._deviceNotificationsEnabled.set(true);
    try {
      localStorage.setItem(NOTIFICATION_INTENT_KEY, 'true');
    } catch {
      // Keep the explicit choice for this app session when storage is blocked.
    }
  }

  private hasNotificationIntent(): boolean {
    if (!this._deviceNotificationsEnabled()) return false;
    try {
      return localStorage.getItem(NOTIFICATION_INTENT_KEY) === 'true';
    } catch {
      return true;
    }
  }

  private readNotificationIntent(): boolean {
    try {
      return localStorage.getItem(NOTIFICATION_INTENT_KEY) === 'true';
    } catch {
      return false;
    }
  }

  private forgetNotificationIntent(): void {
    this._deviceNotificationsEnabled.set(false);
    try {
      localStorage.removeItem(NOTIFICATION_INTENT_KEY);
    } catch {
      // The in-memory preference is already cleared.
    }
  }

  private readAnonymousNotificationCredentials(): AnonymousNotificationCredentials | null {
    try {
      const value = this.asRecord(JSON.parse(
        localStorage.getItem(ANONYMOUS_NOTIFICATION_CREDENTIALS_KEY) ?? 'null',
      ));
      const installationId = String(value['installationId'] ?? '');
      const secret = String(value['secret'] ?? '');
      const snapshotRevision = Number(value['snapshotRevision']);
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(installationId) ||
        !/^[A-Za-z0-9_-]{43}$/.test(secret) ||
        !Number.isSafeInteger(snapshotRevision) ||
        snapshotRevision < 0
      ) return this.anonymousCredentialsMemory;
      const credentials = { installationId, secret, snapshotRevision };
      this.anonymousCredentialsMemory = credentials;
      return credentials;
    } catch {
      return this.anonymousCredentialsMemory;
    }
  }

  private nextAnonymousNotificationCredentials(
    existing = this.readAnonymousNotificationCredentials(),
  ): AnonymousNotificationCredentials {
    const credentials = existing ?? {
      installationId: crypto.randomUUID(),
      secret: this.uint8ArrayToUrlBase64(crypto.getRandomValues(new Uint8Array(32))),
      snapshotRevision: 0,
    };
    const snapshotRevision = Math.max(credentials.snapshotRevision + 1, Date.now());
    const revised = { ...credentials, snapshotRevision };
    this.persistAnonymousNotificationCredentials(revised);
    return revised;
  }

  private persistAnonymousNotificationCredentials(credentials: AnonymousNotificationCredentials): void {
    this.anonymousCredentialsMemory = credentials;
    try {
      localStorage.setItem(ANONYMOUS_NOTIFICATION_CREDENTIALS_KEY, JSON.stringify(credentials));
    } catch {
      // The in-memory credential still allows same-session cleanup. Browsers
      // that block persistent storage cannot guarantee closed-app reminders.
    }
  }

  private removeAnonymousNotificationCredentials(): void {
    this.anonymousCredentialsMemory = null;
    try {
      localStorage.removeItem(ANONYMOUS_NOTIFICATION_CREDENTIALS_KEY);
    } catch {
      // A new in-memory credential will still avoid reusing this installation.
    }
  }

  private readAnonymousNotificationActive(): boolean | null {
    try {
      const value = localStorage.getItem(ANONYMOUS_NOTIFICATION_ACTIVE_KEY);
      if (value === 'true') return true;
      if (value === 'false') return false;
      return null;
    } catch {
      return null;
    }
  }

  private storeAnonymousNotificationActive(active: boolean): void {
    try {
      localStorage.setItem(ANONYMOUS_NOTIFICATION_ACTIVE_KEY, String(active));
    } catch {
      // The service-worker marker remains the local delivery authority.
    }
  }

  private removeAnonymousNotificationActive(): void {
    try {
      localStorage.removeItem(ANONYMOUS_NOTIFICATION_ACTIVE_KEY);
    } catch {
      // The service-worker marker has already been cleared.
    }
  }

  private anonymousNotificationHeaders(credentials: AnonymousNotificationCredentials): Record<string, string> {
    return {
      [ANONYMOUS_INSTALLATION_ID_HEADER]: credentials.installationId,
      [ANONYMOUS_INSTALLATION_SECRET_HEADER]: credentials.secret,
      [ANONYMOUS_SNAPSHOT_REVISION_HEADER]: String(credentials.snapshotRevision),
    };
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

  private httpStatus(error: unknown): number | null {
    const status = this.asRecord(error)['status'];
    return typeof status === 'number' ? status : null;
  }

  private httpErrorCode(error: unknown): string {
    const body = this.asRecord(this.asRecord(error)['error']);
    return typeof body['code'] === 'string' ? body['code'] : '';
  }

  private adoptAnonymousServerRevision(error: unknown): void {
    const body = this.asRecord(this.asRecord(error)['error']);
    const currentRevision = Number(body['currentSnapshotRevision']);
    const credentials = this.readAnonymousNotificationCredentials();
    if (!credentials || !Number.isSafeInteger(currentRevision) || currentRevision < 1) return;
    if (currentRevision > credentials.snapshotRevision) {
      this.persistAnonymousNotificationCredentials({ ...credentials, snapshotRevision: currentRevision });
    }
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }
}
