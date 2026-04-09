import { Module } from '@nestjs/common';
import { DebugController } from './debug.controller';
import { CanvasModule } from '../canvas/canvas.module';
import { CourseSettingsModule } from '../course-settings/course-settings.module';
import { LtiModule } from '../lti/lti.module';

@Module({
  imports: [CanvasModule, CourseSettingsModule, LtiModule],
  controllers: [DebugController],
})
export class DebugModule {}
