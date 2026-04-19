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
  youtubeSync?: {
    youtubeRef: RefObject<YoutubeIframePlayerHandle | null>;
    clipStartSec: number;
    clipEndSec: number;
  };
  /** Optional WebVTT for embedded submission captions (`<track kind="subtitles">`). */
  captionsVtt?: string;
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
  youtubeSync,
  captionsVtt,
}: GradingVideoPlayerProps) {
  const [vttObjectUrl, setVttObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    const raw = (captionsVtt ?? '').trim();
    if (!raw) {
      setVttObjectUrl(null);
      return;
    }
    const blob = new Blob([raw], { type: 'text/vtt;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    setVttObjectUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [captionsVtt]);

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
          {vttObjectUrl ? (
            <track kind="subtitles" src={vttObjectUrl} srcLang="en" label="Transcript" default />
          ) : null}
        </video>
      </div>
      {!hideControls ? bar : null}
    </div>
  );
}
