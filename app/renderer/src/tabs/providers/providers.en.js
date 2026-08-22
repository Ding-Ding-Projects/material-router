// Purpose: English strings for the Providers & Keys tab (ns 'providers').
// Carries forward the two foundation placeholder keys verbatim.
// Owned by Providers lane.

export const en = {
  // carried forward from the foundation placeholder bundle
  'countProviders': 'providers',
  'countRules': 'routing rules',

  // tab
  'subtitle': 'Connect the AI providers you already have accounts with, store their API keys in the encrypted vault, and route each model to the right place.',
  'searchPlaceholder': 'Filter providers…',
  'addProvider': 'Add provider',
  'loadFailed': 'Could not load providers.',
  'retry': 'Retry',
  'emptyTitle': 'No providers yet',
  'emptyBody': 'Add your first provider to start routing requests.',
  'noMatch': 'No providers match that filter.',

  // type badges
  'type.openai': 'OpenAI',
  'type.anthropic': 'Anthropic',
  'type.compatible': 'OpenAI-compatible',

  // card
  'enabledLabel': 'Enabled',
  'enabledAria': '{name} enabled',
  'status.untested': 'Not tested yet',
  'status.testing': 'Testing…',
  'status.okAt': 'Connected · {time}',
  'status.failAt': 'Failed · {time}',
  'noBaseUrl': 'no base URL',
  'defaultModelLine': 'default model {model}',
  'noDefaultModel': 'no default model',
  'keyStoredLine': 'API key stored as',
  'keyMissingLine': 'No API key stored',
  'action.test': 'Test',
  'action.edit': 'Edit',
  'action.delete': 'Delete',

  // delete confirmation
  'deleteTitle': 'Delete provider “{name}”?',
  'deleteBody': 'This removes the provider record for {name} permanently.',
  'deleteBodyKeyRef': 'Its stored API key (vault id {id}) is deleted too.',
  'deleteBodyNoKey': 'It has no stored API key.',
  'deleteBodyRules': 'Routing rules pointing at it are removed as well.',

  // toasts
  'toast.addedTitle': 'Provider added',
  'toast.savedTitle': 'Provider saved',
  'toast.savedBody': '{name} is up to date.',
  'toast.deletedTitle': 'Provider deleted',
  'toast.testOkTitle': 'Connection OK',
  'toast.testOkBody': 'Reached the endpoint and listed {count} models.',
  'toast.testFailTitle': 'Connection test failed',
  'toast.saveFailedTitle': 'Could not save the provider',
  'toast.testAllSummary': '{ok} of {total} enabled providers responded successfully.',

  // warnings
  'warn.obfuscatedTitle': 'Stored without OS encryption',
  'warn.obfuscatedBody': 'OS-level encryption is unavailable this session, so the key was stored with weak local obfuscation instead.',
  'warn.orphanKeyTitle': 'Vault entry could not be removed',
  'warn.orphanKeyBody': 'Vault id {id} remains stored. Remove it manually later. ({msg})',

  // errors
  'err.deadline': 'The request timed out before the app answered.',

  // palette
  'palette.add': 'Add provider',
  'palette.testAll': 'Test all enabled providers',

  // add/edit form
  'form.titleAdd': 'Add provider',
  'form.titleEdit': 'Edit provider',
  'form.name': 'Name',
  'form.nameHelper': 'A label only you see, e.g. “Work OpenAI”.',
  'form.errNameRequired': 'Give this provider a name so you can recognise it.',
  'form.type': 'Type',
  'form.baseUrl': 'Base URL',
  'form.urlHelper': 'Must start with https:// — http:// is allowed only for localhost addresses.',
  'form.errUrlRequired': 'Enter the base URL, e.g. https://api.openai.com/v1',
  'form.errUrlFormat': 'Base URL must start with https:// (http:// is allowed only for localhost).',
  'form.restoreDefault': 'Restore default URL',
  'form.restoreDefaultTip': 'Put back the standard base URL for this type.',
  'form.alreadyDefault': 'Already the default URL.',
  'form.keyStored': 'API key stored',
  'form.keyReplace': 'Replace key',
  'form.keyRemove': 'Remove key',
  'form.keyUndoRemove': 'Keep key after all',
  'form.keyPendingRemoval': 'The stored key is removed when you save.',
  'form.keyRemoveConfirmTitle': 'Remove the stored API key?',
  'form.keyRemoveConfirmBody': 'The credential under vault id {id} is deleted when you save. Requests will then go out without authentication until a new key is entered.',
  'form.apiKey': 'API key',
  'form.apiKeyPlaceholder': 'Paste the API key',
  'form.showKey': 'Show',
  'form.hideKey': 'Hide',
  'form.keyHelper': 'Stored encrypted in the OS vault; the provider keeps only an id reference.',
  'form.keyReplaceHelper': 'Paste a new key to replace the stored one under the same vault id.',
  'form.defaultModel': 'Default model',
  'form.modelHelper': 'Suggestions come from the last successful connection test.',
  'form.modelHelperEmpty': 'Optional. Run a connection test to list available models here.',
  'form.enabled': 'Enabled',
  'form.save': 'Save provider',
  'form.saving': 'Saving…',

  // routing rules
  'rules.title': 'Routing rules',
  'rules.note': 'Rules apply top to bottom and the first match wins, so keep specific rules above broad ones. Ties break by specificity (exact beats prefix beats catch-all), then by position. A request matching no rule falls back to the first enabled provider that has a default model, or is rejected.',
  'rules.empty': 'No rules yet. Requests fall back to the first enabled provider with a default model.',
  'rules.add': 'Add rule',
  'rules.addNeedsProvider': 'Add a provider first — a rule needs somewhere to send requests.',
  'rules.rowLabel': 'Rule {n}',
  'rules.fallbackBadge': 'Fallback',
  'rules.matchType': 'Match type',
  'rules.matchPrefix': 'Prefix',
  'rules.matchExact': 'Exact',
  'rules.matchCatchall': 'Catch-all',
  'rules.pattern': 'Model pattern',
  'rules.patternPlaceholder': 'e.g. gpt-4o or claude-',
  'rules.chipsLabel': 'Common model prefixes',
  'rules.chipTip': 'Replace the pattern with this prefix',
  'rules.catchallNote': 'Catch-all matches every model, so no pattern is needed.',
  'rules.target': 'Send to provider',
  'rules.targetPlaceholder': 'Choose a provider…',
  'rules.targetRemoved': 'Provider no longer exists — choose another',
  'rules.errPattern': 'Enter the model text to match, e.g. gpt-4o.',
  'rules.errTarget': 'Choose which provider handles this rule.',
  'rules.errTargetNone': 'Add a provider first.',
  'rules.enabled': 'Rule enabled',
  'rules.moveUp': 'Move rule up (higher priority)',
  'rules.moveDown': 'Move rule down (lower priority)',
  'rules.cannotMoveUp': 'Already the top rule.',
  'rules.cannotMoveDown': 'Already the bottom rule.',
  'rules.revert': 'Revert',
  'rules.deleteTitle': 'Delete this routing rule?',
  'rules.deleteBody': 'The rule “{rule}” targeting {provider} stops applying immediately.',
};
