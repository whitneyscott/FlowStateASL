export interface PromptManagerBlobPayload {
  v?: number;
  configs?: Record<string, unknown>;
  resourceLinkAssignmentMap?: Record<string, string>;
  updatedAt?: string;
}

export interface ImportPromptManagerBlobDto {
  blob?: PromptManagerBlobPayload;
  mode: 'merge' | 'replace_selected';
  sourceCourseId?: string;
  assignmentIdMap?: Record<string, string>;
  replaceSourceAssignmentIds?: string[];
  dryRun?: boolean;
  skipSourceAssignmentIds?: string[];
}
