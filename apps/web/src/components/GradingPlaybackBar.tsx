import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type RefObject,
} from 'react';
import { snapToYoutubePlaybackRate } from '../youtube/load-youtube-iframe-api';
import type { YoutubeIframePlayerHandle } from './YoutubeIframePlayer';

export type GradingDurationSource = 'submission' | 'prompts' | 'unknown';

function isMediaDurationUsable(d: number): boolean {
  return Number.isFinite(d) && d > 0;
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—:——';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

const RATE_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export type GradingPlaybackBarProps = {
  videoRef: RefObject<HTMLVideoElement | null>;
  videoKey: string;
  videoDurationSeconds?: number | null;
  durationSource?: GradingDurationSource;
  /** When set, submission video drives YouTube within the clip window. */
  youtubeSync?: {
    youtubeRef: RefObject<YoutubeIframePlayerHandle | null>;
    clipStartSec: number;
    clipEndSec: number;
  };
};

function clipWallSec(sync: NonNullable<GradingPlaybackBarProps['youtubeSync']>): number {
  return Math.max(0, sync.clipEndSec - sync.clipStartSec);
}

export function GradingPlaybackBar({
  videoRef,
  videoKey,
  videoDurationSeconds,
  durationSource,
  youtubeSync,
}: GradingPlaybackBarProps) {
  const isScrubbingRef = useRef(false);
  const [scrubValue, setScrubValue] = useState(0);
  const [displayTime, setDisplayTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [mediaDuration, setMediaDuration] = useState<number | null>(null);
  const [playbackRate, setPlaybackRate] = useState(1);

  const sourceIsUnknown = (durationSource ?? 'unknown') === 'unknown';

  const apiDuration =
    videoDurationSeconds != null &&
    typeof videoDurationSeconds === 'number' &&
    Number.isFinite(videoDurationSeconds) &&
    videoDurationSeconds > 0
      ? videoDurationSeconds
      : null;

  const readMediaDuration = useCallback((): number | null => {
    const v = videoRef.current;
    if (!v) return null;
    const d = v.duration;
    return isMediaDurationUsable(d) ? d : null;
  }, [videoRef]);

  const syncYoutubeToVideo = useCallback(
    (opts?: { forceSeek?: boolean }) => {
      const v = videoRef.current;
      const yt = youtubeSync?.youtubeRef.current;
      if (!v || !yt || !youtubeSync) return;
      const wall = clipWallSec(youtubeSync);
      const subT = v.currentTime;
      const capT = Math.min(subT, wall);
      const targetAbs = youtubeSync.clipStartSec + capT;
      try {
        if (subT >= wall - 0.04) {
          yt.pauseVideo();
          yt.seekToSeconds(youtubeSync.clipEndSec);
        } else {
          const cur = yt.getCurrentTime();
          if (opts?.forceSeek || Math.abs(cur - targetAbs) > 0.35) {
            yt.seekToSeconds(targetAbs);
          }
        }
      } catch {
        /* ignore */
      }
    },
    [youtubeSync],
  );

  const applyPlaybackRate = useCallback(
    (rate: number) => {
      const v = videoRef.current;
      const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
      setPlaybackRate(r);
      if (v) {
        try {
          v.playbackRate = r;
        } catch {
          /* ignore */
        }
      }
      const yt = youtubeSync?.youtubeRef.current;
      if (yt) {
        try {
          yt.setPlaybackRate(r);
        } catch {
          /* ignore */
        }
      }
    },
    [youtubeSync],
  );

  useEffect(() => {
    setMediaDuration(null);
    setDisplayTime(0);
    setScrubValue(0);
    setPlaying(false);
    setPlaybackRate(1);
    isScrubbingRef.current = false;
  }, [videoKey]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    const syncMediaDuration = () => {
      const d = readMediaDuration();
      setMediaDuration(d);
    };

    const onTimeUpdate = () => {
      if (isScrubbingRef.current) return;
      setDisplayTime(v.currentTime);
      setScrubValue(v.currentTime);
      if (youtubeSync) syncYoutubeToVideo();
    };

    const onPlay = () => {
      setPlaying(true);
      if (youtubeSync) {
        const yt = youtubeSync.youtubeRef.current;
        if (!yt) return;
        const wall = clipWallSec(youtubeSync);
        try {
          if (v.currentTime >= wall - 0.04) {
            yt.pauseVideo();
            yt.seekToSeconds(youtubeSync.clipEndSec);
          } else {
            yt.playVideo();
            yt.seekToSeconds(youtubeSync.clipStartSec + Math.min(v.currentTime, wall));
          }
        } catch {
          /* ignore */
        }
      }
    };

    const onPause = () => {
      setPlaying(false);
      if (youtubeSync) {
        try {
          youtubeSync.youtubeRef.current?.pauseVideo();
        } catch {
          /* ignore */
        }
      }
    };

    const onEnded = () => {
      setPlaying(false);
      if (youtubeSync) {
        try {
          youtubeSync.youtubeRef.current?.pauseVideo();
        } catch {
          /* ignore */
        }
      }
    };

    const onVolume = () => setMuted(v.muted);
    const onRate = () => {
      const pr = v.playbackRate;
      if (Number.isFinite(pr) && pr > 0) {
        setPlaybackRate(pr);
        const yt = youtubeSync?.youtubeRef.current;
        if (yt) {
          try {
            yt.setPlaybackRate(pr);
          } catch {
            /* ignore */
          }
        }
      }
    };

    syncMediaDuration();
    setMuted(v.muted);
    setDisplayTime(v.currentTime);
    setScrubValue(v.currentTime);
    setPlaying(!v.paused);
    if (Number.isFinite(v.playbackRate) && v.playbackRate > 0) {
      setPlaybackRate(v.playbackRate);
    }

    v.addEventListener('loadedmetadata', syncMediaDuration);
    v.addEventListener('durationchange', syncMediaDuration);
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onEnded);
    v.addEventListener('volumechange', onVolume);
    v.addEventListener('ratechange', onRate);

    return () => {
      v.removeEventListener('loadedmetadata', syncMediaDuration);
      v.removeEventListener('durationchange', syncMediaDuration);
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('volumechange', onVolume);
      v.removeEventListener('ratechange', onRate);
    };
  }, [videoKey, videoRef, readMediaDuration, youtubeSync, syncYoutubeToVideo]);

  const mediaFinite = mediaDuration != null;
  const indeterminate = sourceIsUnknown && !mediaFinite && apiDuration == null;

  const effectiveDurationSeconds = useMemo(() => {
    if (indeterminate) return null;
    if (apiDuration != null && mediaDuration != null) return Math.max(apiDuration, mediaDuration);
    if (apiDuration != null) return apiDuration;
    if (mediaDuration != null) return mediaDuration;
    return null;
  }, [apiDuration, mediaDuration, indeterminate]);

  const scrubEnabled = !indeterminate && effectiveDurationSeconds != null;
  const rangeMax = effectiveDurationSeconds ?? 1;
  const rangeValue = !scrubEnabled ? 0 : Math.min(scrubValue, rangeMax);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      void v.play().catch(() => {});
    } else {
      v.pause();
    }
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  };

  const restartFromBeginning = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    isScrubbingRef.current = false;
    v.currentTime = 0;
    setScrubValue(0);
    setDisplayTime(0);
    if (youtubeSync) {
      const yt = youtubeSync.youtubeRef.current;
      try {
        yt?.seekToSeconds(youtubeSync.clipStartSec);
      } catch {
        /* ignore */
      }
    }
    if (!v.paused) {
      void v.play().catch(() => {});
    }
  }, [videoRef, youtubeSync]);

  const onRangePointerDown = () => {
    isScrubbingRef.current = true;
  };

  const onRangeChange = (e: ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v || !scrubEnabled || effectiveDurationSeconds == null) return;
    const t = Number(e.target.value);
    setScrubValue(t);
    setDisplayTime(t);
    v.currentTime = t;
    if (youtubeSync) {
      const wall = clipWallSec(youtubeSync);
      const yt = youtubeSync.youtubeRef.current;
      try {
        yt?.seekToSeconds(youtubeSync.clipStartSec + Math.min(t, wall));
      } catch {
        /* ignore */
      }
    }
  };

  const onRangePointerUp = () => {
    isScrubbingRef.current = false;
    const v = videoRef.current;
    if (v) {
      setScrubValue(v.currentTime);
      setDisplayTime(v.currentTime);
      if (youtubeSync) syncYoutubeToVideo({ forceSeek: true });
    }
  };

  return (
    <div className="prompter-viewer-video-bar" role="group" aria-label="Video playback">
      <button
        type="button"
        className="prompter-viewer-video-bar-btn"
        onClick={togglePlay}
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? 'Pause' : 'Play'}
      </button>
      <button
        type="button"
        className="prompter-viewer-video-bar-btn"
        onClick={restartFromBeginning}
        aria-label="Restart from beginning"
      >
        Restart
      </button>
      <div className="prompter-viewer-video-bar-scrub-wrap">
        {indeterminate ? (
          <div
            className="prompter-viewer-video-scrub-indeterminate-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuetext="Duration unknown"
          />
        ) : (
          <input
            type="range"
            className="prompter-viewer-video-scrub"
            min={0}
            max={rangeMax}
            step={0.01}
            value={rangeValue}
            disabled={!scrubEnabled}
            onPointerDown={onRangePointerDown}
            onPointerUp={onRangePointerUp}
            onPointerCancel={onRangePointerUp}
            onChange={onRangeChange}
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={effectiveDurationSeconds ?? undefined}
            aria-valuenow={scrubEnabled ? rangeValue : undefined}
          />
        )}
      </div>
      <span className="prompter-viewer-video-bar-time" aria-live="polite">
        {indeterminate ? (
          <>—:—— / —:——</>
        ) : effectiveDurationSeconds == null ? (
          <>{formatClock(displayTime)} / —:——</>
        ) : (
          <>
            {formatClock(displayTime)} / {formatClock(effectiveDurationSeconds)}
          </>
        )}
      </span>
      <label className="prompter-viewer-video-rate-label">
        <span className="prompter-sr-only">Playback speed</span>
        <select
          className="prompter-viewer-video-rate-select"
          value={snapToYoutubePlaybackRate(playbackRate)}
          onChange={(e) => applyPlaybackRate(Number(e.target.value))}
          aria-label="Playback speed"
        >
          {RATE_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {r === 1 ? '1×' : `${r}×`}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="prompter-viewer-video-bar-btn"
        onClick={toggleMute}
        aria-label={muted ? 'Unmute' : 'Mute'}
        aria-pressed={muted}
      >
        {muted ? 'Unmute' : 'Mute'}
      </button>
    </div>
  );
}
