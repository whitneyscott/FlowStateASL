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

@Controller('flashcard')
export class FlashcardController {
  constructor(
    private readonly flashcard: FlashcardService,
    private readonly ltiService: LtiService,
  ) {}

  @Get('playlists')
  async getPlaylists(@Req() req: Request, @Query('filter') filter: string) {
    const ctx = req.session?.ltiContext;
    const prefix = process.env.CURRICULUM_PREFIX ?? 'TWA';
    let effectiveFilter = filter ?? '';
    if (!effectiveFilter && ctx?.courseId && ctx?.resourceLinkId) {
      const config = await this.flashcard.getConfig(
        ctx.courseId,
        ctx.resourceLinkId,
      );
      if (config && config.curriculum) {
        effectiveFilter = [config.curriculum, config.unit, config.section]
          .filter(Boolean)
          .join(' ');
      }
    }
    if (!effectiveFilter && ctx?.courseId && ctx?.moduleId) {
      const info = await this.flashcard.getModuleInfo(
        ctx.courseId,
        ctx.moduleId,
        prefix,
      );
      effectiveFilter = info.filter ?? '';
    }
    return this.flashcard.getPlaylists(effectiveFilter);
  }

  @Get('items')
  async getItems(@Query('playlist_id') playlistId: string) {
    return this.flashcard.getPlaylistItems(playlistId ?? '');
  }

  @Get('curriculum-hierarchy')
  async getCurriculumHierarchy() {
    return this.flashcard.getCurriculumHierarchy();
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
