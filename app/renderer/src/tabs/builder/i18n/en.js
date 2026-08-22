// Purpose: English strings for the API Builder tab. Flat keys, consumed via
// t('builder.<key>') after builder.js registers the bundle. Facts (labels,
// numbers, statuses) stay plain; funny-level voice attaches through copy()
// on helper sentences only.
// Owned by Builder lane.

export const en = {
  // header
  subtitle: 'Compose a complete API request entirely from controls - typing is only for message text.',

  // endpoint card
  endpointTitle: 'Endpoint',
  endpointHelp: 'The wire format this request is written in. The router translates on the way out when your provider speaks the other format.',
  epOpenai: 'OpenAI · chat.completions',
  epAnthropic: 'Anthropic · messages',

  // routing card
  routingTitle: 'Provider & model',
  providerLabel: 'Provider',
  providerEmpty: 'No providers configured yet',
  providerEmptyHelp: 'Add a provider and its API key in Providers & Keys first - requests need somewhere to go.',
  openProvidersBtn: 'Open Providers & Keys',
  modelLabel: 'Model',
  modelEmptyOption: '- no cached models -',
  refreshModels: 'Refresh models',
  refreshDone: 'Model list refreshed.',
  modelsHint: 'Cached from the provider\'s model list. Refresh fetches it again live.',
  modelsEmptyAfterRefresh: 'The provider returned no models just now - check its base URL and key in Providers & Keys.',
  defaultModelTag: 'provider default',
  serverStoppedNote: '(The local router is currently stopped.)',

  // parameters card
  paramsTitle: 'Parameters',
  temperatureLabel: 'Temperature',
  topPLabel: 'top_p',
  maxTokensLabel: 'Max output tokens',
  stopLabel: 'Stop sequences',
  stopInputLabel: 'New stop sequence',
  stopAdd: 'Add',
  stopSuggest: 'Suggestions:',
  stopHelp: 'Up to 8. The Anthropic format keeps only the first 4.',
  stopRemoveAria: 'Remove stop sequence {value}',
  streamLabel: 'Stream the response',

  // system card
  systemTitle: 'System prompt',
  systemPresetLabel: 'Preset',
  sysNone: 'None',
  sysConcise: 'Concise',
  sysCoder: 'Coder',
  sysTranslator: 'Translator',
  systemCustomLabel: 'Prompt text (editable)',
  provenancePreset: 'Filled from the "{preset}" preset - yours to edit.',
  provenanceCustom: 'Your own prompt text.',
  provenanceNone: 'No system prompt will be sent.',

  // tools card
  toolsTitle: 'Tool use',
  toolsEnableLabel: 'Attach a tool definition',
  toolNameLabel: 'Tool name',
  toolDescLabel: 'Description',
  toolSchemaLabel: 'JSON schema template',
  schemaPreviewLabel: 'Schema preview',

  // messages card
  messagesTitle: 'Messages',
  addMessage: 'Add message',
  roleLabel: 'Role',
  contentLabel: 'Content',
  moveUp: 'Move message up',
  moveDown: 'Move message down',
  duplicate: 'Duplicate message',
  deleteMsg: 'Delete message',
  deleteMsgConfirmTitle: 'Delete message #{index}?',
  deleteMsgConfirmBody: 'Removes the {role} message from the composer. The draft autosaves after this, so it cannot be undone from here.',
  systemRoleNote: 'System rows fold into the Anthropic "system" field instead of the message list.',
  emptyMessages: 'No messages yet. Add one to start.',

  // preview card
  previewTitle: 'Request preview',
  fmtOpenai: 'as OpenAI',
  fmtAnthropic: 'as Anthropic',
  copyPreview: 'Copy JSON',
  previewHint: 'Live view of the exact body that would be sent.',
  translateNotes: 'Translation notes',
  noNotes: 'No translation notes - the formats line up.',
  invalidTitle: 'Not ready to send:',
  'err.noModel': 'Pick a model.',
  'err.noProvider': 'Pick a provider.',
  'err.noMessages': 'At least one message needs content.',

  // send + response
  sendBtn: 'Send test request',
  sending: 'Sending…',
  cancelBtn: 'Cancel request',
  responseTitle: 'Response',
  respStatus: 'HTTP status',
  respTime: 'Round trip',
  respProvider: 'Routed to',
  respFormat: 'Wire format',
  usageTitle: 'Token usage',
  usagePrompt: 'Prompt',
  usageCompletion: 'Completion',
  usageTotal: 'Total',
  prettyToggle: 'Pretty',
  rawToggle: 'Raw',
  streamOutputLabel: 'Streamed output',
  clearResponse: 'Clear',
  respEmpty: 'Nothing here yet - send a request.',
  aborted: 'Request cancelled before finishing.',
  streamTruncated: 'Stream transcript truncated at {kb} KB.',
  sentViaRouter: 'Went through the local router, exactly like an external client.',

  // presets card
  presetsTitle: 'Presets',
  savePreset: 'Save current…',
  presetNameTitle: 'Save preset',
  presetNameLabel: 'Name',
  presetReplaceTitle: 'Replace preset?',
  presetReplaceBody: '"{name}" already exists. Replace it with the current composition?',
  load: 'Load',
  deletePreset: 'Delete',
  deletePresetConfirmTitle: 'Delete preset "{name}"?',
  deletePresetConfirmBody: 'Removes the saved composition "{name}" permanently.',
  exportPreset: 'Export JSON',
  presetsEmpty: 'No presets yet. Compose something and press Save.',
  searchPlaceholder: 'Filter presets…',
  defaultPresetName: 'Composition {ts}',
  presetReplacedB: '"{name}" now holds the current composition.',
  presetSavedB: '"{name}" stored locally.',
  presetLoadedB: '"{name}" filled the composer.',
  presetDeletedB: '"{name}" removed.',

  // snippet card
  snippetTitle: 'Client snippet',
  langLabel: 'Language / client',
  copySnippet: 'Copy snippet',
  exportSnippet: 'Download',
  snippetHint: 'Targets the local router at {url}. Real keys stay in the vault - snippets reference environment variables only.',

  // editor handoff
  openInEditor: 'Open in editor',
  exportedForEditor: 'Saved {file}.',
  openedVscode: 'Opened in VS Code: {path}',
  openedDefault: 'No VS Code found - opened in the default app: {path}',
  openFailed: 'Could not hand off to an editor: {reason}',

  // reset
  resetComposer: 'Reset composer',
  resetConfirmTitle: 'Reset the composer?',
  resetConfirmBody: 'Clears messages, parameters, system prompt and the autosaved draft back to defaults. Saved presets are untouched.',
  composerResetB: 'Back to the shipped defaults.',

  // misc toasts
  copiedToastTitle: 'Copied',
  sendFailedT: 'Request failed',
  modelsFailedT: 'Could not refresh models',
  draftRestoredB: 'Your last composition was restored from the autosaved draft.',

  // history actions
  histSave: 'Preset saved',
  histLoad: 'Preset loaded',
  histDelete: 'Preset deleted',
  histExport: 'Preset exported',
  histMsgDelete: 'Message deleted',
  histReset: 'Composer reset',
  histEditor: 'Opened in editor',

  // palette entries
  palSend: 'Builder: send test request',
  palAddMsg: 'Builder: add message',
  palSavePreset: 'Builder: save current as preset',
  palCopyPreview: 'Builder: copy request JSON',
  palToggleFmt: 'Builder: switch preview format',
};
