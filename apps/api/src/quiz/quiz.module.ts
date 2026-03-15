import { Module } from '@nestjs/common';
import { QuizController } from './quiz.controller';
import { QuizService } from './quiz.service';
import { CanvasModule } from '../canvas/canvas.module';
import { CourseSettingsModule } from '../course-settings/course-settings.module';
import { LtiModule } from '../lti/lti.module';

@Module({
  imports: [CanvasModule, CourseSettingsModule, LtiModule],
  controllers: [QuizController],
  providers: [QuizService],
  exports: [QuizService],
})
export class QuizModule {}
