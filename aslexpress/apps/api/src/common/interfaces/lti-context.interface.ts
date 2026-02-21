export interface LtiContext {
  courseId: string;
  assignmentId: string;
  userId: string;
  resourceLinkId: string;
  moduleId: string;
  toolType: 'flashcards' | 'prompter';
  roles: string;
  resourceLinkTitle?: string;
  assignmentNameSynced?: boolean;
  /** LTI 1.1 Outcomes API — Canvas sends when launched in assignment context */
  lisOutcomeServiceUrl?: string;
  lisResultSourcedid?: string;
}
