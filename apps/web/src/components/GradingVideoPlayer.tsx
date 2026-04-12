import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type RefObject,
  type Ref,
} from 'react';

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

export interface GradingVideoPlayerProps {
  src: string;
  videoKey: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  videoDurationSeconds?: number | null;
  durationSource?: GradingDurationSource;
}

/**
 * Grading viewer video without native controls: stable scrub using API duration when
 * media duration is wrong (e.g. proxied WebM). Parent keeps videoRef for time/feedback/deck.
 */
export function GradingVideoPlayer({
  src,
  videoKey,
  videoRef,
  videoDurationSeconds,
  durationSource,
}: GradingVideoPlayerProps) {
  const isScrubbingRef = useRef(false);
  const [scrubValue, setScrubValue] = useState(0);
  const [displayTime, setDisplayTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [mediaDuration, setMediaDuration] = useState<number | null>(null);

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

  useEffect(() => {
    setMediaDuration(null);
    setDisplayTime(0);
    setScrubValue(0);
    setPlaying(false);
    isScrubbingRef.current = false;
  }, [videoKey, src]);

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
    };

    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => setPlaying(false);
    const onVolume = () => setMuted(v.muted);

    syncMediaDuration();
    setMuted(v.muted);
    setDisplayTime(v.currentTime);
    setScrubValue(v.currentTime);
    setPlaying(!v.paused);

    v.addEventListener('loadedmetadata', syncMediaDuration);
    v.addEventListener('durationchange', syncMediaDuration);
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onEnded);
    v.addEventListener('volumechange', onVolume);

    return () => {
      v.removeEventListener('loadedmetadata', syncMediaDuration);
      v.removeEventListener('durationchange', syncMediaDuration);
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('volumechange', onVolume);
    };
  }, [videoKey, src, videoRef, readMediaDuration]);

  const mediaFinite = mediaDuration != null;
  /** Unknown provenance, no API length, and media has not reported a finite duration. */
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
  };

  const onRangePointerUp = () => {
    isScrubbingRef.current = false;
    const v = videoRef.current;
    if (v) {
      setScrubValue(v.currentTime);
      setDisplayTime(v.currentTime);
    }
  };

  return (
    <div className="prompter-viewer-video-stack">
      {/* Frame clips only the picture; bar stays outside so tall videos cannot hide controls. */}
      <div className="prompter-viewer-video-frame">
        <video
          ref={videoRef as Ref<HTMLVideoElement>}
          key={videoKey}
          src={src}
          playsInline
          preload="metadata"
          className="prompter-viewer-video-element"
        />
      </div>
      <div className="prompter-viewer-video-bar" role="group" aria-label="Video playback">
        <button
          type="button"
          className="prompter-viewer-video-bar-btn"
          onClick={togglePlay}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? 'Pause' : 'Play'}
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
            <>
              {formatClock(displayTime)} / —:——
            </>
          ) : (
            <>
              {formatClock(displayTime)} / {formatClock(effectiveDurationSeconds)}
            </>
          )}
        </span>
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
    </div>
  );
}
