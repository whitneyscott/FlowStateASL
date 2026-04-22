export interface ImportSinglePromptAssignmentDto {
  /** Source Canvas assignment id selected in import modal. */
  sourceAssignmentId?: string;
  /** @deprecated Backward compatibility field; use sourceAssignmentId. */
  sourceSettingsAssignmentId?: string;
  /** Defaults to sourceAssignmentId when omitted. */
  targetAssignmentId?: string;
  /**
   * Optional override. When omitted, the API uses the Canvas module that already contains this assignment
   * (first match in module order); if none, apply fails until the teacher picks a module.
   */
  moduleId?: string;
  dryRun?: boolean;
}
