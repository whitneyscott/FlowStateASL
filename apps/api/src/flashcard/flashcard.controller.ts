import {
  Controller,
  Get,
  Put,
  Body,
  Query,
  Req,
  Res,
  ForbiddenException,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { FlashcardService } from './flashcard.service';
import { LtiService } from '../lti/lti.service';
import { appendLtiLog, setLastError } from '../common/last-error.store';
import { CanvasTokenExpiredError } from '../canvas/canvas.service';
import { LtiLaunchGuard } from '../lti/guards/lti-launch.guard';
import type { LtiContext } from '../common/interfaces/lti-context.interface';

@Controller('flashcard')
@UseGuards(LtiLaunchGuard)
export class FlashcardController {
  constructor(
    private readonly flashcard: FlashcardService,
    private readonly ltiService: LtiService,
  ) {}

  private requireTeacher(ctx: LtiContext | undefined): void {
    if (!ctx?.courseId) {
      throw new ForbiddenException('LTI context required');
    }
    if (!this.ltiService.isTeacherRole(ctx.roles)) {
      throw new ForbiddenException('Teacher role required');
    }
  }

  @Get('playlists')
  async getPlaylists(
    @Req() req: Request,
    @Query('filter') filter: string,
    @Query('curriculum') curriculumQ: string,
    @Query('unit') unitQ: string,
    @Query('section') sectionQ: string,
  ) {
    const ctx = req.session?.ltiContext;
    try {
      if (curriculumQ && ctx?.courseId) {
        return await this.flashcard.getPlaylistsByHierarchy(
          curriculumQ,
          unitQ ?? '',
          sectionQ ?? '',
        );
      }
      let effectiveFilter = filter ?? '';
      if (!effectiveFilter && ctx?.courseId && ctx?.resourceLinkId) {
        const config = await this.flashcard.getConfig(
          ctx.courseId,
          ctx.resourceLinkId,
        );
        if (config?.curriculum) {
          return await this.flashcard.getPlaylistsByHierarchy(
            config.curriculum,
            config.unit,
            config.section,
          );
        }
      }
      return await this.flashcard.getPlaylists(effectiveFilter);
    } catch (err) {
      setLastError('GET /api/flashcard/playlists', err);
      throw err;
    }
  }

  @Get('items')
  async getItems(@Query('playlist_id') playlistId: string) {
    const id = String(playlistId ?? '').trim();
    if (!id) return [];
    return this.flashcard.getPlaylistItems(id);
  }

  @Get('playlist-count')
  async getPlaylistCount() {
    try {
      const count = await this.flashcard.getPlaylistCount();
      return { total: count };
    } catch {
      return { total: 0 };
    }
  }

  @Get('progress')
  async getProgress(
    @Req() req: Request,
    @Query('deck_ids') deckIdsParam?: string,
  ) {
    const ctx = req.session?.ltiContext;
    if (!ctx?.courseId || !ctx?.userId) return {};
    const canvasAccessToken = (req.session as { canvasAccessToken?: string })?.canvasAccessToken;
    const deckIds = deckIdsParam?.split(',').map((s) => s.trim()).filter(Boolean);
    return this.flashcard.getDeckProgress(
      ctx.courseId,
      ctx.userId,
      ctx.canvasDomain,
      deckIds?.length ? deckIds : undefined,
      ctx.canvasBaseUrl,
      canvasAccessToken,
    );
  }

  @Get('all-playlists')
  async getAllPlaylists(@Req() req: Request) {
    this.requireTeacher(req.session?.ltiContext as LtiContext | undefined);
    try {
      return await this.flashcard.getAllPlaylists();
    } catch (err) {
      setLastError('GET /api/flashcard/all-playlists', err);
      throw err;
    }
  }

  @Get('curricula')
  async getCurricula(@Req() req: Request) {
    this.requireTeacher(req.session?.ltiContext as LtiContext | undefined);
    try {
      return await this.flashcard.getTeacherCurricula();
    } catch (err) {
      setLastError('GET /api/flashcard/curricula', err);
      throw err;
    }
  }

  @Get('units')
  async getUnits(
    @Req() req: Request,
    @Query('curricula') curriculaParam?: string,
  ) {
    this.requireTeacher(req.session?.ltiContext as LtiContext | undefined);
    try {
      const curricula = (curriculaParam ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return await this.flashcard.getTeacherUnits(curricula);
    } catch (err) {
      setLastError('GET /api/flashcard/units', err);
      throw err;
    }
  }

  @Get('teacher-playlists')
  async getTeacherPlaylists(
    @Req() req: Request,
    @Query('curricula') curriculaParam?: string,
    @Query('units') unitsParam?: string,
  ) {
    this.requireTeacher(req.session?.ltiContext as LtiContext | undefined);
    try {
      const curricula = (curriculaParam ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const units = (unitsParam ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return await this.flashcard.getTeacherPlaylists(curricula, units);
    } catch (err) {
      setLastError('GET /api/flashcard/teacher-playlists', err);
      throw err;
    }
  }

  @Get('student-playlists-batch')
  async getStudentPlaylistsBatch(@Req() req: Request, @Res() res: Response) {
    const ctx = req.session?.ltiContext;
    if (!ctx?.courseId) {
      throw new ForbiddenException('LTI context required');
    }
    const canvasAccessToken = (req.session as { canvasAccessToken?: string })?.canvasAccessToken;
    const showHiddenParam = (req.query?.showHidden as string) ?? '';
    const showHidden = showHiddenParam === '1' || showHiddenParam === 'true';
    try {
      const data = await this.flashcard.getStudentPlaylistsBatch(
        ctx.courseId,
        ctx.canvasDomain,
        showHidden,
        ctx.canvasBaseUrl,
        canvasAccessToken,
      );
      return res.json(data);
    } catch (err) {
      if (err instanceof CanvasTokenExpiredError) {
        appendLtiLog('flashcard', 'student-playlists-batch: Canvas token expired — 401, redirectToOAuth');
        return res.status(401).json({
          error: 'Canvas token expired',
          redirectToOAuth: true,
          message: 'Re-authorize with Canvas to continue.',
        });
      }
      throw err;
    }
  }

  @Get('student-hub')
  async getStudentHub(
    @Req() req: Request,
    @Res() res: Response,
    @Query('unit') unitParam?: string,
    @Query('section') sectionParam?: string,
    @Query('showHidden') showHiddenParam?: string,
  ) {
    const ctx = req.session?.ltiContext;
    if (!ctx?.courseId) {
      throw new ForbiddenException('LTI context required');
    }
    const canvasAccessToken = (req.session as { canvasAccessToken?: string })?.canvasAccessToken;
    const unit = String(unitParam ?? '').trim() || undefined;
    const section = String(sectionParam ?? '').trim() || undefined;
    const showHidden = showHiddenParam === '1' || showHiddenParam === 'true';
    try {
      const hub = await this.flashcard.getStudentHub(
        ctx.courseId,
        unit,
        section,
        ctx.canvasDomain,
        showHidden,
        ctx.canvasBaseUrl,
        canvasAccessToken,
      );
      return res.json(hub);
    } catch (err) {
      if (err instanceof CanvasTokenExpiredError) {
        appendLtiLog('flashcard', 'student-hub: Canvas token expired — 401, redirectToOAuth');
        return res.status(401).json({
          error: 'Canvas token expired',
          redirectToOAuth: true,
          message: 'Re-authorize with Canvas to continue.',
        });
      }
      throw err;
    }
  }

  @Get('student-units')
  async getStudentUnits(@Req() req: Request) {
    const ctx = req.session?.ltiContext;
    if (!ctx?.courseId) {
      throw new ForbiddenException('LTI context required');
    }
    const canvasAccessToken = (req.session as { canvasAccessToken?: string })?.canvasAccessToken;
    return this.flashcard.getStudentUnits(
      ctx.courseId,
      ctx.canvasDomain,
      undefined,
      ctx.canvasBaseUrl,
      canvasAccessToken,
    );
  }

  @Get('student-sections')
  async getStudentSections(
    @Req() req: Request,
    @Query('unit') unitParam?: string,
  ) {
    const ctx = req.session?.ltiContext;
    if (!ctx?.courseId) {
      throw new ForbiddenException('LTI context required');
    }
    const canvasAccessToken = (req.session as { canvasAccessToken?: string })?.canvasAccessToken;
    const unit = String(unitParam ?? '').trim();
    if (!unit) return [];
    return this.flashcard.getStudentSections(
      ctx.courseId,
      unit,
      ctx.canvasDomain,
      undefined,
      ctx.canvasBaseUrl,
      canvasAccessToken,
    );
  }

  @Get('student-playlists')
  async getStudentPlaylists(
    @Req() req: Request,
    @Query('unit') unitParam?: string,
    @Query('section') sectionParam?: string,
  ) {
    const ctx = req.session?.ltiContext;
    if (!ctx?.courseId) {
      throw new ForbiddenException('LTI context required');
    }
    const canvasAccessToken = (req.session as { canvasAccessToken?: string })?.canvasAccessToken;
    const unit = String(unitParam ?? '').trim();
    const section = String(sectionParam ?? '').trim();
    if (!unit || !section) return [];
    return this.flashcard.getStudentPlaylists(
      ctx.courseId,
      unit,
      section,
      ctx.canvasDomain,
      undefined,
      ctx.canvasBaseUrl,
      canvasAccessToken,
    );
  }

  @Get('config')
  async getConfig(@Req() req: Request) {
    const ctx = req.session?.ltiContext;
    if (!ctx?.courseId) return null;
    return this.flashcard.getConfig(ctx.courseId, ctx.resourceLinkId ?? '');
  }

  @Put('config')
  async saveConfig(
    @Req() req: Request,
    @Body() body: { curriculum: string; unit: string; section: string },
  ) {
    const ctx = req.session?.ltiContext;
    if (!ctx?.courseId) {
      throw new ForbiddenException('LTI context required');
    }
    if (!this.ltiService.isTeacherRole(ctx.roles)) {
      throw new ForbiddenException('Teacher role required');
    }
    await this.flashcard.saveConfig(
      ctx.courseId,
      ctx.resourceLinkId ?? '',
      body.curriculum ?? '',
      body.unit ?? '',
      body.section ?? '',
    );
  }
}
