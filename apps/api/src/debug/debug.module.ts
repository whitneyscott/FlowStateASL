import { Module, forwardRef } from '@nestjs/common';
import { DebugController } from './debug.controller';
import { CanvasModule } from '../canvas/canvas.module';
import { CourseSettingsModule } from '../course-settings/course-settings.module';
import { LtiModule } from '../lti/lti.module';

@Module({
  imports: [forwardRef(() => CanvasModule), CourseSettingsModule, LtiModule],
  controllers: [DebugController],
})
export class DebugModule {}
