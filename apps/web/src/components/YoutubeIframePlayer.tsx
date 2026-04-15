import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import {
  loadYoutubeIframeApi,
  snapToYoutubePlaybackRate,
  type YTPlayerInstance,
} from '../youtube/load-youtube-iframe-api';

export type YoutubeIframePlayerHandle = {
  playVideo: () => void;
  pauseVideo: () => void;
  seekToSeconds: (seconds: number) => void;
  setPlaybackRate: (rate: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  setCaptionsVisible: (visible: boolean) => void;
};

export type YoutubeIframePlayerProps = {
  videoId: string;
  clipStartSec: number;
  clipEndSec: number;
  allowStudentCaptions?: boolean;
  studentCaptionsVisible?: boolean;
  teacherCaptionsEnabled?: boolean;
  isStudent?: boolean;
  autoplay?: boolean;
  className?: string;
  onReady?: (info: { duration: number }) => void;
  onApiError?: (message: string) => void;
};

function applyCaptionsPolicy(p: YTPlayerInstance | null, visible: boolean) {
  if (!p) return;
  try {
    if (visible) p.loadModule('captions');
    else p.unloadModule('captions');
  } catch {
    /* ignore */
  }
}

export const YoutubeIframePlayer = forwardRef<YoutubeIframePlayerHandle, YoutubeIframePlayerProps>(
  function YoutubeIframePlayer(
    {
      videoId,
      clipStartSec,
      clipEndSec,
      allowStudentCaptions = false,
      studentCaptionsVisible = false,
      teacherCaptionsEnabled = false,
      isStudent = false,
      autoplay = false,
      className = '',
      onReady,
      onApiError,
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const playerRef = useRef<YTPlayerInstance | null>(null);
    const playerId = useMemo(
      () => `ytpl-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`,
      [],
    );

    const captionPropsRef = useRef({
      isStudent,
      allowStudentCaptions,
      studentCaptionsVisible,
      teacherCaptionsEnabled,
    });
    captionPropsRef.current = {
      isStudent,
      allowStudentCaptions,
      studentCaptionsVisible,
      teacherCaptionsEnabled,
    };

    const onReadyRef = useRef(onReady);
    onReadyRef.current = onReady;
    const onApiErrorRef = useRef(onApiError);
    onApiErrorRef.current = onApiError;

    useImperativeHandle(ref, () => ({
      playVideo: () => playerRef.current?.playVideo(),
      pauseVideo: () => playerRef.current?.pauseVideo(),
      seekToSeconds: (seconds: number) => {
        const p = playerRef.current;
        if (!p) return;
        p.seekTo(seconds, true);
      },
      setPlaybackRate: (rate: number) => {
        const p = playerRef.current;
        if (!p) return;
        try {
          p.setPlaybackRate(snapToYoutubePlaybackRate(rate));
        } catch {
          /* ignore */
        }
      },
      getCurrentTime: () => {
        try {
          return playerRef.current?.getCurrentTime() ?? 0;
        } catch {
          return 0;
        }
      },
      getDuration: () => {
        try {
          return playerRef.current?.getDuration() ?? 0;
        } catch {
          return 0;
        }
      },
      setCaptionsVisible: (visible: boolean) => applyCaptionsPolicy(playerRef.current, visible),
    }));

    const start = Math.max(0, Math.floor(clipStartSec));
    const end = Math.floor(clipEndSec);
    const endClamped = end > start ? end : start + 1;
    const vid = videoId.trim();

    useEffect(() => {
      const host = hostRef.current;
      if (!host || !vid) return;

      let cancelled = false;
      let created: YTPlayerInstance | null = null;

      (async () => {
        try {
          await loadYoutubeIframeApi();
        } catch (e) {
          if (!cancelled) {
            onApiErrorRef.current?.(e instanceof Error ? e.message : 'YouTube IFrame API failed to load');
          }
          return;
        }
        if (cancelled || !hostRef.current) return;

        host.innerHTML = '';
        const mount = document.createElement('div');
        mount.id = playerId;
        host.appendChild(mount);

        const YT = window.YT;
        if (!YT?.Player) {
          onApiErrorRef.current?.('YouTube IFrame API is not available');
          return;
        }

        try {
          created = new YT.Player(mount.id, {
            host: 'https://www.youtube-nocookie.com',
            videoId: vid,
            width: '100%',
            height: '100%',
            playerVars: {
              controls: 0,
              modestbranding: 1,
              rel: 0,
              playsinline: 1,
              start,
              end: endClamped,
              cc_load_policy: 0,
              enablejsapi: 1,
              origin: typeof window !== 'undefined' ? window.location.origin : undefined,
              autoplay: autoplay ? 1 : 0,
            },
            events: {
              onReady: (ev: { target: YTPlayerInstance }) => {
                if (cancelled) return;
                const pl = ev.target;
                playerRef.current = pl;
                let duration = 0;
                try {
                  duration = pl.getDuration() ?? 0;
                } catch {
                  duration = 0;
                }
                const c = captionPropsRef.current;
                if (c.isStudent) {
                  if (c.allowStudentCaptions) applyCaptionsPolicy(pl, c.studentCaptionsVisible);
                  else applyCaptionsPolicy(pl, false);
                } else {
                  applyCaptionsPolicy(pl, c.teacherCaptionsEnabled);
                }
                onReadyRef.current?.({ duration });
              },
              onError: (ev: { data?: number }) => {
                onApiErrorRef.current?.(`YouTube player error (${ev?.data ?? 'unknown'})`);
              },
            },
          });
        } catch (e) {
          onApiErrorRef.current?.(e instanceof Error ? e.message : 'Failed to create YouTube player');
        }
      })();

      return () => {
        cancelled = true;
        playerRef.current = null;
        try {
          created?.destroy();
        } catch {
          /* ignore */
        }
        if (hostRef.current) hostRef.current.innerHTML = '';
      };
    }, [vid, start, endClamped, playerId, autoplay]);

    useEffect(() => {
      const p = playerRef.current;
      if (!p) return;
      const c = captionPropsRef.current;
      if (c.isStudent) {
        if (c.allowStudentCaptions) applyCaptionsPolicy(p, c.studentCaptionsVisible);
        else applyCaptionsPolicy(p, false);
      } else {
        applyCaptionsPolicy(p, c.teacherCaptionsEnabled);
      }
    }, [isStudent, allowStudentCaptions, studentCaptionsVisible, teacherCaptionsEnabled]);

    return (
      <div
        ref={hostRef}
        className={className}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      />
    );
  },
);
