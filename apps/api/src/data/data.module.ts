import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CONFIG_REPOSITORY } from './tokens';
import { ASSESSMENT_REPOSITORY } from './tokens';
import { PROMPT_DATA_REPOSITORY } from './tokens';
import { PgConfigRepository } from './repositories/postgres/pg-config.repository';
import { PgAssessmentRepository } from './repositories/postgres/pg-assessment.repository';
import { PgPromptDataRepository } from './repositories/postgres/pg-prompt-data.repository';
import { PromptConfigEntity } from '../assessment/entities/prompt-config.entity';
import { BlockedAttemptEntity } from '../assessment/entities/blocked-attempt.entity';
import { AssignmentPromptEntity } from '../prompt/entities/assignment-prompt.entity';
import { StudentResetEntity } from '../prompt/entities/student-reset.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PromptConfigEntity,
      BlockedAttemptEntity,
      AssignmentPromptEntity,
      StudentResetEntity,
    ]),
  ],
  providers: [
    { provide: CONFIG_REPOSITORY, useClass: PgConfigRepository },
    { provide: ASSESSMENT_REPOSITORY, useClass: PgAssessmentRepository },
    { provide: PROMPT_DATA_REPOSITORY, useClass: PgPromptDataRepository },
  ],
  exports: [
    CONFIG_REPOSITORY,
    ASSESSMENT_REPOSITORY,
    PROMPT_DATA_REPOSITORY,
  ],
})
export class DataModule {}
