import {
  Controller,
  Get,
  Put,
  Body,
  Query,
  Req,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';
import { FlashcardService } from './flashcard.service';
import { LtiService } from '../lti/lti.service';
import { setLastError } from '../common/last-error.store';

@Controller('flashcard')
export class FlashcardController {
  constructor(
    private readonly flashcard: FlashcardService,
    private readonly ltiService: LtiService,
  ) {}

  @Get('playlists')
  async getPlaylists(
    @Req() req: Request,
    @Query('filter') filter: string,
    @Query('curriculum') curriculumQ: string,
    @Query('unit') unitQ: string,
    @Query('section') sectionQ: string,
  ) {
    const ctx = req.session?.ltiContext;
    const prefix = process.env.CURRICULUM_PREFIX ?? 'TWA';
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
      if (!effectiveFilter && ctx?.courseId && ctx?.moduleId) {
        const info = await this.flashcard.getModuleInfo(
          ctx.courseId,
          ctx.moduleId,
          prefix,
          ctx?.canvasDomain,
        );
        effectiveFilter = info.filter ?? '';
      }
      return await this.flashcard.getPlaylists(effectiveFilter);
    } catch (err) {
      setLastError('GET /api/flashcard/playlists', err);
      throw err;
    }
  }

  @Get('items')
  async getItems(@Query('playlist_id') playlistId: string) {
    return this.flashcard.getPlaylistItems(playlistId ?? '');
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

  @Get('all-playlists')
  async getAllPlaylists() {
    try {
      return await this.flashcard.getAllPlaylists();
    } catch (err) {
      setLastError('GET /api/flashcard/all-playlists', err);
      throw err;
    }
  }

  @Get('module-suggestion')
  async getModuleSuggestion(@Req() req: Request) {
    const ctx = req.session?.ltiContext;
    if (!ctx?.courseId || !ctx?.moduleId) return null;
    const prefix = process.env.CURRICULUM_PREFIX ?? 'TWA';
    try {
      const info = await this.flashcard.getModuleInfo(
        ctx.courseId,
        ctx.moduleId,
        prefix,
        ctx?.canvasDomain,
      );
      return {
        curriculum: prefix,
        unit: info.unit ?? '',
        section: info.section ?? '',
        moduleName: info.module_name,
      };
    } catch {
      return null;
    }
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
