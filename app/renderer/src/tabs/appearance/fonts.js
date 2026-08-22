// Purpose: font family enumeration. The curated bundled-safe list is always
// present; native families arrive from the main-process bridge (sfnt name
// tables read off disk) and, where the platform exposes it, the renderer's
// Local Font Access API. Failures are reported honestly - a missing native
// list never silently pretends to be the machine's fonts.
// Owned by Appearance lane.

import { invoke } from '../../core/bridge.js';
import { t } from '../../core/i18n.js';

/** Bundled-safe families: universally renderable, CJK/HK-relevant faces included. */
export const CURATED_FONTS = [
  'Segoe UI Variable Text',
  'Segoe UI',
  'system-ui',
  'Arial',
  'Calibri',
  'Cambria',
  'Candara',
  'Consolas',
  'Cascadia Code',
  'Corbel',
  'Constantia',
  'Courier New',
  'Franklin Gothic Medium',
  'Garamond',
  'Georgia',
  'Impact',
  'Lucida Console',
  'Tahoma',
  'Times New Roman',
  'Trebuchet MS',
  'Verdana',
  // Traditional Chinese / Hong Kong faces.
  'Microsoft JhengHei',
  'Microsoft JhengHei UI',
  'PMingLiU',
  'MingLiU-ExtB',
  'DFKai-SB',
];

let cache = null;

/**
 * Returns { families, sources: {curated:true, native:bool, localApi:bool},
 *           note } where `families` is sorted, de-duplicated
 * (case-insensitively) and ALWAYS contains the curated list.
 */
export async function enumerateFonts({ force = false } = {}) {
  if (cache && !force) return cache;

  const curated = [...CURATED_FONTS];
  const seen = new Set(curated.map((f) => f.toLowerCase()));
  const extraNative = [];
  const extraLocal = [];
  let nativeError = null;
  let localError = null;
  let nativeMeta = null;

  try {
    const result = await invoke('shell:appearance-fonts', { force });
    nativeMeta = result;
    for (const family of result?.families ?? []) {
      if (typeof family === 'string' && family.trim() && !seen.has(family.toLowerCase())) {
        seen.add(family.toLowerCase());
        extraNative.push(family.trim());
      }
    }
  } catch (err) {
    nativeError = err.message ?? String(err);
  }

  // Local Font Access API: permission-gated; absence or refusal is honest,
  // never an application error.
  try {
    if (typeof window.queryLocalFonts === 'function') {
      const fonts = await window.queryLocalFonts();
      for (const font of fonts) {
        const family = font?.family;
        if (family && !seen.has(family.toLowerCase())) {
          seen.add(family.toLowerCase());
          extraLocal.push(family);
        }
      }
    }
  } catch (err) {
    localError = err.name === 'NotAllowedError'
      ? t('appearance.font.localDenied')
      : (err.message ?? String(err));
  }

  const families = [...curated, ...extraLocal.sort(), ...extraNative.sort()];
  cache = {
    families,
    meta: {
      curatedCount: curated.length,
      nativeCount: extraNative.length,
      localApiCount: extraLocal.length,
      nativeTruncated: Boolean(nativeMeta?.truncated),
      nativeDurationMs: nativeMeta?.durationMs ?? null,
      unreadableFiles: nativeMeta?.unreadable ?? null,
      scannedFiles: nativeMeta?.scanned ?? null,
    },
    errors: { native: nativeError, localApi: localError },
  };
  return cache;
}

/** Reset so a forced refresh re-reads everything. */
export function clearCache() {
  cache = null;
}
