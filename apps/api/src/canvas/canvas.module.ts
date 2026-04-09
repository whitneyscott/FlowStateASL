import { Module, forwardRef } from '@nestjs/common';
import { CourseSettingsModule } from '../course-settings/course-settings.module';
import { CanvasService } from './canvas.service';
import { CanvasOAuthController } from './canvas-oauth.controller';

@Module({
  imports: [forwardRef(() => CourseSettingsModule)],
  controllers: [CanvasOAuthController],
  providers: [CanvasService],
  exports: [CanvasService],
})
export class CanvasModule {}
