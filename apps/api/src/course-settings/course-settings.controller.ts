import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import type { LtiContext } from '../common/interfaces/lti-context.interface';
import { appendLtiLog } from '../common/last-error.store';
import { getOAuth401Body } from '../common/utils/oauth-401.util';
import { CanvasTokenExpiredError } from '../canvas/canvas.service';
import { LtiLaunchGuard } from '../lti/guards/lti-launch.guard';
import { LtiService } from '../lti/lti.service';
import { TeacherRoleGuard } from '../common/guards/teacher-role.guard';
import { CourseSettingsService } from './course-settings.service';
import { ImportFlashcardSettingsBlobDto } from './dto/import-flashcard-settings-blob.dto';

@Controller('course-settings')
@UseGuards(LtiLaunchGuard)
export class CourseSettingsController {
  constructor(
    private readonly courseSettings: CourseSettingsService,
    private readonly ltiService: LtiService,
  ) {}

  @Get('settings-blob/export')
  @UseGuards(TeacherRoleGuard)
  async exportFlashcardSettingsBlob(@Req() req: Request, @Res() res: Response) {
    const ctx = req.session?.ltiContext as LtiContext | undefined;
    if (!ctx?.courseId) {
      throw new ForbiddenException('LTI context required');
    }
    const canvasAccessToken = (req.session as { canvasAccessToken?: string } | undefined)?.canvasAccessToken;
    try {
      const blob = await this.courseSettings.exportFlashcardSettingsBlob(ctx.courseId, {
        canvasDomain: ctx.canvasDomain,
        canvasBaseUrl: ctx.canvasBaseUrl,
        platformIss: ctx.platformIss,
        canvasAccessToken: canvasAccessToken ?? undefined,
      });
      return res.json(blob);
    } catch (err) {
      if (err instanceof CanvasTokenExpiredError) {
        return res.status(401).json(getOAuth401Body(req));
      }
      throw err;
    }
  }

  @Post('settings-blob/import')
  @UseGuards(TeacherRoleGuard)
  async importFlashcardSettingsBlob(@Req() req: Request, @Body() dto: ImportFlashcardSettingsBlobDto) {
    const ctx = req.session?.ltiContext as LtiContext | undefined;
    if (!ctx?.courseId) {
      throw new ForbiddenException('LTI context required');
    }
    const canvasAccessToken = (req.session as { canvasAccessToken?: string } | undefined)?.canvasAccessToken;
    try {
      return await this.courseSettings.importFlashcardSettingsBlob(ctx.courseId, dto, {
        canvasDomain: ctx.canvasDomain,
        canvasBaseUrl: ctx.canvasBaseUrl,
        platformIss: ctx.platformIss,
        canvasAccessToken: canvasAccessToken ?? undefined,
      });
    } catch (err) {
      if (err instanceof CanvasTokenExpiredError) {
        throw new HttpException(getOAuth401Body(req), HttpStatus.UNAUTHORIZED);
      }
      throw err;
    }
  }

  @Get()
  async get(@Req() req: Request, @Res() res: Response) {
    const ctx = req.session?.ltiContext as LtiContext | undefined;
    const isTeacher = this.ltiService.isTeacherRole(ctx?.roles ?? '');
    const canvasAccessToken = (req.session as { canvasAccessToken?: string } | undefined)?.canvasAccessToken;
    appendLtiLog('course-settings', 'GET /api/course-settings requested', {
      hasSession: !!req.session,
      hasLtiContext: !!ctx,
      hasCanvasAccessToken: !!canvasAccessToken,
      courseId: ctx?.courseId ?? null,
      isTeacher,
    });
    if (!ctx?.courseId) {
      appendLtiLog('course-settings', 'GET aborted: no courseId in session');
      return res.json(null);
    }
    // Teachers need a Canvas API token before any course-settings / announcement logic.
    // Without this, GET returned 200 + empty data (missing-token was swallowed in service),
    // and the UI hit announcement-status → false → "recreate" before token entry (wrong order).
    if (isTeacher && !(canvasAccessToken ?? '').trim()) {
      appendLtiLog('course-settings', 'GET 401: teacher has no Canvas token yet', getOAuth401Body(req));
      return res.status(401).json(getOAuth401Body(req));
    }
    try {
      const result = await this.courseSettings.get(ctx.courseId, {
        isTeacher,
        canvasDomain: ctx.canvasDomain,
        canvasBaseUrl: ctx.canvasBaseUrl,
        platformIss: ctx.platformIss,
        canvasAccessToken: canvasAccessToken ?? undefined,
      });
      appendLtiLog('course-settings', 'GET result from service', {
        courseId: ctx.courseId,
        selectedCurriculums: result?.selectedCurriculums ?? [],
        selectedUnits: result?.selectedUnits ?? [],
        hasResult: !!result,
      });
      return res.json(result);
    } catch (err) {
      if (err instanceof CanvasTokenExpiredError) {
        appendLtiLog('course-settings', 'Canvas token expired — 401', getOAuth401Body(req));
        return res.status(401).json(getOAuth401Body(req));
      }
      throw err;
    }
  }

  @Put()
  async save(
    @Req() req: Request,
    @Body() body: { selectedCurriculums?: string[]; selectedUnits?: string[]; canvasApiToken?: string },
  ) {
    const ctx = req.session?.ltiContext as LtiContext | undefined;
    console.log('[CourseSettings PUT] session:', {
      hasSession: !!req.session,
      sessionId: (req.session as { id?: string } | undefined)?.id ?? req.sessionID,
      hasLtiContext: !!ctx,
      courseId: ctx?.courseId,
      cookieHeader: req.headers.cookie ? 'present' : 'MISSING',
    }, 'body:', JSON.stringify(body));
    if (!ctx?.courseId) {
      throw new ForbiddenException('LTI context required');
    }
    if (!this.ltiService.isTeacherRole(ctx.roles)) {
      throw new ForbiddenException('Teacher role required');
    }
    const canvasAccessToken = (req.session as { canvasAccessToken?: string } | undefined)?.canvasAccessToken;
    await this.courseSettings.save(
      ctx.courseId,
      body.selectedCurriculums ?? [],
      body.selectedUnits ?? [],
      ctx.canvasDomain,
      canvasAccessToken ?? undefined,
      ctx.canvasBaseUrl,
      ctx.platformIss,
    );
  }

  @Get('announcement-status')
  async announcementStatus(@Req() req: Request) {
    const ctx = req.session?.ltiContext as LtiContext | undefined;
    if (!ctx?.courseId) {
      throw new ForbiddenException('LTI context required');
    }
    if (!this.ltiService.isTeacherRole(ctx.roles)) {
      throw new ForbiddenException('Teacher role required');
    }
    const canvasAccessToken = (req.session as { canvasAccessToken?: string })?.canvasAccessToken;
    if (!(canvasAccessToken ?? '').trim()) {
      throw new HttpException(getOAuth401Body(req), HttpStatus.UNAUTHORIZED);
    }
    const exists = await this.courseSettings.announcementExists(ctx.courseId, {
      canvasDomain: ctx.canvasDomain,
      canvasBaseUrl: ctx.canvasBaseUrl,
      platformIss: ctx.platformIss,
      canvasAccessToken: canvasAccessToken ?? undefined,
    });
    return { exists };
  }

  @Post('recreate-announcement')
  async recreateAnnouncement(@Req() req: Request, @Res() res: Response) {
    const ctx = req.session?.ltiContext as LtiContext | undefined;
    if (!ctx?.courseId) {
      throw new ForbiddenException('LTI context required');
    }
    if (!this.ltiService.isTeacherRole(ctx.roles)) {
      throw new ForbiddenException('Teacher role required');
    }
    const canvasAccessToken = (req.session as { canvasAccessToken?: string })?.canvasAccessToken;
    if (!(canvasAccessToken ?? '').trim()) {
      throw new HttpException(getOAuth401Body(req), HttpStatus.UNAUTHORIZED);
    }
    try {
      await this.courseSettings.recreateAnnouncement(ctx.courseId, {
        canvasDomain: ctx.canvasDomain,
        canvasBaseUrl: ctx.canvasBaseUrl,
        platformIss: ctx.platformIss,
        canvasAccessToken: canvasAccessToken ?? undefined,
      });
      return res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const looksLikeCanvasPermission403 =
        /\b403\b/.test(msg) &&
        (
          msg.includes('Canvas create assignment failed') ||
          msg.includes('Canvas list assignment groups failed') ||
          msg.includes('Canvas create assignment group failed') ||
          msg.includes('"status":"unauthorized"')
        );
      if (looksLikeCanvasPermission403) {
        appendLtiLog('course-settings', 'recreate-announcement: Canvas permission denied, forcing re-authorization', {
          courseId: ctx.courseId,
          message: msg.slice(0, 300),
        });
        const sess = req.session as { canvasAccessToken?: string; save?: (cb: (e?: unknown) => void) => void } | undefined;
        if (sess) {
          delete sess.canvasAccessToken;
          if (typeof sess.save === 'function') {
            await new Promise<void>((resolve) => sess.save?.(() => resolve()));
          }
        }
        const body = getOAuth401Body(req);
        body.message =
          'Canvas denied assignment creation (403). Re-authorize with Canvas and retry. If your Developer Key enforces scopes, ensure assignment and assignment_groups write scopes are enabled.';
        return res.status(401).json(body);
      }
      throw err;
    }
  }
}
