/** Canonical student/teacher preview embed (matches CSP expectations for nocookie). */
export function buildYoutubeNocookieEmbedSrc(
  videoId: string,
  opts?: { startSec?: number; endSec?: number },
): string {
  const id = videoId.trim();
  const start = Math.max(0, Math.floor(opts?.startSec ?? 0));
  const endRaw = opts?.endSec !== undefined ? Math.floor(opts.endSec) : undefined;
  const params = new URLSearchParams({ rel: '0' });
  if (start > 0) params.set('start', String(start));
  if (endRaw != null && Number.isFinite(endRaw) && endRaw > start) {
    params.set('end', String(endRaw));
  }
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?${params.toString()}`;
}
