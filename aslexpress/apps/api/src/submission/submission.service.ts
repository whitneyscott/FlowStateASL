import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssessmentSessionEntity } from '../assessment/entities/assessment-session.entity';
import { CanvasService } from '../canvas/canvas.service';
import type { LtiContext } from '../common/interfaces/lti-context.interface';
import type { SubmitFlashcardDto } from './dto/submit-flashcard.dto';

@Injectable()
export class SubmissionService {
  constructor(
    @InjectRepository(AssessmentSessionEntity)
    private readonly sessionRepo: Repository<AssessmentSessionEntity>,
    private readonly canvas: CanvasService,
  ) {}

  /**
   * Tutorial = 0 pts; others = percentage (0–100).
   */
  calculateGrade(dto: SubmitFlashcardDto): { points: number; isGraded: boolean } {
    const mode = (dto.mode ?? 'rehearsal').toLowerCase();
    if (mode === 'tutorial') {
      return { points: 0, isGraded: false };
    }
    const percentage =
      dto.scoreTotal > 0 ? (dto.score / dto.scoreTotal) * 100 : 0;
    return { points: percentage, isGraded: true };
  }

  /**
   * Flashcard submission: UPSERT outbox → attempt LTI grade → DELETE on success.
   * Returns 201 if synced, 202 if Canvas/LTI fails (row kept for retry).
   */
  async submitFlashcard(ctx: LtiContext, dto: SubmitFlashcardDto): Promise<{
    synced: boolean;
    error?: string;
  }> {
    const { points, isGraded } = this.calculateGrade(dto);
    const assignmentId = ctx.assignmentId || ctx.resourceLinkId || '0';

    const existing = await this.sessionRepo.findOne({
      where: {
        courseId: ctx.courseId,
        assignmentId,
        userId: ctx.userId,
      },
    });

    const entity: Partial<AssessmentSessionEntity> = {
      courseId: ctx.courseId,
      assignmentId,
      userId: ctx.userId,
      resourceLinkId: ctx.resourceLinkId || '',
      deckIds: dto.deckIds,
      wordCount: dto.wordCount ?? 0,
      score: dto.score,
      scoreTotal: dto.scoreTotal,
      promptSnapshotHtml: null,
      selectedCardsHtml: null,
      syncStatus: 'pending',
      syncErrorMessage: null,
      submittedAt: new Date(),
    };

    const row = existing
      ? await this.sessionRepo.save({ ...existing, ...entity })
      : await this.sessionRepo.save(
          this.sessionRepo.create({
            ...entity,
            uploadProgressOffset: 0,
          }),
        );

    if (!isGraded) {
      await this.sessionRepo.delete(row.id);
      return { synced: true };
    }

    const { lisOutcomeServiceUrl, lisResultSourcedid } = ctx;
    if (!lisOutcomeServiceUrl || !lisResultSourcedid) {
      await this.sessionRepo.update(row.id, {
        syncStatus: 'failed',
        syncErrorMessage: 'LTI grade passback not configured for this launch',
      });
      return {
        synced: false,
        error: 'LTI grade passback not configured for this launch',
      };
    }

    try {
      await this.canvas.submitGrade(
        lisOutcomeServiceUrl,
        lisResultSourcedid,
        dto.score,
        dto.scoreTotal,
      );
      await this.sessionRepo.delete(row.id);
      return { synced: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.sessionRepo.update(row.id, {
        syncStatus: 'failed',
        syncErrorMessage: msg,
      });
      return { synced: false, error: msg };
    }
  }
}
