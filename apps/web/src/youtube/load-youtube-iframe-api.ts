/** Load https://www.youtube.com/iframe_api once; resolves when `window.YT.Player` exists. */

const SCRIPT_SRC = 'https://www.youtube.com/iframe_api';

let loadPromise: Promise<void> | null = null;

/** Minimal typing for YT.Player instance methods we use. */
export type YTPlayerInstance = {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead?: boolean) => void;
  setPlaybackRate: (rate: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  loadModule: (moduleName: string) => void;
  unloadModule: (moduleName: string) => void;
  destroy: () => void;
  mute: () => void;
  unMute: () => void;
};

declare global {
  interface Window {
    YT?: {
      Player: new (elementId: string, options: Record<string, unknown>) => YTPlayerInstance;
    };
  }
}

export function loadYoutubeIframeApi(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('YouTube IFrame API requires a browser'));
  }
  if (window.YT?.Player) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = new Promise<void>((resolve, reject) => {
    const w = window as Window & { onYouTubeIframeAPIReady?: () => void };

    const finishOk = () => {
      if (w.YT?.Player) resolve();
      else {
        loadPromise = null;
        reject(new Error('YouTube IFrame API ready but YT.Player is missing'));
      }
    };

    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      try {
        prev?.();
      } catch {
        /* ignore */
      }
      finishOk();
    };

    const existing = document.querySelector(`script[src="${SCRIPT_SRC}"]`);
    if (existing) {
      if (w.YT?.Player) {
        finishOk();
        return;
      }
      const poll = window.setInterval(() => {
        if (w.YT?.Player) {
          window.clearInterval(poll);
          finishOk();
        }
      }, 50);
      window.setTimeout(() => {
        window.clearInterval(poll);
        if (!w.YT?.Player) {
          loadPromise = null;
          reject(new Error('YouTube IFrame API load timeout'));
        }
      }, 20_000);
      return;
    }

    const tag = document.createElement('script');
    tag.src = SCRIPT_SRC;
    tag.async = true;
    tag.onerror = () => {
      loadPromise = null;
      reject(new Error('Failed to load YouTube IFrame API script'));
    };
    document.head.appendChild(tag);
  });

  return loadPromise;
}

/** YouTube-supported playback rates; snap custom values to nearest. */
export const YOUTUBE_PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export function snapToYoutubePlaybackRate(r: number): number {
  if (!Number.isFinite(r) || r <= 0) return 1;
  let best = 1;
  let bestDiff = Infinity;
  for (const x of YOUTUBE_PLAYBACK_RATES) {
    const d = Math.abs(x - r);
    if (d < bestDiff) {
      bestDiff = d;
      best = x;
    }
  }
  return best;
}
