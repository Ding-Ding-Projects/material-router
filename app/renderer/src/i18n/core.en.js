// Purpose: English strings for every foundation shell surface. Flat keys,
// namespaced by prefix. Lanes add their own bundle files (ns.en.js / ns.zh.js)
// and register them via i18n.addBundle.
// Owned by Foundation Core lane.

export const en = {
  // common
  'common.ok': 'OK',
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.save': 'Save',
  'common.close': 'Close',
  'common.delete': 'Delete',
  'common.rename': 'Rename',
  'common.search': 'Search',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.exportJson': 'Export JSON',
  'common.exportMd': 'Export Markdown',
  'common.selectAll': 'Select all shown',
  'common.select': 'Select',
  'common.selected': 'selected',
  'common.pinned': 'Pinned',
  'common.tabs': 'Tabs',
  'common.ungrouped': 'Ungrouped',
  'common.errorTitle': 'Something went wrong',

  // titlebar
  'shell.appName': 'Material Router',
  'shell.minimize': 'Minimize',
  'shell.maximize': 'Maximize',
  'shell.closeWindow': 'Close window',
  'shell.notifications': 'Notifications',
  'shell.history': 'Local history',
  'shell.commandPalette': 'Command palette (Ctrl+Shift+F)',

  // tabs
  'tabs.pin': 'Pin tab',
  'tabs.unpin': 'Unpin tab',
  'tabs.renameTitle': 'Rename tab',
  'tabs.renameLabel': 'New name (empty restores the default)',
  'tabs.moveIntoGroup': 'Move into group',
  'tabs.filterGroups': 'Filter groups',
  'tabs.newGroup': 'New group',
  'tabs.newGroupTitle': 'New group',
  'tabs.groupNameLabel': 'Group name',
  'tabs.noMoveTargets': 'No other destination available.',
  'tabs.disbandGroup': 'Disband group (keep tabs)',
  'tabs.renameGroupTitle': 'Rename group',
  'tabs.editAppearance': 'Edit appearance…',
  'tabs.lockElement': 'Lock this element…',
  'tabs.closeOthers': 'Close others',
  'tabs.closeAll': 'Close all unpinned',
  'tabs.close': 'Close',
  'tabs.guardUnsaved': 'This tab has unsaved work. Close anyway?',

  // dock
  'dock.edge': 'Dock edge',
  'dock.left': 'Dock left',
  'dock.right': 'Dock right',
  'dock.top': 'Dock top',
  'dock.bottom': 'Dock bottom',

  // palette
  'palette.title': 'Command palette',
  'palette.placeholder': 'Type a command, setting, or page…',
  'palette.hint': '↑↓ navigate · Enter run · Esc close · Ctrl+Shift+F toggle',
  'palette.noResults': 'Nothing matches that search.',
  'palette.fullWindow': 'Full-window view',
  'palette.boundedView': 'Bounded card view',
  'palette.section.tabs': 'Tabs',
  'palette.section.settings': 'Settings',
  'palette.section.appearance': 'Appearance',
  'palette.section.docs': 'Docs',
  'palette.section.actions': 'Actions',

  // notifications
  'notif.searchPlaceholder': 'Search notifications…',
  'notif.empty': 'No notifications yet. When something happens, it lands here.',
  'notif.dismissSelected': 'Dismiss selected',
  'notif.clearAll': 'Clear all',
  'notif.clearConfirmTitle': 'Clear the notification history?',
  'notif.clearConfirmBody': 'This removes every stored notification from this device. It cannot be undone.',

  // history
  'history.panelTitle': 'History',
  'history.searchPlaceholder': 'Search history…',
  'history.empty': 'No history entries match.',
  'history.dateFrom': 'From date',
  'history.dateTo': 'To date',
  'history.restore': 'Restore selected',
  'history.restoredTitle': 'Restored',

  // settings
  'settings.title': 'Settings',
  'settings.searchPlaceholder': 'Search settings across every section…',
  'settings.noSections': 'No settings sections registered yet.',

  // about
  'about.version': 'Version',
  'about.pitch': 'Bring your own keys: one local, loopback-only router for OpenAI- and Anthropic-compatible clients.',
  'about.repo': 'Project repository on GitHub',
  'about.license': 'Released under the MIT license.',
  'about.thirdPartyNote': 'Third-party licenses are bundled with the installer and listed in the repository.',

  // dialogs
  'dialogs.continue': 'Continue',
  'dialogs.destructiveSecondTitle': 'Are you completely sure?',
  'dialogs.destructiveSecondBody': 'This is destructive and cannot be undone automatically. Confirm a second time to proceed.',
  'dialogs.destructiveConfirm': 'Yes, do it',

  // regex builder
  'regex.title': 'Regex builder',
  'regex.insertTokens': 'Insert tokens',
  'regex.anyDigit': 'digit \d',
  'regex.anyWord': 'word \w',
  'regex.anySpace': 'space \s',
  'regex.patternLabel': 'Regular expression pattern',
  'regex.flags': 'Flags',
  'regex.flagGlobal': 'global',
  'regex.flagIgnoreCase': 'ignore case',
  'regex.flagMultiline': 'multiline ^ $',
  'regex.flagDotAll': 'dot matches newline',
  'regex.flagUnicode': 'unicode',
  'regex.flagSticky': 'sticky',
  'regex.sample': 'Sample text',
  'regex.samplePlaceholder': 'Paste sample text to test against…',
  'regex.sampleTooBig': 'Sample truncated at the 64KB limit.',
  'regex.matches': 'Matches',
  'regex.errorPrefix': 'Invalid pattern:',
  'regex.engineNote': 'Engine: JavaScript RegExp',
  'regex.copyPattern': 'Copy pattern',
  'regex.copySnippet': 'Copy code snippet',
  'regex.apply': 'Apply',
  'regex.stepBudgetExceeded': 'Matching stopped after the step budget - this pattern may be pathological.',
  'regex.noMatches': 'No matches in the sample text.',
  'regex.moreMatches': '…and {count} more matches.',
  'regex.groupUnset': '(unset)',
  'regex.openBuilder': 'Open the regex builder',
  'search.toggleMode': 'Toggle plain-text / regex mode',

  // docs browser
  'docs.articleRegion': 'Article content',
  'docs.searchPlaceholder': 'Search articles (titles and full text)…',

  // placeholders
  'placeholder.generic': 'This surface is scaffolded and ready for its feature lane.',
  'placeholder.laneBuilder': 'Owned by the Builder lane - visual request building arrives with that lane.',
  'placeholder.laneServer': 'Owned by the Server lane - server controls and the live log stream arrive with that lane.',
  'placeholder.laneProviders': 'Owned by the Providers lane - provider, key and routing-rule editors arrive with that lane.',
  'placeholder.laneAppearance': 'Owned by the Appearance lane - per-element editors and presets arrive with that lane.',
  'placeholder.laneDelight': 'Owned by the Delight lane - modes, locks and the unlock ladder arrive with that lane.',
  'placeholder.laneUtility': 'Owned by the Utility lane - file converter and extended tools arrive with that lane.',
  'placeholder.laneAuthenticator': 'Owned by the Authenticator lane - TOTP entries and QR pairing arrive with that lane.',

  // tab labels
  'tabs.builder': 'API Builder',
  'tabs.providers': 'Providers & Keys',
  'tabs.server': 'Server & Logs',
  'tabs.docs': 'Docs',
  'tabs.appearance': 'Appearance',
  'tabs.delight': 'Modes & Delights',
  'tabs.utility': 'Toolbox',
  'tabs.authenticator': 'Authenticator',
  'tabs.settings': 'Settings',

  // server status bits used by stubs
  'server.statusRunning': 'Server running',
  'server.statusStopped': 'Server stopped',
  'providers.countProviders': 'providers',
  'providers.countRules': 'routing rules',
  'vault.osEncrypted': 'Secrets are protected by operating-system encryption.',
  'vault.obfuscatedFallback': 'OS encryption unavailable - secrets are only obfuscated locally.',

  // theme / language / actions for the palette
  'appearance.themeLight': 'Theme: light',
  'appearance.themeDark': 'Theme: dark',
  'appearance.themeSystem': 'Theme: follow system',
  'language.modeEn': 'Language: English',
  'language.modeZh': 'Language: 繁體中文（香港）',
  'language.modeBilingual': 'Language: bilingual',
  'actions.serverStart': 'Start the local server',
  'actions.serverStop': 'Stop the local server',
};
