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
 * Set VITE_APP_MODE_PASSWORD for production builds. In Vite dev, defaults to dev2025 when unset.
 */
export function getConfiguredModePassword(): string {
  const fromEnv = import.meta.env.VITE_APP_MODE_PASSWORD;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  if (import.meta.env.DEV) return 'dev2025';
  return '';
}

export function isDeveloperModeActive(appMode: AppMode): boolean {
  return appMode === 'developer';
}
