/**
 * Sprout video embed URL — must match `FlashcardsPage` `buildEmbed` (raw account + id in path).
 * The Sprout `videoId` here is the API/media id (same as flashcard `items` rows).
 */
export function buildSproutVideoEmbedUrl(sproutAccountId: string, videoId: string): string {
  const a = sproutAccountId.trim();
  const v = videoId.trim();
  return `https://videos.sproutvideo.com/embed/${a}/${v}`;
}
