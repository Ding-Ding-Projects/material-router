/* Page registry: one list drives the tab strip, the command palette, and the
   docs hub. ids are stable; hrefs are file names relative to site root. */

export const PAGES = [
  { id: 'home', href: 'index.html', labelKey: 'nav.home', labelZh: '主頁' },
  { id: 'docs', href: 'docs.html', labelKey: 'nav.docs', labelZh: '文檔' },
  { id: 'routing', href: 'articles/routing.html', labelKey: 'nav.routing', labelZh: '路由' },
  { id: 'builder', href: 'articles/builder.html', labelKey: 'nav.builder', labelZh: '請求產生器' },
  { id: 'providers', href: 'articles/providers.html', labelKey: 'nav.providers', labelZh: '供應商' },
  { id: 'modes', href: 'articles/modes.html', labelKey: 'nav.modes', labelZh: '語言模式' },
  { id: 'appearance', href: 'articles/appearance.html', labelKey: 'nav.appearance', labelZh: '外觀' },
  { id: 'toolbox', href: 'articles/toolbox.html', labelKey: 'nav.toolbox', labelZh: '工具箱' },
  { id: 'authenticator', href: 'articles/authenticator.html', labelKey: 'nav.authenticator', labelZh: '驗證器' },
  { id: 'platform', href: 'articles/platform.html', labelKey: 'nav.platform', labelZh: '平台' },
  { id: 'changelog', href: 'changelog.html', labelKey: 'nav.changelog', labelZh: '更新日誌' },
  { id: 'settings', href: 'settings.html', labelKey: 'nav.settings', labelZh: '設定' },
  { id: 'about', href: 'about.html', labelKey: 'nav.about', labelZh: '關於' },
];
