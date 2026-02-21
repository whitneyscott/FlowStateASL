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
  /** Canvas instance hostname extracted from LTI launch */
  canvasDomain?: string;
}
