import { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { setLtiToken } from './lti-token.store';
import { setLastError } from '../common/last-error.store';
import type { LtiContext } from '../common/interfaces/lti-context.interface';

export interface PersistLtiContextOptions {
  /** When set, redirect to this URL instead of buildRedirectUrl (e.g. OAuth init). Receives token to build returnTo. */
  oauthInitUrlBuilder?: (token: string) => string;
}

/**
 * Persists LTI context to session, stores the one-time token, and redirects.
 * Used by LTI 1.3 launch (launch13) to avoid duplicating token/session/redirect logic.
 */
export function persistLtiContextAndRedirect(
  req: Request,
  res: Response,
  ctx: LtiContext,
  buildRedirectUrl: (token: string) => string,
  options?: PersistLtiContextOptions,
): void {
  const token = randomBytes(24).toString('hex');
  setLtiToken(token, ctx);

  const redirectTo = options?.oauthInitUrlBuilder
    ? options.oauthInitUrlBuilder(token)
    : buildRedirectUrl(token);

  if (req.session) {
    req.session.ltiContext = ctx;
    if (!req.session.ltiLaunchType) req.session.ltiLaunchType = '1.3';
    req.session.save((err) => {
      if (err) setLastError('/api/lti/launch', err);
      res.redirect(redirectTo);
    });
  } else {
    res.redirect(redirectTo);
  }
}
