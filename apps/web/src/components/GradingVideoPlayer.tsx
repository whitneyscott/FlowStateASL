import { useEffect, useMemo, useState, type Ref, type RefObject } from 'react';
import { GradingPlaybackBar, type GradingDurationSource } from './GradingPlaybackBar';
import type { YoutubeIframePlayerHandle } from './YoutubeIframePlayer';

export type { GradingDurationSource };

export interface GradingVideoPlayerProps {
  src: string;
  videoKey: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  videoDurationSeconds?: number | null;
  durationSource?: GradingDurationSource;
  /** Omit transport bar (e.g. dual YouTube grading layout). */
  hideControls?: boolean;
  /** When set (grading only), shows a CC toggle and a captions &lt;track&gt; (e.g. Deepgram WebVTT). */
  captionsVttSrc?: string;
  youtubeSync?: {
    youtubeRef: RefObject<YoutubeIframePlayerHandle | null>;
    clipStartSec: number;
    clipEndSec: number;
  };
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
  hideControls = false,
  captionsVttSrc,
  youtubeSync,
}: GradingVideoPlayerProps) {
  const [ccOn, setCcOn] = useState(false);

  useEffect(() => {
    setCcOn(false);
  }, [videoKey, captionsVttSrc]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !captionsVttSrc) return;
    const sync = () => {
      for (let i = 0; i < el.textTracks.length; i += 1) {
        el.textTracks[i].mode = ccOn ? 'showing' : 'hidden';
      }
    };
    sync();
    el.addEventListener('loadedmetadata', sync);
    return () => el.removeEventListener('loadedmetadata', sync);
  }, [videoRef, captionsVttSrc, ccOn, videoKey]);

  const bar = useMemo(
    () => (
      <GradingPlaybackBar
        videoRef={videoRef}
        videoKey={videoKey}
        videoDurationSeconds={videoDurationSeconds}
        durationSource={durationSource}
        youtubeSync={youtubeSync}
      />
    ),
    [videoRef, videoKey, videoDurationSeconds, durationSource, youtubeSync],
  );

  return (
    <div className="prompter-viewer-video-stack">
      <div className="prompter-viewer-video-frame">
        <video
          ref={videoRef as Ref<HTMLVideoElement>}
          key={videoKey}
          src={src}
          playsInline
          preload="metadata"
          className="prompter-viewer-video-element"
        >
          {captionsVttSrc ? (
            <track kind="captions" srcLang="en" label="Captions" src={captionsVttSrc} />
          ) : null}
        </video>
      </div>
      {captionsVttSrc ? (
        <div className="prompter-viewer-youtube-dual-toolbar">
          <label className="prompter-viewer-cc-toggle">
            <input type="checkbox" checked={ccOn} onChange={(e) => setCcOn(e.target.checked)} /> Show captions (submission)
          </label>
        </div>
      ) : null}
      {!hideControls ? bar : null}
    </div>
  );
}
