import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface DebugState {
  sproutVideoAccessed: boolean;
  sproutVideoPlaylistsRetrieved: number | null;
  lastFunctionCalled: string | null;
  lastApiResult: { endpoint: string; status: number; ok: boolean } | null;
  lastApiError: { endpoint: string; status: number; message: string } | null;
}

interface DebugContextValue extends DebugState {
  setSproutVideo: (accessed: boolean, playlistsRetrieved: number | null) => void;
  setLastFunction: (fn: string) => void;
  setLastApiResult: (endpoint: string, status: number, ok: boolean) => void;
  setLastApiError: (endpoint: string, status: number, message: string) => void;
}

const initial: DebugState = {
  sproutVideoAccessed: false,
  sproutVideoPlaylistsRetrieved: null,
  lastFunctionCalled: null,
  lastApiResult: null,
  lastApiError: null,
};

const DebugContext = createContext<DebugContextValue | null>(null);

export function DebugProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DebugState>(initial);

  const setSproutVideo = useCallback((accessed: boolean, playlistsRetrieved: number | null) => {
    setState((s) => ({ ...s, sproutVideoAccessed: accessed, sproutVideoPlaylistsRetrieved: playlistsRetrieved }));
  }, []);

  const setLastFunction = useCallback((fn: string) => {
    setState((s) => ({ ...s, lastFunctionCalled: fn }));
  }, []);

  const setLastApiResult = useCallback((endpoint: string, status: number, ok: boolean) => {
    setState((s) => ({ ...s, lastApiResult: { endpoint, status, ok }, lastApiError: ok ? s.lastApiError : null }));
  }, []);

  const setLastApiError = useCallback((endpoint: string, status: number, message: string) => {
    setState((s) => ({ ...s, lastApiError: { endpoint, status, message } }));
  }, []);

  return (
    <DebugContext.Provider value={{ ...state, setSproutVideo, setLastFunction, setLastApiResult, setLastApiError }}>
      {children}
    </DebugContext.Provider>
  );
}

export function useDebug() {
  const ctx = useContext(DebugContext);
  return ctx ?? {
    sproutVideoAccessed: false,
    sproutVideoPlaylistsRetrieved: null,
    lastFunctionCalled: null,
    lastApiResult: null,
    lastApiError: null,
    setSproutVideo: () => {},
    setLastFunction: () => {},
    setLastApiResult: () => {},
    setLastApiError: () => {},
  };
}
