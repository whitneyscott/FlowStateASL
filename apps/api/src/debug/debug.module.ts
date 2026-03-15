import { Module } from '@nestjs/common';
import { DebugController } from './debug.controller';
import { CanvasModule } from '../canvas/canvas.module';
import { CourseSettingsModule } from '../course-settings/course-settings.module';

@Module({
  imports: [CanvasModule, CourseSettingsModule],
  controllers: [DebugController],
})
export class DebugModule {}
