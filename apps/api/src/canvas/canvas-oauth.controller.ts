import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { appendLtiLog } from '../common/last-error.store';

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 min
const oauthStateStore = new Map<
  string,
  { canvasBaseUrl: string; returnTo: string; expires: number }
>();

@Controller('oauth/canvas')
export class CanvasOAuthController {
  constructor(private readonly config: ConfigService) {}

  /**
   * Initiate Canvas OAuth. Redirects user to Canvas authorize URL.
   * Requires session with ltiContext (canvasBaseUrl) from LTI launch.
   */
  @Get()
  async init(
    @Req() req: Request,
    @Res() res: Response,
    @Query('returnTo') returnTo?: string,
    @Query('canvasBaseUrl') canvasBaseUrlParam?: string,
  ) {
    const ctx = req.session?.ltiContext;
    const canvasBaseUrl =
      (canvasBaseUrlParam ?? ctx?.canvasBaseUrl ?? this.config.get<string>('CANVAS_API_BASE_URL'))?.trim() || undefined;
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
        'Canvas OAuth not configured: set CANVAS_OAUTH_CLIENT_ID, CANVAS_OAUTH_CLIENT_SECRET, CANVAS_OAUTH_REDIRECT_URI. Canvas base URL comes from LTI launch (canvasBaseUrl) or CANVAS_API_BASE_URL.';
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

    appendLtiLog('oauth', 'Redirecting to Canvas OAuth', { authUrl: authUrl.href });
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
