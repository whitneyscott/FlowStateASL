/** Deck recording: card boundaries in seconds from MediaRecorder start (actual timeline, survives scrubbing). */
export class DeckTimelineEntryDto {
  title: string;
  startSec: number;
}

export class SubmitPromptDto {
  promptSnapshotHtml: string;
  deckTimeline?: DeckTimelineEntryDto[];
}
