export interface ImportSinglePromptAssignmentDto {
  /** Source Canvas assignment id selected in import modal. */
  sourceAssignmentId?: string;
  /** @deprecated Backward compatibility field; use sourceAssignmentId. */
  sourceSettingsAssignmentId?: string;
  /** Defaults to sourceAssignmentId when omitted. */
  targetAssignmentId?: string;
  /**
   * Required when applying (`dryRun` false). Canvas module where the assignment is placed and the
   * Prompter tool is added above it (mirrors Prompt Manager save). Dry-run may omit this to preview only.
   */
  moduleId?: string;
  dryRun?: boolean;
}
