export type AppMode = 'demo' | 'developer' | 'production';

export const APP_MODE_STORAGE_KEY = 'aslExpressAppMode';

export function readStoredAppMode(): AppMode {
  try {
    const v = localStorage.getItem(APP_MODE_STORAGE_KEY);
    if (v === 'developer' || v === 'production' || v === 'demo') return v;
  } catch {
    /* ignore */
  }
  return 'demo';
}

/**
 * Password for switching into Developer or Production mode (Bulk Editor–style).
 * Uses MODE_PASSWORD (injected at build via Vite define).
 * Legacy fallback: VITE_APP_MODE_PASSWORD. In local dev, defaults to dev2025 when unset.
 */
export function getConfiguredModePassword(): string {
  const fromMode = typeof __MODE_PASSWORD__ === 'string' ? __MODE_PASSWORD__.trim() : '';
  if (fromMode) return fromMode;
  const legacy = import.meta.env.VITE_APP_MODE_PASSWORD;
  if (typeof legacy === 'string' && legacy.trim()) return legacy.trim();
  if (import.meta.env.DEV) return 'dev2025';
  return '';
}

export function isDeveloperModeActive(appMode: AppMode): boolean {
  return appMode === 'developer';
}
