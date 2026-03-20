import { Module } from '@nestjs/common';
import { LtiController } from './lti.controller';
import { LtiService } from './lti.service';
import { LtiJwksService } from './lti-jwks.service';
import { Lti13LaunchService } from './lti13-launch.service';
import { Lti11LaunchVerifyService } from './lti11-launch.verify.service';
import { LtiAgsService } from './lti-ags.service';
import { LtiDeepLinkFileStore } from './lti-deep-link-file.store';
import { LtiDeepLinkResponseService } from './lti-deep-link-response.service';
import { AssessmentModule } from '../assessment/assessment.module';

@Module({
  imports: [AssessmentModule],
  controllers: [LtiController],
  providers: [
    LtiService,
    LtiJwksService,
    Lti13LaunchService,
    Lti11LaunchVerifyService,
    LtiAgsService,
    LtiDeepLinkFileStore,
    LtiDeepLinkResponseService,
  ],
  exports: [LtiService, LtiAgsService, LtiDeepLinkFileStore, LtiDeepLinkResponseService],
})
export class LtiModule {}
