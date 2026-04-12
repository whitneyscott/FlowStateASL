import { getAuthToken } from '../api/lti-token';

/**
 * HTML video elements cannot send `Authorization: Bearer`. Cookieless LTI uses in-memory JWT
 * for fetch(); append it for our video-proxy URL so grading viewer playback works.
 */
export function videoSrcWithBearerIfNeeded(url: string): string {
  const token = getAuthToken();
  if (!token) return url;
  if (!url.includes('/api/prompt/video-proxy')) return url;
  if (url.includes('access_token=')) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}access_token=${encodeURIComponent(token)}`;
}
