/**
 * Client-side mirror of API `normalizeYoutubeInputToVideoId` — keep parsing rules in sync.
 */
const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

function extractSrcFromIframeSnippet(html: string): string | null {
  const m = html.match(/<iframe[^>]+src\s*=\s*["']([^"']+)["']/i);
  return m?.[1]?.trim() ?? null;
}

export function normalizeYoutubeInputToVideoIdClient(input: string): string {
  let raw = (input ?? '').trim();
  if (!raw) {
    throw new Error('YouTube URL or video ID is required.');
  }
  if (VIDEO_ID_RE.test(raw)) {
    return raw;
  }
  if (/<iframe/i.test(raw)) {
    const src = extractSrcFromIframeSnippet(raw);
    if (!src) {
      throw new Error('Could not find a valid iframe src for YouTube embed.');
    }
    raw = src;
  }
  let url: URL;
  try {
    raw = raw.startsWith('//') ? `https:${raw}` : raw;
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    throw new Error('Invalid YouTube URL or video ID.');
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const allowedHosts = new Set([
    'youtube.com',
    'm.youtube.com',
    'youtube-nocookie.com',
    'youtu.be',
  ]);
  if (!allowedHosts.has(host)) {
    throw new Error('Only youtube.com, youtu.be, and youtube-nocookie.com links are allowed.');
  }
  if (host === 'youtu.be') {
    const id = url.pathname.replace(/^\//, '').split('/')[0]?.split('?')[0] ?? '';
    if (VIDEO_ID_RE.test(id)) return id;
    throw new Error('Could not extract a valid YouTube video ID from this youtu.be link.');
  }
  const path = url.pathname;
  if (path.startsWith('/embed/') || path.startsWith('/shorts/')) {
    const id = path.split('/').filter(Boolean)[1]?.split('?')[0] ?? '';
    if (VIDEO_ID_RE.test(id)) return id;
  }
  const v = url.searchParams.get('v');
  if (v && VIDEO_ID_RE.test(v)) {
    return v;
  }
  throw new Error('Could not extract a valid 11-character YouTube video ID from this URL.');
}
