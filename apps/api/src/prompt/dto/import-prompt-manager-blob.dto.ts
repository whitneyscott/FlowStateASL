export interface PromptManagerBlobPayload {
  v?: number;
  configs?: Record<string, unknown>;
  resourceLinkAssignmentMap?: Record<string, string>;
  updatedAt?: string;
}

export interface ImportPromptManagerBlobDto {
  blob?: PromptManagerBlobPayload;
  mode: 'merge' | 'replace_selected';
  /**
   * Required when applying an import (`dryRun` false). Canvas module id where each imported
   * assignment is placed and the Prompter external tool is synced above it (same behavior as Save in Prompt Manager).
   */
  targetModuleId?: string;
  sourceCourseId?: string;
  /** Same course: read exported PM JSON from this assignment's description (orphan / duplicate settings). */
  sourceAssignmentId?: string;
  assignmentIdMap?: Record<string, string>;
  replaceSourceAssignmentIds?: string[];
  dryRun?: boolean;
  skipSourceAssignmentIds?: string[];
}
