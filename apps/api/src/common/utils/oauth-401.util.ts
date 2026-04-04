import type { Session } from 'express-session';

/**
 * When Canvas token is expired/missing, return 401 body.
 * For LTI 1.1 (ltiLaunchType === '1.1'), use needsManualToken so frontend shows manual token form.
 * For LTI 1.3, use redirectToOAuth so frontend redirects to OAuth flow.
 */
export function getOAuth401Body(req: { session?: Session }): {
  error: string;
  redirectToOAuth?: boolean;
  needsManualToken?: boolean;
  message?: string;
} {
  const ltiLaunchType = (req.session as { ltiLaunchType?: '1.1' | '1.3' })?.ltiLaunchType;

  if (ltiLaunchType !== '1.3') {
    return {
      error: 'Canvas token expired',
      needsManualToken: true,
      message: 'Enter your Canvas API token to continue.',
    };
  }

  return {
    error: 'Canvas token expired',
    redirectToOAuth: true,
    message: 'Re-authorize with Canvas to continue.',
  };
}
