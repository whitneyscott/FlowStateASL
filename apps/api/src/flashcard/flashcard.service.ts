import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SproutVideoService } from '../sproutvideo/sproutvideo.service';
import { CanvasService } from '../canvas/canvas.service';
import { FlashcardConfigEntity } from './entities/flashcard-config.entity';

@Injectable()
export class FlashcardService {
  constructor(
    private readonly sproutVideo: SproutVideoService,
    private readonly canvas: CanvasService,
    @InjectRepository(FlashcardConfigEntity)
    private readonly configRepo: Repository<FlashcardConfigEntity>,
  ) {}

  async getPlaylists(filter: string) {
    return this.sproutVideo.getPlaylistItems(filter);
  }

  async getPlaylistsByHierarchy(
    curriculum: string,
    unit: string,
    section: string,
  ) {
    const playlists = await this.sproutVideo.fetchAllPlaylists();
    console.log('[SproutVideo] playlists: API accessed, retrieved:', playlists.length);
    return this.sproutVideo.filterPlaylistsByHierarchy(
      playlists,
      curriculum,
      unit,
      section,
    );
  }

  async getPlaylistItems(playlistId: string) {
    return this.sproutVideo.getPlaylistItems('', playlistId);
  }

  async getModuleInfo(courseId: string, moduleId: string, prefix?: string) {
    return this.canvas.getModuleInfo(courseId, moduleId, prefix);
  }

  async getCurriculumHierarchy() {
    return this.sproutVideo.getCurriculumHierarchy();
  }

  async getConfig(
    courseId: string,
    resourceLinkId: string,
  ): Promise<{ curriculum: string; unit: string; section: string } | null> {
    const linkId = resourceLinkId || 'default';
    const row = await this.configRepo.findOne({
      where: { courseId, resourceLinkId: linkId },
    });
    if (!row) return null;
    return {
      curriculum: row.curriculum,
      unit: row.unit,
      section: row.section,
    };
  }

  async saveConfig(
    courseId: string,
    resourceLinkId: string,
    curriculum: string,
    unit: string,
    section: string,
  ): Promise<void> {
    const linkId = resourceLinkId || 'default';
    await this.configRepo.upsert(
      {
        courseId,
        resourceLinkId: linkId,
        curriculum,
        unit,
        section,
      },
      { conflictPaths: ['courseId', 'resourceLinkId'] },
    );
  }
}
