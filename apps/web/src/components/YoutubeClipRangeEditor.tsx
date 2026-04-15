import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react';

type Dragging = 'start' | 'end' | null;

export type YoutubeClipRangeEditorProps = {
  /** From YT.Player.getDuration(); 0 means unknown / unavailable. */
  durationSec: number;
  startSec: number;
  endSec: number;
  onStartSecChange: (v: number) => void;
  onEndSecChange: (v: number) => void;
  /** When true, hides the track and shows API warning (inputs still work). */
  apiFailed?: boolean;
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function secFromClientX(track: HTMLDivElement, clientX: number, duration: number): number {
  const r = track.getBoundingClientRect();
  if (r.width <= 0 || duration <= 0) return 0;
  const x = clamp(clientX - r.left, 0, r.width);
  return Math.round((x / r.width) * duration);
}

/**
 * Custom dual-thumb range (no third-party slider). Numeric inputs live in the parent
 * and stay in sync via controlled props.
 */
export function YoutubeClipRangeEditor({
  durationSec,
  startSec,
  endSec,
  onStartSecChange,
  onEndSecChange,
  apiFailed = false,
}: YoutubeClipRangeEditorProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef<Dragging>(null);

  const dur = Number.isFinite(durationSec) && durationSec > 0 ? Math.floor(durationSec) : 0;
  const start = Math.max(0, Math.floor(startSec));
  const end = Math.max(0, Math.floor(endSec));

  const applyPair = useCallback(
    (nextStart: number, nextEnd: number) => {
      const d = dur;
      let a = clamp(Math.floor(nextStart), 0, d);
      let b = clamp(Math.floor(nextEnd), 0, d);
      if (d > 0) {
        if (b <= a) b = Math.min(d, a + 1);
        if (b <= a) a = Math.max(0, b - 1);
      } else {
        if (b <= a) b = a + 1;
      }
      if (a !== start) onStartSecChange(a);
      if (b !== end) onEndSecChange(b);
    },
    [dur, start, end, onStartSecChange, onEndSecChange],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const mode = draggingRef.current;
      const tr = trackRef.current;
      if (!mode || !tr || dur <= 0) return;
      const sec = secFromClientX(tr, e.clientX, dur);
      if (mode === 'start') {
        const maxStart = Math.max(0, end - 1);
        applyPair(clamp(sec, 0, maxStart), end);
      } else {
        const minEnd = Math.min(dur, start + 1);
        applyPair(start, clamp(sec, minEnd, dur));
      }
    },
    [dur, applyPair, start, end],
  );

  const endDrag = useCallback(() => {
    draggingRef.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
  }, [onPointerMove]);

  const beginDrag = (mode: 'start' | 'end') => (e: ReactPointerEvent<HTMLElement>) => {
    if (apiFailed || dur <= 0) return;
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = mode;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  };

  const pct = (s: number) => (dur > 0 ? (clamp(s, 0, dur) / dur) * 100 : 0);
  const leftPct = pct(start);
  const rightPct = pct(end);
  const rangeWidth = Math.max(0, rightPct - leftPct);

  return (
    <div className="prompter-youtube-clip-range">
      {apiFailed ? (
        <p className="prompter-youtube-clip-range-warning" role="status">
          YouTube preview controls could not load. Set the clip using the number fields — you can still save.
        </p>
      ) : null}
      <div
        ref={trackRef}
        className={`prompter-youtube-clip-range-track ${apiFailed || dur <= 0 ? 'prompter-youtube-clip-range-track--disabled' : ''}`}
        onPointerDown={(e) => {
          if (apiFailed || dur <= 0) return;
          const tr = trackRef.current;
          if (!tr) return;
          const sec = secFromClientX(tr, e.clientX, dur);
          const mid = (start + end) / 2;
          if (sec < mid) beginDrag('start')(e);
          else beginDrag('end')(e);
        }}
      >
        <div className="prompter-youtube-clip-range-fill" style={{ left: `${leftPct}%`, width: `${rangeWidth}%` }} />
        <button
          type="button"
          className="prompter-youtube-clip-range-thumb prompter-youtube-clip-range-thumb--start"
          style={{ left: `${leftPct}%` }}
          disabled={apiFailed || dur <= 0}
          aria-label="Clip start on timeline"
          onPointerDown={beginDrag('start')}
        />
        <button
          type="button"
          className="prompter-youtube-clip-range-thumb prompter-youtube-clip-range-thumb--end"
          style={{ left: `${rightPct}%` }}
          disabled={apiFailed || dur <= 0}
          aria-label="Clip end on timeline"
          onPointerDown={beginDrag('end')}
        />
      </div>
      {dur <= 0 && !apiFailed ? (
        <p className="prompter-hint">Load the preview to enable the clip timeline handles.</p>
      ) : null}
    </div>
  );
}
