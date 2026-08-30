import { app, BrowserWindow, ipcMain, Menu, Notification, protocol, shell, Tray } from 'electron';
import * as crypto from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const APP_PROTOCOL = 'splendide';
const APP_HOST = 'app';
const GOOGLE_AUTH_HOST = 'auth';
const GOOGLE_AUTH_CALLBACK_PATH = '/google/callback';
const GOOGLE_AUTH_REDIRECT_URI = `${APP_PROTOCOL}://${GOOGLE_AUTH_HOST}${GOOGLE_AUTH_CALLBACK_PATH}`;
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const DEV_SERVER_URL = 'http://localhost:4201';
const DEADLINE_STATE_FILENAME = 'deadline-notifications.json';
const DEADLINE_OPENED_CHANNEL = 'deadline-notification-opened';
const BACKGROUND_START_ARGUMENT = '--splendide-background';
const DEADLINE_LATE_GRACE_MS = 24 * 60 * 60 * 1000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
// Align with the premium product ceiling (100 pages × 1,000 active tasks) so
// an authoritative backend snapshot is never rejected merely for being valid.
const MAX_DEADLINE_SCHEDULES = 100_000;
const MAX_DELIVERED_DEADLINE_EVENTS = 100_000;
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://api.splendide.app",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
let mainWindow: BrowserWindow | null = null;

type GoogleAuthResult = {
  code: string;
  codeVerifier: string;
  redirectUri: string;
};

type PendingGoogleAuth = {
  state: string;
  codeVerifier: string;
  timeout: NodeJS.Timeout;
  resolve: (result: GoogleAuthResult) => void;
  reject: (error: Error) => void;
};

type DeadlineNotificationPermission = 'unsupported' | 'prompt' | 'granted';

type DeadlineNotificationTarget = {
  pageId: string;
  taskId: string;
  shareToken?: string;
};

type DeadlineNotificationSchedule = DeadlineNotificationTarget & {
  eventId: string;
  pageTitle: string;
  taskText: string;
  deadlineAt: string;
  deliveredAt?: string;
};

type DeadlineNotificationState = {
  enabled: boolean;
  schedules: DeadlineNotificationSchedule[];
  deliveredEvents: { eventId: string; deliveredAt: string }[];
};

let pendingGoogleAuth: PendingGoogleAuth | null = null;
let deadlineState: DeadlineNotificationState = { enabled: false, schedules: [], deliveredEvents: [] };
let deadlineStateWrite: Promise<void> = Promise.resolve();
const deadlineTimers = new Map<string, NodeJS.Timeout>();
const deliveredDeadlineEventsById = new Map<string, string>();
let backgroundTray: Tray | null = null;
let isQuitting = false;

function logDesktop(message: string, error?: unknown): void {
  try {
    const details = error instanceof Error ? ` ${error.stack ?? error.message}` : error ? ` ${String(error)}` : '';
    const logDir = app.getPath('userData');
    fsSync.mkdirSync(logDir, { recursive: true });
    fsSync.appendFileSync(
      path.join(logDir, 'desktop.log'),
      `${new Date().toISOString()} ${message}${details}\n`,
    );
  } catch {
    // Logging should never be able to crash the desktop app.
  }
}

function deadlineStatePath(): string {
  return path.join(app.getPath('userData'), DEADLINE_STATE_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximumLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximumLength) : '';
}

function parseDeadlineSchedule(value: unknown): DeadlineNotificationSchedule | null {
  if (!isRecord(value)) return null;
  const eventId = boundedString(value['eventId'], 300);
  const pageId = boundedString(value['pageId'], 100);
  const taskId = boundedString(value['taskId'], 100);
  const pageTitle = boundedString(value['pageTitle'], 100) || 'Splendide';
  const taskText = boundedString(value['taskText'], 120) || 'Task deadline';
  const shareToken = boundedString(value['shareToken'], 300);
  const deadlineAt = boundedString(value['deadlineAt'], 64);
  const deadlineTime = Date.parse(deadlineAt);
  const deliveredAt = boundedString(value['deliveredAt'], 64);

  if (!eventId || !pageId || !taskId || !Number.isFinite(deadlineTime)) return null;
  return {
    eventId,
    pageId,
    taskId,
    pageTitle,
    taskText,
    deadlineAt: new Date(deadlineTime).toISOString(),
    ...(shareToken ? { shareToken } : {}),
    ...(deliveredAt && Number.isFinite(Date.parse(deliveredAt)) ? { deliveredAt } : {}),
  };
}

function parseDeliveredDeadlineEvent(value: unknown): { eventId: string; deliveredAt: string } | null {
  if (!isRecord(value)) return null;
  const eventId = boundedString(value['eventId'], 300);
  const deliveredAt = boundedString(value['deliveredAt'], 64);
  const deliveredTime = Date.parse(deliveredAt);
  if (!eventId || !Number.isFinite(deliveredTime)) return null;
  return { eventId, deliveredAt: new Date(deliveredTime).toISOString() };
}

function normalizeDeliveredDeadlineEvents(
  values: { eventId: string; deliveredAt: string }[],
): { eventId: string; deliveredAt: string }[] {
  const byEventId = new Map<string, { eventId: string; deliveredAt: string }>();
  for (const value of values) {
    byEventId.delete(value.eventId);
    byEventId.set(value.eventId, value);
  }
  return [...byEventId.values()].slice(-MAX_DELIVERED_DEADLINE_EVENTS);
}

function deliveredDeadlineAt(eventId: string): string | undefined {
  return deliveredDeadlineEventsById.get(eventId);
}

function recordDeadlineDelivered(eventId: string, deliveredAt: string): void {
  deliveredDeadlineEventsById.delete(eventId);
  deliveredDeadlineEventsById.set(eventId, deliveredAt);
  while (deliveredDeadlineEventsById.size > MAX_DELIVERED_DEADLINE_EVENTS) {
    const oldest = deliveredDeadlineEventsById.keys().next().value as string | undefined;
    if (!oldest) break;
    deliveredDeadlineEventsById.delete(oldest);
  }
  deadlineState.deliveredEvents = [...deliveredDeadlineEventsById].map(([storedEventId, storedAt]) => ({
    eventId: storedEventId,
    deliveredAt: storedAt,
  }));
}

async function loadDeadlineNotificationState(): Promise<void> {
  try {
    const raw = await fs.readFile(deadlineStatePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return;
    const schedules = Array.isArray(parsed['schedules'])
      ? parsed['schedules'].slice(0, MAX_DEADLINE_SCHEDULES).map(parseDeadlineSchedule).filter((value): value is DeadlineNotificationSchedule => !!value)
      : [];
    const deliveredEvents = Array.isArray(parsed['deliveredEvents'])
      ? parsed['deliveredEvents']
          .map(parseDeliveredDeadlineEvent)
          .filter((value): value is { eventId: string; deliveredAt: string } => !!value)
      : [];
    // Older state files kept delivery history only on active schedules.
    // Promote it into the independent ledger before schedules can disappear.
    for (const schedule of schedules) {
      if (schedule.deliveredAt) {
        deliveredEvents.push({ eventId: schedule.eventId, deliveredAt: schedule.deliveredAt });
      }
    }
    const normalizedDeliveredEvents = normalizeDeliveredDeadlineEvents(deliveredEvents);
    deadlineState = {
      enabled: parsed['enabled'] === true,
      schedules,
      deliveredEvents: normalizedDeliveredEvents,
    };
    deliveredDeadlineEventsById.clear();
    for (const event of normalizedDeliveredEvents) {
      deliveredDeadlineEventsById.set(event.eventId, event.deliveredAt);
    }
  } catch (error) {
    const code = isRecord(error) ? error['code'] : undefined;
    if (code !== 'ENOENT') logDesktop('Failed to read deadline notification state', error);
  }
}

function saveDeadlineNotificationState(): Promise<void> {
  const snapshot = JSON.stringify(deadlineState);
  deadlineStateWrite = deadlineStateWrite
    .catch(() => undefined)
    .then(async () => {
      const destination = deadlineStatePath();
      const temporary = `${destination}.tmp`;
      await fs.writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, destination);
    })
    .catch(error => {
      logDesktop('Failed to save deadline notification state', error);
      throw error;
    });
  return deadlineStateWrite;
}

function clearDeadlineTimers(): void {
  for (const timer of deadlineTimers.values()) clearTimeout(timer);
  deadlineTimers.clear();
}

function deadlineTarget(schedule: DeadlineNotificationSchedule): DeadlineNotificationTarget {
  return {
    pageId: schedule.pageId,
    taskId: schedule.taskId,
    ...(schedule.shareToken ? { shareToken: schedule.shareToken } : {}),
  };
}

function sendDeadlineTargetToRenderer(target: DeadlineNotificationTarget): void {
  const send = () => mainWindow?.webContents.send(DEADLINE_OPENED_CHANNEL, target);
  if (!mainWindow) holdMainWindow(createWindow());
  if (!mainWindow) return;
  if (mainWindow.webContents.isLoadingMainFrame()) {
    mainWindow.webContents.once('did-finish-load', send);
  } else {
    send();
  }
  focusMainWindow();
}

async function showDeadlineNotification(taskId: string, eventId: string): Promise<void> {
  if (!deadlineState.enabled) return;
  const schedule = deadlineState.schedules.find(item => item.taskId === taskId && item.eventId === eventId);
  if (!schedule || schedule.deliveredAt || deliveredDeadlineAt(eventId)) return;

  // Persist before calling the OS so a process crash cannot replay the same alert.
  schedule.deliveredAt = new Date().toISOString();
  recordDeadlineDelivered(schedule.eventId, schedule.deliveredAt);
  await saveDeadlineNotificationState().catch(() => undefined);
  deadlineTimers.delete(taskId);

  // A disable, sign-out, deletion, or reschedule can run while the state write
  // above is pending. Re-read the live snapshot immediately before the
  // synchronous OS display so an obsolete task cannot escape cancellation.
  const current = deadlineState.schedules.find(item =>
    item.taskId === taskId &&
    item.eventId === eventId &&
    item.deadlineAt === schedule.deadlineAt,
  );
  if (!deadlineState.enabled || !current) return;
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: current.pageTitle,
    body: current.taskText,
    icon: path.join(rendererRoot(), 'icons', 'icon-256.png'),
    silent: false,
  });
  notification.on('click', () => sendDeadlineTargetToRenderer(deadlineTarget(current)));
  notification.on('failed', (_event, error) => logDesktop('Deadline notification failed', error));
  notification.show();
}

function armDeadlineTimer(
  schedule: DeadlineNotificationSchedule,
  notifyOverdue = true,
): void {
  if (schedule.deliveredAt || deliveredDeadlineAt(schedule.eventId)) return;
  const remaining = Date.parse(schedule.deadlineAt) - Date.now();
  if (remaining < -DEADLINE_LATE_GRACE_MS) {
    schedule.deliveredAt = new Date().toISOString();
    recordDeadlineDelivered(schedule.eventId, schedule.deliveredAt);
    void saveDeadlineNotificationState().catch(() => undefined);
    return;
  }
  // On process startup, let the renderer reconcile completed, deleted, or
  // remotely changed tasks before emitting an overdue notification.
  if (remaining <= 0 && !notifyOverdue) return;

  const delay = Math.max(0, Math.min(remaining, MAX_TIMER_DELAY_MS));
  const timer = setTimeout(() => {
    deadlineTimers.delete(schedule.taskId);
    if (remaining > MAX_TIMER_DELAY_MS) {
      const current = deadlineState.schedules.find(item => item.taskId === schedule.taskId && item.eventId === schedule.eventId);
      if (current && deadlineState.enabled) armDeadlineTimer(current);
      return;
    }
    void showDeadlineNotification(schedule.taskId, schedule.eventId).catch(error => {
      logDesktop('Failed to show deadline notification', error);
    });
  }, delay);
  deadlineTimers.set(schedule.taskId, timer);
}

function refreshDeadlineTimers(notifyOverdue = true): void {
  clearDeadlineTimers();
  if (!deadlineState.enabled) return;
  for (const schedule of deadlineState.schedules) armDeadlineTimer(schedule, notifyOverdue);
}

async function reconcileDeadlineNotifications(rawSchedules: unknown): Promise<void> {
  if (!Array.isArray(rawSchedules)) throw new Error('Invalid deadline schedule snapshot.');
  if (rawSchedules.length > MAX_DEADLINE_SCHEDULES) throw new Error('Too many deadline schedules.');

  const previousByTask = new Map(deadlineState.schedules.map(schedule => [schedule.taskId, schedule]));
  const nextByTask = new Map<string, DeadlineNotificationSchedule>();
  for (const value of rawSchedules) {
    const schedule = parseDeadlineSchedule(value);
    if (!schedule) continue;
    const previous = previousByTask.get(schedule.taskId);
    const deliveredAt = deliveredDeadlineAt(schedule.eventId) ??
      (previous?.eventId === schedule.eventId ? previous.deliveredAt : undefined);
    if (deliveredAt) {
      schedule.deliveredAt = deliveredAt;
      recordDeadlineDelivered(schedule.eventId, deliveredAt);
    }
    nextByTask.set(schedule.taskId, schedule);
  }

  deadlineState.schedules = [...nextByTask.values()];
  await saveDeadlineNotificationState();
  refreshDeadlineTimers();
}

function deadlinePermissionStatus(): DeadlineNotificationPermission {
  if (!Notification.isSupported()) return 'unsupported';
  return deadlineState.enabled ? 'granted' : 'prompt';
}

function updateDeadlineLoginItem(enabled: boolean): void {
  if (!app.isPackaged || (process.platform !== 'win32' && process.platform !== 'darwin')) return;
  try {
    if (process.platform === 'win32') {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        path: process.execPath,
        args: enabled ? [BACKGROUND_START_ARGUMENT] : [],
      });
      return;
    }
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: enabled });
  } catch (error) {
    logDesktop('Failed to update deadline launch-at-login setting', error);
  }
}

function shouldStartInBackground(): boolean {
  if (!deadlineState.enabled) return false;
  if (process.argv.includes(BACKGROUND_START_ARGUMENT)) return true;
  if (process.platform !== 'darwin') return false;
  try {
    return app.getLoginItemSettings().wasOpenedAsHidden === true;
  } catch {
    return false;
  }
}

function destroyBackgroundTray(): void {
  backgroundTray?.destroy();
  backgroundTray = null;
}

function ensureBackgroundTray(): void {
  if (process.platform === 'darwin' || backgroundTray) return;
  backgroundTray = new Tray(path.join(rendererRoot(), 'favicon.ico'));
  backgroundTray.setToolTip('Splendide');
  backgroundTray.setContextMenu(Menu.buildFromTemplate([
    { label: 'open Splendide', click: () => focusMainWindow() },
    { type: 'separator' },
    {
      label: 'quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
  backgroundTray.on('click', () => focusMainWindow());
}

function stopBackgroundProcessIfIdle(): void {
  // Remaining alive while the user has opted into deadline alerts lets the
  // hidden renderer discover deadlines created by collaborators or another
  // device, even when there was no schedule at the moment the window closed.
  if (deadlineState.enabled || !backgroundTray) return;
  const windowIsHidden = mainWindow !== null && !mainWindow.isVisible();
  destroyBackgroundTray();
  if (windowIsHidden) {
    isQuitting = true;
    app.quit();
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

function rendererRoot(): string {
  return path.resolve(__dirname, '..', 'dist', 'splendide', 'browser');
}

function contentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  return types[ext] ?? 'application/octet-stream';
}

function isInsideRoot(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

async function fileResponse(filePath: string): Promise<Response> {
  const file = await fs.readFile(filePath);
  return new Response(file, {
    headers: protocolHeaders(contentType(filePath)),
  });
}

function protocolHeaders(type = 'text/plain; charset=utf-8'): Record<string, string> {
  return {
    'content-type': type,
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'x-content-type-options': 'nosniff',
  };
}

function textProtocolResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: protocolHeaders(),
  });
}

function shouldServeIndexFallback(request: Request, requestedPath: string): boolean {
  const accept = request.headers.get('accept') ?? '';
  return !path.extname(requestedPath) || accept.includes('text/html');
}

async function registerAppProtocol(): Promise<void> {
  const root = rendererRoot();
  const indexPath = path.join(root, 'index.html');

  protocol.handle(APP_PROTOCOL, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== APP_HOST) {
      return textProtocolResponse('Not found', 404);
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname || '/index.html');
    } catch {
      return textProtocolResponse('Bad request', 400);
    }

    const requested = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.resolve(root, `.${requested}`);

    if (!isInsideRoot(root, filePath)) {
      return textProtocolResponse('Not found', 404);
    }

    try {
      return await fileResponse(filePath);
    } catch {
      if (shouldServeIndexFallback(request, requested)) {
        try {
          return await fileResponse(indexPath);
        } catch (error) {
          logDesktop('Failed to serve SPA fallback', error);
        }
      }
      return textProtocolResponse('Not found', 404);
    }
  });
}

function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function isHttpsUrl(rawUrl: string): boolean {
  return parseUrl(rawUrl)?.protocol === 'https:';
}

function isAllowedRendererNavigation(rawUrl: string): boolean {
  const url = parseUrl(rawUrl);
  if (!url) return false;

  if (url.protocol === `${APP_PROTOCOL}:`) {
    return url.hostname === APP_HOST;
  }

  if (process.env['ELECTRON_START_URL'] && url.origin === DEV_SERVER_URL) {
    return true;
  }

  return false;
}

async function openHttpsExternal(rawUrl: string): Promise<void> {
  const url = parseUrl(rawUrl);
  if (!url || url.protocol !== 'https:') {
    throw new Error('Only HTTPS links can be opened externally.');
  }
  await shell.openExternal(url.toString());
}

function registerDeepLinkClient(): void {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(APP_PROTOCOL, process.execPath, [path.resolve(process.argv[1]!)]);
    return;
  }

  app.setAsDefaultProtocolClient(APP_PROTOCOL);
}

function base64Url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function randomUrlToken(bytes = 32): string {
  return base64Url(crypto.randomBytes(bytes));
}

function createCodeChallenge(codeVerifier: string): string {
  return base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
}

function focusMainWindow(): void {
  if (!mainWindow) holdMainWindow(createWindow());
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  destroyBackgroundTray();
}

function clearPendingGoogleAuth(): PendingGoogleAuth | null {
  const pending = pendingGoogleAuth;
  pendingGoogleAuth = null;
  if (pending) {
    clearTimeout(pending.timeout);
  }
  return pending;
}

function rejectPendingGoogleAuth(error: Error): void {
  const pending = clearPendingGoogleAuth();
  pending?.reject(error);
}

function completeGoogleAuthCallback(url: URL): boolean {
  const pending = pendingGoogleAuth;
  if (!pending) {
    logDesktop(`Ignored Google OAuth callback without a pending request: ${url.toString()}`);
    return true;
  }

  const state = url.searchParams.get('state');
  if (!state || state !== pending.state) {
    logDesktop('Ignored Google OAuth callback with invalid state');
    return true;
  }

  const error = url.searchParams.get('error');
  const errorDescription = url.searchParams.get('error_description');
  if (error) {
    rejectPendingGoogleAuth(new Error(errorDescription || error));
    focusMainWindow();
    return true;
  }

  const code = url.searchParams.get('code');
  if (!code) {
    rejectPendingGoogleAuth(new Error('Google did not return an authorization code.'));
    focusMainWindow();
    return true;
  }

  clearPendingGoogleAuth()?.resolve({
    code,
    codeVerifier: pending.codeVerifier,
    redirectUri: GOOGLE_AUTH_REDIRECT_URI,
  });
  focusMainWindow();
  return true;
}

function handleDeepLink(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol !== `${APP_PROTOCOL}:`) {
    return false;
  }

  if (url.hostname === GOOGLE_AUTH_HOST && url.pathname === GOOGLE_AUTH_CALLBACK_PATH) {
    return completeGoogleAuthCallback(url);
  }

  return false;
}

function findDeepLink(argv: string[]): string | undefined {
  return argv.find((value) => value.startsWith(`${APP_PROTOCOL}://`));
}

function validateGoogleClientId(clientId: string): string {
  const trimmed = clientId.trim();
  if (!/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(trimmed)) {
    throw new Error('Invalid Google client ID.');
  }
  return trimmed;
}

async function startGoogleOAuth(rawClientId: string): Promise<GoogleAuthResult> {
  const clientId = validateGoogleClientId(rawClientId);
  const state = randomUrlToken();
  const codeVerifier = randomUrlToken();
  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', GOOGLE_AUTH_REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', createCodeChallenge(codeVerifier));
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('prompt', 'select_account');

  if (pendingGoogleAuth) {
    rejectPendingGoogleAuth(new Error('A new Google sign-in was started.'));
  }

  return new Promise<GoogleAuthResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      rejectPendingGoogleAuth(new Error('Google sign-in timed out.'));
    }, GOOGLE_AUTH_TIMEOUT_MS);

    pendingGoogleAuth = {
      state,
      codeVerifier,
      timeout,
      resolve,
      reject,
    };

    shell.openExternal(authUrl.toString()).catch((error: unknown) => {
      rejectPendingGoogleAuth(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function createWindow(showWhenReady = true): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: 'Splendide',
    icon: path.join(rendererRoot(), 'icons', 'icon-256.png'),
    backgroundColor: '#fafafa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The renderer performs the authenticated deadline snapshot refresh.
      // Keep that short poll reliable while the opted-in app is hidden in the
      // tray; Chromium otherwise heavily throttles background timers.
      backgroundThrottling: false,
    },
  });

  if (showWhenReady) win.once('ready-to-show', () => win.show());

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logDesktop(`Renderer failed to load ${validatedURL}: ${errorCode} ${errorDescription}`);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    logDesktop(`Renderer process gone: ${details.reason}`);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpsUrl(url)) {
      void openHttpsExternal(url).catch((error) => logDesktop('Failed to open external window URL', error));
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedRendererNavigation(url)) {
      event.preventDefault();
      if (isHttpsUrl(url)) {
        void openHttpsExternal(url).catch((error) => logDesktop('Failed to open external navigation URL', error));
      }
    }
  });

  const devServerUrl = process.env['ELECTRON_START_URL'];
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadURL(`${APP_PROTOCOL}://${APP_HOST}/index.html`);
  }

  return win;
}

function registerIpc(): void {
  ipcMain.handle('open-external', async (_event, rawUrl: string) => {
    await openHttpsExternal(rawUrl);
  });

  ipcMain.handle('google-oauth-start', async (_event, clientId: string) => startGoogleOAuth(clientId));

  ipcMain.handle('notification-permission-status', () => deadlinePermissionStatus());
  ipcMain.handle('notification-request-permission', async () => {
    if (!Notification.isSupported()) return 'unsupported' satisfies DeadlineNotificationPermission;
    deadlineState.enabled = true;
    await saveDeadlineNotificationState();
    updateDeadlineLoginItem(true);
    refreshDeadlineTimers();
    return 'granted' satisfies DeadlineNotificationPermission;
  });
  ipcMain.handle('notification-reconcile-deadlines', async (_event, schedules: unknown) => {
    await reconcileDeadlineNotifications(schedules);
    stopBackgroundProcessIfIdle();
  });
  ipcMain.handle('notification-cancel-all-deadlines', async () => {
    deadlineState.enabled = false;
    deadlineState.schedules = [];
    clearDeadlineTimers();
    await saveDeadlineNotificationState();
    updateDeadlineLoginItem(false);
    stopBackgroundProcessIfIdle();
  });
}

app.setAppUserModelId('app.splendide.desktop');

process.on('uncaughtException', (error) => logDesktop('Uncaught exception', error));
process.on('unhandledRejection', (reason) => logDesktop('Unhandled rejection', reason));

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const deepLink = findDeepLink(argv);
    if (deepLink) {
      handleDeepLink(deepLink);
    }
    focusMainWindow();
  });
}

function holdMainWindow(win: BrowserWindow): void {
  mainWindow = win;
  mainWindow.on('close', event => {
    if (
      !isQuitting &&
      deadlineState.enabled
    ) {
      event.preventDefault();
      mainWindow?.hide();
      if (process.platform !== 'darwin') ensureBackgroundTray();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

if (gotSingleInstanceLock) {
  app.whenReady().then(async () => {
    try {
      await loadDeadlineNotificationState();
      refreshDeadlineTimers(false);
      updateDeadlineLoginItem(deadlineState.enabled);
      registerDeepLinkClient();
      registerIpc();
      await registerAppProtocol();
      const startInBackground = shouldStartInBackground();
      holdMainWindow(createWindow(!startInBackground));
      if (startInBackground && process.platform !== 'darwin') ensureBackgroundTray();

      const startupDeepLink = findDeepLink(process.argv);
      if (startupDeepLink) {
        handleDeepLink(startupDeepLink);
      }

      app.on('activate', () => {
        if (mainWindow) {
          focusMainWindow();
        } else if (BrowserWindow.getAllWindows().length === 0) {
          holdMainWindow(createWindow());
        }
      });
    } catch (error) {
      logDesktop('Startup failed', error);
      app.quit();
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  destroyBackgroundTray();
});
