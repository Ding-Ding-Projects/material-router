// Shared helper: resolve the repository root from a script's own URL.
import { fileURLToPath } from 'node:url';

export function fileURLToRoot(importMetaUrl) {
  return fileURLToPath(new URL('../', importMetaUrl));
}
