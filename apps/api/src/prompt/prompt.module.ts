import { Module } from '@nestjs/common';
import { PromptController } from './prompt.controller';
import { PromptService } from './prompt.service';
import { DataModule } from '../data/data.module';
import { CanvasModule } from '../canvas/canvas.module';
import { CourseSettingsModule } from '../course-settings/course-settings.module';
import { LtiModule } from '../lti/lti.module';
import { QuizModule } from '../quiz/quiz.module';

@Module({
  imports: [DataModule, CanvasModule, CourseSettingsModule, LtiModule, QuizModule],
  controllers: [PromptController],
  providers: [PromptService],
})
export class PromptModule {}
