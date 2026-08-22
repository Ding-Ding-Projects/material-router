// Purpose: Traditional Chinese (Hong Kong colloquial) strings for the API
// Builder tab. Machine-literal phrasing is treated as a defect: these read
// the way a Hong Kong user actually talks about software.
// Owned by Builder lane.

export const zh = {
  // header
  subtitle: '成個請求都用介面砌——淨係訊息內容先至要打字。',

  // endpoint card
  endpointTitle: '端點',
  endpointHelp: '呢個請求用邊種線格式。供應商講另一隻話嘅話，路由器出發前會自動翻譯。',
  epOpenai: 'OpenAI · chat.completions',
  epAnthropic: 'Anthropic · messages',

  // routing card
  routingTitle: '供應商同模型',
  providerLabel: '供應商',
  providerEmpty: '仲未設定任何供應商',
  providerEmptyHelp: '去「供應商同金鑰」加返個供應商同 API 金鑰先——請求都要有地方去㗎。',
  openProvidersBtn: '打開「供應商同金鑰」',
  modelLabel: '模型',
  modelEmptyOption: '- 未有模型快取 -',
  refreshModels: '重新抓取模型',
  refreshDone: '模型清單更新咗喇。',
  modelsHint: '由供應商嘅模型清單快取返嚟。撳一下就會即時再抓。',
  modelsEmptyAfterRefresh: '供應商啱啱一個模型都冇返——去「供應商同金鑰」檢查下個 base URL 同金鑰。',
  defaultModelTag: '供應商預設',
  serverStoppedNote: '（本地路由器而家停咗。）',

  // parameters card
  paramsTitle: '參數',
  temperatureLabel: '溫度（temperature）',
  topPLabel: 'top_p',
  maxTokensLabel: '輸出上限（max tokens）',
  stopLabel: '停止序列',
  stopInputLabel: '新停止序列',
  stopAdd: '加入',
  stopSuggest: '建議：',
  stopHelp: '最多八個。Anthropic 格式淨計頭四個。',
  stopRemoveAria: '刪除停止序列 {value}',
  streamLabel: '串流接收回應',

  // system card
  systemTitle: '系統提示',
  systemPresetLabel: '預設',
  sysNone: '無',
  sysConcise: '簡短',
  sysCoder: '寫程式',
  sysTranslator: '翻譯',
  systemCustomLabel: '提示文字（可以改）',
  provenancePreset: '由「{preset}」預設帶入嚟——鍾意就改。',
  provenanceCustom: '你自己寫嘅提示。',
  provenanceNone: '唔會送系統提示出去。',

  // tools card
  toolsTitle: '工具調用',
  toolsEnableLabel: '附加一個工具定義',
  toolNameLabel: '工具名稱',
  toolDescLabel: '描述',
  toolSchemaLabel: 'JSON schema 範本',
  schemaPreviewLabel: 'Schema 預覽',

  // messages card
  messagesTitle: '訊息',
  addMessage: '加訊息',
  roleLabel: '角色',
  contentLabel: '內容',
  moveUp: '向上移動訊息',
  moveDown: '向下移動訊息',
  duplicate: '複製訊息',
  deleteMsg: '刪除訊息',
  deleteMsgConfirmTitle: '刪除第 {index} 條訊息？',
  deleteMsgConfirmBody: '會將呢條 {role} 訊息由撰寫區度攞走。草稿即刻自動自動儲存，喺度冇得反悔。',
  systemRoleNote: 'system 角色嘅列送去 Anthropic 嗰陣會併入 "system" 欄位，唔會入訊息列表。',
  emptyMessages: '仲未有訊息，加一條開波啦。',

  // preview card
  previewTitle: '請求預覽',
  fmtOpenai: '以 OpenAI 格式',
  fmtAnthropic: '以 Anthropic 格式',
  copyPreview: '複製 JSON',
  previewHint: '即時顯示真正會送出去嗰個 body。',
  translateNotes: '翻譯備註',
  noNotes: '冇翻譯備註——兩邊格式啱啱好對得上。',
  invalidTitle: '未準備好傳送：',
  'err.noModel': '揀返個模型。',
  'err.noProvider': '揀返個供應商。',
  'err.noMessages': '至少一條訊息要有內容。',

  // send + response
  sendBtn: '傳送測試請求',
  sending: '傳送中…',
  cancelBtn: '取消請求',
  responseTitle: '回應',
  respStatus: 'HTTP 狀態',
  respTime: '來回時間',
  respProvider: '路由去咗',
  respFormat: '線格式',
  usageTitle: 'Token 用量',
  usagePrompt: '提示',
  usageCompletion: '完成',
  usageTotal: '總計',
  prettyToggle: '美化',
  rawToggle: '原始',
  streamOutputLabel: '串流輸出',
  clearResponse: '清空',
  respEmpty: '仲未有嘢——傳一個請求睇下。',
  aborted: '請求未完成就取消咗。',
  streamTruncated: '串流記錄喺 {kb} KB 截斷咗。',
  sentViaRouter: '經本地路由器出嘅，同外部 client 一模一樣。',

  // presets card
  presetsTitle: '預設組合',
  savePreset: '儲存而家呢個…',
  presetNameTitle: '儲存預設組合',
  presetNameLabel: '名稱',
  presetReplaceTitle: '覆蓋原有組合？',
  presetReplaceBody: '已經有個叫「{name}」嘅組合。用而家呢個取代佢？',
  load: '載入',
  deletePreset: '刪除',
  deletePresetConfirmTitle: '刪除組合「{name}」？',
  deletePresetConfirmBody: '會永久移除已儲存嘅「{name}」。',
  exportPreset: '匯出 JSON',
  presetsEmpty: '仲未有組合。砌好少少嘢就撳「儲存」。',
  searchPlaceholder: '篩選組合…',
  defaultPresetName: '組合 {ts}',
  presetReplacedB: '「{name}」而家裝住目前嘅組合。',
  presetSavedB: '「{name}」已儲存喺本地。',
  presetLoadedB: '「{name}」已填滿撰寫區。',
  presetDeletedB: '「{name}」已移除。',

  // snippet card
  snippetTitle: 'Client 程式碼片段',
  langLabel: '語言／client',
  copySnippet: '複製片段',
  exportSnippet: '下載',
  snippetHint: '對住本地路由器 {url} 嚟寫。真金鑰留喺保險庫——片段只會引用環境變數。',

  // editor handoff
  openInEditor: '喺編輯器打開',
  exportedForEditor: '已儲存 {file}。',
  openedVscode: '已喺 VS Code 打開：{path}',
  openedDefault: '搵唔到 VS Code——改用預設 app 開咗：{path}',
  openFailed: '交畀編輯器失敗：{reason}',

  // reset
  resetComposer: '重設撰寫區',
  resetConfirmTitle: '重設成預設值？',
  resetConfirmBody: '會將訊息、參數、系統提示同自動儲存嘅草稿全部還原到出廠狀態。已儲存嘅組合唔受影響。',
  composerResetB: '還原晒喇。',

  // misc toasts
  copiedToastTitle: '已複製',
  sendFailedT: '請求失敗',
  modelsFailedT: '抓取模型失敗',
  draftRestoredB: '上次個組合由自動儲存草稿還原返嚟喇。',

  // history actions
  histSave: '已儲存組合',
  histLoad: '已載入組合',
  histDelete: '已刪除組合',
  histExport: '已匯出組合',
  histMsgDelete: '已刪除訊息',
  histReset: '已重設撰寫區',
  histEditor: '已喺編輯器打開',

  // palette entries
  palSend: '建造器：傳送測試請求',
  palAddMsg: '建造器：加訊息',
  palSavePreset: '建造器：儲存目前組合',
  palCopyPreview: '建造器：複製請求 JSON',
  palToggleFmt: '建造器：切換預覽格式',
};
