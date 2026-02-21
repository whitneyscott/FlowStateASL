import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CanvasService } from './canvas.service';
import { LtiLaunchGuard } from '../lti/guards/lti-launch.guard';

@Controller('canvas')
@UseGuards(LtiLaunchGuard)
export class CanvasController {
  constructor(private readonly canvas: CanvasService) {}

  @Get('module')
  async getModule(
    @Query('course_id') courseId: string,
    @Query('module_id') moduleId: string,
  ) {
    const prefix = process.env.CURRICULUM_PREFIX ?? 'TWA';
    return this.canvas.getModuleInfo(courseId ?? '', moduleId ?? '', prefix);
  }
}
