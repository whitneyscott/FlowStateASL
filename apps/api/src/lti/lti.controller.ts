import { Controller, Post, Get, Body, Res, Req, Param, Inject, forwardRef } from '@nestjs/common';
import { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { LtiService } from './lti.service';
import { LtiJwksService } from './lti-jwks.service';
import { Lti13LaunchService } from './lti13-launch.service';
import { Lti11LaunchVerifyService } from './lti11-launch.verify.service';
import { AssessmentService } from '../assessment/assessment.service';
import { LtiDeepLinkFileStore } from './lti-deep-link-file.store';
import { setLtiToken, getLtiToken } from './lti-token.store';
import { setOidcState, consumeOidcState } from './lti-oidc-state.store';
import { setLastError, appendLtiLog } from '../common/last-error.store';
import { renderLtiLaunchErrorHtml } from './lti-error.util';
import { getRedirectPathForToolType } from './lti-redirect.util';
import { persistLtiContextAndRedirect } from './lti-launch-finish.util';
import { sanitizeLtiContext } from '../common/utils/lti-context-value.util';
import { getPublicOrigin } from '../common/utils/public-origin.util';
import {
  canvasApiBaseFromLtiContext,
  isGenericCanvasCloudRestBase,
  normalizeToCanvasRestBase,
} from '../common/utils/canvas-base-url.util';
import { PromptService } from '../prompt/prompt.service';

@Controller('lti')
export class LtiController {
  constructor(
    private readonly ltiService: LtiService,
    private readonly ltiJwks: LtiJwksService,
    private readonly lti13: Lti13LaunchService,
    private readonly lti11: Lti11LaunchVerifyService,
    private readonly assessmentService: AssessmentService,
    private readonly config: ConfigService,
    private readonly deepLinkFileStore: LtiDeepLinkFileStore,
    @Inject(forwardRef(() => PromptService))
    private readonly promptService: PromptService,
  ) {}

  private inferCanvasBaseFromLaunchRequest(req: Request): string | undefined {
    const candidates = [
      req.get('origin')?.trim(),
      req.get('referer')?.trim(),
      req.get('x-original-referer')?.trim(),
      req.get('x-forwarded-referer')?.trim(),
    ].filter(Boolean) as string[];

    const apiHost = (req.get('host') ?? '').split(':')[0].toLowerCase();

    const pick = (allowGenericCloud: boolean): string | undefined => {
      for (const c of candidates) {
        const base = normalizeToCanvasRestBase(c);
        if (!base) continue;
        if (!allowGenericCloud && isGenericCanvasCloudRestBase(base)) continue;
        const candidateHost = new URL(base).hostname.toLowerCase();
        if (apiHost && candidateHost === apiHost) continue;
        return base;
      }
      return undefined;
    };

    return pick(false) ?? pick(true);
  }

  private repairCanvasHostFromLaunchRequest(
    req: Request,
    ctx: { canvasBaseUrl?: string; canvasDomain?: string; platformIss?: string },
  ): void {
    const resolved = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));
    if (resolved) return;

    const inferred = this.inferCanvasBaseFromLaunchRequest(req);
    if (!inferred) return;

    ctx.canvasBaseUrl = inferred;
    ctx.canvasDomain = new URL(inferred).hostname;
    appendLtiLog('launch', 'Canvas REST host repaired from launch headers', {
      inferred,
      path: req.path,
      hadResolved: resolved ?? '(none)',
    });
  }

  private logLaunchEntry(
    req: Request,
    source: string,
    fields: {
      courseId?: string;
      assignmentId?: string;
      moduleId?: string;
      resourceLinkId?: string;
      userId?: string;
      roles?: string;
      hasIdToken?: boolean;
      hasOAuthSignature?: boolean;
    } = {},
  ): void {
    appendLtiLog('launch-entry', source, {
      method: req.method,
      path: req.path,
      courseId: fields.courseId ?? '',
      assignmentId: fields.assignmentId ?? '',
      moduleId: fields.moduleId ?? '',
      resourceLinkId: fields.resourceLinkId ?? '',
      userId: fields.userId ?? '',
      roles: fields.roles ? String(fields.roles).slice(0, 180) : '',
      hasIdToken: !!fields.hasIdToken,
      hasOAuthSignature: !!fields.hasOAuthSignature,
    });
  }

  @Post('launch/flashcards')
  async launchFlashcards(
    @Body() body: Record<string, string>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    this.logLaunchEntry(req, 'POST /api/lti/launch/flashcards received', {
      courseId: body.custom_canvas_course_id ?? body.custom_course_id ?? body.context_id,
      assignmentId: body.custom_canvas_assignment_id ?? body.custom_assignment_id,
      moduleId: body.custom_canvas_module_id ?? body.custom_module_id,
      resourceLinkId: body.resource_link_id ?? body.custom_resource_link_id,
      userId: body.custom_canvas_user_id ?? body.user_id ?? body.lis_person_sourcedid,
      roles: body.roles ?? body.custom_roles ?? body.ext_roles ?? body.canvas_membership_roles,
      hasOAuthSignature: !!body.oauth_signature,
    });
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
    this.repairCanvasHostFromLaunchRequest(req, ctx);
    const token = randomBytes(24).toString('hex');
    setLtiToken(token, ctx);
    if (req.session) {
      req.session.ltiContext = ctx;
      req.session.ltiLaunchType = '1.1';
      req.session.save((err) => {
        if (err) console.error('[LTI] launch session save failed', err);
        else console.log('[LTI] launch session saved, sessionId=', req.sessionID?.slice(0, 16));
        const base = getPublicOrigin(req) || (this.config.get<string>('FRONTEND_URL') ?? '');
        const url = base ? `${base}/flashcards?lti_token=${token}` : `/flashcards?lti_token=${token}`;
        console.log('[LTI] redirecting to', url.replace(token, '***'));
        res.redirect(url);
      });
    } else {
      const base = getPublicOrigin(req) || (this.config.get<string>('FRONTEND_URL') ?? '');
      const url = base ? `${base}/flashcards?lti_token=${token}` : `/flashcards?lti_token=${token}`;
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
    this.logLaunchEntry(req, 'POST /api/lti/launch/prompter received', {
      courseId: body.custom_canvas_course_id ?? body.custom_course_id ?? body.context_id,
      assignmentId: body.custom_canvas_assignment_id ?? body.custom_assignment_id,
      moduleId: body.custom_canvas_module_id ?? body.custom_module_id,
      resourceLinkId: body.resource_link_id ?? body.custom_resource_link_id,
      userId: body.custom_canvas_user_id ?? body.user_id ?? body.lis_person_sourcedid,
      roles: body.roles ?? body.custom_roles ?? body.ext_roles ?? body.canvas_membership_roles,
      hasOAuthSignature: !!body.oauth_signature,
    });
    const ctx = this.ltiService.extractContext(body);
    if (!ctx) {
      return res.status(400).send('Missing LTI parameters');
    }
    ctx.toolType = 'prompter';
    this.repairCanvasHostFromLaunchRequest(req, ctx);
    try {
      await this.promptService.rememberResourceLinkAssignmentMappingFromLaunch({
        ...ctx,
        canvasAccessToken: (req.session as { canvasAccessToken?: string } | undefined)?.canvasAccessToken,
        ltiLaunchType: '1.1',
      });
    } catch (err) {
      appendLtiLog('prompt-decks', 'real launch mapping failed (controller non-fatal)', {
        assignmentId: ctx.assignmentId || '(none)',
        resourceLinkId: ctx.resourceLinkId || '(none)',
        error: String(err),
      });
    }
    /* Do not rename assignment - prompter is placed in the assignment; leave title unchanged. */
    const token = randomBytes(24).toString('hex');
    setLtiToken(token, ctx);
    if (req.session) {
      req.session.ltiContext = ctx;
      req.session.ltiLaunchType = '1.1';
      req.session.save((err) => {
        if (err) console.error('[LTI] session save failed', err);
        const base = getPublicOrigin(req) || (this.config.get<string>('FRONTEND_URL') ?? '');
        res.redirect(base ? `${base}/prompter?lti_token=${token}` : `/prompter?lti_token=${token}`);
      });
    } else {
      const base = getPublicOrigin(req) || (this.config.get<string>('FRONTEND_URL') ?? '');
      res.redirect(base ? `${base}/prompter?lti_token=${token}` : `/prompter?lti_token=${token}`);
    }
  }

  @Get('context')
  getContext(@Req() req: Request) {
    const sctx = req.session?.ltiContext;
    this.logLaunchEntry(req, 'GET /api/lti/context', {
      courseId: sctx?.courseId,
      assignmentId: sctx?.assignmentId,
      moduleId: sctx?.moduleId,
      resourceLinkId: sctx?.resourceLinkId,
      userId: sctx?.userId,
      roles: sctx?.roles,
    });
    const ctx = req.session?.ltiContext;
    if (ctx) {
      console.log('[LTI] context from session', { courseId: ctx.courseId, roles: ctx.roles?.slice(0, 30) });
      return sanitizeLtiContext(ctx);
    }
    const token = (req.query.lti_token as string) ?? '';
    if (token) {
      const tokenCtx = getLtiToken(token);
      if (tokenCtx) {
        console.log('[LTI] context from token', { courseId: tokenCtx.courseId });
        if (req.session) {
          req.session.ltiContext = sanitizeLtiContext(tokenCtx) as typeof tokenCtx;
          req.session.save((err) => {
            if (err) console.error('[LTI] session save failed after lti_token', err);
            else console.log('[LTI] session saved with ltiContext, sessionId=', req.sessionID?.slice(0, 16));
          });
        } else {
          console.warn('[LTI] lti_token success but req.session is null - no cookie will be set');
        }
        return sanitizeLtiContext(tokenCtx);
      }
      console.warn('[LTI] lti_token present but getLtiToken returned null (token unknown/expired, possible multi-instance)');
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

  /**
   * Serve deep-link video file for Canvas to fetch (file content item).
   * Supports Range requests for seeking.
   */
  @Get('deep-link-file/:token')
  async deepLinkFile(
    @Param('token') tokenParam: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const token = (tokenParam ?? '').toString().trim();
    if (!token) return res.status(404).send();
    const file = this.deepLinkFileStore.get(token);
    if (!file) return res.status(404).send('Not found or expired');
    const buffer = file.buffer;
    const size = buffer.length;
    const contentType = file.contentType || 'video/webm';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(size));

    const range = req.headers.range;
    if (range) {
      const match = range.match(/^bytes=(\d*)-(\d*)$/);
      if (match) {
        let start = match[1] ? parseInt(match[1], 10) : 0;
        let end = match[2] ? parseInt(match[2], 10) : size - 1;
        if (Number.isNaN(start)) start = 0;
        if (Number.isNaN(end) || end >= size) end = size - 1;
        if (start > end) {
          return res.status(416).setHeader('Content-Range', `bytes */${size}`).send();
        }
        const chunk = buffer.subarray(start, end + 1);
        res.status(206);
        res.setHeader('Content-Length', String(chunk.length));
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        return res.send(chunk);
      }
    }

    return res.send(buffer);
  }

  @Get('oidc/login')
  async oidcLoginGet(@Req() req: Request, @Res() res: Response) {
    this.logLaunchEntry(req, 'GET /api/lti/oidc/login', {
      hasIdToken: !!(req.query as Record<string, unknown>)?.id_token,
      hasOAuthSignature: !!(req.query as Record<string, unknown>)?.oauth_signature,
    });
    const params = { ...req.query } as Record<string, string | undefined>;
    return this.handleOidcLogin(req, params, res);
  }

  @Post('oidc/login')
  async oidcLoginPost(@Req() req: Request, @Res() res: Response) {
    this.logLaunchEntry(req, 'POST /api/lti/oidc/login', {
      hasIdToken: !!(req.body as Record<string, unknown>)?.id_token,
      hasOAuthSignature: !!(req.body as Record<string, unknown>)?.oauth_signature,
    });
    const params = { ...req.body, ...req.query } as Record<string, string | undefined>;
    return this.handleOidcLogin(req, params, res);
  }

  private handleOidcLogin(
    req: Request,
    params: Record<string, string | undefined>,
    res: Response,
  ) {
    const iss = (params.iss ?? params.issuer ?? '').toString().trim();
    const loginHint = (params.login_hint ?? params.loginHint ?? '').toString().trim();
    const targetLinkUri = (params.target_link_uri ?? params.targetLinkUri ?? '').toString().trim();
    const ltiMessageHint = (params.lti_message_hint ?? params.ltiMessageHint ?? '').toString().trim() || undefined;
    const clientIdParam = (params.client_id ?? params.clientId ?? '').toString().trim() || undefined;
    const ltiClientIdEnv = (this.config.get<string>('LTI_CLIENT_ID') ?? process.env.LTI_CLIENT_ID ?? '').trim();
    const prompterClientIdEnv = (this.config.get<string>('LTI_PROMPTER_CLIENT_ID') ?? process.env.LTI_PROMPTER_CLIENT_ID ?? '').trim();
    // MUST use client_id from Canvas (request) so we use the key Canvas is launching with
    const clientId = (clientIdParam ?? ltiClientIdEnv ?? prompterClientIdEnv ?? '').trim();
    if (clientIdParam) {
      console.log('[LTI OIDC] client_id from Canvas:', clientId);
      appendLtiLog('oidc', 'client_id from Canvas', { clientId });
    } else {
      console.warn('[LTI OIDC] WARNING: Canvas did NOT send client_id. Using .env fallback:', clientId);
      appendLtiLog('oidc', 'WARNING: Canvas did NOT send client_id, using .env fallback', { clientId });
    }
    const dynamicOrigin = getPublicOrigin(req);
    const redirectUri = (dynamicOrigin ? `${dynamicOrigin}/api/lti/launch` : (this.config.get<string>('LTI_REDIRECT_URI') ?? '')).trim();
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
      appendLtiLog('oidc', 'OIDC login missing required params', {
        missing,
        hasIss: !!iss,
        hasLoginHint: !!loginHint,
        hasTargetLinkUri: !!targetLinkUri,
        hasClientId: !!clientId,
        hasRedirectUri: !!redirectUri,
      });
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
    appendLtiLog('oidc', 'OIDC login redirecting to Canvas authorize_redirect', {
      iss,
      clientId,
      hasLtiMessageHint: !!ltiMessageHint,
      targetLinkUri,
      redirectUri,
    });
    return res.redirect(fullAuthUrl);
  }

  @Post('launch')
  async launch13(
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const idTokenForEntry = (body?.id_token ?? body?.idToken ?? '').toString().trim();
    const oauthSignatureForEntry = (body?.oauth_signature ?? '').toString().trim();
    this.logLaunchEntry(req, 'POST /api/lti/launch received', {
      hasIdToken: !!idTokenForEntry,
      hasOAuthSignature: !!oauthSignatureForEntry,
    });
    appendLtiLog('launch', 'POST /launch received', { bodyKeys: body ? Object.keys(body) : [] });
    const canvasError = (body?.error ?? '').toString().trim();
    const canvasErrorDesc = (body?.error_description ?? body?.errorDescription ?? '').toString().trim();
    const frontendBase = getPublicOrigin(req) || (this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:4200');
    if (canvasError) {
      const msg = `LTI auth failed: ${canvasError}${canvasErrorDesc ? ` - ${canvasErrorDesc}` : ''}`;
      setLastError('/api/lti/launch', new Error(msg));
      appendLtiLog('launch', msg, { canvasError, canvasErrorDesc });
      return res.status(400).type('html').send(renderLtiLaunchErrorHtml(msg, { frontendUrl: frontendBase }));
    }

    // Branch on payload: 1.3 (id_token+state) first, then 1.1 (oauth_consumer_key+oauth_signature)
    const idToken = (body?.id_token ?? body?.idToken ?? '').toString().trim();
    const state = (body?.state ?? '').toString().trim();
    const oauthConsumerKey = (body?.oauth_consumer_key ?? '').toString().trim();
    const oauthSignature = (body?.oauth_signature ?? '').toString().trim();

    if (idToken && state) {
      return this.handleLti13Launch(req, res, body, idToken, state, frontendBase);
    }
    if (oauthConsumerKey && oauthSignature) {
      return this.handleLti11Launch(req, res, body, frontendBase);
    }

    const bodyKeys = body ? Object.keys(body) : [];
    const msg = `Missing LTI params: need id_token+state (1.3) or oauth_consumer_key+oauth_signature (1.1). Body keys: ${bodyKeys.join(', ')}`;
    setLastError('/api/lti/launch', new Error(msg));
    appendLtiLog('launch', msg, { bodyKeys });
    return res.status(400).type('html').send(renderLtiLaunchErrorHtml(msg, { frontendUrl: frontendBase }));
  }

  private async handleLti13Launch(
    req: Request,
    res: Response,
    body: Record<string, unknown>,
    idToken: string,
    state: string,
    frontendBase: string,
  ): Promise<void | Response> {
    const stored = consumeOidcState(state);
    if (!stored) {
      const msg = 'Invalid or expired state';
      setLastError('/api/lti/launch', new Error(msg));
      appendLtiLog('launch', msg);
      return res.status(400).type('html').send(renderLtiLaunchErrorHtml(msg, { frontendUrl: frontendBase }));
    }
    const result = await this.lti13.validateAndExtract(idToken);
    if ('error' in result) {
      setLastError('/api/lti/launch', new Error(result.error));
      appendLtiLog('launch', 'Invalid id_token', { reason: result.error });
      return res.status(400).type('html').send(renderLtiLaunchErrorHtml(`Invalid id_token: ${result.error}`, { frontendUrl: frontendBase }));
    }
    const ctx = result.context;
    this.repairCanvasHostFromLaunchRequest(req, ctx);
    appendLtiLog('launch', 'LTI context extracted', {
      courseId: ctx.courseId,
      toolType: ctx.toolType,
      canvasBaseUrl: ctx.canvasBaseUrl ?? '(none)',
      canvasDomain: ctx.canvasDomain ?? '(none)',
      hasSubmissionToken: !!ctx.submissionToken,
    });
    const base = frontendBase;
    /* When viewing an ltiResourceLink submission, redirect to review page */
    const buildRedirectUrl = ctx.submissionToken
      ? (_token: string) => {
          const tokenPart = `token=${encodeURIComponent(ctx.submissionToken!)}`;
          const title = (ctx.submissionTitle ?? '').trim();
          const titlePart = title ? `&title=${encodeURIComponent(title)}` : '';
          appendLtiLog('launch', 'Submission review redirect (token + title)', {
            hasSubmissionToken: true,
            hasSubmissionTitle: !!title,
            submissionTitle: title || '(none)',
          });
          return `${base}/prompt/review?${tokenPart}${titlePart}`;
        }
      : (() => {
          const path = getRedirectPathForToolType(ctx.toolType, this.ltiService.isTeacherRole(ctx.roles));
          ctx.redirectPath = path;
          appendLtiLog('launch', 'Redirect path (Step 2)', { path, toolType: ctx.toolType, redirectUrl: `${base}${path}?lti_token=***` });
          return (token: string) => `${base}${path}?lti_token=${token}`;
        })();

    const needsOAuth = !(req.session as { canvasAccessToken?: string })?.canvasAccessToken;
    const oauthConfigured =
      !!this.config.get<string>('CANVAS_OAUTH_CLIENT_ID') &&
      !!this.config.get<string>('CANVAS_OAUTH_CLIENT_SECRET') &&
      !!this.config.get<string>('CANVAS_OAUTH_REDIRECT_URI');
    const canvasBaseUrl = canvasApiBaseFromLtiContext(ctx, this.config.get<string>('CANVAS_API_BASE_URL'));

    appendLtiLog('launch', 'OAuth redirect decision', {
      needsOAuth,
      oauthConfigured,
      canvasBaseUrl: canvasBaseUrl ?? '(none)',
      isTeacher: this.ltiService.isTeacherRole(ctx.roles),
      hasCanvasAccessToken: !!(req.session as { canvasAccessToken?: string })?.canvasAccessToken,
    });

    const options =
      needsOAuth && oauthConfigured && canvasBaseUrl && !ctx.submissionToken
        ? {
            oauthInitUrlBuilder: (token: string) => {
              const apiBase = this.config.get<string>('APP_URL') ?? `http://localhost:${this.config.get('PORT') ?? 3000}`;
              const base = (canvasBaseUrl ?? '').replace(/\/$/, '');
              const params = new URLSearchParams({ returnTo: buildRedirectUrl(token) });
              if (base) params.set('canvasBaseUrl', base);
              return `${apiBase}/api/oauth/canvas?${params.toString()}`;
            },
          }
        : undefined;

    persistLtiContextAndRedirect(req, res, ctx, buildRedirectUrl, options);
  }

  /**
   * Handle LTI 1.1 launch (OAuth 1.0a). Verifies signature, checks instructor role,
   * sets session with ltiLaunchType='1.1', redirects directly to app (no OAuth2).
   */
  private async handleLti11Launch(
    req: Request,
    res: Response,
    body: Record<string, unknown>,
    frontendBase: string,
  ): Promise<void | Response> {
    appendLtiLog('launch', 'LTI 1.1 launch detected', { bodyKeys: Object.keys(body) });

    const launchUrl = this.buildLtiLaunchUrl(req);
    const bodyForVerify = body as Record<string, string | string[] | undefined>;

    const result = this.lti11.verify(bodyForVerify, launchUrl);
    if (!result.ok) {
      setLastError('/api/lti/launch', new Error(result.error));
      appendLtiLog('launch', 'LTI 1.1 verify failed', { error: result.error });
      return res
        .status(400)
        .type('html')
        .send(renderLtiLaunchErrorHtml(`LTI 1.1 verification failed: ${result.error}`, { frontendUrl: frontendBase }));
    }

    const data = result.data;

    const ctx = {
      courseId: data.courseId,
      assignmentId: data.assignmentId ?? '',
      userId: data.ltiSub,
      resourceLinkId: data.resourceLinkId ?? '',
      moduleId: data.moduleId ?? '',
      toolType: data.toolType ?? 'flashcards',
      roles: data.roles,
      resourceLinkTitle: data.resourceLinkTitle,
      canvasDomain: data.canvasApiDomain || undefined,
      canvasBaseUrl: data.canvasBaseUrl || undefined,
    };
    this.repairCanvasHostFromLaunchRequest(req, ctx);

    // Step 1 fallback (highest priority): on real 1.1 launch, persist map immediately
    // when both ids are present. Non-fatal by design.
    try {
      await this.promptService.rememberResourceLinkAssignmentMappingFromLaunch({
        ...ctx,
        canvasAccessToken: (req.session as { canvasAccessToken?: string } | undefined)?.canvasAccessToken,
        ltiLaunchType: '1.1',
      });
    } catch (err) {
      appendLtiLog('prompt-decks', 'real launch mapping failed (controller non-fatal)', {
        assignmentId: ctx.assignmentId || '(none)',
        resourceLinkId: ctx.resourceLinkId || '(none)',
        error: String(err),
      });
    }

    const token = randomBytes(24).toString('hex');
    setLtiToken(token, ctx);

    if (req.session) {
      req.session.ltiContext = ctx;
      req.session.ltiLaunchType = '1.1';
      delete (req.session as { ltiClientId?: string }).ltiClientId;
      req.session.save((err) => {
        if (err) {
          setLastError('/api/lti/launch', err);
        }
        const path = getRedirectPathForToolType(ctx.toolType, this.ltiService.isTeacherRole(data.roles));
        const url = `${frontendBase}${path}?lti_token=${token}&courseId=${encodeURIComponent(data.courseId)}`;
        appendLtiLog('launch', 'LTI 1.1 redirect to app (no OAuth)', { path, url: url.replace(token, '***') });
        res.redirect(url);
      });
    } else {
      const path = getRedirectPathForToolType(ctx.toolType, this.ltiService.isTeacherRole(data.roles));
      res.redirect(`${frontendBase}${path}?lti_token=${token}&courseId=${encodeURIComponent(data.courseId)}`);
    }
  }

  private buildLtiLaunchUrl(req: Request): string {
    const origin = getPublicOrigin(req);
    if (origin) {
      return `${origin}/api/lti/launch`;
    }
    const appUrl = (this.config.get<string>('APP_URL') ?? '').trim();
    if (appUrl) {
      return `${appUrl.replace(/\/$/, '')}/api/lti/launch`;
    }
    const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
    const host = req.get('x-forwarded-host') || req.get('host') || 'localhost';
    const scheme = (proto === 'https' || proto === 'http') ? proto : 'https';
    return `${scheme}://${host}/api/lti/launch`;
  }
}
