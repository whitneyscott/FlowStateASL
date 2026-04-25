/**
 * Sprout inline embed URL uses **video id** and **security token** (per Sprout API / embed_code),
 * not the account id. See https://www.sproutvideo.com/docs/api.html — `embed_code` contains
 * `videos.sproutvideo.com/embed/{id}/{security_token}`.
 */
export function parseSproutEmbedPairFromEmbedCode(embedCode: string | null | undefined): {
  videoId: string;
  securityToken: string;
} | null {
  if (!embedCode || typeof embedCode !== 'string') return null;
  const m = embedCode.match(/videos\.sproutvideo\.com\/embed\/([a-f0-9]+)\/([a-f0-9]+)/i);
  if (!m) return null;
  return { videoId: m[1], securityToken: m[2] };
}

export function buildSproutVideoEmbedUrl(videoId: string, securityToken: string): string {
  return `https://videos.sproutvideo.com/embed/${videoId.trim()}/${securityToken.trim()}`;
}
