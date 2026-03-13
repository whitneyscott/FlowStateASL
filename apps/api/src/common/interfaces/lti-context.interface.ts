export interface LtiContext {
  courseId: string;
  assignmentId: string;
  userId: string;
  /** Canvas numeric user ID from custom user_id ($Canvas.user.id). Use for Canvas API submission GET. */
  canvasUserId?: string;
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
  /** LTI 1.1 Outcomes API — Canvas sends when launched in assignment context */
  lisOutcomeServiceUrl?: string;
  lisResultSourcedid?: string;
  /** Canvas instance hostname (legacy) */
  canvasDomain?: string;
  /** Full Canvas base URL from LTI iss (e.g. http://localhost:3001) - use for API calls to preserve scheme+port */
  canvasBaseUrl?: string;
  /** Canvas OAuth access token — from session after OAuth flow; use for Canvas API, not LTI JWT */
  canvasAccessToken?: string;
  /** AGS lineitems URL from launch JWT (for Step 11b). Canvas sends when AGS is enabled on the Developer Key. */
  agsLineitemsUrl?: string;
  /** AGS single lineitem URL from launch JWT (optional; Canvas may send for specific resource links). */
  agsLineitemUrl?: string;
  /** When message_type is LtiDeepLinkingRequest (e.g. homework_submission). */
  messageType?: 'LtiResourceLinkRequest' | 'LtiDeepLinkingRequest';
  /** Deep Linking: URL where the tool must POST the LtiDeepLinkingResponse JWT. */
  deepLinkReturnUrl?: string;
  /** Deep Linking: opaque data from platform to echo back in the response. */
  deepLinkData?: string;
  /** Platform issuer from launch JWT (for Deep Linking response aud). */
  platformIss?: string;
  /** Deployment ID from launch JWT (for Deep Linking response). */
  deploymentId?: string;
  /** From ltiResourceLink custom: when viewing a homework submission, Canvas passes this. */
  submissionToken?: string;
}
