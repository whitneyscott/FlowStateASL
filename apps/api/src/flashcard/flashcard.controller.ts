import { Controller, Get, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { FlashcardService } from './flashcard.service';

@Controller('flashcard')
export class FlashcardController {
  constructor(private readonly flashcard: FlashcardService) {}

  @Get('playlists')
  async getPlaylists(@Req() req: Request, @Query('filter') filter: string) {
    const ctx = req.session?.ltiContext;
    const prefix = process.env.CURRICULUM_PREFIX ?? 'TWA';
    let effectiveFilter = filter ?? '';
    if (!effectiveFilter && ctx?.courseId && ctx?.moduleId) {
      const info = await this.flashcard.getModuleInfo(ctx.courseId, ctx.moduleId, prefix);
      effectiveFilter = info.filter ?? '';
    }
    return this.flashcard.getPlaylists(effectiveFilter);
  }

  @Get('items')
  async getItems(@Query('playlist_id') playlistId: string) {
    return this.flashcard.getPlaylistItems(playlistId ?? '');
  }
}
