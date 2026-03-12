import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
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

@Controller('prompt')
@UseGuards(LtiLaunchGuard)
export class PromptController {
  constructor(private readonly prompt: PromptService) {}

  private getCtx(req: Request): LtiContext {
    const ctx = req.session?.ltiContext as LtiContext | undefined;
    if (!ctx) throw new ForbiddenException('LTI context required');
    const canvasAccessToken = (req.session as { canvasAccessToken?: string })?.canvasAccessToken;
    return { ...ctx, canvasAccessToken };
  }

  @Get('config')
  async getConfig(@Req() req: Request, @Res() res: Response) {
    const ctx = this.getCtx(req);
    try {
      const config = await this.prompt.getConfig(ctx);
      return res.json(config);
    } catch (err) {
      if (err instanceof CanvasTokenExpiredError) {
        return res.status(401).json({
          error: 'Canvas token expired',
          redirectToOAuth: true,
        });
      }
      throw err;
    }
  }

  @Put('config')
  async putConfig(@Req() req: Request, @Body() dto: PutPromptConfigDto) {
    const ctx = this.getCtx(req);
    await this.prompt.putConfig(ctx, dto);
  }

  @Post('verify-access')
  @HttpCode(HttpStatus.OK)
  async verifyAccess(@Req() req: Request, @Body() dto: VerifyAccessDto) {
    const ctx = this.getCtx(req);
    return this.prompt.verifyAccess(ctx, dto.accessCode, dto.fingerprint);
  }

  @Post('save-prompt')
  @HttpCode(HttpStatus.OK)
  async savePrompt(@Req() req: Request, @Body() dto: SavePromptDto) {
    const ctx = this.getCtx(req);
    await this.prompt.savePrompt(ctx, dto.promptText);
    return { status: 'success' };
  }

  @Post('submit')
  @HttpCode(HttpStatus.CREATED)
  async submit(@Req() req: Request, @Body() dto: SubmitPromptDto) {
    const ctx = this.getCtx(req);
    await this.prompt.submit(ctx, dto.promptSnapshotHtml);
    return { status: 'success' };
  }

  @Post('upload-video')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('video'))
  async uploadVideo(
    @Req() req: Request,
    @UploadedFile() file: { buffer?: Buffer; originalname?: string } | undefined,
  ) {
    const ctx = this.getCtx(req);
    if (!file?.buffer) {
      throw new BadRequestException('No video file provided');
    }
    const result = await this.prompt.uploadVideo(
      ctx,
      Buffer.from(file.buffer),
      file.originalname || `asl_submission_${Date.now()}.webm`,
    );
    return { status: 'success', fileId: result.fileId };
  }

  @Get('submissions')
  @UseGuards(TeacherRoleGuard)
  async getSubmissions(@Req() req: Request) {
    const ctx = this.getCtx(req);
    return this.prompt.getSubmissions(ctx);
  }

  @Post('grade')
  @HttpCode(HttpStatus.OK)
  async grade(@Req() req: Request, @Body() dto: GradeDto) {
    const ctx = this.getCtx(req);
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
    const ctx = this.getCtx(req);
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
  async editComment(@Req() req: Request, @Body() dto: EditCommentDto) {
    const ctx = this.getCtx(req);
    await this.prompt.editComment(ctx, dto.userId, dto.commentId, dto.time, dto.text);
    return { ok: true };
  }

  @Post('comment/delete')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TeacherRoleGuard)
  async deleteComment(@Req() req: Request, @Body() dto: DeleteCommentDto) {
    const ctx = this.getCtx(req);
    await this.prompt.deleteComment(ctx, dto.userId, dto.commentId);
    return { ok: true };
  }

  @Post('reset-attempt')
  @HttpCode(HttpStatus.OK)
  async resetAttempt(@Req() req: Request, @Body() dto: ResetAttemptDto) {
    const ctx = this.getCtx(req);
    await this.prompt.resetAttempt(ctx, dto.userId);
    return { ok: true };
  }

  @Get('assignment')
  @UseGuards(TeacherRoleGuard)
  async getAssignment(@Req() req: Request) {
    const ctx = this.getCtx(req);
    const result = await this.prompt.getAssignmentForGrading(ctx);
    return result ?? { pointsPossible: null, rubric: null };
  }
}
