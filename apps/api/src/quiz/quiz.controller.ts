import {
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { LtiLaunchGuard } from '../lti/guards/lti-launch.guard';
import { TeacherRoleGuard } from '../common/guards/teacher-role.guard';
import { CanvasTokenExpiredError } from '../canvas/canvas.service';
import { sanitizeLtiContext } from '../common/utils/lti-context-value.util';
import { getOAuth401Body } from '../common/utils/oauth-401.util';
import type { LtiContext } from '../common/interfaces/lti-context.interface';
import { QuizService } from './quiz.service';

@Controller('quiz')
@UseGuards(LtiLaunchGuard)
export class QuizController {
  constructor(private readonly quiz: QuizService) {}

  private getCtx(req: Request): LtiContext {
    const raw = req.session?.ltiContext as LtiContext | undefined;
    if (!raw) throw new ForbiddenException('LTI context required');
    const ctx = sanitizeLtiContext(raw) as LtiContext;
    const canvasAccessToken = (req.session as { canvasAccessToken?: string })?.canvasAccessToken;
    return { ...ctx, canvasAccessToken };
  }

  /** Ensure prompt-storage quiz exists. Call when teacher creates first assignment. */
  @Post('ensure')
  @UseGuards(TeacherRoleGuard)
  async ensure(@Req() req: Request, @Res() res: Response) {
    const ctx = this.getCtx(req);
    try {
      const quizId = await this.quiz.ensurePromptStorageQuiz(ctx);
      return res.json({ quizId });
    } catch (err) {
      if (err instanceof CanvasTokenExpiredError) {
        return res.status(401).json(getOAuth401Body(req));
      }
      throw err;
    }
  }

  /** Get stored prompt for a student and assignment (for grading display). */
  @Get('prompt')
  @UseGuards(TeacherRoleGuard)
  async getPrompt(
    @Req() req: Request,
    @Res() res: Response,
    @Query('studentUserId') studentUserId: string,
    @Query('assignmentId') assignmentId: string,
  ) {
    const ctx = this.getCtx(req);
    const sid = (studentUserId ?? '').toString().trim();
    const aid = (assignmentId ?? '').toString().trim();
    if (!sid || !aid) {
      return res.status(400).json({ error: 'studentUserId and assignmentId required' });
    }
    try {
      const prompt = await this.quiz.getPromptForAssignment(ctx, sid, aid);
      return res.json({ prompt: prompt ?? null });
    } catch (err) {
      if (err instanceof CanvasTokenExpiredError) {
        return res.status(401).json(getOAuth401Body(req));
      }
      throw err;
    }
  }
}
