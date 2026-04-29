export type AppMode = 'demo' | 'developer' | 'production';

export const APP_MODE_STORAGE_KEY = 'aslExpressAppMode';

/**
 * When set to `1` / `true`, show Bridge Debug Log in this browser for any role.
 * Gated by {@link getConfiguredModePassword} via Support dialog (students have no mode switcher).
 */
export const STUDENT_BRIDGE_STORAGE_KEY = 'aslExpressStudentBridge';

export function readStudentBridgeEnabled(): boolean {
  try {
    const v = localStorage.getItem(STUDENT_BRIDGE_STORAGE_KEY);
    if (v === '1' || v === 'true') return true;
  } catch {
    /* ignore */
  }
  return false;
}

export function setStudentBridgeEnabled(on: boolean): void {
  try {
    if (on) {
      localStorage.setItem(STUDENT_BRIDGE_STORAGE_KEY, '1');
    } else {
      localStorage.removeItem(STUDENT_BRIDGE_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new CustomEvent('aslexpress:student-bridge-changed', { detail: { on } }));
  } catch {
    /* ignore */
  }
}

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
 * No fallback/default password is allowed.
 */
export function getConfiguredModePassword(): string {
  const fromMode = typeof __MODE_PASSWORD__ === 'string' ? __MODE_PASSWORD__.trim() : '';
  if (fromMode) return fromMode;
  return '';
}

export function isDeveloperModeActive(appMode: AppMode): boolean {
  return appMode === 'developer';
}
