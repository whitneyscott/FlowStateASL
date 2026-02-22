import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface DebugState {
  sproutVideoAccessed: boolean;
  sproutVideoPlaylistsRetrieved: number | null;
  lastFunctionCalled: string | null;
  lastApiResult: { endpoint: string; status: number; ok: boolean } | null;
}

interface DebugContextValue extends DebugState {
  setSproutVideo: (accessed: boolean, playlistsRetrieved: number | null) => void;
  setLastFunction: (fn: string) => void;
  setLastApiResult: (endpoint: string, status: number, ok: boolean) => void;
}

const initial: DebugState = {
  sproutVideoAccessed: false,
  sproutVideoPlaylistsRetrieved: null,
  lastFunctionCalled: null,
  lastApiResult: null,
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
    setState((s) => ({ ...s, lastApiResult: { endpoint, status, ok } }));
  }, []);

  return (
    <DebugContext.Provider value={{ ...state, setSproutVideo, setLastFunction, setLastApiResult }}>
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
    setSproutVideo: () => {},
    setLastFunction: () => {},
    setLastApiResult: () => {},
  };
}
