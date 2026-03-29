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
  setMode: (mode: AppMode) => void;
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
  const setMode = useCallback((mode: AppMode) => {
    setAppMode(mode);
    try {
      localStorage.setItem(APP_MODE_STORAGE_KEY, mode);
    } catch {
      // In some embedded/iframe contexts storage may be blocked; keep in-memory mode for this session.
    }
  }, []);

  const isDeveloperMode = useMemo(() => isDeveloperModeActive(appMode), [appMode]);

  const value = useMemo(
    () => ({
      appMode,
      isDeveloperMode,
      openModeModal,
      setMode,
    }),
    [appMode, isDeveloperMode, openModeModal, setMode],
  );

  return (
    <AppModeContext.Provider value={value}>
      {children}
      <AppModeModal
        open={modalOpen}
        currentMode={appMode}
        onClose={closeModeModal}
        getExpectedPassword={getConfiguredModePassword}
        onApplyMode={setMode}
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
      setMode: () => {},
    };
  }
  return ctx;
}
