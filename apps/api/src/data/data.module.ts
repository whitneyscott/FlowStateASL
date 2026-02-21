import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CONFIG_REPOSITORY } from './tokens';
import { ASSESSMENT_REPOSITORY } from './tokens';
import { PgConfigRepository } from './repositories/postgres/pg-config.repository';
import { PgAssessmentRepository } from './repositories/postgres/pg-assessment.repository';
import { PromptConfigEntity } from '../assessment/entities/prompt-config.entity';
import { BlockedAttemptEntity } from '../assessment/entities/blocked-attempt.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([PromptConfigEntity, BlockedAttemptEntity]),
  ],
  providers: [
    { provide: CONFIG_REPOSITORY, useClass: PgConfigRepository },
    { provide: ASSESSMENT_REPOSITORY, useClass: PgAssessmentRepository },
  ],
  exports: [CONFIG_REPOSITORY, ASSESSMENT_REPOSITORY],
})
export class DataModule {}
