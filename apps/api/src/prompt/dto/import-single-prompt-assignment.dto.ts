export interface ImportSinglePromptAssignmentDto {
  /** Source Canvas assignment id selected in import modal. */
  sourceAssignmentId?: string;
  /** @deprecated Backward compatibility field; use sourceAssignmentId. */
  sourceSettingsAssignmentId?: string;
  /** Defaults to sourceAssignmentId when omitted. */
  targetAssignmentId?: string;
  /**
   * Required. Canvas module where the assignment is placed and the Prompter tool is added above it
   * (mirrors Prompt Manager save).
   */
  moduleId?: string;
  /**
   * When set, forces `promptMode` on the imported embed after merging source data.
   * Omit to use Auto: infer from structured fields (and ASL embed merged from source description).
   */
  promptMode?: 'text' | 'decks' | 'youtube';
}
