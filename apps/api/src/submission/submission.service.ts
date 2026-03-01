import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { AssessmentSessionEntity } from '../assessment/entities/assessment-session.entity';
import { CanvasService } from '../canvas/canvas.service';
import { CourseSettingsService } from '../course-settings/course-settings.service';
import type { LtiContext } from '../common/interfaces/lti-context.interface';
import type { SubmitFlashcardDto } from './dto/submit-flashcard.dto';

export function calculateRehearsalThreshold(deckSize: number): number {
  return Math.max(Math.ceil(deckSize * 0.85), deckSize - 1);
}

type DeckResult = {
  sessionId: string;
  browserSession: string;
  mode: 'tutorial' | 'rehearsal' | 'screening';
  score: number;
  scoreTotal: number;
  playlistTitle: string;
  rehearsalBestScore: string | null;
};

type SubmissionBodyResults = Record<string, DeckResult>;

function parseSubmissionBody(raw: string | null | undefined): { results: SubmissionBodyResults; wasMalformed: boolean } {
  const trimmed = raw?.trim();
  if (!trimmed) return { results: {}, wasMalformed: false };
  try {
    const parsed = JSON.parse(trimmed) as { results?: SubmissionBodyResults };
    if (parsed && typeof parsed === 'object' && parsed.results && typeof parsed.results === 'object' && !Array.isArray(parsed.results)) {
      return { results: parsed.results, wasMalformed: false };
    }
  } catch {
    // fall through
  }
  return { results: {}, wasMalformed: true };
}

function mergeDeckResult(existing: DeckResult | undefined, dto: SubmitFlashcardDto): DeckResult {
  const raw = (dto.mode ?? 'rehearsal').toLowerCase();
  const mode: 'tutorial' | 'rehearsal' | 'screening' =
    raw === 'tutorial' || raw === 'screening' ? raw : 'rehearsal';
  const score = dto.score ?? 0;
  const scoreTotal = dto.scoreTotal ?? 0;
  const playlistTitle = dto.playlistTitle ?? '';

  let rehearsalBestScore: string | null = existing?.rehearsalBestScore ?? null;
  if (mode === 'rehearsal' && scoreTotal > 0) {
    const storedScore = existing?.rehearsalBestScore
      ? parseFloat(existing.rehearsalBestScore.split('/')[0] ?? '0')
      : -1;
    if (score > storedScore) {
      rehearsalBestScore = `${score}/${scoreTotal}`;
    }
  }

  return {
    sessionId: randomUUID(),
    browserSession: Date.now().toString(36),
    mode,
    score,
    scoreTotal,
    playlistTitle,
    rehearsalBestScore,
  };
}

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
    const existing = await this.canvas.getSubmission(
      ctx.courseId,
      progressAssignmentId,
      ctx.userId,
      ctx.canvasDomain,
      token,
    );
    const parsed = parseSubmissionBody(existing?.body);
    if (parsed.wasMalformed) {
      console.warn('[saveProgressToCanvas] submission body malformed, starting fresh');
    }
    const results = { ...parsed.results };
    const deckIdsToSave = dto.deckIds ?? [];
    for (const deckId of deckIdsToSave) {
      const id = String(deckId);
      results[id] = mergeDeckResult(results[id], dto);
    }
    const bodyJson = JSON.stringify({ results });

    if (!existing) {
      await this.canvas.createSubmissionWithBodyAndComment(
        ctx.courseId,
        progressAssignmentId,
        ctx.userId,
        bodyJson,
        commentText,
        ctx.canvasDomain,
        token,
      );
    } else {
      await this.canvas.putSubmissionComment(
        ctx.courseId,
        progressAssignmentId,
        ctx.userId,
        commentText,
        ctx.canvasDomain,
        token,
      );
      await this.canvas.putSubmissionBody(
        ctx.courseId,
        progressAssignmentId,
        ctx.userId,
        bodyJson,
        ctx.canvasDomain,
        token,
      );
    }

    // Verify: re-fetch submission and confirm our data is present
    const verified = await this.canvas.getSubmission(
      ctx.courseId,
      progressAssignmentId,
      ctx.userId,
      ctx.canvasDomain,
      token,
    );
    if (!verified?.body?.trim()) {
      throw new Error(
        `Verification failed: submission for user ${ctx.userId} on Flashcard Progress assignment (${progressAssignmentId}) has no body. ` +
        'Check Canvas: Course > Assignments > Flashcard Progress > SpeedGrader for this student.',
      );
    }
    const verifiedParsed = parseSubmissionBody(verified.body);
    const hasOurDeck = deckIdsToSave.some((id) => verifiedParsed.results[String(id)]);
    if (!hasOurDeck) {
      throw new Error(
        `Verification failed: saved data not found for deck(s) ${deckIdsToSave.join(', ')}. ` +
        `Assignment ${progressAssignmentId}, user ${ctx.userId}. Canvas may not persist submission body via PUT.`,
      );
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

    await this.sessionRepo.delete(row.id);

    // TODO: Replace with rubric criterion scoring once gate assignments and rubric system are implemented.
    // submitGrade(lisOutcomeServiceUrl, lisResultSourcedid, dto.score, dto.scoreTotal) — STUBBED OUT

    return { synced: true, debug: { progressSaved: true, gradeSent: false, details: 'Progress saved to Flashcard Progress assignment (comments and submission body).' } };
  }
}
