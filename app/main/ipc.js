// Purpose: the IPC registry. Handlers register under a domain; the renderer
// invokes exactly one channel ('mr:invoke') with {channel, payload} and this
// module allowlists both the domain and the registered handler before dispatch.
// Foundation seam: every lane registers handlers here via registerHandler().
// Owned by Foundation Core lane.

import { ipcMain, dialog, shell, BrowserWindow, app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/** Domains pre-registered for later lanes; unknown domains are rejected. */
export const DOMAINS = Object.freeze([
  'settings',
  'vault',
  'server',
  'providers',
  'builder',
  'logs',
  'history',
  'notify',
  'dialog',
  'shell',
  'docs', // offline article browser (bundled docs/articles)
]);

const INVOKE_CHANNEL = 'mr:invoke';
const EVENT_CHANNEL = 'mr:event';
const handlers = new Map();

/**
 * Register a handler exposed to the renderer as invoke('domain:name', payload).
 * fn receives (payload, event). Return values are structured-clone-serialized;
 * throw to surface an error to the renderer.
 */
export function registerHandler(domain, name, fn) {
  if (!DOMAINS.includes(domain)) {
    throw new Error(`ipc: unknown domain "${domain}"`);
  }
  if (typeof fn !== 'function') {
    throw new Error(`ipc: handler for ${domain}:${name} must be a function`);
  }
  handlers.set(`${domain}:${name}`, fn);
}

export function hasHandler(channel) {
  return handlers.has(channel);
}

/**
 * Wire the single invoke channel plus event broadcasting. Call once at startup
 * before any window is created.
 */
export function attachIpc() {
  ipcMain.removeHandler(INVOKE_CHANNEL);
  ipcMain.handle(INVOKE_CHANNEL, async (event, channel, payload) => {
    if (typeof channel !== 'string' || !handlers.has(channel)) {
      throw new Error(`ipc: no handler for "${typeof channel === 'string' ? channel : '(non-string)'}"`);
    }
    const [domain] = channel.split(':');
    if (!DOMAINS.includes(domain)) throw new Error(`ipc: domain "${domain}" is not allowed`);
    try {
      return await handlers.get(channel)(payload ?? {}, event);
    } catch (err) {
      // Surface a clean error object; never leak internal stacks to the UI.
      const e = new Error(err?.message || 'internal error');
      e.code = err?.code || 'HANDLER_ERROR';
      throw e;
    }
  });
}

/**
 * Broadcast an event to every live window. Renderer subscribes via
 * materialRouter.on('log'|'toast'|'server-status'|'update-status', cb).
 */
export function broadcast(type, data) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(EVENT_CHANNEL, { type, data });
    }
  }
}

// ---------------------------------------------------------------------------
// Foundation-built-in handlers (later lanes add more)
// ---------------------------------------------------------------------------

export function registerBuiltinHandlers({ settingsStore, vault, providersStore, routerServer }) {
  // settings ---------------------------------------------------------------
  registerHandler('settings', 'get-all', () => settingsStore.getAll());
  registerHandler('settings', 'get', ({ key, fallback }) => settingsStore.get(String(key), fallback));
  registerHandler('settings', 'set', ({ key, value }) => {
    if (typeof key !== 'string') throw new Error('settings.set: key required');
    settingsStore.set(key, value);
    return true;
  });

  // vault --------------------------------------------------------------------
  registerHandler('vault', 'status', () => ({
    encryptionAvailable: vault.encryptionAvailable,
    obfuscationWarned: vault.obfuscationWarned,
    ids: vault.listIds(),
  }));
  registerHandler('vault', 'has', ({ id }) => Boolean(vault.has(String(id))));
  registerHandler('vault', 'set-secret', ({ id, value }) => vault.setSecret(String(id), String(value ?? '')));
  registerHandler('vault', 'delete-secret', ({ id }) => vault.deleteSecret(String(id)));

  // server -------------------------------------------------------------------
  const statusPayload = () => routerServer.getStatus();
  registerHandler('server', 'get-status', () => statusPayload());
  registerHandler('server', 'start', async () => {
    await routerServer.start();
    broadcast('server-status', statusPayload());
    return statusPayload();
  });
  registerHandler('server', 'stop', async () => {
    await routerServer.stop();
    broadcast('server-status', statusPayload());
    return statusPayload();
  });

  // providers ------------------------------------------------------------------
  const publicProvider = (p) => ({ ...p }); // keyRef id only; never a secret value
  registerHandler('providers', 'list', () => ({
    providers: providersStore.listProviders().map(publicProvider),
    rules: providersStore.listRules(),
  }));
  registerHandler('providers', 'save', ({ provider }) => {
    if (!provider || typeof provider !== 'object') throw new Error('providers.save: provider object required');
    if (provider.id && providersStore.getProvider(provider.id)) {
      return publicProvider(providersStore.updateProvider(provider.id, provider));
    }
    return publicProvider(providersStore.createProvider(provider));
  });
  registerHandler('providers', 'delete', ({ id }) => providersStore.deleteProvider(String(id)));
  registerHandler('providers', 'save-rule', ({ rule }) => {
    if (!rule || typeof rule !== 'object') throw new Error('providers.save-rule: rule object required');
    if (rule.id && providersStore.listRules().some((r) => r.id === rule.id)) {
      return providersStore.updateRule(rule.id, rule);
    }
    return providersStore.addRule(rule);
  });
  registerHandler('providers', 'delete-rule', ({ id }) => providersStore.deleteRule(String(id)));
  registerHandler('providers', 'refresh-models', async ({ id }) =>
    providersStore.refreshModels(String(id), (ref) => vault.getSecret(ref)));
  registerHandler('providers', 'get-models', ({ id }) => providersStore.getCachedModels(String(id)) || []);

  // builder ------------------------------------------------------------------
  // Builder lane replaces this descriptor with real request-building state.
  registerHandler('builder', 'schema', () => ({
    version: 1,
    inboundFormats: ['openai', 'anthropic'],
    endpoints: ['/v1/chat/completions', '/v1/messages'],
    note: 'Foundation seam only - Builder lane owns real builder state.',
  }));

  // logs -----------------------------------------------------------------------
  /** @type {Array<object>} ring buffer of structured log events */
  const logRing = [];
  const LOG_RING_MAX = 2000;
  registerHandler('logs', 'query', ({ limit = 200 } = {}) => logRing.slice(-Math.max(1, Math.min(limit, LOG_RING_MAX))));
  registerHandler('logs', 'clear', () => { logRing.length = 0; return true; });

  routerServer.on('log', (event) => {
    logRing.push(event);
    if (logRing.length > LOG_RING_MAX) logRing.splice(0, logRing.length - LOG_RING_MAX);
    broadcast('log', event);
  });

  // history ---------------------------------------------------------------------
  // The journal itself lives renderer-side in foundation; this domain exists so
  // main-originated history events have an allowed channel from day one.
  registerHandler('history', 'list', () => []);

  // notify ------------------------------------------------------------------------
  registerHandler('notify', 'show', (payload) => {
    broadcast('toast', payload ?? {});
    return true;
  });

  // dialog --------------------------------------------------------------------------
  registerHandler('dialog', 'file-open', async ({ title, filters, multi } = {}, event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: typeof title === 'string' ? title : 'Open file',
      properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: Array.isArray(filters) ? filters : undefined,
    });
    return result.canceled ? null : result.filePaths;
  });

  // shell ------------------------------------------------------------------------------
  registerHandler('shell', 'open-external', async ({ url }) => {
    const u = new URL(String(url));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      throw new Error('only http(s) URLs can be opened externally');
    }
    await shell.openExternal(u.toString());
    return true;
  });
  registerHandler('shell', 'window-control', ({ action } = {}, event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    switch (String(action)) {
      case 'minimize': win.minimize(); break;
      case 'maximize': win.isMaximized() ? win.unmaximize() : win.maximize(); break;
      case 'close': win.close(); break;
      default: throw new Error(`unknown window action "${action}"`);
    }
    return true;
  });
  registerHandler('shell', 'set-background-color', ({ color } = {}, event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) {
      win.setBackgroundColor(color);
    }
    return true;
  });
  registerHandler('shell', 'app-info', async () => {
    const { app: electronApp } = await import('electron');
    return {
      name: 'Material Router',
      version: electronApp.getVersion(),
      platform: process.platform,
      userDataPath: electronApp.getPath('userData'),
    };
  });

  // docs -----------------------------------------------------------------------
  // The offline article browser reads its bundled manifest + articles through
  // here (file:// fetch is CORS-blocked in the sandboxed renderer).
  let articlesDirCache = null;
  function articlesDir() {
    if (articlesDirCache) return articlesDirCache;
    const packaged = path.join(process.resourcesPath ?? '', 'articles');
    if (fs.existsSync(packaged)) {
      articlesDirCache = packaged;
      return packaged;
    }
    articlesDirCache = path.join(app.getAppPath(), 'docs', 'articles');
    return articlesDirCache;
  }

  function readManifest() {
    try {
      return JSON.parse(fs.readFileSync(path.join(articlesDir(), 'index.json'), 'utf8'));
    } catch {
      return { generatedAt: null, count: 0, articles: [] };
    }
  }

  function resolveArticleFile(idOrFile) {
    const dir = articlesDir();
    const safe = String(idOrFile).replace(/[\\/]/g, '');
    for (const candidate of [safe, `${safe}.md`]) {
      const full = path.join(dir, candidate);
      if (path.dirname(full) === dir && fs.existsSync(full)) return full;
    }
    return null;
  }

  registerHandler('docs', 'list-articles', () => readManifest());
  registerHandler('docs', 'read-article', ({ id } = {}) => {
    const full = resolveArticleFile(id);
    if (!full) throw new Error(`article "${id}" not found`);
    const content = fs.readFileSync(full, 'utf8');
    const titleMatch = /^#\s+(.+)$/m.exec(content);
    return { id: String(id), title: titleMatch ? titleMatch[1] : String(id), content };
  });

  void hasHandler; // kept exported for lane-side assertions
}
