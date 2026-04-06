export interface LtiContext {
  courseId: string;
  assignmentId: string;
  userId: string;
  /** Numeric Canvas user id from custom ($Canvas.user.id). Use for Canvas REST; keep `userId` as LTI identity when opaque (1.3 sub). */
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
  /** Canvas instance hostname extracted from LTI launch */
  canvasDomain?: string;
  /** AGS lineitems URL from launch JWT (for Step 11b). */
  agsLineitemsUrl?: string;
  /** AGS single lineitem URL from launch JWT. */
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
  /** Submission display title from deep-link item (resource_link.title or custom.sprout_video_title). */
  submissionTitle?: string;
}
