import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  IAssessmentRepository,
  BlockedAttempt,
} from '../../interfaces/assessment-repository.interface';
import { BlockedAttemptEntity } from '../../../assessment/entities/blocked-attempt.entity';

@Injectable()
export class PgAssessmentRepository implements IAssessmentRepository {
  constructor(
    @InjectRepository(BlockedAttemptEntity)
    private readonly repo: Repository<BlockedAttemptEntity>,
  ) {}

  async getBlockedAttempt(
    courseId: string,
    resourceLinkId: string,
    fingerprintHash: string,
  ): Promise<BlockedAttempt | null> {
    const row = await this.repo.findOne({
      where: { courseId, resourceLinkId, fingerprintHash },
    });
    return row
      ? {
          courseId: row.courseId,
          resourceLinkId: row.resourceLinkId,
          fingerprintHash: row.fingerprintHash,
          attemptCount: row.attemptCount,
          blockedAt: row.blockedAt,
        }
      : null;
  }

  async recordAttempt(
    courseId: string,
    resourceLinkId: string,
    fingerprintHash: string,
  ): Promise<BlockedAttempt> {
    const existing = await this.repo.findOne({
      where: { courseId, resourceLinkId, fingerprintHash },
    });
    const entity = existing
      ? await this.repo.save({
          ...existing,
          attemptCount: existing.attemptCount + 1,
        })
      : await this.repo.save(
          this.repo.create({
            courseId,
            resourceLinkId,
            fingerprintHash,
            attemptCount: 1,
          }),
        );
    return {
      courseId: entity.courseId,
      resourceLinkId: entity.resourceLinkId,
      fingerprintHash: entity.fingerprintHash,
      attemptCount: entity.attemptCount,
      blockedAt: entity.blockedAt,
    };
  }

  async clearAttempts(courseId: string, resourceLinkId: string): Promise<void> {
    await this.repo.delete({ courseId, resourceLinkId });
  }

  async isBlocked(
    courseId: string,
    resourceLinkId: string,
    fingerprintHash: string,
    maxAttempts: number,
  ): Promise<boolean> {
    const row = await this.getBlockedAttempt(
      courseId,
      resourceLinkId,
      fingerprintHash,
    );
    return row ? row.attemptCount >= maxAttempts : false;
  }
}
