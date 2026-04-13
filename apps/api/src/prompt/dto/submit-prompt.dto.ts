/** Deck recording: card boundaries in seconds from MediaRecorder start (actual timeline, survives scrubbing). */
export class DeckTimelineEntryDto {
  title: string;
  startSec: number;
  /** Sprout video id for the prompt source clip (optional; older clients omit). */
  videoId?: string;
}

export class SubmitPromptDto {
  promptSnapshotHtml: string;
  deckTimeline?: DeckTimelineEntryDto[];
}
