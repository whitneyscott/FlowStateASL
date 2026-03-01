export class SubmitFlashcardDto {
  score: number;
  scoreTotal: number;
  deckIds: string[];
  wordCount?: number;
  mode?: string;
  playlistTitle?: string;
  incorrectItems?: Array<{ videoId: string; name: string }>;
}
