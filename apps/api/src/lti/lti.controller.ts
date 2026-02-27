import {
  Controller,
  Post,
  Get,
  Body,
  Res,
  Req,
  NotImplementedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { LtiService } from './lti.service';
import { AssessmentService } from '../assessment/assessment.service';
import { setLtiToken, consumeLtiToken } from './lti-token.store';

@Controller('lti')
export class LtiController {
  constructor(
    private readonly ltiService: LtiService,
    private readonly assessmentService: AssessmentService,
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

  @Get('oidc/login')
  oidcLogin() {
    throw new NotImplementedException('LTI 1.3 not implemented');
  }

  @Post('oidc/redirect')
  oidcRedirect() {
    throw new NotImplementedException('LTI 1.3 not implemented');
  }
}
