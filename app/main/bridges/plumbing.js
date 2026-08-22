// Plumbing lane bridge: auto-updater IPC surface.
//
// Registered handlers (renderer calls via invoke):
//   shell:updater-status  -> current updater status snapshot
//   shell:updater-check   -> manual check-for-updates now
//   shell:updater-cancel  -> cancel an in-flight download / staging
//   shell:updater-install -> spawn the staged unsigned installer and exit
//
// Seam note: ipc.js owns the DOMAINS allowlist and is another lane's file, so
// these handlers live under the existing app-level 'shell' domain rather than
// a dedicated 'updater' domain. Channel names stay stable like every other
// seam; progress and state changes travel on the pre-existing 'update-status'
// broadcast event.

import { registerHandler } from '../ipc.js';
import { AutoUpdater } from '../updater.js';

/** Single shared instance; register() runs exactly once at startup. */
let updater = null;

export function getUpdater() {
  return updater;
}

export function register(ctx) {
  const { settingsStore, broadcast } = ctx;
  if (!settingsStore) throw new Error('plumbing bridge: settingsStore required');
  if (typeof broadcast !== 'function') throw new Error('plumbing bridge: broadcast required');

  updater = new AutoUpdater({ settingsStore, broadcast });

  registerHandler('shell', 'updater-status', () => updater.getStatus());

  registerHandler('shell', 'updater-check', async () => updater.checkNow({ manual: true }));

  registerHandler('shell', 'updater-cancel', () => updater.cancelDownload());

  registerHandler('shell', 'updater-install', () => {
    const ok = updater.install();
    if (!ok) throw new Error(updater.getStatus().error ?? 'no staged update is ready to install');
    return true;
  });

  // The first network check is deliberately delayed inside start(), after
  // windows exist to receive its broadcasts.
  updater.start();
}
