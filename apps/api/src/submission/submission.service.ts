import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { AssessmentSessionEntity } from '../assessment/entities/assessment-session.entity';
import { CanvasService } from '../canvas/canvas.service';
import { CourseSettingsService } from '../course-settings/course-settings.service';
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
    private readonly courseSettings: CourseSettingsService,
  ) {}

  private async saveProgressToCanvas(
    ctx: LtiContext,
    dto: SubmitFlashcardDto,
  ): Promise<void> {
    const progressAssignmentId =
      await this.courseSettings.getProgressAssignmentId(
        ctx.courseId,
        ctx.canvasDomain,
      );
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId);
    const commentText = buildProgressJson(dto);
    try {
      await this.canvas.putSubmissionComment(
        ctx.courseId,
        progressAssignmentId,
        ctx.userId,
        commentText,
        ctx.canvasDomain,
        token,
      );
    } catch (putErr) {
      console.warn(
        '[saveProgressToCanvas] putSubmissionComment failed, trying createSubmissionWithComment',
        { courseId: ctx.courseId, assignmentId: progressAssignmentId, userId: ctx.userId },
      );
      try {
        await this.canvas.createSubmissionWithComment(
          ctx.courseId,
          progressAssignmentId,
          ctx.userId,
          'Flashcard progress',
          commentText,
          ctx.canvasDomain,
          token,
        );
      } catch (createErr) {
        const msg = createErr instanceof Error ? createErr.message : String(createErr);
        console.error('[saveProgressToCanvas] failed:', msg);
        throw createErr;
      }
    }
  }

  calculateGrade(dto: SubmitFlashcardDto): { points: number; isGraded: boolean } {
    const mode = (dto.mode ?? 'rehearsal').toLowerCase();
    if (mode === 'tutorial') {
      return { points: 0, isGraded: false };
    }
    const percentage =
      dto.scoreTotal > 0 ? (dto.score / dto.scoreTotal) * 100 : 0;
    return { points: percentage, isGraded: true };
  }

  async submitFlashcard(ctx: LtiContext, dto: SubmitFlashcardDto): Promise<{
    synced: boolean;
    error?: string;
    debug?: { progressSaved: boolean; gradeSent?: boolean; details: string };
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
      try {
        await this.saveProgressToCanvas(ctx, dto);
        return { synced: true, debug: { progressSaved: true, details: 'Progress saved to Flashcard Progress assignment.' } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          synced: false,
          error: msg,
          debug: { progressSaved: false, details: `Progress failed to save. Reason: ${msg}` },
        };
      }
    }

    try {
      await this.saveProgressToCanvas(ctx, dto);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        synced: false,
        error: msg,
        debug: {
          progressSaved: false,
          details: `Progress failed to save. Reason: ${msg} Check that the Canvas API token is configured in Teacher Settings or CANVAS_API_TOKEN env, and that the Flashcard Progress assignment exists and is published.`,
        },
      };
    }

    const { lisOutcomeServiceUrl, lisResultSourcedid } = ctx;
    if (!lisOutcomeServiceUrl || !lisResultSourcedid) {
      await this.sessionRepo.delete(row.id);
      return {
        synced: true,
        debug: {
          progressSaved: true,
          gradeSent: false,
          details: 'Progress saved to Flashcard Progress assignment. Grade not sent: lis_outcome_service_url and lis_result_sourcedid were not in the LTI launch. Canvas sends these only when the tool is launched from an External Tool assignment. To fix: Add the flashcards tool as an External Tool assignment in your Canvas course and launch from that assignment link (instead of Course Navigation).',
        },
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
      return { synced: true, debug: { progressSaved: true, gradeSent: true, details: 'Progress saved. Grade sent to assignment.' } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.sessionRepo.update(row.id, {
        syncStatus: 'failed',
        syncErrorMessage: msg,
      });
      return {
        synced: true,
        debug: {
          progressSaved: true,
          gradeSent: false,
          details: `Progress saved. Grade failed to send: ${msg}`,
        },
      };
    }
  }
}
