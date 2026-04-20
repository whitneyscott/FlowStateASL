export interface ImportSinglePromptAssignmentDto {
  sourceSettingsAssignmentId: string;
  targetAssignmentId: string;
  /** Required when applying (non–dry-run): module for Canvas placement + Prompter LTI row above the assignment. */
  moduleId?: string;
  dryRun?: boolean;
}
