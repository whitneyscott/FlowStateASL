/** Deck recording: card boundaries in seconds from MediaRecorder start (actual timeline, survives scrubbing). */
export class DeckTimelineEntryDto {
  title: string;
  startSec: number;
  /** Sprout video id for the prompt source clip (optional; older clients omit). */
  videoId?: string;
  /** Sprout security token — second path segment in embed URL (optional; older clients omit). */
  securityToken?: string;
}

export class SubmitPromptDto {
  /** Text-prompt mode only. Omit when `deckTimeline` carries the full prompt (deck mode). */
  promptSnapshotHtml?: string;
  deckTimeline?: DeckTimelineEntryDto[];
}
