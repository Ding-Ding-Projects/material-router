// Purpose: Traditional Chinese (Hong Kong colloquial) strings mirroring
// i18n.en.js key-for-key. Facts (algorithm names, digit counts, periods) stay
// exact; only the surrounding voice is local and friendly.
// Owned by the Authenticator lane.

export const zh = {
  // header
  'auth.subtitle': '本機時間動態密碼。密鑰全部鎖喺加密保險庫入面。',
  'auth.vaultOk': '保險庫加密生效中',
  'auth.vaultFallback': '系統加密用唔到，改咗用混淆方式暫存密鑰',
  'auth.entries': '個項目',
  'auth.entry': '個項目',

  // empty state
  'auth.emptyTitle': '仲未有項目',
  'auth.emptyBody': '貼上服務畀你嗰條 otpauth:// 連結，或者人手輸入 base32 密鑰，就加到第一個項目喇。',

  // add menu
  'auth.add': '新增項目',
  'auth.addUri': '貼上 otpauth:// 連結',
  'auth.addManual': '人手輸入密鑰',
  'auth.importList': '一次過匯入多條連結',

  // search / list
  'auth.searchPlaceholder': '搜尋項目…',
  'auth.selectAllShown': '揀晒顯示緊嘅',
  'auth.invertSelection': '反轉揀選',
  'auth.clearSelection': '清除揀選',
  'auth.selectedCount': '已揀 {n} 個',
  'auth.deleteSelected': '刪除已揀項目…',
  'auth.groupSelected': '將已揀項目移去群組…',

  // row
  'auth.unconfirmedBadge': '未確認配對',
  'auth.confirmShort': '確認',
  'auth.copyCode': '複製目前密碼',
  'auth.codeCopied': '密碼複製咗',
  'auth.peek': '睇下一組密碼',
  'auth.hidePeek': '收起下一組密碼',
  'auth.nextLabel': '下一組：',
  'auth.secondsLeft': '{s} 秒後更新',
  'auth.codesRotated': '動態密碼已經更新',
  'auth.hotpCounter': '計數器 {n}',
  'auth.rowMenu': '項目動作',
  'auth.reveal': '顯示 QR code 同密鑰',
  'auth.edit': '編輯',
  'auth.remove': '刪除',
  'auth.moveUp': '向上移',
  'auth.moveDown': '向下移',
  'auth.incrementCounter': '推進計數器',
  'auth.verifyLive': '核對一組密碼',
  'auth.dragHandle': '拖曳排序（Alt 加方向鍵都得）',

  // group headers
  'auth.noGroup': '未入組',
  'auth.toggleGroup': '展開或者收起群組',

  // add-by-uri dialog
  'auth.uriTitle': '貼上 otpauth:// 連結',
  'auth.uriField': 'otpauth:// 連結',
  'auth.uriPlaceholder': 'otpauth://totp/Example:alice@example.com?secret=…',
  'auth.parse': '讀取連結',
  'auth.parseBad': '呢條連結讀唔到',

  // manual dialog
  'auth.manualTitle': '新項目資料',
  'auth.type': '種類',
  'auth.typeTotp': '時間制（TOTP）',
  'auth.typeHotp': '計數器制（HOTP）',
  'auth.secret': '密鑰（base32）',
  'auth.secretPlaceholder': '貼上 base32 密鑰，例如 JBSW Y3DP EHPK 3PXP',
  'auth.secretHint': '空格同橫線會自動忽略。建議起碼 80 bit（16 個字符）。',
  'auth.generate': '幫我生成年新密鑰',
  'auth.issuer': '服務名稱（issuer）',
  'auth.account': '帳戶名稱',
  'auth.algorithm': '演算法',
  'auth.digits': '位數',
  'auth.digitsUnit': '位',
  'auth.period': '更新週期',
  'auth.periodUnit': '秒',
  'auth.counter': '起始計數器',

  // edit dialog
  'auth.editTitle': '編輯項目',
  'auth.icon': '圖示（一個 emoji）',
  'auth.group': '群組',
  'auth.groupPlaceholder': '例如 工作、私人',
  'auth.cryptoWarning': '改動演算法、位數或者週期會令之前確認咗嘅配對失效，之後要重新輸入一次新密碼確認。',

  // pairing / confirm
  'auth.pairTitle': '確認配對',
  'auth.pairIntro': '用你部驗證器掃描呢個 QR code，或者撳「顯示密鑰」人手輸入。跟住喺下面填入佢而家顯示嘅密碼，核實先算完成。',
  'auth.revealKey': '顯示密鑰',
  'auth.hideKey': '收起密鑰',
  'auth.keyCopy': '複製密鑰',
  'auth.params': '{algo} · {digits} 位 · 每 {period} 秒一轉',
  'auth.paramsHotp': 'HOTP · {digits} 位 · 計數器由 {counter} 開始',
  'auth.confirmField': '裝置目前顯示嘅密碼',
  'auth.confirmBtn': '核實並儲存',
  'auth.confirmExisting': '核實並確認配對',
  'auth.wrongCode': '密碼對唔上，咩都冇改到。',
  'auth.paired': '配對成功，已經儲存',
  'auth.qrAlt': '{name} 嘅配對 QR code',

  // deletion
  'auth.deleteOneTitle': '刪除呢個項目？',
  'auth.deleteOneBody': '「{name}」同佢存放嘅密鑰會由保險庫移除，做咗就返唔到轉頭，日誌都救唔返。',
  'auth.deleteManyTitle': '刪除 {n} 個項目？',
  'auth.deleteManyBody': '{n} 個項目連同佢哋存放嘅密鑰會由保險庫移除，做咗就返唔到轉頭。',
  'auth.deleteConfirm': '確定刪除',

  // exports
  'auth.exportMenu': '匯出',
  'auth.exportRedacted': '只匯出資料（唔包密鑰）',
  'auth.exportFull': '連密鑰一齊匯出（明文！）',
  'auth.redactedNote': '呢個檔案只有項目資料；密鑰係刻意唔包落去嘅。',
  'auth.fullGateTitle': '匯出可讀密鑰？',
  'auth.fullGateBody': '匯出檔會以明文寫低所有密鑰，任何人攞到個檔案都可以生產你嘅動態密碼。照樣繼續？',
  'auth.exported': '匯出完成',

  // history manager
  'auth.historyOpen': '變更日誌',
  'auth.historyTitle': '驗證器變更日誌',
  'auth.historyIntro': '你對項目做過嘅每一步都會記錄喺度。日誌永遠唔會儲存密鑰或者密碼。',
  'auth.setPasswordTitle': '保護變更日誌',
  'auth.setPasswordIntro': '設定一個密碼嚟睇變更日誌。除非你自己特登用同一個，否則佢同其他密碼互相獨立。',
  'auth.password': '密碼',
  'auth.newPassword': '新密碼',
  'auth.oldPassword': '目前密碼',
  'auth.setPassword': '儲存密碼',
  'auth.unlockTitle': '解鎖日誌',
  'auth.unlock': '解鎖',
  'auth.lock': '鎖上日誌',
  'auth.wrongPassword': '密碼對唔上。',
  'auth.historyEmpty': '仲未有記錄。',
  'auth.historySearch': '搜尋日誌…',
  'auth.dateFrom': '開始日期',
  'auth.dateTo': '完結日期',
  'auth.retention': '最多保留 {max} 筆記錄，或者 {days} 日。',
  'auth.prune': '即刻清理過期記錄',
  'auth.prunedCount': '清走咗 {n} 筆過期記錄',
  'auth.restoreBtn': '還原呢一步',
  'auth.restoreDone': '已經還原',
  'auth.cannotRestore': '呢筆記錄無得還原',
  'auth.removedNotRestorable': '刪除咗嘅項目冇得靠日誌還原，因為密鑰係同一時間剷走咗。想攞返就要重新掃描或者貼過條密鑰。',
  'auth.diffDetail': '改咗啲乜',
  'auth.exportHistoryMd': '匯出現時篩選嘅歷史',
  'auth.historyOmits': '講明先：呢度永遠唔記錄密鑰同密碼，所以匯出亦都唔會有。',
  'auth.journalFailed': '修改本身儲存成功，但係寫入日誌失敗：{error}',

  // journal action names
  'act.add': '新增',
  'act.edit': '編輯',
  'act.rename': '改名',
  'act.rekey': '改參數',
  'act.remove': '刪除',
  'act.import': '匯入',
  'act.reorder': '重新排序',
  'act.group-change': '調動群組',
  'act.confirm-pairing': '確認配對',
  'act.restore': '還原',
  'act.prune': '清理日誌',
  'act.history-password-change': '更改日誌密碼',
};
