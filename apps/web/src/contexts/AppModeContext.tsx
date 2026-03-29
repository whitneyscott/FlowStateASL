import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  APP_MODE_STORAGE_KEY,
  type AppMode,
  getConfiguredModePassword,
  isDeveloperModeActive,
  readStoredAppMode,
} from '../utils/app-mode';
import { AppModeModal } from '../components/AppModeModal';
import '../components/AppModeModal.css';

interface AppModeContextValue {
  appMode: AppMode;
  /** True when Bridge Log and other dev tools should be shown */
  isDeveloperMode: boolean;
  openModeModal: () => void;
}

const AppModeContext = createContext<AppModeContextValue | null>(null);

export function AppModeProvider({ children }: { children: ReactNode }) {
  const [appMode, setAppMode] = useState<AppMode>(() => readStoredAppMode());
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === APP_MODE_STORAGE_KEY && e.newValue) {
        const v = e.newValue as AppMode;
        if (v === 'demo' || v === 'developer' || v === 'production') setAppMode(v);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const openModeModal = useCallback(() => setModalOpen(true), []);
  const closeModeModal = useCallback(() => setModalOpen(false), []);

  const isDeveloperMode = useMemo(() => isDeveloperModeActive(appMode), [appMode]);

  const value = useMemo(
    () => ({
      appMode,
      isDeveloperMode,
      openModeModal,
    }),
    [appMode, isDeveloperMode, openModeModal],
  );

  return (
    <AppModeContext.Provider value={value}>
      {children}
      <button
        type="button"
        className="app-mode-float-btn"
        onClick={openModeModal}
        title="Application mode (Demo / Developer / Production)"
      >
        Mode
      </button>
      <AppModeModal
        open={modalOpen}
        currentMode={appMode}
        onClose={closeModeModal}
        getExpectedPassword={getConfiguredModePassword}
      />
    </AppModeContext.Provider>
  );
}

export function useAppMode(): AppModeContextValue {
  const ctx = useContext(AppModeContext);
  if (!ctx) {
    return {
      appMode: 'demo',
      isDeveloperMode: false,
      openModeModal: () => {},
    };
  }
  return ctx;
}
