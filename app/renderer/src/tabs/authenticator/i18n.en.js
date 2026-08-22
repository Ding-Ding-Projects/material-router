// Purpose: English strings for the Authenticator tab. Facts (algorithm names,
// digit counts, periods, paths) stay exact at every funny level; humour styles
// only the surrounding voice via copy().
// Owned by the Authenticator lane.

export const en = {
  // header
  'auth.subtitle': 'Local time-based codes. Secrets stay in the encrypted vault.',
  'auth.vaultOk': 'Vault encryption active',
  'auth.vaultFallback': 'OS encryption unavailable - secrets stored with obfuscation fallback',
  'auth.entries': 'entries',
  'auth.entry': 'entry',

  // empty state
  'auth.emptyTitle': 'No entries yet',
  'auth.emptyBody': 'Add an entry by pasting its otpauth:// URI or typing the base32 key your service showed you.',

  // add menu
  'auth.add': 'Add entry',
  'auth.addUri': 'Paste otpauth:// link',
  'auth.addManual': 'Enter key manually',
  'auth.importList': 'Import many links at once',

  // search / list
  'auth.searchPlaceholder': 'Search entries…',
  'auth.selectAllShown': 'Select all shown',
  'auth.invertSelection': 'Invert selection',
  'auth.clearSelection': 'Clear selection',
  'auth.selectedCount': '{n} selected',
  'auth.deleteSelected': 'Delete selected…',
  'auth.groupSelected': 'Move selected to group…',

  // row
  'auth.unconfirmedBadge': 'Not confirmed yet',
  'auth.confirmShort': 'Confirm',
  'auth.copyCode': 'Copy current code',
  'auth.codeCopied': 'Code copied',
  'auth.peek': 'Show next code',
  'auth.hidePeek': 'Hide next code',
  'auth.nextLabel': 'Next:',
  'auth.secondsLeft': '{s} s left',
  'auth.codesRotated': 'One-time codes refreshed',
  'auth.hotpCounter': 'Counter {n}',
  'auth.rowMenu': 'Entry actions',
  'auth.reveal': 'Show QR and key',
  'auth.edit': 'Edit',
  'auth.remove': 'Delete',
  'auth.moveUp': 'Move up',
  'auth.moveDown': 'Move down',
  'auth.incrementCounter': 'Advance counter',
  'auth.verifyLive': 'Check a code',
  'auth.dragHandle': 'Drag to reorder (Alt+Arrow keys also work)',

  // group headers
  'auth.noGroup': 'No group',
  'auth.toggleGroup': 'Show or hide group',

  // add-by-uri dialog
  'auth.uriTitle': 'Paste an otpauth:// link',
  'auth.uriField': 'otpauth:// link',
  'auth.uriPlaceholder': 'otpauth://totp/Example:alice@example.com?secret=…',
  'auth.parse': 'Read link',
  'auth.parseBad': 'That link could not be read',

  // manual dialog
  'auth.manualTitle': 'New entry details',
  'auth.type': 'Type',
  'auth.typeTotp': 'Time-based (TOTP)',
  'auth.typeHotp': 'Counter-based (HOTP)',
  'auth.secret': 'Key (base32)',
  'auth.secretPlaceholder': 'Paste the base32 key, e.g. JBSW Y3DP EHPK 3PXP',
  'auth.secretHint': 'Spaces and dashes are ignored. At least 80 bits (16 characters) is recommended.',
  'auth.generate': 'Generate a key instead',
  'auth.issuer': 'Service (issuer)',
  'auth.account': 'Account name',
  'auth.algorithm': 'Algorithm',
  'auth.digits': 'Digits',
  'auth.digitsUnit': 'digits',
  'auth.period': 'Period',
  'auth.periodUnit': 'seconds',
  'auth.counter': 'Starting counter',

  // edit dialog
  'auth.editTitle': 'Edit entry',
  'auth.icon': 'Icon (one emoji)',
  'auth.group': 'Group',
  'auth.groupPlaceholder': 'e.g. Work, Personal',
  'auth.cryptoWarning': 'Changing the algorithm, digits or period breaks the confirmed pairing - you will be asked to confirm a fresh code afterwards.',

  // pairing / confirm
  'auth.pairTitle': 'Confirm pairing',
  'auth.pairIntro': 'Scan this QR code with your authenticator device, or reveal the key and type it in there. Then type the code it currently shows to finish.',
  'auth.revealKey': 'Reveal key',
  'auth.hideKey': 'Hide key',
  'auth.keyCopy': 'Copy key',
  'auth.params': '{algo} · {digits} digits · every {period} s',
  'auth.paramsHotp': 'HOTP · {digits} digits · counter starts at {counter}',
  'auth.confirmField': 'Current code from the device',
  'auth.confirmBtn': 'Verify and save',
  'auth.confirmExisting': 'Verify and confirm',
  'auth.wrongCode': 'That code did not match. Nothing was changed.',
  'auth.paired': 'Paired and saved',
  'auth.qrAlt': 'Pairing QR code for {name}',

  // deletion
  'auth.deleteOneTitle': 'Delete entry?',
  'auth.deleteOneBody': '"{name}" and its stored key will be removed from the vault. This cannot be undone and the journal cannot bring it back.',
  'auth.deleteManyTitle': 'Delete {n} entries?',
  'auth.deleteManyBody': '{n} entries and their stored keys will be removed from the vault. This cannot be undone.',
  'auth.deleteConfirm': 'Delete permanently',

  // exports
  'auth.exportMenu': 'Export',
  'auth.exportRedacted': 'Metadata only (no secrets)',
  'auth.exportFull': 'Keys included (readable plain text)',
  'auth.redactedNote': 'This file contains entry details only. Keys are deliberately omitted.',
  'auth.fullGateTitle': 'Export readable keys?',
  'auth.fullGateBody': 'The export will contain every key in plain text that any authenticator app could use. Anyone who can read this file can generate your codes. Continue?',
  'auth.exported': 'Export saved',

  // history manager
  'auth.historyOpen': 'Mutation history',
  'auth.historyTitle': 'Authenticator mutation history',
  'auth.historyIntro': 'Every change to your entries lands here first. The journal never stores keys or codes.',
  'auth.setPasswordTitle': 'Protect the history',
  'auth.setPasswordIntro': 'Choose a password for viewing the mutation journal. It is independent of anything else unless you deliberately reuse it.',
  'auth.password': 'Password',
  'auth.newPassword': 'New password',
  'auth.oldPassword': 'Current password',
  'auth.setPassword': 'Save password',
  'auth.unlockTitle': 'Unlock history',
  'auth.unlock': 'Unlock',
  'auth.lock': 'Lock history',
  'auth.wrongPassword': 'That password did not match.',
  'auth.historyEmpty': 'Nothing recorded yet.',
  'auth.historySearch': 'Search the journal…',
  'auth.dateFrom': 'From date',
  'auth.dateTo': 'To date',
  'auth.retention': 'Keeping at most {max} records or {days} days.',
  'auth.prune': 'Prune aged records now',
  'auth.prunedCount': '{n} aged records removed',
  'auth.restoreBtn': 'Restore this change',
  'auth.restoreDone': 'Restored',
  'auth.cannotRestore': 'This record cannot be restored',
  'auth.removedNotRestorable': 'Deleted entries cannot be restored from the journal because their key was deleted with them. Re-add them by scanning or pasting the key again.',
  'auth.diffDetail': 'What changed',
  'auth.exportHistoryMd': 'Export filtered history',
  'auth.historyOmits': 'Export states plainly: no keys and no codes are ever recorded here, so none appear below.',
  'auth.journalFailed': 'The change was saved, but writing it to the journal failed: {error}',

  // journal action names (shown verbatim in the list)
  'act.add': 'Added',
  'act.edit': 'Edited',
  'act.rename': 'Renamed',
  'act.rekey': 'Parameters changed',
  'act.remove': 'Deleted',
  'act.import': 'Imported',
  'act.reorder': 'Reordered',
  'act.group-change': 'Grouped',
  'act.confirm-pairing': 'Confirmed pairing',
  'act.restore': 'Restored',
  'act.prune': 'Pruned journal',
  'act.history-password-change': 'History password changed',
};
