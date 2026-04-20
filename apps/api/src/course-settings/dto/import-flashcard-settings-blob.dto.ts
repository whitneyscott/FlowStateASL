export interface FlashcardBlobPayload {
  v?: number;
  selectedCurriculums?: string[];
  selectedUnits?: string[];
  updatedAt?: string;
}

export interface ImportFlashcardSettingsBlobDto {
  blob?: FlashcardBlobPayload;
  mode: 'merge' | 'replace_selected';
  sourceCourseId?: string;
  dryRun?: boolean;
}
