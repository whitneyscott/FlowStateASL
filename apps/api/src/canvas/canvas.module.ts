import { Module, forwardRef } from '@nestjs/common';
import { CourseSettingsModule } from '../course-settings/course-settings.module';
import { CanvasService } from './canvas.service';
import { CanvasOAuthController } from './canvas-oauth.controller';
import { AuthStateModule } from '../auth-state/auth-state.module';

@Module({
  imports: [forwardRef(() => CourseSettingsModule), AuthStateModule],
  controllers: [CanvasOAuthController],
  providers: [CanvasService],
  exports: [CanvasService],
})
export class CanvasModule {}
