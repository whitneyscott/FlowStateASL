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
  /** Canvas instance hostname (legacy) */
  canvasDomain?: string;
  /** Full Canvas base URL from LTI iss (e.g. http://localhost:3001) - use for API calls to preserve scheme+port */
  canvasBaseUrl?: string;
  /** Canvas OAuth access token — from session after OAuth flow; use for Canvas API, not LTI JWT */
  canvasAccessToken?: string;
}
