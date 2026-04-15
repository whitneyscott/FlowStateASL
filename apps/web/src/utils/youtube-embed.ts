/** Canonical student/teacher preview embed (matches CSP expectations for nocookie). */
export function buildYoutubeNocookieEmbedSrc(
  videoId: string,
  opts?: {
    startSec?: number;
    endSec?: number;
    /** Best-effort; many browsers require a recent user gesture for audible autoplay. */
    autoplay?: boolean;
    mute?: boolean;
    playsinline?: boolean;
    /** Non-interactive embeds only; interactive flows use YT.Player. */
    ccLoadPolicy?: 0 | 1;
  },
): string {
  const id = videoId.trim();
  const start = Math.max(0, Math.floor(opts?.startSec ?? 0));
  const endRaw = opts?.endSec !== undefined ? Math.floor(opts.endSec) : undefined;
  const params = new URLSearchParams({ rel: '0' });
  if (opts?.ccLoadPolicy === 1) params.set('cc_load_policy', '1');
  if (start > 0) params.set('start', String(start));
  if (endRaw != null && Number.isFinite(endRaw) && endRaw > start) {
    params.set('end', String(endRaw));
  }
  if (opts?.autoplay) params.set('autoplay', '1');
  if (opts?.mute) params.set('mute', '1');
  if (opts?.playsinline !== false) params.set('playsinline', '1');
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?${params.toString()}`;
}
