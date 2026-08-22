// Purpose: loads this lane's shared stylesheet (core/appearance.css) from its
// owning module. index.html cannot be edited by lanes, so the module injects
// one same-origin <link> - allowed by the renderer CSP (style-src 'self').
// Idempotent: repeated imports never duplicate the link.
// Owned by Appearance lane.

let loaded = false;

export function loadAppearanceCss() {
  // Guarded so the module graph stays importable outside a browser (the
  // repository's import checks) - CSS loading only matters in the renderer.
  if (loaded || typeof document === 'undefined') return;
  const href = new URL('../../core/appearance.css', import.meta.url).href;
  const existing = document.querySelector(`link[rel="stylesheet"][href="${CSS.escape(href)}"]`);
  if (existing) {
    loaded = true;
    return;
  }
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.append(link);
  loaded = true;
}
