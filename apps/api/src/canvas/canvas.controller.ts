import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { CanvasService } from './canvas.service';
import { LtiLaunchGuard } from '../lti/guards/lti-launch.guard';

@Controller('canvas')
@UseGuards(LtiLaunchGuard)
export class CanvasController {
  constructor(private readonly canvas: CanvasService) {}

  @Get('module')
  async getModule(
    @Req() req: Request,
    @Query('course_id') courseId: string,
    @Query('module_id') moduleId: string,
  ) {
    const prefix = process.env.CURRICULUM_PREFIX ?? 'TWA';
    const canvasDomain = req.session?.ltiContext?.canvasDomain;
    return this.canvas.getModuleInfo(
      courseId ?? '',
      moduleId ?? '',
      prefix,
      canvasDomain,
    );
  }
}
