import * as promptApi from '../api/prompt.api';

/**
 * Resolve API `videoUrl` to a value suitable for `<video src>`.
 * Canvas proxy URLs need a POST-minted `proxy_token` (no JWT in query).
 */
export async function resolveViewerVideoPlaybackUrl(videoUrlFromApi: string): Promise<string> {
  if (!videoUrlFromApi.includes('/api/prompt/video-proxy')) {
    return videoUrlFromApi;
  }
  if (videoUrlFromApi.includes('proxy_token=')) {
    return videoUrlFromApi;
  }
  let canvasUrl: string;
  try {
    const u = new URL(videoUrlFromApi, window.location.origin);
    const p = u.searchParams.get('url');
    if (!p?.trim()) throw new Error('Missing video url');
    canvasUrl = p.trim();
  } catch {
    throw new Error('Invalid video proxy URL');
  }
  const { playbackUrl } = await promptApi.mintVideoProxyPlaybackUrl(canvasUrl);
  return playbackUrl;
}
