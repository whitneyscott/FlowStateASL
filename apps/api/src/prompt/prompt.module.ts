import { Module } from '@nestjs/common';
import { PromptController } from './prompt.controller';
import { PromptService } from './prompt.service';
import { PromptFallbackStore } from './prompt-fallback.store';
import { PromptVideoTitleStore } from './prompt-video-title.store';
import { DataModule } from '../data/data.module';
import { CanvasModule } from '../canvas/canvas.module';
import { CourseSettingsModule } from '../course-settings/course-settings.module';
import { LtiModule } from '../lti/lti.module';
import { QuizModule } from '../quiz/quiz.module';
import { SproutVideoModule } from '../sproutvideo/sproutvideo.module';

@Module({
  imports: [DataModule, CanvasModule, CourseSettingsModule, LtiModule, QuizModule, SproutVideoModule],
  controllers: [PromptController],
  providers: [PromptService, PromptFallbackStore, PromptVideoTitleStore],
})
export class PromptModule {}
