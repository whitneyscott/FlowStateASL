import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import type { LtiContext } from '../common/interfaces/lti-context.interface';
import { appendLtiLog } from '../common/last-error.store';
import { LtiLaunchGuard } from '../lti/guards/lti-launch.guard';
import { LtiService } from '../lti/lti.service';
import { CanvasTokenExpiredError } from '../canvas/canvas-token-expired.error';
import { CourseSettingsService } from './course-settings.service';

@Controller('course-settings')
@UseGuards(LtiLaunchGuard)
export class CourseSettingsController {
  constructor(
    private readonly courseSettings: CourseSettingsService,
    private readonly ltiService: LtiService,
  ) {}

  @Get()
  async get(@Req() req: Request) {
    const ctx = req.session?.ltiContext as LtiContext | undefined;
    const isTeacher = this.ltiService.isTeacherRole(ctx?.roles ?? '');
    appendLtiLog('course-settings', 'GET /api/course-settings requested', {
      hasSession: !!req.session,
      hasLtiContext: !!ctx,
      courseId: ctx?.courseId ?? null,
      isTeacher,
    });
    if (!ctx?.courseId) {
      appendLtiLog('course-settings', 'GET aborted: no courseId in session');
      return null;
    }
    let result;
    try {
      result = await this.courseSettings.get(ctx.courseId, {
        isTeacher,
        canvasDomain: ctx.canvasDomain,
        canvasBaseUrl: ctx.canvasBaseUrl,
      });
    } catch (err) {
      if (err instanceof CanvasTokenExpiredError) {
        appendLtiLog('course-settings', 'Canvas token expired — reauth required', {});
        throw new HttpException(
          { reauthRequired: true, message: 'Canvas token expired. Re-authorizing...' },
          HttpStatus.UNAUTHORIZED,
        );
      }
      throw err;
    }
    appendLtiLog('course-settings', 'GET result from service', {
      courseId: ctx.courseId,
      selectedCurriculums: result?.selectedCurriculums ?? [],
      selectedUnits: result?.selectedUnits ?? [],
      hasResult: !!result,
    });
    return result;
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
    const canvasToken = (body.canvasApiToken?.trim() || null) ?? (req.session as { canvasAccessToken?: string })?.canvasAccessToken ?? null;
    await this.courseSettings.save(
      ctx.courseId,
      body.selectedCurriculums ?? [],
      body.selectedUnits ?? [],
      ctx.canvasDomain,
      canvasToken ?? undefined,
      ctx.canvasBaseUrl,
    );
  }
}
