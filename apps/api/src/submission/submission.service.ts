import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { AssessmentSessionEntity } from '../assessment/entities/assessment-session.entity';
import { appendLtiLog } from '../common/last-error.store';
import { CanvasService } from '../canvas/canvas.service';
import { CourseSettingsService } from '../course-settings/course-settings.service';
import { LtiAgsService } from '../lti/lti-ags.service';
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
  incorrectItems: Array<{ videoId: string; name: string }>;
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
  const incorrectItems = Array.isArray(dto.incorrectItems)
    ? dto.incorrectItems
        .map((item) => ({
          videoId: String(item?.videoId ?? '').trim(),
          name: String(item?.name ?? '').trim(),
        }))
        .filter((item) => item.videoId.length > 0 && item.name.length > 0)
    : [];

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
    incorrectItems,
  };
}

@Injectable()
export class SubmissionService {
  constructor(
    @InjectRepository(AssessmentSessionEntity)
    private readonly sessionRepo: Repository<AssessmentSessionEntity>,
    private readonly canvas: CanvasService,
    private readonly courseSettings: CourseSettingsService,
    private readonly ltiAgs: LtiAgsService,
  ) {}

  private async saveProgressToCanvas(
    ctx: LtiContext,
    dto: SubmitFlashcardDto,
  ): Promise<void> {
    const canvasOverride = ctx.canvasBaseUrl ?? ctx.canvasDomain;
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    const progressAssignmentId =
      await this.courseSettings.getProgressAssignmentId(
        ctx.courseId,
        ctx.canvasDomain,
        ctx.canvasBaseUrl,
        token,
      );
    const numericUserId = await this.canvas.getCurrentCanvasUserId(canvasOverride, token);
    const apiUserId = numericUserId ?? ctx.canvasUserId ?? ctx.userId;
    const existing = await this.canvas.getSubmission(
      ctx.courseId,
      progressAssignmentId,
      apiUserId,
      canvasOverride,
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

    appendLtiLog('submission', 'saveProgressToCanvas (Step 10)', {
      progressAssignmentId,
      deckCount: deckIdsToSave.length,
      tokenSource: ctx.canvasAccessToken ? 'session (launcher token)' : 'null',
      submittingForUserId: ctx.userId,
    });

    // Use writeSubmissionBody (Step 9); it calls createSubmissionWithBody internally.
    await this.canvas.writeSubmissionBody(ctx, progressAssignmentId, bodyJson, token);

    // Verify: re-fetch submission using the token owner's Canvas ID (same source as the write)
    let verified: { body?: string } | null = null;
    if (numericUserId) {
      verified = await this.canvas.getSubmission(
        ctx.courseId,
        progressAssignmentId,
        numericUserId,
        canvasOverride,
        token,
      );
    }
    if (!verified?.body?.trim()) {
      verified = await this.canvas.getSubmissionForCurrentUser(
        ctx.courseId,
        progressAssignmentId,
        canvasOverride,
        token,
      );
    }
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
    debug?: {
      progressSaved: boolean;
      gradeSent?: boolean;
      details: string;
      canvasRequest?: {
        tokenSource: string;
        tokenPreview: string;
        submittingForUserId: string;
        as_user_idInRequest: boolean;
        note?: string;
      };
    };
  }> {
    const { points, isGraded } = this.calculateGrade(dto);
    appendLtiLog('submission', 'submitFlashcard branch', {
      dtoMode: dto.mode ?? '(absent)',
      isGraded,
      points,
      branch: !isGraded ? 'REST only (tutorial — AGS never called)' : 'REST then AGS (graded)',
    });
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
        const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
        const tokenPreview = token ? `${token.slice(0, 4)}...${token.slice(-4)} (len=${token.length})` : 'MISSING';
        return {
          synced: false,
          error: msg,
          debug: {
            progressSaved: false,
            details: `Progress failed to save. Reason: ${msg}`,
            canvasRequest: {
              tokenSource: ctx.canvasAccessToken ? 'session (launcher\'s OAuth token)' : 'null',
              tokenPreview,
              submittingForUserId: ctx.userId,
              as_user_idInRequest: false,
            },
          },
        };
      }
    }

    try {
      await this.saveProgressToCanvas(ctx, dto);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
      const tokenPreview = token ? `${token.slice(0, 4)}...${token.slice(-4)} (len=${token.length})` : 'MISSING';
      return {
        synced: false,
        error: msg,
        debug: {
          progressSaved: false,
          details: `Progress failed to save. Reason: ${msg} Complete Canvas OAuth (Teacher Settings) and ensure the Flashcard Progress assignment exists and is published.`,
          canvasRequest: {
            tokenSource: ctx.canvasAccessToken ? 'session (launcher\'s OAuth token)' : 'null',
            tokenPreview,
            submittingForUserId: ctx.userId,
            as_user_idInRequest: false,
            note: 'actAsUser not used → no as_user_id (self-submit)',
          },
        },
      };
    }

    await this.sessionRepo.delete(row.id);

    let gradeSent = false;
    if (isGraded) {
      try {
        await this.ltiAgs.submitGradeViaAgs(ctx, { score: points, scoreMaximum: 100 });
        gradeSent = true;
        appendLtiLog('submission', 'submitGradeViaAgs (Step 12) success', { score: points, scoreMaximum: 100 });
      } catch (agsErr) {
        const agsMsg = agsErr instanceof Error ? agsErr.message : String(agsErr);
        console.warn('[Submission] AGS grade passback failed:', agsMsg);
        appendLtiLog('submission', 'submitGradeViaAgs (Step 12) failed', { error: agsMsg });
      }
    }

    return {
      synced: true,
      debug: {
        progressSaved: true,
        gradeSent,
        details: gradeSent
          ? 'Progress saved and grade sent to Canvas via AGS.'
          : 'Progress saved to Flashcard Progress assignment submission body.',
      },
    };
  }
}
