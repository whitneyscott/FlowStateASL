import { useMemo, type Ref, type RefObject } from 'react';
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
}: GradingVideoPlayerProps) {
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
        />
      </div>
      {!hideControls ? bar : null}
    </div>
  );
}
