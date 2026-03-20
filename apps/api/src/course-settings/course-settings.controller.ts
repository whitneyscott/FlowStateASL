import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import type { LtiContext } from '../common/interfaces/lti-context.interface';
import { appendLtiLog } from '../common/last-error.store';
import { getOAuth401Body } from '../common/utils/oauth-401.util';
import { CanvasTokenExpiredError } from '../canvas/canvas.service';
import { LtiLaunchGuard } from '../lti/guards/lti-launch.guard';
import { LtiService } from '../lti/lti.service';
import { CourseSettingsService } from './course-settings.service';

@Controller('course-settings')
@UseGuards(LtiLaunchGuard)
export class CourseSettingsController {
  constructor(
    private readonly courseSettings: CourseSettingsService,
    private readonly ltiService: LtiService,
  ) {}

  @Get()
  async get(@Req() req: Request, @Res() res: Response) {
    const ctx = req.session?.ltiContext as LtiContext | undefined;
    const isTeacher = this.ltiService.isTeacherRole(ctx?.roles ?? '');
    const canvasAccessToken = (req.session as { canvasAccessToken?: string } | undefined)?.canvasAccessToken;
    appendLtiLog('course-settings', 'GET /api/course-settings requested', {
      hasSession: !!req.session,
      hasLtiContext: !!ctx,
      hasCanvasAccessToken: !!canvasAccessToken,
      courseId: ctx?.courseId ?? null,
      isTeacher,
    });
    if (!ctx?.courseId) {
      appendLtiLog('course-settings', 'GET aborted: no courseId in session');
      return res.json(null);
    }
    // Teachers need a Canvas API token before any course-settings / announcement logic.
    // Without this, GET returned 200 + empty data (missing-token was swallowed in service),
    // and the UI hit announcement-status → false → "recreate" before token entry (wrong order).
    if (isTeacher && !(canvasAccessToken ?? '').trim()) {
      appendLtiLog('course-settings', 'GET 401: teacher has no Canvas token yet', getOAuth401Body(req));
      return res.status(401).json(getOAuth401Body(req));
    }
    try {
      const result = await this.courseSettings.get(ctx.courseId, {
        isTeacher,
        canvasDomain: ctx.canvasDomain,
        canvasBaseUrl: ctx.canvasBaseUrl,
        canvasAccessToken: canvasAccessToken ?? undefined,
      });
      appendLtiLog('course-settings', 'GET result from service', {
        courseId: ctx.courseId,
        selectedCurriculums: result?.selectedCurriculums ?? [],
        selectedUnits: result?.selectedUnits ?? [],
        hasResult: !!result,
      });
      return res.json(result);
    } catch (err) {
      if (err instanceof CanvasTokenExpiredError) {
        appendLtiLog('course-settings', 'Canvas token expired — 401', getOAuth401Body(req));
        return res.status(401).json(getOAuth401Body(req));
      }
      throw err;
    }
  }

  @Put()
  async save(
    @Req() req: Request,
    @Body() body: { selectedCurriculums?: string[]; selectedUnits?: string[]; canvasApiToken?: string },
  ) {
    const ctx = req.session?.ltiContext as LtiContext | undefined;
    console.log('[CourseSettings PUT] session:', {
      hasSession: !!req.session,
      sessionId: (req.session as { id?: string } | undefined)?.id ?? req.sessionID,
      hasLtiContext: !!ctx,
      courseId: ctx?.courseId,
      cookieHeader: req.headers.cookie ? 'present' : 'MISSING',
    }, 'body:', JSON.stringify(body));
    if (!ctx?.courseId) {
      throw new ForbiddenException('LTI context required');
    }
    if (!this.ltiService.isTeacherRole(ctx.roles)) {
      throw new ForbiddenException('Teacher role required');
    }
    const canvasAccessToken = (req.session as { canvasAccessToken?: string } | undefined)?.canvasAccessToken;
    await this.courseSettings.save(
      ctx.courseId,
      body.selectedCurriculums ?? [],
      body.selectedUnits ?? [],
      ctx.canvasDomain,
      canvasAccessToken ?? undefined,
      ctx.canvasBaseUrl,
    );
  }

  @Get('announcement-status')
  async announcementStatus(@Req() req: Request) {
    const ctx = req.session?.ltiContext as LtiContext | undefined;
    if (!ctx?.courseId) {
      throw new ForbiddenException('LTI context required');
    }
    if (!this.ltiService.isTeacherRole(ctx.roles)) {
      throw new ForbiddenException('Teacher role required');
    }
    const canvasAccessToken = (req.session as { canvasAccessToken?: string })?.canvasAccessToken;
    if (!(canvasAccessToken ?? '').trim()) {
      throw new HttpException(getOAuth401Body(req), HttpStatus.UNAUTHORIZED);
    }
    const exists = await this.courseSettings.announcementExists(ctx.courseId, {
      canvasDomain: ctx.canvasDomain,
      canvasBaseUrl: ctx.canvasBaseUrl,
      canvasAccessToken: canvasAccessToken ?? undefined,
    });
    return { exists };
  }

  @Post('recreate-announcement')
  async recreateAnnouncement(@Req() req: Request) {
    const ctx = req.session?.ltiContext as LtiContext | undefined;
    if (!ctx?.courseId) {
      throw new ForbiddenException('LTI context required');
    }
    if (!this.ltiService.isTeacherRole(ctx.roles)) {
      throw new ForbiddenException('Teacher role required');
    }
    const canvasAccessToken = (req.session as { canvasAccessToken?: string })?.canvasAccessToken;
    if (!(canvasAccessToken ?? '').trim()) {
      throw new HttpException(getOAuth401Body(req), HttpStatus.UNAUTHORIZED);
    }
    await this.courseSettings.recreateAnnouncement(ctx.courseId, {
      canvasDomain: ctx.canvasDomain,
      canvasBaseUrl: ctx.canvasBaseUrl,
      canvasAccessToken: canvasAccessToken ?? undefined,
    });
    return { success: true };
  }
}
