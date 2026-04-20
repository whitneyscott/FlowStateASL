export interface ImportSinglePromptAssignmentDto {
  sourceSettingsAssignmentId: string;
  targetAssignmentId: string;
  /**
   * Optional override. When omitted, the API uses the Canvas module that already contains this assignment
   * (first match in module order); if none, apply fails until the teacher picks a module.
   */
  moduleId?: string;
  dryRun?: boolean;
}
