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
    if (!ctx?.courseId) return null;
    return this.courseSettings.get(ctx.courseId);
  }

  @Put()
  async save(
    @Req() req: Request,
    @Body() body: { selectedCurriculums?: string[]; selectedUnits?: string[] },
  ) {
    const ctx = req.session?.ltiContext as LtiContext | undefined;
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
    );
  }
}
