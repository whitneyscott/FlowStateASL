import { Injectable } from '@nestjs/common';
import { SproutVideoService } from '../sproutvideo/sproutvideo.service';
import { CanvasService } from '../canvas/canvas.service';

@Injectable()
export class FlashcardService {
  constructor(
    private readonly sproutVideo: SproutVideoService,
    private readonly canvas: CanvasService,
  ) {}

  async getPlaylists(filter: string) {
    return this.sproutVideo.getPlaylistItems(filter);
  }

  async getPlaylistItems(playlistId: string) {
    return this.sproutVideo.getPlaylistItems('', playlistId);
  }

  async getModuleInfo(courseId: string, moduleId: string, prefix?: string) {
    return this.canvas.getModuleInfo(courseId, moduleId, prefix);
  }
}
