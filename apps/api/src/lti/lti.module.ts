import { Module } from '@nestjs/common';
import { LtiController } from './lti.controller';
import { LtiService } from './lti.service';
import { AssessmentModule } from '../assessment/assessment.module';

@Module({
  imports: [AssessmentModule],
  controllers: [LtiController],
  providers: [LtiService],
  exports: [LtiService],
})
export class LtiModule {}
