export interface AssignmentPrompt {
  courseId: string;
  assignmentId: string;
  userId: string;
  resourceLinkId: string;
  promptText: string;
  createdAt: Date;
}

export interface StudentReset {
  courseId: string;
  assignmentId: string;
  userId: string;
  resetAt: Date;
}

export interface IPromptDataRepository {
  saveAssignmentPrompt(prompt: {
    courseId: string;
    assignmentId: string;
    userId: string;
    resourceLinkId?: string;
    promptText: string;
  }): Promise<void>;

  getAssignmentPrompt(
    courseId: string,
    assignmentId: string,
    userId: string
  ): Promise<AssignmentPrompt | null>;

  recordStudentReset(
    courseId: string,
    assignmentId: string,
    userId: string
  ): Promise<void>;

  isStudentReset(
    courseId: string,
    assignmentId: string,
    userId: string
  ): Promise<boolean>;

  clearStudentReset(
    courseId: string,
    assignmentId: string,
    userId: string
  ): Promise<void>;
}
