import { Inject, Injectable } from '@nestjs/common';
import { ASSESSMENT_REPOSITORY, PROMPT_DATA_REPOSITORY } from '../data/tokens';
import type { IAssessmentRepository } from '../data/interfaces/assessment-repository.interface';
import type { IPromptDataRepository } from '../data/interfaces/prompt-data-repository.interface';
import { appendLtiLog } from '../common/last-error.store';
import { CanvasService } from '../canvas/canvas.service';
import { CourseSettingsService } from '../course-settings/course-settings.service';
import { LtiAgsService } from '../lti/lti-ags.service';
import type { LtiContext } from '../common/interfaces/lti-context.interface';
import type { PromptConfigJson, PutPromptConfigDto } from './dto/prompt-config.dto';

const PROMPTER_ASSIGNMENT_TITLE = 'Prompt Manager Submissions';
const MAX_ACCESS_ATTEMPTS = 3;

/** Extract JSON from Canvas assignment description (same pattern as course-settings). Canvas may wrap in HTML. */
function extractPromptConfigFromDescription(raw: string): PromptConfigJson | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as PromptConfigJson;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as PromptConfigJson;
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

@Injectable()
export class PromptService {
  constructor(
    @Inject(ASSESSMENT_REPOSITORY) private readonly assessmentRepo: IAssessmentRepository,
    @Inject(PROMPT_DATA_REPOSITORY) private readonly promptDataRepo: IPromptDataRepository,
    private readonly canvas: CanvasService,
    private readonly courseSettings: CourseSettingsService,
    private readonly ltiAgs: LtiAgsService,
  ) {}

  private async getPrompterAssignmentId(ctx: LtiContext): Promise<string> {
    if (ctx.assignmentId?.trim()) {
      appendLtiLog('prompt', 'assignment resolution (1.2)', {
        courseId: ctx.courseId,
        source: 'ctx.assignmentId',
        result: 'found',
        assignmentId: ctx.assignmentId,
      });
      return ctx.assignmentId.trim();
    }
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      throw new Error('Canvas OAuth token required for Prompter assignment resolution');
    }
    const assignmentId = await this.canvas.ensureAssignmentForCourse(
      ctx,
      {
        title: PROMPTER_ASSIGNMENT_TITLE,
        description: 'ASL Express Prompt Manager submissions (auto-created)',
        submissionTypes: ['online_text_entry', 'online_upload'],
      },
      token,
    );
    appendLtiLog('prompt', 'assignment resolution (1.2)', {
      courseId: ctx.courseId,
      source: 'ensureAssignmentForCourse',
      result: 'created',
      assignmentId,
    });
    return assignmentId;
  }

  async getConfig(ctx: LtiContext): Promise<PromptConfigJson | null> {
    const assignmentId = ctx.assignmentId?.trim();
    if (!assignmentId) {
      appendLtiLog('prompt', 'config (1.1)', { action: 'get', courseId: ctx.courseId, reason: 'no_assignment_id' });
      return null;
    }
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      appendLtiLog('prompt', 'config (1.1)', { action: 'get', courseId: ctx.courseId, reason: 'no_canvas_token' });
      return null;
    }
    const domainOverride = ctx.canvasBaseUrl ?? ctx.canvasDomain;
    const assignment = await this.canvas.getAssignment(ctx.courseId, assignmentId, domainOverride, token);
    const rawDesc = assignment?.description?.trim() ?? '';
    const parsed = extractPromptConfigFromDescription(rawDesc);
    appendLtiLog('prompt', 'config (1.1)', {
      action: 'get',
      courseId: ctx.courseId,
      assignmentId,
      success: !!parsed,
    });
    return parsed;
  }

  async putConfig(ctx: LtiContext, dto: PutPromptConfigDto): Promise<void> {
    const assignmentId = ctx.assignmentId?.trim();
    if (!assignmentId) {
      throw new Error('Tool must be placed in an assignment. No assignment ID in LTI context.');
    }
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      throw new Error('Canvas OAuth token required. Complete the Canvas OAuth flow (launch via LTI as teacher).');
    }
    const existing = await this.getConfig(ctx);
    const base: PromptConfigJson = existing ?? { minutes: 5, prompts: [], accessCode: '' };
    const merged: PromptConfigJson = {
      ...base,
      ...(dto.minutes != null && { minutes: dto.minutes }),
      ...(dto.prompts != null && { prompts: dto.prompts }),
      ...(dto.accessCode !== undefined && { accessCode: dto.accessCode }),
      ...(dto.assignmentName !== undefined && { assignmentName: dto.assignmentName }),
      ...(dto.assignmentGroupId !== undefined && { assignmentGroupId: dto.assignmentGroupId }),
      ...(dto.pointsPossible !== undefined && { pointsPossible: dto.pointsPossible }),
      ...(dto.rubricId !== undefined && { rubricId: dto.rubricId }),
      ...(dto.dueAt !== undefined && { dueAt: dto.dueAt }),
      ...(dto.unlockAt !== undefined && { unlockAt: dto.unlockAt }),
      ...(dto.lockAt !== undefined && { lockAt: dto.lockAt }),
      ...(dto.allowedAttempts !== undefined && { allowedAttempts: dto.allowedAttempts }),
      ...(dto.shadowAssignmentId !== undefined && { shadowAssignmentId: dto.shadowAssignmentId }),
      ...(dto.version !== undefined && { version: dto.version }),
    };
    const domainOverride = ctx.canvasBaseUrl ?? ctx.canvasDomain;
    const description = `<div style="display:none">${JSON.stringify(merged)}</div>`;
    await this.canvas.updateAssignmentDescription(
      ctx.courseId,
      assignmentId,
      description,
      domainOverride,
      token,
    );
    appendLtiLog('prompt', 'config (1.1)', {
      action: 'put',
      courseId: ctx.courseId,
      assignmentId,
      source: 'assignment_description',
      success: true,
    });
  }

  async verifyAccess(
    ctx: LtiContext,
    accessCode: string,
    _fingerprint: string,
  ): Promise<{ success: boolean; blocked?: boolean; attemptCount?: number }> {
    /* Config (including accessCode) from assignment description only - same pattern as flashcards. No DB. */
    const config = await this.getConfig(ctx);
    const expected = (config?.accessCode ?? '').trim().toUpperCase();
    const given = (accessCode ?? '').trim().toUpperCase();

    if (expected && given !== expected) {
      appendLtiLog('prompt', 'verify-access (3.2)', {
        courseId: ctx.courseId,
        resourceLinkId: ctx.resourceLinkId,
        success: false,
      });
      return { success: false };
    }

    appendLtiLog('prompt', 'verify-access (3.2)', {
      courseId: ctx.courseId,
      resourceLinkId: ctx.resourceLinkId,
      success: true,
    });
    return { success: true };
  }

  async savePrompt(ctx: LtiContext, promptText: string): Promise<void> {
    const assignmentId = await this.getPrompterAssignmentId(ctx);
    await this.promptDataRepo.saveAssignmentPrompt({
      courseId: ctx.courseId,
      assignmentId,
      userId: ctx.userId,
      resourceLinkId: ctx.resourceLinkId,
      promptText,
    });
    appendLtiLog('prompt', 'save-prompt', {
      courseId: ctx.courseId,
      assignmentId,
      userId: ctx.userId,
      success: true,
    });
  }

  async submit(ctx: LtiContext, promptSnapshotHtml: string): Promise<void> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      throw new Error('Canvas OAuth token required for submission');
    }
    const assignmentId = await this.getPrompterAssignmentId(ctx);
    const bodyString = JSON.stringify({
      promptSnapshotHtml,
      submittedAt: new Date().toISOString(),
    });
    const ctxWithToken: LtiContext = { ...ctx, canvasAccessToken: token };
    await this.canvas.writeSubmissionBody(ctxWithToken, assignmentId, bodyString, token);
    appendLtiLog('prompt', 'submit (4.1)', {
      courseId: ctx.courseId,
      assignmentId,
      userId: ctx.userId,
      step: 'writeBody',
      success: true,
    });
  }

  async uploadVideo(
    ctx: LtiContext,
    buffer: Buffer,
    filename: string,
  ): Promise<{ fileId: string }> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      throw new Error('Canvas OAuth token required for video upload');
    }
    const domainOverride = ctx.canvasBaseUrl ?? ctx.canvasDomain;
    const numericUserId = await this.canvas.getCurrentCanvasUserId(domainOverride, token);
    const apiUserId = numericUserId ?? ctx.canvasUserId ?? ctx.userId;
    const assignmentId = await this.getPrompterAssignmentId(ctx);
    // Option 1: upload to user's files (users/self/files), then attach to submission
    const { uploadUrl, uploadParams } = await this.canvas.initiateUserFileUpload(
      filename,
      buffer.length,
      'video/webm',
      domainOverride,
      token,
    );
    const { fileId } = await this.canvas.uploadFileToCanvas(uploadUrl, uploadParams, buffer, {
      tokenOverride: token,
    });
    await this.canvas.attachFileToSubmission(
      ctx.courseId,
      assignmentId,
      apiUserId,
      fileId,
      domainOverride,
      token,
    );
    appendLtiLog('prompt', 'video upload (4.3)', {
      assignmentId,
      fileId,
      apiUserId,
      success: true,
    });
    return { fileId };
  }

  async getSubmissions(ctx: LtiContext): Promise<
    Array<{
      userId: string;
      userName?: string;
      body?: string;
      score?: number;
      grade?: string;
      submissionComments?: Array<{ id: number; comment: string }>;
      videoUrl?: string;
    }>
  > {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      throw new Error('Canvas OAuth token required');
    }
    const assignmentId = await this.getPrompterAssignmentId(ctx);
    const domainOverride = ctx.canvasBaseUrl ?? ctx.canvasDomain;
    const list = await this.canvas.listSubmissions(
      ctx.courseId,
      assignmentId,
      domainOverride,
      token,
    );
    return list.map((s) => ({
      userId: String(s.user_id),
      userName: s.user?.name,
      body: s.body,
      score: s.score,
      grade: s.grade,
      submissionComments: s.submission_comments?.map((c) => ({ id: c.id, comment: c.comment })) ?? [],
      videoUrl: s.attachment?.url ?? s.attachments?.[0]?.url,
    }));
  }

  async grade(
    ctx: LtiContext,
    userId: string,
    score: number,
    scoreMaximum: number,
    resultContent?: string,
    rubricAssessment?: Record<string, unknown>,
  ): Promise<void> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) {
      throw new Error('Canvas OAuth token required');
    }
    const assignmentId = await this.getPrompterAssignmentId(ctx);
    const domainOverride = ctx.canvasBaseUrl ?? ctx.canvasDomain;

    if (rubricAssessment && Object.keys(rubricAssessment).length > 0) {
      await this.canvas.putSubmissionGrade(
        ctx.courseId,
        assignmentId,
        userId,
        { rubricAssessment },
        domainOverride,
        token,
      );
    } else {
      const scoreMax = scoreMaximum > 0 ? scoreMaximum : 100;
      await this.ltiAgs.submitGradeViaAgs(ctx, {
        score,
        scoreMaximum: scoreMax,
        resultContent: resultContent ?? undefined,
        userId,
      });
    }
    appendLtiLog('prompt', 'grade submit (4.4)', {
      courseId: ctx.courseId,
      assignmentId,
      userId,
      score,
      success: true,
    });
  }

  /** Teacher only - guard applied at controller. */
  async addComment(
    ctx: LtiContext,
    userId: string,
    time: number,
    text: string,
    attempt?: number,
  ): Promise<{ commentId?: number }> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) throw new Error('Canvas OAuth token required');
    const assignmentId = await this.getPrompterAssignmentId(ctx);
    const m = Math.floor(time / 60);
    const s = time % 60;
    const commentLine = `[${m}:${s < 10 ? '0' : ''}${s}] ${text}`;
    const domainOverride = ctx.canvasBaseUrl ?? ctx.canvasDomain;
    return this.canvas.addSubmissionComment(
      ctx.courseId,
      assignmentId,
      userId,
      commentLine,
      { attempt },
      domainOverride,
      token,
    );
  }

  async editComment(
    ctx: LtiContext,
    userId: string,
    commentId: string,
    time: number,
    text: string,
  ): Promise<void> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) throw new Error('Canvas OAuth token required');
    const assignmentId = await this.getPrompterAssignmentId(ctx);
    const m = Math.floor(time / 60);
    const s = time % 60;
    const commentLine = `[${m}:${s < 10 ? '0' : ''}${s}] ${text}`;
    const domainOverride = ctx.canvasBaseUrl ?? ctx.canvasDomain;
    await this.canvas.editSubmissionComment(
      ctx.courseId,
      assignmentId,
      userId,
      commentId,
      commentLine,
      domainOverride,
      token,
    );
  }

  /** Teacher only - guard applied at controller. */
  async deleteComment(ctx: LtiContext, userId: string, commentId: string): Promise<void> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) throw new Error('Canvas OAuth token required');
    const assignmentId = await this.getPrompterAssignmentId(ctx);
    const domainOverride = ctx.canvasBaseUrl ?? ctx.canvasDomain;
    await this.canvas.deleteSubmissionComment(
      ctx.courseId,
      assignmentId,
      userId,
      commentId,
      domainOverride,
      token,
    );
  }

  async resetAttempt(ctx: LtiContext, userId: string): Promise<void> {
    const assignmentId = await this.getPrompterAssignmentId(ctx);
    await this.promptDataRepo.recordStudentReset(ctx.courseId, assignmentId, userId);
    appendLtiLog('prompt', 'reset-attempt', {
      courseId: ctx.courseId,
      assignmentId,
      userId,
      success: true,
    });
  }

  /** Teacher only - guard applied at controller. */
  async getAssignmentForGrading(ctx: LtiContext): Promise<{
    pointsPossible?: number;
    rubric?: Array<unknown>;
  } | null> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) return null;
    const assignmentId = await this.getPrompterAssignmentId(ctx);
    const domainOverride = ctx.canvasBaseUrl ?? ctx.canvasDomain;
    const raw = await this.canvas.getAssignment(ctx.courseId, assignmentId, domainOverride, token);
    if (!raw) return null;
    return { pointsPossible: raw.points_possible, rubric: raw.rubric };
  }
}
