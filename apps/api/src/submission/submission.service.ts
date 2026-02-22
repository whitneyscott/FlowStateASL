import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { AssessmentSessionEntity } from '../assessment/entities/assessment-session.entity';
import { CanvasService } from '../canvas/canvas.service';
import type { LtiContext } from '../common/interfaces/lti-context.interface';
import type { SubmitFlashcardDto } from './dto/submit-flashcard.dto';

function buildProgressJson(dto: SubmitFlashcardDto): string {
  const payload = {
    sessionId: randomUUID(),
    browserSession: Date.now().toString(36),
    deckIds: dto.deckIds ?? [],
    mode: dto.mode ?? 'rehearsal',
    score: dto.score,
    scoreTotal: dto.scoreTotal,
    playlistTitle: dto.playlistTitle ?? '',
    submittedAt: new Date().toISOString(),
  };
  return JSON.stringify(payload);
}

@Injectable()
export class SubmissionService {
  constructor(
    @InjectRepository(AssessmentSessionEntity)
    private readonly sessionRepo: Repository<AssessmentSessionEntity>,
    private readonly canvas: CanvasService,
  ) {}

  /**
   * Save flashcard progress to Canvas Flashcard Progress assignment via submission comment.
   * Ensures the assignment exists, then adds comment (or creates submission + comment if none).
   */
  private async saveProgressToCanvas(
    ctx: LtiContext,
    dto: SubmitFlashcardDto,
  ): Promise<void> {
    try {
      const progressAssignmentId = await this.canvas.ensureFlashcardProgressAssignment(
        ctx.courseId,
        ctx.canvasDomain,
      );
      const commentText = buildProgressJson(dto);
      try {
        await this.canvas.putSubmissionComment(
          ctx.courseId,
          progressAssignmentId,
          ctx.userId,
          commentText,
          ctx.canvasDomain,
        );
      } catch {
        await this.canvas.createSubmissionWithComment(
          ctx.courseId,
          progressAssignmentId,
          ctx.userId,
          'Flashcard progress',
          commentText,
          ctx.canvasDomain,
        );
      }
    } catch {
      // Non-fatal: progress save best-effort; do not block LTI sync
    }
  }

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
   * Flashcard submission: UPSERT outbox → save progress to Flashcard Progress assignment →
   * attempt LTI grade → DELETE on success.
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
      await this.saveProgressToCanvas(ctx, dto);
      return { synced: true };
    }

    await this.saveProgressToCanvas(ctx, dto);

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
