import { app, BrowserWindow, dialog, Menu, nativeImage, session, Tray } from 'electron';
import path from 'node:path';
import type { MvpPublisher } from './mvp.js';
import { managementCookieName } from './management-access.js';

let publisher: MvpPublisher | undefined;
let tray: Tray | undefined;
let window: BrowserWindow | undefined;
let quitRequested = false;

function createTrayIcon(): Electron.NativeImage {
  const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'build', 'icon.png'));
  if (icon.isEmpty()) throw new Error('Could not create the AACpipe tray icon');
  return icon;
}

function managementUrl(): string {
  return `http://127.0.0.1:${String(publisher?.port ?? 0)}/manage`;
}

// Return to the pairing list, leaving any error or confirmation page behind.
function loadManagementPage(): void {
  void window?.loadURL(managementUrl()).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox('AACpipe management page failed to load', message);
  });
}

function onManagementPage(): boolean {
  const current = window?.webContents.getURL();
  if (current === undefined || current === '') return false;
  try {
    const url = new URL(current);
    return url.origin === new URL(managementUrl()).origin && url.pathname === '/manage';
  } catch {
    return false;
  }
}

function openManagementWindow(): void {
  if (publisher === undefined) return;
  if (window !== undefined) {
    if (!onManagementPage()) loadManagementPage();
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 920,
    height: 760,
    minWidth: 600,
    minHeight: 480,
    title: 'AACpipe partner pairing',
    autoHideMenuBar: true,
    icon: createTrayIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, destination) => {
    const target = new URL(destination);
    const management = new URL(managementUrl());
    if (target.origin !== management.origin || !target.pathname.startsWith('/manage')) {
      event.preventDefault();
      void dialog.showMessageBox({
        type: 'info',
        title: 'Open this link on the partner device',
        message:
          'Scan the QR code with the partner device, or use Copy link. Pairing links are private.',
      });
    }
  });
  window.on('close', (event) => {
    if (!quitRequested) {
      event.preventDefault();
      window?.hide();
    }
  });
  window.on('closed', () => {
    window = undefined;
  });
  loadManagementPage();
}

function hideManagementWindow(): void {
  window?.hide();
}

function showPairingChanges(change: 'paired' | 'changed'): void {
  if (change === 'paired') {
    if (window === undefined) {
      openManagementWindow();
      return;
    }
    window.show();
    window.focus();
  }
  // Reloading a POST result page would resubmit it, so always load the pairing list.
  if (onManagementPage()) {
    window?.webContents.reloadIgnoringCache();
  } else {
    loadManagementPage();
  }
}

function createOneTimePairing(): void {
  void publisher?.createOneTimePairing().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox('AACpipe could not create a one-time pairing', message);
  });
}

async function startApplication(): Promise<void> {
  process.env['AACPIPE_APP_ROOT'] = app.getAppPath();
  process.env['AACPIPE_NATIVE_MODULE'] = path.join(
    app.getAppPath(),
    'dist',
    'apps',
    'publisher',
    'native',
    'aacpipe_win32_native.node',
  );
  const { startMvp } = await import('./mvp.js');
  publisher = await startMvp((error) => {
    dialog.showErrorBox('AACpipe Publisher stopped', error.message);
    app.quit();
  });
  if (publisher === undefined) {
    app.quit();
    return;
  }
  await session.defaultSession.cookies.set({
    url: managementUrl(),
    name: managementCookieName,
    value: publisher.managementAccess,
    path: '/manage',
    httpOnly: true,
    sameSite: 'strict',
  });
  publisher.onChannelsChanged(showPairingChanges);
  publisher.onWindowRequest((request) => {
    if (request === 'show') openManagementWindow();
    else hideManagementWindow();
  });

  tray = new Tray(createTrayIcon());
  tray.setToolTip('AACpipe Publisher');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open partner pairing', click: openManagementWindow },
      { label: 'New one-time pairing', click: createOneTimePairing },
      {
        label: 'About AACpipe',
        click: () => {
          void dialog.showMessageBox({
            type: 'info',
            title: 'About AACpipe',
            message: `AACpipe ${app.getVersion()} (experimental preview)`,
            detail:
              'Simon Judge | MIT licence\nAn additional AAC partner display for trusted local networks.\nUnsigned preview; not a replacement for normal AAC speech or communication.',
          });
        },
      },
      { type: 'separator' },
      { label: 'Quit AACpipe', click: () => app.quit() },
    ]),
  );
  tray.on('double-click', openManagementWindow);
  // The bridge passes --hidden when it starts AACpipe for a Grid content command.
  if (!process.argv.includes('--hidden')) openManagementWindow();
}

const ownsApplicationLock = app.requestSingleInstanceLock();
if (!ownsApplicationLock) {
  app.quit();
} else {
  app.on('second-instance', openManagementWindow);
  app.on('before-quit', (event) => {
    if (quitRequested || publisher === undefined) return;
    event.preventDefault();
    quitRequested = true;
    void publisher
      .close()
      .then(() => {
        tray?.destroy();
        tray = undefined;
        app.quit();
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        dialog.showErrorBox('AACpipe Publisher shutdown failed', message);
        app.exit(1);
      });
  });
  void app
    .whenReady()
    .then(startApplication)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox('AACpipe Publisher failed to start', message);
      app.quit();
    });
}
