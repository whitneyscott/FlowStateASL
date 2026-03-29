import { Controller, Get, Post, Body, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { appendLtiLog } from '../common/last-error.store';
import type { LtiContext } from '../common/interfaces/lti-context.interface';
import { canvasApiBaseFromLtiContext } from '../common/utils/canvas-base-url.util';
import { DEFAULT_CANVAS_OAUTH_SCOPES } from './canvas-oauth-scopes';

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 min
const oauthStateStore = new Map<
  string,
  { canvasBaseUrl: string; returnTo: string; expires: number }
>();

@Controller('oauth/canvas')
export class CanvasOAuthController {
  constructor(private readonly config: ConfigService) {}

  /**
   * Store manual Canvas API token in session (for LTI 1.1 users who cannot use OAuth2).
   * Requires session with ltiContext from LTI 1.1 launch.
   */
  @Post('token')
  storeManualToken(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: { token?: string },
  ) {
    const token = (body?.token ?? '').toString().trim();
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }
    if (!req.session?.ltiContext) {
      return res.status(403).json({ error: 'LTI context required' });
    }
    req.session.canvasAccessToken = token;
    req.session.save((err) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to save token' });
      }
      appendLtiLog('oauth', 'Manual token stored in session');
      return res.json({ success: true });
    });
  }

  /**
   * Clear Canvas API token from session (OAuth or manual token).
   * Keeps LTI context/session so the app can immediately prompt for auth again.
   */
  @Post('token/reset')
  resetToken(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!req.session?.ltiContext) {
      return res.status(403).json({ error: 'LTI context required' });
    }
    const hadToken = !!(req.session.canvasAccessToken ?? '').trim();
    delete req.session.canvasAccessToken;
    req.session.save((err) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to clear token' });
      }
      appendLtiLog('oauth', 'Canvas token cleared from session', { hadToken });
      return res.json({ success: true, hadToken });
    });
  }

  /**
   * Initiate Canvas OAuth. Redirects user to Canvas authorize URL.
   * Requires session with ltiContext (canvasBaseUrl) from LTI launch.
   * Short-circuits for LTI 1.1: redirects back to app instead of OAuth2.
   */
  @Get()
  async init(
    @Req() req: Request,
    @Res() res: Response,
    @Query('returnTo') returnTo?: string,
    @Query('canvasBaseUrl') canvasBaseUrlParam?: string,
  ) {
    const ltiLaunchType = (req.session as { ltiLaunchType?: '1.1' | '1.3' })?.ltiLaunchType;
    if (ltiLaunchType === '1.1') {
      appendLtiLog('oauth', 'LTI 1.1 short-circuit: redirect to app (no OAuth2)');
      const appUrl = (this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:4200').replace(/\/$/, '');
      const returnPath = (returnTo ?? '/flashcards').replace(/^https?:\/\/[^/]+/, '') || '/flashcards';
      const dest = returnPath.startsWith('http') ? returnPath : `${appUrl}${returnPath}`;
      return res.redirect(dest);
    }

    const ctx = req.session?.ltiContext as LtiContext | undefined;
    const fromParam = (canvasBaseUrlParam ?? '').trim();
    const fromLaunch = canvasApiBaseFromLtiContext(ctx ?? {}, this.config.get<string>('CANVAS_API_BASE_URL'));
    const canvasBaseUrl = fromParam || fromLaunch;
    const clientId = (this.config.get<string>('CANVAS_OAUTH_CLIENT_ID') ?? '').trim();
    const clientSecret = (this.config.get<string>('CANVAS_OAUTH_CLIENT_SECRET') ?? '').trim();
    const redirectUri = (this.config.get<string>('CANVAS_OAUTH_REDIRECT_URI') ?? '').trim();

    appendLtiLog('oauth', 'Canvas OAuth init', {
      hasLtiContext: !!ctx,
      canvasBaseUrl: canvasBaseUrl ?? '(none)',
      hasClientId: !!clientId,
      hasClientSecret: !!clientSecret,
    });

    if (!canvasBaseUrl || !clientId || !clientSecret || !redirectUri) {
      const msg =
        'Canvas OAuth not configured: set CANVAS_OAUTH_CLIENT_ID, CANVAS_OAUTH_CLIENT_SECRET, CANVAS_OAUTH_REDIRECT_URI. Canvas base URL must come from the LTI launch (issuer / consumer URL); CANVAS_API_BASE_URL is optional for local non-LTI use.';
      appendLtiLog('oauth', 'OAuth init failed', { msg });
      return res.status(400).send(msg);
    }

    const base = (canvasBaseUrl.startsWith('http') ? canvasBaseUrl : `https://${canvasBaseUrl}`).replace(/\/$/, '');
    const state = randomBytes(16).toString('hex');
    const returnPath = (returnTo ?? '/flashcards').replace(/^https?:\/\/[^/]+/, '') || '/flashcards';
    const appUrl = (this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:4200').replace(/\/$/, '');
    const fullReturnTo = returnPath.startsWith('http') ? returnPath : `${appUrl}${returnPath}`;

    oauthStateStore.set(state, {
      canvasBaseUrl: base,
      returnTo: fullReturnTo,
      expires: Date.now() + OAUTH_STATE_TTL_MS,
    });

    const authUrl = new URL(`${base}/login/oauth2/auth`);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);

    const scopeMode = (this.config.get<string>('CANVAS_OAUTH_SCOPE_MODE') ?? '').trim().toLowerCase();
    if (scopeMode !== 'off' && scopeMode !== 'none' && scopeMode !== '0') {
      const custom = (this.config.get<string>('CANVAS_OAUTH_SCOPES') ?? '').trim();
      const scope = custom || DEFAULT_CANVAS_OAUTH_SCOPES;
      if (scope) {
        authUrl.searchParams.set('scope', scope);
      }
    }

    appendLtiLog('oauth', 'Redirecting to Canvas OAuth', {
      authUrl: authUrl.href,
      scopeMode: scopeMode || 'default',
      hasScopeParam: authUrl.searchParams.has('scope'),
    });
    return res.redirect(authUrl.href);
  }

  /**
   * Canvas OAuth callback. Exchanges code for access token, stores in session.
   */
  @Get('callback')
  async callback(
    @Req() req: Request,
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
    @Query('error_description') errorDescription?: string,
  ) {
    appendLtiLog('oauth', 'OAuth callback REACHED', { url: req.url, hasCode: !!code, hasState: !!state });
    appendLtiLog('oauth', 'Canvas OAuth callback', { hasCode: !!code, hasState: !!state, error: error ?? null });

    if (error) {
      const msg = `Canvas OAuth error: ${error} ${errorDescription ?? ''}`.trim();
      appendLtiLog('oauth', 'OAuth callback error', { error, errorDescription });
      const appUrl = (this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:4200').replace(/\/$/, '');
      return res.redirect(`${appUrl}/flashcards?oauth_error=${encodeURIComponent(msg)}`);
    }

    if (!code || !state) {
      return res.status(400).send('Missing code or state');
    }

    const stored = oauthStateStore.get(state);
    oauthStateStore.delete(state);
    if (!stored || Date.now() > stored.expires) {
      appendLtiLog('oauth', 'OAuth state invalid or expired', { state: state.slice(0, 8) });
      const appUrl = (this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:4200').replace(/\/$/, '');
      return res.redirect(`${appUrl}/flashcards?oauth_error=Invalid+or+expired+state`);
    }

    const clientId = (this.config.get<string>('CANVAS_OAUTH_CLIENT_ID') ?? '').trim();
    const clientSecret = (this.config.get<string>('CANVAS_OAUTH_CLIENT_SECRET') ?? '').trim();
    const redirectUri = (this.config.get<string>('CANVAS_OAUTH_REDIRECT_URI') ?? '').trim();

    const tokenUrl = `${stored.canvasBaseUrl}/login/oauth2/token`;
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    });

    let fetchRes: Awaited<ReturnType<typeof fetch>>;
    try {
      fetchRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (err) {
      appendLtiLog('oauth', 'Token exchange fetch failed', { error: (err as Error).message });
      const appUrl = (this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:4200').replace(/\/$/, '');
      return res.redirect(`${appUrl}/flashcards?oauth_error=Token+exchange+failed`);
    }

    const tokenData = (await fetchRes.json()) as { access_token?: string; error?: string };
    if (!fetchRes.ok || !tokenData.access_token) {
      appendLtiLog('oauth', 'Token exchange failed', {
        status: fetchRes.status,
        body: JSON.stringify(tokenData).slice(0, 200),
      });
      const appUrl = (this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:4200').replace(/\/$/, '');
      return res.redirect(`${appUrl}/flashcards?oauth_error=Failed+to+get+access+token`);
    }

    const tok = tokenData.access_token!;
    appendLtiLog('oauth', 'Token from Canvas (before storage)', {
      accessTokenLength: tok.length,
      first4: tok.slice(0, 4),
      last4: tok.slice(-4),
    });

    if (req.session) {
      req.session.canvasAccessToken = tokenData.access_token;
      req.session.save((err) => {
        if (err) {
          appendLtiLog('oauth', 'Session save failed', { error: (err as Error).message });
        } else {
          appendLtiLog('oauth', 'Canvas access token stored in session', {
            tokenLength: tokenData.access_token!.length,
          });
        }
        res.redirect(stored.returnTo);
      });
    } else {
      appendLtiLog('oauth', 'No session - cannot store token');
      res.redirect(`${stored.returnTo}?oauth_error=No+session`);
    }
  }
}
