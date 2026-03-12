import { Module } from '@nestjs/common';
import { LtiController } from './lti.controller';
import { LtiService } from './lti.service';
import { LtiJwksService } from './lti-jwks.service';
import { Lti13LaunchService } from './lti13-launch.service';
import { LtiAgsService } from './lti-ags.service';
import { AssessmentModule } from '../assessment/assessment.module';

@Module({
  imports: [AssessmentModule],
  controllers: [LtiController],
  providers: [LtiService, LtiJwksService, Lti13LaunchService, LtiAgsService],
  exports: [LtiService, LtiAgsService],
})
export class LtiModule {}
