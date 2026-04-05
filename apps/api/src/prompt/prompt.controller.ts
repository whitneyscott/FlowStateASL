import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { LtiLaunchGuard } from '../lti/guards/lti-launch.guard';
import { TeacherRoleGuard } from '../common/guards/teacher-role.guard';
import { CanvasTokenExpiredError } from '../canvas/canvas.service';
import type { LtiContext } from '../common/interfaces/lti-context.interface';
import { sanitizeLtiContext } from '../common/utils/lti-context-value.util';
import { getOAuth401Body } from '../common/utils/oauth-401.util';
import { PromptService } from './prompt.service';
import { PutPromptConfigDto } from './dto/prompt-config.dto';
import { VerifyAccessDto } from './dto/verify-access.dto';
import { SavePromptDto } from './dto/save-prompt.dto';
import { SubmitPromptDto } from './dto/submit-prompt.dto';
import { GradeDto } from './dto/grade.dto';
import {
  AddCommentDto,
  EditCommentDto,
  DeleteCommentDto,
} from './dto/comment.dto';
import { ResetAttemptDto } from './dto/reset-attempt.dto';
import { LtiDeepLinkFileStore } from '../lti/lti-deep-link-file.store';
import { appendLtiLog } from '../common/last-error.store';

@Controller('prompt')
@UseGuards(LtiLaunchGuard)
export class PromptController {
  constructor(
    private readonly prompt: PromptService,
    private readonly deepLinkFileStore: LtiDeepLinkFileStore,
  ) {}

  private getCtx(req: Request): LtiContext {
    const raw = req.session?.ltiContext as LtiContext | undefined;
    if (!raw) throw new ForbiddenException('LTI context required');
    const ctx = sanitizeLtiContext(raw) as LtiContext;
    const canvasAccessToken = (req.session as { canvasAccessToken?: string })?.canvasAccessToken;
    const ltiLaunchType = (req.session as { ltiLaunchType?: '1.1' | '1.3' })?.ltiLaunchType;
    return { ...ctx, canvasAccessToken, ltiLaunchType };
  }

  /** Merge assignmentId from query into ctx for teacher endpoints (course_navigation has no assignment). */
  private getCtxWithAssignment(req: Request): LtiContext {
    const ctx = this.getCtx(req);
    const q = req.query as { assignmentId?: string; assignment_id?: string };
    const aid = (q?.assignmentId ?? q?.assignment_id ?? '').toString().trim();
    if (aid) return { ...ctx, assignmentId: aid };
    return ctx;
  }

  private validatePutConfigDto(dto: PutPromptConfigDto): void {
    if (dto.pointsPossible !== undefined) {
      const v = Number(dto.pointsPossible);
      if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
        throw new BadRequestException('pointsPossible must be a non-negative integer');
      }
    }
    if (dto.allowedAttempts !== undefined) {
      const v = Number(dto.allowedAttempts);
      if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1) {
        throw new BadRequestException('allowedAttempts must be an integer greater than or equal to 1');
      }
    }
    if (dto.videoPromptConfig?.totalCards !== undefined) {
      const v = Number(dto.videoPromptConfig.totalCards);
      if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1) {
        throw new BadRequestException('videoPromptConfig.totalCards must be an integer greater than or equal to 1');
      }
    }
  }

  @Get('config')
  async getConfig(@Req() req: Request, @Res() res: Response) {
    const ctx = this.getCtxWithAssignment(req);
    try {
      const config = await this.prompt.getConfig(ctx);
      return res.json(config);
    } catch (err) {
      if (err instanceof CanvasTokenExpiredError) {
        return res.status(401).json(getOAuth401Body(req));
      }
      throw err;
    }
  }

  @Put('config')
  async putConfig(@Req() req: Request, @Res() res: Response, @Body() dto: PutPromptConfigDto) {
    const ctx = this.getCtxWithAssignment(req);
    this.validatePutConfigDto(dto);
    const { appendLtiLog } = await import('../common/last-error.store');
    appendLtiLog('prompt', 'sync-to-canvas: putConfig received', {
      assignmentId: ctx.assignmentId,
      moduleId: dto.moduleId ?? '(none)',
      assignmentGroupId: dto.assignmentGroupId,
      newGroupName: dto.newGroupName ? '(present)' : '(absent)',
    });
    try {
      await this.prompt.putConfig(ctx, dto);
      appendLtiLog('prompt', 'sync-to-canvas: putConfig success', {
        assignmentId: ctx.assignmentId,
        moduleId: dto.moduleId ?? '(none)',
      });
      return res.status(204).send();
    } catch (err) {
      appendLtiLog('prompt', 'sync-to-canvas: putConfig failed', {
        assignmentId: ctx.assignmentId,
        moduleId: dto.moduleId ?? '(none)',
        error: String(err),
      });
      if (err instanceof CanvasTokenExpiredError) {
        return res.status(401).json(getOAuth401Body(req));
      }
      throw err;
    }
  }

  @Post('verify-access')
  @HttpCode(HttpStatus.OK)
  async verifyAccess(@Req() req: Request, @Body() dto: VerifyAccessDto) {
    const ctx = this.getCtxWithAssignment(req);
    return this.prompt.verifyAccess(ctx, dto.accessCode, dto.fingerprint);
  }

  @Post('save-prompt')
  @HttpCode(HttpStatus.OK)
  async savePrompt(@Req() req: Request, @Body() dto: SavePromptDto) {
    const ctx = this.getCtxWithAssignment(req);
    await this.prompt.savePrompt(ctx, dto.promptText);
    return { status: 'success' };
  }

  @Post('submit')
  @HttpCode(HttpStatus.CREATED)
  async submit(@Req() req: Request, @Body() dto: SubmitPromptDto) {
    const { appendLtiLog } = await import('../common/last-error.store');
    appendLtiLog('prompt', 'POST /submit received', {
      bodyLength: dto.promptSnapshotHtml?.length ?? 0,
      deckTimelineCount: dto.deckTimeline?.length ?? 0,
    });
    const ctx = this.getCtxWithAssignment(req);
    await this.prompt.submit(ctx, dto.promptSnapshotHtml, dto.deckTimeline);
    return { status: 'success' };
  }

  @Post('upload-video')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('video'))
  async uploadVideo(
    @Req() req: Request,
    @UploadedFile() file: { buffer?: Buffer; originalname?: string } | undefined,
  ) {
    appendLtiLog('prompt', 'POST /upload-video received', { hasFile: !!file?.buffer, size: file?.buffer?.length ?? 0, filename: file?.originalname ?? '(none)' });
    const ctx = this.getCtxWithAssignment(req);
    if (!file?.buffer) {
      throw new BadRequestException('No video file provided');
    }
    const result = await this.prompt.uploadVideo(
      ctx,
      Buffer.from(file.buffer),
      file.originalname || `asl_submission_${Date.now()}.webm`,
    );
    appendLtiLog('prompt-upload', 'POST /api/prompt/upload-video 201 response (client can read verify in JSON body)', {
      fileId: result.fileId,
      courseId: result.courseId,
      assignmentId: result.assignmentId,
      verify: result.verify,
    });
    return {
      status: 'success',
      fileId: result.fileId,
      courseId: result.courseId,
      assignmentId: result.assignmentId,
      studentUserId: result.studentUserId,
      studentIdSource: result.studentIdSource,
      verify: result.verify,
    };
  }

  /**
   * Retrieve a submission video by token (from ltiResourceLink custom.submission_token).
   * Streams the stored video buffer. Returns 404 if token is missing or expired.
   */
  @Get('submission/:token')
  async getSubmission(
    @Req() req: Request,
    @Res() res: Response,
    @Param() params: { token: string },
  ) {
    const token = (params?.token ?? '').toString().trim();
    if (!token) return res.status(404).send();
    const file = this.deepLinkFileStore.get(token);
    if (!file) return res.status(404).send('Not found or expired');
    const buffer = file.buffer;
    const total = buffer.length;
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    const rangeHeader = (req.headers.range ?? '').toString();
    const rangeMatch = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
    if (rangeMatch) {
      const start = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0;
      const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : total - 1;
      const s = Math.min(start, total - 1);
      const e = Math.min(end, total - 1);
      const chunk = buffer.subarray(s, e + 1);
      res.setHeader('Content-Range', `bytes ${s}-${e}/${total}`);
      res.setHeader('Content-Length', String(chunk.length));
      res.status(206);
      return res.send(chunk);
    }
    res.setHeader('Content-Length', String(total));
    return res.send(buffer);
  }

  /**
   * Proxy Canvas video URLs so the frontend can load them with auth (Canvas file URLs
   * require OAuth; the video element cannot send our token cross-origin).
   * Supports Range requests for video seeking.
   */
  @Get('video-proxy')
  async videoProxy(@Req() req: Request, @Res() res: Response) {
    const q = req.query as { url?: string };
    const targetUrl = (q?.url ?? '').toString().trim();
    if (!targetUrl) return res.status(400).send('Missing url parameter');
    try {
      const ctx = this.getCtx(req);
      const result = await this.prompt.streamVideoProxy(ctx, targetUrl);
      if (!result) return res.status(404).send('Not found or access denied');
      const { buffer, contentType } = result;
      const total = buffer.length;
      res.setHeader('Content-Type', contentType);
      res.setHeader('Accept-Ranges', 'bytes');
      const rangeHeader = (req.headers.range ?? '').toString();
      const rangeMatch = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
      if (rangeMatch) {
        const start = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0;
        const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : total - 1;
        const s = Math.min(start, total - 1);
        const e = Math.min(end, total - 1);
        const chunk = buffer.subarray(s, e + 1);
        res.setHeader('Content-Range', `bytes ${s}-${e}/${total}`);
        res.setHeader('Content-Length', String(chunk.length));
        res.status(206);
        return res.send(chunk);
      }
      res.setHeader('Content-Length', String(total));
      return res.send(buffer);
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      return res.status(502).send('Proxy failed');
    }
  }

  /**
   * Deep Linking (homework_submission): accept video, return HTML form that auto-posts
   * LtiDeepLinkingResponse to Canvas deep_link_return_url so Canvas attaches the file.
   */
  @Post('submit-deep-link')
  @UseInterceptors(FileInterceptor('video'))
  async submitDeepLink(
    @Req() req: Request,
    @Res() res: Response,
    @UploadedFile() file: { buffer?: Buffer; originalname?: string; mimetype?: string } | undefined,
  ) {
    const { appendLtiLog } = await import('../common/last-error.store');
    appendLtiLog('prompt', 'POST /submit-deep-link received', { hasFile: !!file?.buffer, size: file?.buffer?.length ?? 0, filename: file?.originalname ?? '(none)' });
    const ctx = this.getCtxWithAssignment(req);
    if (!file?.buffer) {
      throw new BadRequestException('No video file provided');
    }
    const result = await this.prompt.submitDeepLink(
      ctx,
      Buffer.from(file.buffer),
      file.mimetype || 'video/webm',
      file.originalname,
    );
    if (typeof result === 'object') {
      return res.json(result);
    }
    return res.type('html').send(result);
  }

  @Get('submission-count')
  @UseGuards(TeacherRoleGuard)
  async getSubmissionCount(@Req() req: Request) {
    appendLtiLog('viewer', 'GET submission-count');
    const ctx = this.getCtxWithAssignment(req);
    const count = await this.prompt.getSubmissionCount(ctx);
    return { count };
  }

  @Get('submissions')
  @UseGuards(TeacherRoleGuard)
  async getSubmissions(@Req() req: Request) {
    const q = req.query as { assignmentId?: string };
    appendLtiLog('viewer', 'GET submissions', { assignmentId: q?.assignmentId });
    const ctx = this.getCtxWithAssignment(req);
    const result = await this.prompt.getSubmissions(ctx);
    appendLtiLog('viewer', 'GET submissions response', { count: result?.length ?? 0 });
    return result;
  }

  @Get('my-submission')
  async getMySubmission(@Req() req: Request, @Res() res: Response) {
    const ctx = this.getCtxWithAssignment(req);
    try {
      const result = await this.prompt.getMySubmission(ctx);
      return res.json(result ?? null);
    } catch (err) {
      if (err instanceof CanvasTokenExpiredError) {
        return res.status(401).json(getOAuth401Body(req));
      }
      throw err;
    }
  }

  @Get('assignment-for-viewer')
  async getAssignmentForViewer(@Req() req: Request, @Res() res: Response) {
    const ctx = this.getCtxWithAssignment(req);
    try {
      const result = await this.prompt.getAssignmentForGrading(ctx);
      return res.json(result ?? { pointsPossible: null, rubric: null });
    } catch (err) {
      if (err instanceof CanvasTokenExpiredError) {
        return res.status(401).json(getOAuth401Body(req));
      }
      throw err;
    }
  }

  @Post('grade')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TeacherRoleGuard)
  async grade(@Req() req: Request, @Body() dto: GradeDto) {
    const ctx = this.getCtxWithAssignment(req);
    await this.prompt.grade(
      ctx,
      dto.userId,
      dto.score,
      dto.scoreMaximum ?? 100,
      dto.resultContent,
      dto.rubricAssessment,
    );
    return { ok: true };
  }

  @Post('comment/add')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TeacherRoleGuard)
  async addComment(@Req() req: Request, @Body() dto: AddCommentDto) {
    const ctx = this.getCtxWithAssignment(req);
    const result = await this.prompt.addComment(
      ctx,
      dto.userId,
      dto.time,
      dto.text,
      dto.attempt,
    );
    return { ok: true, commentId: result.commentId };
  }

  @Post('comment/edit')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TeacherRoleGuard)
  async editComment(@Req() req: Request, @Body() dto: EditCommentDto) {
    const ctx = this.getCtxWithAssignment(req);
    await this.prompt.editComment(ctx, dto.userId, dto.commentId, dto.time, dto.text);
    return { ok: true };
  }

  @Post('comment/delete')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TeacherRoleGuard)
  async deleteComment(@Req() req: Request, @Body() dto: DeleteCommentDto) {
    const ctx = this.getCtxWithAssignment(req);
    await this.prompt.deleteComment(ctx, dto.userId, dto.commentId);
    return { ok: true };
  }

  @Post('reset-attempt')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TeacherRoleGuard)
  async resetAttempt(@Req() req: Request, @Body() dto: ResetAttemptDto) {
    const ctx = this.getCtxWithAssignment(req);
    await this.prompt.resetAttempt(ctx, dto.userId);
    return { ok: true };
  }

  @Get('assignment')
  @UseGuards(TeacherRoleGuard)
  async getAssignment(@Req() req: Request) {
    const ctx = this.getCtxWithAssignment(req);
    const result = await this.prompt.getAssignmentForGrading(ctx);
    return result ?? { pointsPossible: null, rubric: null };
  }

  @Get('configured-assignments')
  @UseGuards(TeacherRoleGuard)
  async getConfiguredAssignments(@Req() req: Request, @Res() res: Response) {
    appendLtiLog('viewer', 'GET configured-assignments');
    const ctx = this.getCtx(req);
    try {
      const list = await this.prompt.getConfiguredAssignments(ctx);
      return res.json(list);
    } catch (err) {
      if (err instanceof CanvasTokenExpiredError) {
        return res.status(401).json(getOAuth401Body(req));
      }
      throw err;
    }
  }

  /**
   * Build the prompt list for a deck-based prompt session.
   * Used by both teacher preview and student session initialization.
   * Accepts selectedDecks and totalCards in the query or body.
   */
  @Post('build-deck-prompts')
  async buildDeckPrompts(
    @Req() req: Request,
    @Body() body: { selectedDecks?: Array<{ id?: string; title?: string }>; totalCards?: number },
  ) {
    const ctx = this.getCtxWithAssignment(req);
    const selectedDecks = (body.selectedDecks ?? []).map(d => ({
      id: (d.id ?? '').trim(),
      title: (d.title ?? '').trim(),
    })).filter(d => d.id);
    const requestedTotal = Number(body.totalCards);
    const totalCards =
      Number.isFinite(requestedTotal) && requestedTotal > 0 ? Math.floor(requestedTotal) : 10;
    appendLtiLog('prompt-decks', 'buildDeckPrompts request', {
      assignmentId: ctx.assignmentId ?? '(none)',
      resourceLinkId: ctx.resourceLinkId ?? '(none)',
      selectedDeckCount: selectedDecks.length,
      totalCards,
    });

    if (selectedDecks.length === 0) {
      appendLtiLog('prompt-decks', 'buildDeckPrompts short-circuit: no valid decks selected', {
        assignmentId: ctx.assignmentId ?? '(none)',
      });
      return { prompts: [], warning: 'No valid decks selected' };
    }

    try {
      const result = await this.prompt.buildDeckPromptList(selectedDecks, totalCards);
      appendLtiLog('prompt-decks', 'buildDeckPrompts result', {
        assignmentId: ctx.assignmentId ?? '(none)',
        promptCount: result.prompts?.length ?? 0,
        warning: result.warning ?? '(none)',
      });
      return result;
    } catch (err) {
      appendLtiLog('prompt-decks', 'buildDeckPrompts failed', { error: String(err) });
      throw err;
    }
  }

  @Get('assignment-groups')
  @UseGuards(TeacherRoleGuard)
  async getAssignmentGroups(@Req() req: Request, @Res() res: Response) {
    const ctx = this.getCtx(req);
    try {
      const list = await this.prompt.getAssignmentGroups(ctx);
      return res.json(list);
    } catch (err) {
      if (err instanceof CanvasTokenExpiredError) {
        return res.status(401).json(getOAuth401Body(req));
      }
      throw err;
    }
  }

  @Get('rubrics')
  @UseGuards(TeacherRoleGuard)
  async getRubrics(@Req() req: Request, @Res() res: Response) {
    const ctx = this.getCtx(req);
    try {
      const list = await this.prompt.getRubrics(ctx);
      return res.json(list);
    } catch (err) {
      if (err instanceof CanvasTokenExpiredError) {
        return res.status(401).json(getOAuth401Body(req));
      }
      throw err;
    }
  }

  @Post('assignment-groups')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TeacherRoleGuard)
  async createAssignmentGroup(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: { name?: string },
  ) {
    const ctx = this.getCtx(req);
    const name = (body?.name ?? '').toString().trim() || 'New Group';
    try {
      const group = await this.prompt.createAssignmentGroup(ctx, name);
      return res.status(HttpStatus.CREATED).json(group);
    } catch (err) {
      if (err instanceof CanvasTokenExpiredError) {
        return res.status(401).json(getOAuth401Body(req));
      }
      throw err;
    }
  }

  @Get('modules')
  @UseGuards(TeacherRoleGuard)
  async getModules(@Req() req: Request, @Res() res: Response) {
    const ctx = this.getCtx(req);
    try {
      const list = await this.prompt.getModules(ctx);
      return res.json(list);
    } catch (err) {
      if (err instanceof CanvasTokenExpiredError) {
        return res.status(401).json(getOAuth401Body(req));
      }
      throw err;
    }
  }

  @Post('modules')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TeacherRoleGuard)
  async createModule(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: { name?: string; position?: number },
  ) {
    const ctx = this.getCtx(req);
    const name = (body?.name ?? '').toString().trim() || 'New Module';
    const position = typeof body?.position === 'number' ? body.position : undefined;
    try {
      const module = await this.prompt.createModule(ctx, name, position);
      return res.status(HttpStatus.CREATED).json(module);
    } catch (err) {
      if (err instanceof CanvasTokenExpiredError) {
        return res.status(401).json(getOAuth401Body(req));
      }
      throw err;
    }
  }

  @Post('create-assignment')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TeacherRoleGuard)
  async createAssignment(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: { name?: string; assignmentGroupId?: string; newGroupName?: string },
  ) {
    const ctx = this.getCtx(req);
    const name = (body?.name ?? '').toString().trim() || 'ASL Express Assignment';
    try {
      const { appendLtiLog } = await import('../common/last-error.store');
      appendLtiLog('prompt', 'create-assignment received', {
        name,
        assignmentGroupId: body?.assignmentGroupId ?? '(none)',
        newGroupName: body?.newGroupName ?? '(none)',
        rawBody: { name: body?.name, assignmentGroupId: body?.assignmentGroupId, newGroupName: body?.newGroupName },
      });
      const result = await this.prompt.createPromptManagerAssignment(ctx, name, {
        assignmentGroupId: body?.assignmentGroupId,
        newGroupName: body?.newGroupName,
      });
      appendLtiLog('prompt', 'create-assignment success', {
        name,
        assignmentId: result.assignmentId,
      });
      return res.status(HttpStatus.CREATED).json(result);
    } catch (err) {
      appendLtiLog('prompt', 'create-assignment failed', {
        name,
        error: String(err),
      });
      if (err instanceof CanvasTokenExpiredError) {
        return res.status(401).json(getOAuth401Body(req));
      }
      throw err;
    }
  }

  @Delete('configured-assignments/:assignmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(TeacherRoleGuard)
  async deleteConfiguredAssignment(
    @Req() req: Request,
    @Res() res: Response,
    @Param('assignmentId') assignmentId: string,
  ) {
    const ctx = this.getCtx(req);
    try {
      appendLtiLog('prompt', 'delete-assignment received', { assignmentId });
      await this.prompt.deleteConfiguredAssignment(ctx, assignmentId);
      return res.status(HttpStatus.NO_CONTENT).send();
    } catch (err) {
      if (err instanceof CanvasTokenExpiredError) {
        return res.status(401).json(getOAuth401Body(req));
      }
      throw err;
    }
  }
}
