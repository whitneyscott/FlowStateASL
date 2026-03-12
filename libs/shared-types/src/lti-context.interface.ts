export interface LtiContext {
  courseId: string;
  assignmentId: string;
  userId: string;
  resourceLinkId: string;
  moduleId: string;
  toolType: 'flashcards' | 'prompter';
  /** Raw custom.tool_type from LTI JWT (for Step 4 bridge debug). */
  customToolTypeFromJwt?: string;
  /** SPA path used for post-launch redirect (e.g. /flashcards). Set at launch for bridge debug log. */
  redirectPath?: string;
  roles: string;
  resourceLinkTitle?: string;
  assignmentNameSynced?: boolean;
  /** Canvas instance hostname extracted from LTI launch */
  canvasDomain?: string;
  /** AGS lineitems URL from launch JWT (for Step 11b). */
  agsLineitemsUrl?: string;
  /** AGS single lineitem URL from launch JWT. */
  agsLineitemUrl?: string;
}
