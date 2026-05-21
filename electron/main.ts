import { app, BrowserWindow, ipcMain, protocol, shell } from 'electron';
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

let pendingGoogleAuth: PendingGoogleAuth | null = null;

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
    headers: { 'content-type': contentType(filePath) },
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
      return new Response('Not found', { status: 404 });
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname || '/index.html');
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    const requested = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.resolve(root, `.${requested}`);

    if (!isInsideRoot(root, filePath)) {
      return new Response('Not found', { status: 404 });
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
      return new Response('Not found', { status: 404 });
    }
  });
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
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
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

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: 'Splendide',
    backgroundColor: '#fafafa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logDesktop(`Renderer failed to load ${validatedURL}: ${errorCode} ${errorDescription}`);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    logDesktop(`Renderer process gone: ${details.reason}`);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const isAppUrl = url.startsWith(`${APP_PROTOCOL}://${APP_HOST}`) || url.startsWith('http://localhost:4201');
    if (!isAppUrl) {
      event.preventDefault();
      if (url.startsWith('https://') || url.startsWith('http://')) {
        void shell.openExternal(url);
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
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') {
      throw new Error('Only HTTPS links can be opened externally.');
    }
    await shell.openExternal(url.toString());
  });

  ipcMain.handle('google-oauth-start', async (_event, clientId: string) => startGoogleOAuth(clientId));
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
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

if (gotSingleInstanceLock) {
  app.whenReady().then(async () => {
    try {
      registerDeepLinkClient();
      registerIpc();
      await registerAppProtocol();
      holdMainWindow(createWindow());

      const startupDeepLink = findDeepLink(process.argv);
      if (startupDeepLink) {
        handleDeepLink(startupDeepLink);
      }

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
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
