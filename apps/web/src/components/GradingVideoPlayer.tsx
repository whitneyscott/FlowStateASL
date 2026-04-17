import { useEffect, useMemo, useRef, useState, type Ref, type RefObject } from 'react';
import { GradingPlaybackBar, type GradingDurationSource } from './GradingPlaybackBar';
import type { YoutubeIframePlayerHandle } from './YoutubeIframePlayer';
import { ltiTokenHeaders } from '../api/lti-token';

export type { GradingDurationSource };

export interface GradingVideoPlayerProps {
  src: string;
  videoKey: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  videoDurationSeconds?: number | null;
  durationSource?: GradingDurationSource;
  /** Omit transport bar (e.g. dual YouTube grading layout). */
  hideControls?: boolean;
  /** When set (grading only), prefetch VTT then show CC toggle + &lt;track&gt; so a 404/race never breaks the main video. */
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
  const [vttBlobUrl, setVttBlobUrl] = useState<string | null>(null);
  const captionFetchSeq = useRef(0);

  useEffect(() => {
    setCcOn(false);
  }, [videoKey, captionsVttSrc]);

  useEffect(() => {
    if (!captionsVttSrc?.trim()) {
      setVttBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      return;
    }

    const ac = new AbortController();
    const seq = ++captionFetchSeq.current;
    const clearVtt = () =>
      setVttBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });

    void (async () => {
      try {
        const res = await fetch(captionsVttSrc, {
          credentials: 'include',
          signal: ac.signal,
          headers: { ...ltiTokenHeaders() },
        });
        if (ac.signal.aborted || seq !== captionFetchSeq.current) return;
        if (!res.ok) {
          if (seq === captionFetchSeq.current) clearVtt();
          return;
        }
        const text = await res.text();
        if (ac.signal.aborted || seq !== captionFetchSeq.current) return;
        if (!text.trim()) {
          if (seq === captionFetchSeq.current) clearVtt();
          return;
        }
        const blob = new Blob([text], { type: 'text/vtt;charset=utf-8' });
        const nextUrl = URL.createObjectURL(blob);
        if (ac.signal.aborted || seq !== captionFetchSeq.current) {
          URL.revokeObjectURL(nextUrl);
          return;
        }
        setVttBlobUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return nextUrl;
        });
      } catch {
        if (!ac.signal.aborted && seq === captionFetchSeq.current) clearVtt();
      }
    })();

    return () => {
      ac.abort();
      clearVtt();
    };
  }, [captionsVttSrc]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !vttBlobUrl) return;
    const sync = () => {
      for (let i = 0; i < el.textTracks.length; i += 1) {
        el.textTracks[i].mode = ccOn ? 'showing' : 'hidden';
      }
    };
    sync();
    el.addEventListener('loadedmetadata', sync);
    return () => el.removeEventListener('loadedmetadata', sync);
  }, [videoRef, vttBlobUrl, ccOn, videoKey]);

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
          {vttBlobUrl ? (
            <track kind="captions" srcLang="en" label="Captions" src={vttBlobUrl} />
          ) : null}
        </video>
      </div>
      {vttBlobUrl ? (
        <div className="prompter-viewer-youtube-dual-toolbar">
          <label className="prompter-viewer-cc-toggle">
            <input type="checkbox" checked={ccOn} onChange={(e) => setCcOn(e.target.checked)} />{' '}
            Show captions (Canvas submission video)
          </label>
        </div>
      ) : null}
      {!hideControls ? bar : null}
    </div>
  );
}
