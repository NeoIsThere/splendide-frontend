import { app, BrowserWindow, ipcMain, protocol, shell } from 'electron';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const APP_PROTOCOL = 'splendide';
const APP_HOST = 'app';
let mainWindow: BrowserWindow | null = null;

function logDesktop(message: string, error?: unknown): void {
  try {
    const details = error instanceof Error ? ` ${error.stack ?? error.message}` : error ? ` ${String(error)}` : '';
    const logDir = path.join(process.env['APPDATA'] ?? process.cwd(), 'Splendide');
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

async function registerAppProtocol(): Promise<void> {
  const root = rendererRoot();

  protocol.handle(APP_PROTOCOL, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== APP_HOST) {
      return new Response('Not found', { status: 404 });
    }

    const pathname = decodeURIComponent(url.pathname || '/index.html');
    const requested = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.resolve(root, `.${requested}`);

    if (!filePath.startsWith(root)) {
      return new Response('Not found', { status: 404 });
    }

    try {
      const file = await fs.readFile(filePath);
      return new Response(file, {
        headers: { 'content-type': contentType(filePath) },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
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
}

app.setAppUserModelId('app.splendide.desktop');

process.on('uncaughtException', (error) => logDesktop('Uncaught exception', error));
process.on('unhandledRejection', (reason) => logDesktop('Unhandled rejection', reason));

function holdMainWindow(win: BrowserWindow): void {
  mainWindow = win;
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    registerIpc();
    await registerAppProtocol();
    holdMainWindow(createWindow());

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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
