import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import type { LtiContext } from '../common/interfaces/lti-context.interface';
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
  async get(@Req() req: Request) {
    const ctx = req.session?.ltiContext as LtiContext | undefined;
    console.log('[CourseSettings GET] session:', {
      hasSession: !!req.session,
      sessionId: (req.session as { id?: string } | undefined)?.id ?? req.sessionID,
      hasLtiContext: !!ctx,
      courseId: ctx?.courseId,
      cookieHeader: req.headers.cookie ? 'present' : 'MISSING',
    });
    if (!ctx?.courseId) return null;
    const result = await this.courseSettings.get(ctx.courseId, {
      isTeacher: this.ltiService.isTeacherRole(ctx.roles ?? ''),
      canvasDomain: ctx.canvasDomain,
    });
    console.log('[CourseSettings GET] courseId:', ctx.courseId, 'result:', JSON.stringify(result));
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
    await this.courseSettings.save(
      ctx.courseId,
      body.selectedCurriculums ?? [],
      body.selectedUnits ?? [],
      ctx.canvasDomain,
      body.canvasApiToken,
    );
  }
}
