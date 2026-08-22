// Purpose: Traditional Chinese (Hong Kong colloquial) strings mirroring
// core.en.js key-for-key. Voice is local and friendly; facts stay exact.
// Owned by Foundation Core lane.

export const zh = {
  // common
  'common.ok': '好',
  'common.cancel': '取消',
  'common.confirm': '確認',
  'common.save': '儲存',
  'common.close': '閂咗佢',
  'common.delete': '刪除',
  'common.rename': '改名',
  'common.search': '搜尋',
  'common.copy': '複製',
  'common.copied': '複製咗喇',
  'common.exportJson': '匯出 JSON',
  'common.exportMd': '匯出 Markdown',
  'common.selectAll': '揀晒顯示緊嘅',
  'common.select': '揀',
  'common.selected': '已揀',
  'common.pinned': '釘選',
  'common.tabs': '分頁',
  'common.ungrouped': '未入組',
  'common.errorTitle': '哎呀，有啲問題',

  // titlebar
  'shell.appName': 'Material Router',
  'shell.minimize': '縮到最小',
  'shell.maximize': '放到最大',
  'shell.closeWindow': '閂視窗',
  'shell.notifications': '通知',
  'shell.history': '本地歷史',
  'shell.commandPalette': '指令面板（Ctrl+Shift+F）',

  // tabs
  'tabs.pin': '釘住個分頁',
  'tabs.unpin': '拔返個釘',
  'tabs.renameTitle': '分頁改名',
  'tabs.renameLabel': '新名（留空就返預設）',
  'tabs.moveIntoGroup': '搬入組別',
  'tabs.filterGroups': '篩選組別',
  'tabs.newGroup': '開新組',
  'tabs.newGroupTitle': '開新組',
  'tabs.groupNameLabel': '組名',
  'tabs.noMoveTargets': '冇其他目的地揀喇。',
  'tabs.disbandGroup': '解散組別（分頁留低）',
  'tabs.renameGroupTitle': '組別改名',
  'tabs.editAppearance': '編輯外觀…',
  'tabs.lockElement': '鎖上呢個元素…',
  'tabs.closeOthers': '閂其他',
  'tabs.closeAll': '閂晒未釘嘅',
  'tabs.close': '閂',
  'tabs.guardUnsaved': '呢個分頁有未儲存嘅嘢，照樣閂？',

  // dock
  'dock.edge': '停泊邊邊',
  'dock.left': '泊左邊',
  'dock.right': '泊右邊',
  'dock.top': '泊頂部',
  'dock.bottom': '泊底部',

  // palette
  'palette.title': '指令面板',
  'palette.placeholder': '打指令、設定或者頁面名…',
  'palette.hint': '↑↓ 揀 · Enter 行 · Esc 閂 · Ctrl+Shift+F 開關',
  'palette.noResults': '搵唔到相符嘅嘢。',
  'palette.fullWindow': '成個窗咁大',
  'palette.boundedView': '細卡模式',
  'palette.section.tabs': '分頁',
  'palette.section.settings': '設定',
  'palette.section.appearance': '外觀',
  'palette.section.docs': '說明文件',
  'palette.section.actions': '動作',

  // notifications
  'notif.searchPlaceholder': '搜尋通知…',
  'notif.empty': '暫時冇通知。有嘢發生就會喺度出現。',
  'notif.dismissSelected': '清除已揀',
  'notif.clearAll': '全部清走',
  'notif.clearConfirmTitle': '清走成個通知歷史？',
  'notif.clearConfirmBody': '呢個動作會刪走呢部機上面所有儲存嘅通知，做咗就返唔到轉頭。',

  // history
  'history.panelTitle': '歷史',
  'history.searchPlaceholder': '搜尋歷史…',
  'history.empty': '冇相符嘅歷史紀錄。',
  'history.dateFrom': '開始日期',
  'history.dateTo': '結束日期',
  'history.restore': '還原已揀',
  'history.restoredTitle': '還原咗',

  // settings
  'settings.title': '設定',
  'settings.searchPlaceholder': '跨所有分節搜尋設定…',
  'settings.noSections': '仲未有設定分節登記。',

  // about
  'about.version': '版本',
  'about.pitch': '自帶金鑰：一個淨係綁定本機 loopback 嘅路由器，OpenAI 同 Anthropic 相容客戶端都用得。',
  'about.repo': '喺 GitHub 睇專案儲存庫',
  'about.license': '以 MIT 授權發布。',
  'about.thirdPartyNote': '第三方授權清單隨安裝包附上，亦喺儲存庫入面。',

  // dialogs
  'dialogs.continue': '繼續',
  'dialogs.destructiveSecondTitle': '真係徹底肯定？',
  'dialogs.destructiveSecondBody': '呢個動作係破壞性嘅，做咗冇得自動返轉頭。要再確認多次先至行。',
  'dialogs.destructiveConfirm': '係，照做',

  // regex builder
  'regex.title': '正則表達式建造器',
  'regex.insertTokens': '插入符號',
  'regex.anyDigit': '數字 \d',
  'regex.anyWord': '文字 \w',
  'regex.anySpace': '空白 \s',
  'regex.patternLabel': '正則表達式',
  'regex.flags': '旗標',
  'regex.flagGlobal': '全域',
  'regex.flagIgnoreCase': '忽略大小寫',
  'regex.flagMultiline': '多行 ^ $',
  'regex.flagDotAll': '句點包括換行',
  'regex.flagUnicode': 'Unicode',
  'regex.flagSticky': '黏性',
  'regex.sample': '測試文字',
  'regex.samplePlaceholder': '貼啲文字落嚟試下…',
  'regex.sampleTooBig': '測試文字喺 64KB 上限截斷咗。',
  'regex.matches': '相符結果',
  'regex.errorPrefix': '無效表達式：',
  'regex.engineNote': '引擎：JavaScript RegExp',
  'regex.copyPattern': '複製表達式',
  'regex.copySnippet': '複製程式碼片段',
  'regex.apply': '套用',
  'regex.stepBudgetExceeded': '超過運算預算，停止配對——呢條表達式可能有回溯炸彈。',
  'regex.noMatches': '測試文字入面搵唔到相符。',
  'regex.moreMatches': '…仲有 {count} 個相符。',
  'regex.groupUnset': '（未有）',
  'regex.openBuilder': '開啟正則建造器',
  'search.toggleMode': '切換純文字／正則模式',

  // docs browser
  'docs.articleRegion': '文章內容',
  'docs.searchPlaceholder': '搜尋文章（標題加全文）…',

  // placeholders
  'placeholder.generic': '呢個版面已經起好骨架，等緊所屬嘅功能組別入伙。',
  'placeholder.laneBuilder': '由 Builder 組別負責——視覺化請求建造會同嗰組一齊到。',
  'placeholder.laneServer': '由 Server 組別負責——伺服器控制同即時日誌會同嗰組一齊到。',
  'placeholder.laneProviders': '由 Providers 組別負責——供應商、金鑰同路由規則編輯器會同嗰組一齊到。',
  'placeholder.laneAppearance': '由 Appearance 組別負責——逐元素編輯器同預設會同嗰組一齊到。',
  'placeholder.laneDelight': '由 Delight 組別負責——模式、鎖同解鎖梯會同嗰組一齊到。',
  'placeholder.laneUtility': '由 Utility 組別負責——檔案轉換器同延伸工具會同嗰組一齊到。',
  'placeholder.laneAuthenticator': '由 Authenticator 組別負責——TOTP 條目同 QR 配對會同嗰組一齊到。',

  // tab labels
  'tabs.builder': 'API 建造器',
  'tabs.providers': '供應商同金鑰',
  'tabs.server': '伺服器同日誌',
  'tabs.docs': '說明文件',
  'tabs.appearance': '外觀',
  'tabs.delight': '模式與趣味',
  'tabs.utility': '工具箱',
  'tabs.authenticator': '驗證器',
  'tabs.settings': '設定',

  // server status bits used by stubs
  'server.statusRunning': '伺服器行緊',
  'server.statusStopped': '伺服器停咗',
  'providers.countProviders': '個供應商',
  'providers.countRules': '條路由規則',
  'vault.osEncrypted': '機密由作業系統層級加密保護緊。',
  'vault.obfuscatedFallback': '作業系統加密用唔到——機密只係本地混淆處理。',

  // theme / language / actions for the palette
  'appearance.themeLight': '主題：淺色',
  'appearance.themeDark': '主題：深色',
  'appearance.themeSystem': '主題：跟系統',
  'language.modeEn': '語言：English',
  'language.modeZh': '語言：繁體中文（香港）',
  'language.modeBilingual': '語言：雙語',
  'actions.serverStart': '啟動本地伺服器',
  'actions.serverStop': '停止本地伺服器',
};
