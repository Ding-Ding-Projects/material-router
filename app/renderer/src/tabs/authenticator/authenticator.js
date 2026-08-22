// Purpose: Authenticator tab - PLACEHOLDER (the encrypted vault and scrypt
// lock hashing already exist in main/vault.js; TOTP entries + QR pairing UI
// land here).
// Owned by Authenticator lane - replace contents freely; keep the registerTab
// call and the exported tab id ('authenticator') stable.

import { h } from '../../core/util.js';
import { t } from '../../core/i18n.js';
import { registerTab, iconFromPath } from '../registry.js';
import { invoke } from '../../core/bridge.js';

function render(container) {
  const vaultLine = h('p', { class: 'mr-typography-body-medium', style: 'color:var(--md-sys-color-on-surface-variant)' }, '');
  invoke('vault:status').then((s) => {
    vaultLine.textContent = s.encryptionAvailable
      ? t('vault.osEncrypted')
      : t('vault.obfuscatedFallback');
  }).catch(() => {});

  container.append(
    h('div', { class: 'mr-placeholder' },
      h('h1', { class: 'mr-typography-headline-small' }, t('tabs.authenticator')),
      vaultLine,
      h('div', { class: 'lane-note' }, t('placeholder.laneAuthenticator')),
    ),
  );
}

registerTab({
  id: 'authenticator',
  label: { en: 'Authenticator', zh: '驗證器' },
  get icon() { return iconFromPath('M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4Zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8Z'); },
  init: render,
});
