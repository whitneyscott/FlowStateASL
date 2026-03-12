import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssessmentSessionEntity } from '../assessment/entities/assessment-session.entity';
import { CanvasModule } from '../canvas/canvas.module';
import { CourseSettingsModule } from '../course-settings/course-settings.module';
import { LtiModule } from '../lti/lti.module';
import { SubmissionController } from './submission.controller';
import { SubmissionService } from './submission.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([AssessmentSessionEntity]),
    CanvasModule,
    CourseSettingsModule,
    LtiModule,
  ],
  controllers: [SubmissionController],
  providers: [SubmissionService],
})
export class SubmissionModule {}
