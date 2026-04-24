import type { PromptConfigJson } from './dto/prompt-config.dto';

/**
 * Infer prompt mode from structured config fields (embed / blob), not from free-form HTML.
 * YouTube wins when a valid clip is configured; then deck-shaped videoPromptConfig; else explicit promptMode; default text.
 */
export function inferPromptModeFromStructuredConfig(cfg: PromptConfigJson): 'text' | 'decks' | 'youtube' {
  const y = cfg.youtubePromptConfig;
  const vid = typeof y?.videoId === 'string' ? y.videoId.trim() : '';
  if (vid) {
    const end = Math.floor(Number(y?.clipEndSec));
    const start = Math.max(0, Math.floor(Number(y?.clipStartSec ?? 0)));
    if (Number.isFinite(end) && end > start) return 'youtube';
    const legacy = Math.floor(Number((y as { durationSec?: unknown }).durationSec));
    if (Number.isFinite(legacy) && legacy >= 1) return 'youtube';
  }
  const vpc = cfg.videoPromptConfig;
  const decks = vpc?.selectedDecks;
  const tc = Math.floor(Number(vpc?.totalCards));
  if (Array.isArray(decks) && decks.length > 0 && Number.isFinite(tc) && tc >= 1) return 'decks';
  const banks = vpc?.storedPromptBanks;
  if (Array.isArray(banks) && banks.some((b) => Array.isArray(b) && b.length > 0)) return 'decks';
  if (cfg.promptMode === 'decks') return 'decks';
  if (cfg.promptMode === 'youtube') return 'youtube';
  if (cfg.promptMode === 'text') return 'text';
  return 'text';
}

/**
 * Overlay ASL-embed-derived fields from the source assignment onto merged import config.
 * Preserves DTO `moduleId` (Canvas placement) on merged.
 */
export function mergeSourceEmbedForImport(
  merged: PromptConfigJson,
  embed: PromptConfigJson,
  moduleIdTrim: string,
): PromptConfigJson {
  return {
    ...merged,
    ...(embed.promptMode === 'text' || embed.promptMode === 'decks' || embed.promptMode === 'youtube'
      ? { promptMode: embed.promptMode }
      : {}),
    ...(embed.videoPromptConfig ? { videoPromptConfig: embed.videoPromptConfig } : {}),
    ...(embed.youtubePromptConfig ? { youtubePromptConfig: embed.youtubePromptConfig } : {}),
    ...(Array.isArray(embed.prompts) ? { prompts: embed.prompts } : {}),
    ...(embed.accessCode !== undefined ? { accessCode: embed.accessCode } : {}),
    ...(embed.minutes != null && Number.isFinite(Number(embed.minutes)) ? { minutes: embed.minutes } : {}),
    ...(embed.signToVoiceRequired !== undefined ? { signToVoiceRequired: embed.signToVoiceRequired } : {}),
    ...(typeof embed.version === 'string' && embed.version.trim() ? { version: embed.version.trim() } : {}),
    ...(typeof embed.instructions === 'string' && embed.instructions.trim()
      ? { instructions: embed.instructions }
      : {}),
    moduleId: moduleIdTrim,
  };
}
