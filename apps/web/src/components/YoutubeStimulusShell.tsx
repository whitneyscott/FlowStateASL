import type { ReactNode } from 'react';
import type { YoutubeSubtitleMask } from '../api/prompt.api';

type MaskInput = YoutubeSubtitleMask | undefined;

/**
 * Relative wrapper for every YouTube stimulus frame so an opaque bottom mask
 * aligns identically (TeacherConfig, TimerPage, TeacherViewer).
 */
export function YoutubeStimulusShell({
  subtitleMask,
  children,
  className = '',
}: {
  subtitleMask?: MaskInput;
  children: ReactNode;
  className?: string;
}) {
  const sm = subtitleMask;
  const show = sm?.enabled === true && Number.isFinite(sm.heightPercent);
  const hp = show ? Math.min(30, Math.max(5, Math.round(Number(sm!.heightPercent)))) : 0;

  return (
    <div className={`prompter-youtube-stimulus-shell ${className}`.trim()}>
      {children}
      {show ? (
        <div
          className="prompter-youtube-stimulus-mask"
          style={{ height: `${hp}%` }}
          aria-hidden
        />
      ) : null}
    </div>
  );
}
