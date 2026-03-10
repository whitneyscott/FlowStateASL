import { Module } from '@nestjs/common';
import { LtiController } from './lti.controller';
import { LtiService } from './lti.service';
import { LtiJwksService } from './lti-jwks.service';
import { Lti13LaunchService } from './lti13-launch.service';
import { AssessmentModule } from '../assessment/assessment.module';
import { CourseSettingsModule } from '../course-settings/course-settings.module';

@Module({
  imports: [AssessmentModule, CourseSettingsModule],
  controllers: [LtiController],
  providers: [LtiService, LtiJwksService, Lti13LaunchService],
  exports: [LtiService],
})
export class LtiModule {}
