// Purpose: Electron app lifecycle. Frameless Material window, single-instance
// lock, IPC wiring, local router server startup per settings, and clean
// shutdown flushing. No tray (deliberately skipped in foundation).
// Owned by Foundation Core lane.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';

// ESM modules have no __dirname; derive the main directory once.
const MAIN_DIR = path.dirname(fileURLToPath(import.meta.url));
import { JSONStore } from './store.js';
import { Vault, defaultVaultPath } from './vault.js';
import { ProvidersStore } from './providers-store.js';
import { LocalRouterServer } from './server.js';
import { attachIpc, registerBuiltinHandlers, broadcast } from './ipc.js';

const THEME_BACKGROUNDS = {
  light: '#FEF7FF',
  dark: '#141218',
  system: '#1B191E',
};

/** @type {JSONStore|null} */
let settingsStore = null;
/** @type {Vault|null} */
let vault = null;
/** @type {ProvidersStore|null} */
let providersStore = null;
/** @type {LocalRouterServer|null} */
let routerServer = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(bootstrap).catch((err) => {
    console.error('[material-router] fatal during bootstrap:', err);
    app.quit();
  });
}

async function bootstrap() {
  app.setAppUserModelId('com.dingdingprojects.materialrouter');
  app.setName('Material Router');

  settingsStore = new JSONStore(path.join(app.getPath('userData'), 'settings.json'), {
    defaults: defaultSettings(),
    debounceMs: 150,
  });
  vault = new Vault(defaultVaultPath(app.getPath('userData')));
  providersStore = new ProvidersStore(path.join(app.getPath('userData'), 'providers.json'));
  routerServer = new LocalRouterServer({
    providersStore,
    getSecret: (ref) => vault.getSecret(ref),
    settings: settingsStore,
  });

  attachIpc();
  registerBuiltinHandlers({ settingsStore, vault, providersStore, routerServer });

  // Feature-lane bridges self-register from app/main/bridges/*.js (see index.js).
  const { loadLaneBridges } = await import('./bridges/index.js');
  await loadLaneBridges({ settingsStore, vault, providersStore, routerServer, broadcast });

  createWindow();

  // Start the loopback router only when the setting allows it.
  const cfg = serverConfig();
  if (cfg.enabled) {
    try {
      await routerServer.start();
    } catch (err) {
      broadcast('toast', {
        kind: 'error',
        title: 'Local server failed to start',
        body: `${err.message} (port ${cfg.port})`,
      });
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

function createWindow() {
  const theme = String(settingsStore.get('appearance.theme', 'system'));
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: THEME_BACKGROUNDS[theme] || THEME_BACKGROUNDS.system,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(MAIN_DIR, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(MAIN_DIR, '..', 'renderer', 'index.html'));
  return win;
}

function serverConfig() {
  return {
    enabled: settingsStore.get('server.enabled', true),
    port: Number(settingsStore.get('server.port', 8787)),
  };
}

function defaultSettings() {
  return {
    schemaVersion: 1,
    general: {
      languageMode: 'en', // 'en' | 'zh' | 'bilingual'
      emojiInDialogs: false,
    },
    appearance: {
      theme: 'system', // 'light' | 'dark' | 'system'
    },
    server: {
      enabled: true,
      port: 8787,
      host: '127.0.0.1',
      corsEnabled: false,
      corsAllowOrigin: '*',
      authRequired: false,
      requestTimeoutMs: 120_000,
      maxBodyBytes: 10 * 1024 * 1024,
    },
    ui: {
      tabstrip: null,
      paletteFull: false,
    },
  };
}

app.on('window-all-closed', () => {
  // Windows-first product: closing the last window quits.
  app.quit();
});

app.on('before-quit', async () => {
  try {
    if (routerServer?.isRunning) await routerServer.stop();
  } catch { /* shutdown must proceed regardless */ }
  try {
    settingsStore?.flushSync();
  } catch (err) {
    console.error('[material-router] final settings flush failed:', err.message);
  }
});
