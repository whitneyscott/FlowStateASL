import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PromptController } from './prompt.controller';
import { PromptService } from './prompt.service';
import { UploadResilienceService } from './upload-resilience.service';
import { DataModule } from '../data/data.module';
import { CanvasModule } from '../canvas/canvas.module';
import { CourseSettingsModule } from '../course-settings/course-settings.module';
import { LtiModule } from '../lti/lti.module';
import { QuizModule } from '../quiz/quiz.module';
import { SproutVideoModule } from '../sproutvideo/sproutvideo.module';
import { SproutPlaylistVideoEntity } from '../sproutvideo/entities/sprout-playlist-video.entity';

@Module({
  imports: [
    DataModule,
    forwardRef(() => CanvasModule),
    forwardRef(() => CourseSettingsModule),
    forwardRef(() => LtiModule),
    forwardRef(() => QuizModule),
    SproutVideoModule,
    TypeOrmModule.forFeature([SproutPlaylistVideoEntity]),
  ],
  controllers: [PromptController],
  providers: [PromptService, UploadResilienceService],
  exports: [PromptService],
})
export class PromptModule {}
