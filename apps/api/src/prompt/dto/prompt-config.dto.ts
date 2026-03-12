export interface PromptConfigJson {
  minutes?: number;
  prompts?: string[];
  accessCode?: string;
  assignmentName?: string;
  assignmentGroupId?: string;
  pointsPossible?: number;
  rubricId?: string;
  dueAt?: string;
  unlockAt?: string;
  lockAt?: string;
  allowedAttempts?: number;
  shadowAssignmentId?: string;
  version?: string;
}

export class PutPromptConfigDto {
  minutes?: number;
  prompts?: string[];
  accessCode?: string;
  assignmentName?: string;
  assignmentGroupId?: string;
  pointsPossible?: number;
  rubricId?: string;
  dueAt?: string;
  unlockAt?: string;
  lockAt?: string;
  allowedAttempts?: number;
  shadowAssignmentId?: string;
  version?: string;
}
