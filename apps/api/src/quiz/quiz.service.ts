import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CanvasService } from '../canvas/canvas.service';
import { CourseSettingsService } from '../course-settings/course-settings.service';
import { appendLtiLog } from '../common/last-error.store';
import type { LtiContext } from '../common/interfaces/lti-context.interface';

const PROMPT_STORAGE_QUIZ_DESCRIPTION = `DO NOT DELETE - ASL Express Prompt Storage

This quiz stores the prompts assigned to students for each video assignment. Students do not take this quiz; the app uses it to record which prompt each student saw, so teachers can review it during grading. Deleting it will cause that data to be lost.`;

@Injectable()
export class QuizService {
  constructor(
    private readonly canvas: CanvasService,
    private readonly courseSettings: CourseSettingsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Prefer teacher token (CANVAS_API_TOKEN) for quiz operations that act on behalf of students.
   * Fall back to session OAuth token.
   */
  private getTokenForQuizOps(oauthToken?: string | null): string | null {
    const staticToken =
      (this.config.get<string>('CANVAS_API_TOKEN') ?? this.config.get<string>('CANVAS_ACCESS_TOKEN'))?.trim() || null;
    return staticToken ?? (oauthToken?.trim() || null) ?? null;
  }

  /**
   * Ensure the prompt-storage quiz exists for the course.
   * Create with DO NOT DELETE description if not found.
   * Call when teacher creates first assignment and before any store-prompt.
   */
  async ensurePromptStorageQuiz(ctx: LtiContext): Promise<number> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) throw new Error('Canvas OAuth token required');
    const effectiveToken = this.getTokenForQuizOps(token) ?? token;
    const domainOverride = ctx.canvasBaseUrl ?? ctx.canvasDomain;

    const existing = await this.canvas.findQuizByTitle(
      ctx.courseId,
      CanvasService.PROMPT_STORAGE_QUIZ_TITLE,
      domainOverride,
      effectiveToken,
    );
    if (existing) {
      appendLtiLog('quiz', 'ensurePromptStorageQuiz: found existing', { quizId: existing.id });
      return existing.id;
    }

    const created = await this.canvas.createQuiz(
      ctx.courseId,
      {
        title: CanvasService.PROMPT_STORAGE_QUIZ_TITLE,
        description: PROMPT_STORAGE_QUIZ_DESCRIPTION,
        quizType: 'assignment',
        published: false,
      },
      domainOverride,
      effectiveToken,
    );
    appendLtiLog('quiz', 'ensurePromptStorageQuiz: created', { quizId: created.id });
    return created.id;
  }

  /**
   * Ensure a question exists for the assignment. Create when teacher saves config; one question per assignment.
   * Question metadata: question_name = assignment:{assignmentId}, question_text = assignmentTitle.
   * Student responses are keyed by question ID only—no assignment_id in the answer.
   */
  async ensureQuestionForAssignment(
    ctx: LtiContext,
    assignmentId: string,
    assignmentTitle: string,
  ): Promise<{ quizId: number; questionId: number }> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) throw new Error('Canvas OAuth token required');
    const effectiveToken = this.getTokenForQuizOps(token) ?? token;
    const domainOverride = ctx.canvasBaseUrl ?? ctx.canvasDomain;

    const quizId = await this.ensurePromptStorageQuiz(ctx);
    const questionName = `assignment:${assignmentId}`;
    const questionText = assignmentTitle.trim() || `Assignment ${assignmentId}`;

    const questions = await this.canvas.listQuizQuestions(ctx.courseId, quizId, domainOverride, effectiveToken);
    const existing = questions.find((q) => q.question_name === questionName);
    if (existing?.id) {
      return { quizId, questionId: existing.id };
    }

    const { id } = await this.canvas.createQuizQuestion(
      ctx.courseId,
      quizId,
      { questionText, questionName, questionType: 'essay_question', pointsPossible: 0 },
      domainOverride,
      effectiveToken,
    );
    appendLtiLog('quiz', 'ensureQuestionForAssignment: created', { assignmentId, questionId: id });
    return { quizId, questionId: id };
  }

  /**
   * Store a prompt in the quiz: answer the question for this assignment.
   * Question (with assignment_id + title) is created when teacher saves; student response is keyed by question ID only.
   */
  async storePrompt(
    ctx: LtiContext,
    assignmentId: string,
    assignmentTitle: string,
    promptHtml: string,
    studentUserId: string,
  ): Promise<void> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) throw new Error('Canvas OAuth token required');
    const effectiveToken = this.getTokenForQuizOps(token) ?? token;
    const domainOverride = ctx.canvasBaseUrl ?? ctx.canvasDomain;

    const { quizId, questionId } = await this.ensureQuestionForAssignment(ctx, assignmentId, assignmentTitle);

    const sub = await this.canvas.getOrCreateQuizSubmission(
      ctx.courseId,
      quizId,
      studentUserId,
      domainOverride,
      effectiveToken,
      true, // actAsUser: create submission for student when using teacher token
    );
    if (!sub.validation_token) {
      throw new Error('Canvas did not return validation_token for quiz submission');
    }

    await this.canvas.answerQuizQuestions(
      sub.id,
      {
        attempt: sub.attempt ?? 1,
        validationToken: sub.validation_token,
        quizQuestions: [{ id: String(questionId), answer: promptHtml }],
      },
      domainOverride,
      effectiveToken,
    );
    appendLtiLog('quiz', 'storePrompt: stored', { quizId, assignmentId, studentUserId });
  }

  /**
   * Get the prompt for a student and assignment from the quiz storage.
   * Returns the answer (prompt HTML) for the question matching assignmentId.
   */
  async getPromptForAssignment(
    ctx: LtiContext,
    studentUserId: string,
    assignmentId: string,
  ): Promise<string | null> {
    const token = await this.courseSettings.getEffectiveCanvasToken(ctx.courseId, ctx.canvasAccessToken);
    if (!token) return null;
    const effectiveToken = this.getTokenForQuizOps(token) ?? token;
    const domainOverride = ctx.canvasBaseUrl ?? ctx.canvasDomain;

    const existing = await this.canvas.findQuizByTitle(
      ctx.courseId,
      CanvasService.PROMPT_STORAGE_QUIZ_TITLE,
      domainOverride,
      effectiveToken,
    );
    if (!existing) return null;

    const list = await this.canvas.listQuizSubmissions(ctx.courseId, existing.id, domainOverride, effectiveToken);
    const match = list.find((s) => String(s.user_id) === String(studentUserId));
    if (!match?.id) return null;

    const questions = await this.canvas.getQuizSubmissionQuestions(match.id, domainOverride, effectiveToken);
    const q = questions.find((qu) => qu.question_name === `assignment:${assignmentId}`);
    if (!q?.answer) return null;
    return typeof q.answer === 'string' ? q.answer : JSON.stringify(q.answer);
  }
}
