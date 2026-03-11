import { Controller, Post, Get, Body, Res, Req, Query } from '@nestjs/common';
import { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { LtiService } from './lti.service';
import { LtiJwksService } from './lti-jwks.service';
import { Lti13LaunchService } from './lti13-launch.service';
import { AssessmentService } from '../assessment/assessment.service';
import { setLtiToken, consumeLtiToken } from './lti-token.store';
import { setOidcState, consumeOidcState } from './lti-oidc-state.store';
import { setLastError, appendLtiLog } from '../common/last-error.store';
import { renderLtiLaunchErrorHtml } from './lti-error.util';

@Controller('lti')
export class LtiController {
  constructor(
    private readonly ltiService: LtiService,
    private readonly ltiJwks: LtiJwksService,
    private readonly lti13: Lti13LaunchService,
    private readonly assessmentService: AssessmentService,
    private readonly config: ConfigService,
  ) {}

  @Post('launch/flashcards')
  async launchFlashcards(
    @Body() body: Record<string, string>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const roleKeys = ['custom_roles','roles','ext_roles','canvas_membership_roles'];
    const rolesReceived = roleKeys
      .filter((k) => body[k])
      .map((k) => `${k}=${String(body[k]).slice(0, 80)}`);
    console.log('[LTI] launch/flashcards received', {
      hasCourseId: !!body.custom_canvas_course_id,
      hasUserId: !!body.custom_canvas_user_id,
      rolesReceived: rolesReceived.length ? rolesReceived : 'none',
    });
    const ctx = this.ltiService.extractContext(body);
    if (!ctx) {
      console.log('[LTI] extractContext failed', { bodyKeys: Object.keys(body) });
      return res.status(400).send('Missing LTI parameters');
    }
    ctx.toolType = 'flashcards';
    const token = randomBytes(24).toString('hex');
    setLtiToken(token, ctx);
    if (req.session) {
      req.session.ltiContext = ctx;
      req.session.save((err) => {
        if (err) console.error('[LTI] launch session save failed', err);
        else console.log('[LTI] launch session saved, sessionId=', req.sessionID?.slice(0, 16));
        const base = process.env.FRONTEND_URL ?? '';
        const url = `${base}/flashcards?lti_token=${token}`;
        console.log('[LTI] redirecting to', url.replace(token, '***'));
        res.redirect(url);
      });
    } else {
      const base = process.env.FRONTEND_URL ?? '';
      const url = `${base}/flashcards?lti_token=${token}`;
      console.log('[LTI] no session, redirecting with token');
      res.redirect(url);
    }
  }

  @Post('launch/prompter')
  async launchPrompter(
    @Body() body: Record<string, string>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ctx = this.ltiService.extractContext(body);
    if (!ctx) {
      return res.status(400).send('Missing LTI parameters');
    }
    ctx.toolType = 'prompter';
    if (this.ltiService.isTeacherRole(ctx.roles) && ctx.assignmentId && ctx.resourceLinkTitle) {
      try {
        ctx.assignmentNameSynced = await this.assessmentService.syncAssignmentNameIfNeeded(
          ctx.courseId,
          ctx.assignmentId,
          ctx.resourceLinkId || '',
          ctx.resourceLinkTitle,
          ctx.canvasDomain,
          ctx.canvasBaseUrl,
          (req.session as { canvasAccessToken?: string })?.canvasAccessToken,
        );
      } catch {
        ctx.assignmentNameSynced = false;
      }
    }
    const token = randomBytes(24).toString('hex');
    setLtiToken(token, ctx);
    if (req.session) {
      req.session.ltiContext = ctx;
      req.session.save((err) => {
        if (err) console.error('[LTI] session save failed', err);
        const base = process.env.FRONTEND_URL ?? '';
        res.redirect(`${base}/prompter?lti_token=${token}`);
      });
    } else {
      const base = process.env.FRONTEND_URL ?? '';
      res.redirect(`${base}/prompter?lti_token=${token}`);
    }
  }

  @Get('context')
  getContext(@Req() req: Request) {
    const ctx = req.session?.ltiContext;
    if (ctx) {
      console.log('[LTI] context from session', { courseId: ctx.courseId, roles: ctx.roles?.slice(0, 30) });
      return ctx;
    }
    const token = (req.query.lti_token as string) ?? '';
    if (token) {
      const tokenCtx = consumeLtiToken(token);
      if (tokenCtx) {
        console.log('[LTI] context from token', { courseId: tokenCtx.courseId });
        if (req.session) {
          req.session.ltiContext = tokenCtx;
          req.session.save((err) => {
            if (err) console.error('[LTI] session save failed after lti_token', err);
            else console.log('[LTI] session saved with ltiContext, sessionId=', req.sessionID?.slice(0, 16));
          });
        } else {
          console.warn('[LTI] lti_token success but req.session is null - no cookie will be set');
        }
        return tokenCtx;
      }
      console.warn('[LTI] lti_token present but consumeLtiToken returned null (token unknown/expired, possible multi-instance)');
    } else {
      console.log('[LTI] context fallback: no session.ltiContext, no lti_token');
    }
    return {
      courseId: '',
      assignmentId: '',
      userId: 'standalone',
      resourceLinkId: '',
      moduleId: '',
      toolType: 'flashcards' as const,
      roles: '',
    };
  }

  @Get('jwks')
  async jwks(@Res() res: Response) {
    const jwks = await this.ltiJwks.getJwks();
    res.json(jwks);
  }

  @Get('oidc/login')
  async oidcLoginGet(@Req() req: Request, @Res() res: Response) {
    const params = { ...req.query } as Record<string, string | undefined>;
    return this.handleOidcLogin(params, res);
  }

  @Post('oidc/login')
  async oidcLoginPost(@Req() req: Request, @Res() res: Response) {
    const params = { ...req.body, ...req.query } as Record<string, string | undefined>;
    return this.handleOidcLogin(params, res);
  }

  private handleOidcLogin(
    params: Record<string, string | undefined>,
    res: Response,
  ) {
    const iss = (params.iss ?? params.issuer ?? '').toString().trim();
    const loginHint = (params.login_hint ?? params.loginHint ?? '').toString().trim();
    const targetLinkUri = (params.target_link_uri ?? params.targetLinkUri ?? '').toString().trim();
    const ltiMessageHint = (params.lti_message_hint ?? params.ltiMessageHint ?? '').toString().trim() || undefined;
    const clientIdParam = (params.client_id ?? params.clientId ?? '').toString().trim() || undefined;
    const ltiClientIdEnv = (this.config.get<string>('LTI_CLIENT_ID') ?? '').trim();
    // MUST use client_id from Canvas (request) so we use the key Canvas is launching with
    const clientId = (clientIdParam ?? ltiClientIdEnv ?? '').trim();
    if (clientIdParam) {
      console.log('[LTI OIDC] client_id from Canvas:', clientId);
      appendLtiLog('oidc', 'client_id from Canvas', { clientId });
    } else {
      console.warn('[LTI OIDC] WARNING: Canvas did NOT send client_id. Using LTI_CLIENT_ID from .env:', clientId);
      appendLtiLog('oidc', 'WARNING: Canvas did NOT send client_id, using .env fallback', { clientId });
    }
    const redirectUri = (this.config.get<string>('LTI_REDIRECT_URI') ?? '').trim();
    const debug = (params.debug ?? params.debugMode ?? '').toString().toLowerCase() === '1' || (params.debug ?? params.debugMode ?? '').toString().toLowerCase() === 'true';
    console.log('[LTI OIDC] redirect_uri:', JSON.stringify(redirectUri), '| length:', redirectUri.length);
    if (!iss || !loginHint || !targetLinkUri || !clientId || !redirectUri) {
      const missing = [
        !iss && 'iss',
        !loginHint && 'login_hint',
        !targetLinkUri && 'target_link_uri',
        !clientId && 'client_id',
        !redirectUri && 'LTI_REDIRECT_URI (set in .env)',
      ].filter(Boolean);
      return res.status(400).send(`Missing OIDC params: ${missing.join(', ')}`);
    }
    const state = randomBytes(16).toString('hex');
    const nonce = randomBytes(16).toString('hex');
    setOidcState(state, nonce, redirectUri, targetLinkUri);
    const authUrl = new URL('/api/lti/authorize_redirect', iss.endsWith('/') ? iss.slice(0, -1) : iss);
    authUrl.searchParams.set('scope', 'openid');
    authUrl.searchParams.set('response_type', 'id_token');
    authUrl.searchParams.set('prompt', 'none');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('login_hint', loginHint);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('nonce', nonce);
    authUrl.searchParams.set('response_mode', 'form_post');
    if (ltiMessageHint) authUrl.searchParams.set('lti_message_hint', ltiMessageHint);

    const fullAuthUrl = authUrl.toString();
    console.log('[LTI OIDC] redirect_uri:', JSON.stringify(redirectUri), '| client_id:', clientId, '| iss:', iss);
    console.log('[LTI OIDC] full auth URL (no state/nonce):', authUrl.origin + authUrl.pathname + '?' + new URLSearchParams({ scope: 'openid', response_type: 'id_token', client_id: clientId, redirect_uri: redirectUri }).toString());

    if (debug) {
      return res.json({
        debug: true,
        redirect_uri: redirectUri,
        redirect_uri_quoted: JSON.stringify(redirectUri),
        redirect_uri_length: redirectUri.length,
        client_id: clientId,
        iss,
        target_link_uri: targetLinkUri,
        auth_url: fullAuthUrl,
        hint: 'Canvas requires redirect_uri to match Developer Key exactly. Check trailing slash, http vs https.',
      });
    }
    return res.redirect(fullAuthUrl);
  }

  @Post('launch')
  async launch13(
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    appendLtiLog('launch', 'POST /launch received', { bodyKeys: body ? Object.keys(body) : [] });
    const canvasError = (body?.error ?? '').toString().trim();
    const canvasErrorDesc = (body?.error_description ?? body?.errorDescription ?? '').toString().trim();
    if (canvasError) {
      const msg = `LTI auth failed: ${canvasError}${canvasErrorDesc ? ` - ${canvasErrorDesc}` : ''}`;
      setLastError('/api/lti/launch', new Error(msg));
      appendLtiLog('launch', msg, { canvasError, canvasErrorDesc });
      return res.status(400).type('html').send(renderLtiLaunchErrorHtml(msg, { frontendUrl: this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:4200' }));
    }
    const idToken = (body?.id_token ?? body?.idToken ?? '').toString().trim();
    const state = (body?.state ?? '').toString().trim();
    if (!idToken || !state) {
      const bodyKeys = body ? Object.keys(body) : [];
      const msg = `Missing id_token or state. Body keys: ${bodyKeys.join(', ')}`;
      setLastError('/api/lti/launch', new Error(msg));
      appendLtiLog('launch', msg, { bodyKeys });
      return res.status(400).type('html').send(renderLtiLaunchErrorHtml(msg, { frontendUrl: this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:4200' }));
    }
    const stored = consumeOidcState(state);
    if (!stored) {
      const msg = 'Invalid or expired state';
      setLastError('/api/lti/launch', new Error(msg));
      appendLtiLog('launch', msg);
      return res.status(400).type('html').send(renderLtiLaunchErrorHtml(msg, { frontendUrl: this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:4200' }));
    }
    const result = await this.lti13.validateAndExtract(idToken);
    if ('error' in result) {
      setLastError('/api/lti/launch', new Error(result.error));
      appendLtiLog('launch', 'Invalid id_token', { reason: result.error });
      return res.status(400).type('html').send(renderLtiLaunchErrorHtml(`Invalid id_token: ${result.error}`, { frontendUrl: this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:4200' }));
    }
    const ctx = result.context;
    appendLtiLog('launch', 'LTI context extracted', {
      courseId: ctx.courseId,
      toolType: ctx.toolType,
      canvasBaseUrl: ctx.canvasBaseUrl ?? '(none)',
      canvasDomain: ctx.canvasDomain ?? '(none)',
    });
    if (ctx.toolType === 'prompter' && this.ltiService.isTeacherRole(ctx.roles) && ctx.assignmentId && ctx.resourceLinkTitle) {
      try {
        ctx.assignmentNameSynced = await this.assessmentService.syncAssignmentNameIfNeeded(
          ctx.courseId,
          ctx.assignmentId,
          ctx.resourceLinkId || '',
          ctx.resourceLinkTitle,
          ctx.canvasDomain,
          ctx.canvasBaseUrl,
          (req.session as { canvasAccessToken?: string })?.canvasAccessToken,
        );
      } catch {
        ctx.assignmentNameSynced = false;
      }
    }
    const token = randomBytes(24).toString('hex');
    setLtiToken(token, ctx);
    const base = this.config.get<string>('FRONTEND_URL') ?? '';
    const path = ctx.toolType === 'prompter' ? '/prompter' : '/flashcards';
    const finalRedirect = `${base}${path}?lti_token=${token}`;

    const isTeacher = this.ltiService.isTeacherRole(ctx.roles);
    const needsOAuth = !(req.session as { canvasAccessToken?: string })?.canvasAccessToken;
    const oauthConfigured =
      !!this.config.get<string>('CANVAS_OAUTH_CLIENT_ID') &&
      !!this.config.get<string>('CANVAS_OAUTH_CLIENT_SECRET') &&
      !!this.config.get<string>('CANVAS_OAUTH_REDIRECT_URI');
    const canvasBaseUrl = ctx.canvasBaseUrl ?? this.config.get<string>('CANVAS_API_BASE_URL');

    appendLtiLog('launch', 'OAuth redirect decision', {
      needsOAuth,
      oauthConfigured,
      canvasBaseUrl: canvasBaseUrl ?? '(none)',
      isTeacher,
      hasCanvasAccessToken: !!(req.session as { canvasAccessToken?: string })?.canvasAccessToken,
    });

    if (req.session) {
      req.session.ltiContext = ctx;
      req.session.save((err) => {
        if (err) setLastError('/api/lti/launch', err);
        if (needsOAuth && oauthConfigured && canvasBaseUrl) {
          const apiBase = this.config.get<string>('APP_URL') ?? `http://localhost:${this.config.get('PORT') ?? 3000}`;
          const oauthInitUrl = `${apiBase}/api/oauth/canvas?returnTo=${encodeURIComponent(finalRedirect)}`;
          appendLtiLog('launch', 'User without Canvas token — redirecting to OAuth init', { oauthInitUrl });
          res.redirect(oauthInitUrl);
        } else {
          appendLtiLog('launch', 'Success - redirecting', { redirectUrl: finalRedirect });
          res.redirect(finalRedirect);
        }
      });
    } else {
      appendLtiLog('launch', 'Success - redirecting (no session)', { redirectUrl: finalRedirect });
      res.redirect(finalRedirect);
    }
  }
}
