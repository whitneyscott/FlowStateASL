export interface LtiContext {
  courseId: string;
  assignmentId: string;
  /** LTI subject (`sub` in 1.3) — opaque; not valid for Canvas REST paths like /submissions/:user_id/files. */
  userId: string;
  /**
   * Numeric Canvas user id from JWT custom `user_id` when the tool declares e.g. user_id=$Canvas.user.id.
   * If unset, API code must not fall back to `userId` for Canvas file/submission URLs — use OAuth /users/self or fix the tool config.
   */
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
  /** Tenant Canvas REST base URL (scheme + host). From LTI: custom API domain, launch return_url, or iss (self-hosted). */
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
  /** Submission display title from deep-link item (resource_link.title or custom.sprout_video_title). */
  submissionTitle?: string;
  ltiLaunchType?: '1.1' | '1.3';
}
