import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CanvasService } from '../canvas/canvas.service';
import { CourseSettingsService } from '../course-settings/course-settings.service';
import { SproutVideoService } from '../sproutvideo/sproutvideo.service';
import { PlaylistCacheService } from '../sproutvideo/playlist-cache.service';
import { FlashcardConfigEntity } from './entities/flashcard-config.entity';

@Injectable()
export class FlashcardService {
  constructor(
    private readonly sproutVideo: SproutVideoService,
    private readonly playlistCache: PlaylistCacheService,
    private readonly canvas: CanvasService,
    private readonly courseSettings: CourseSettingsService,
    @InjectRepository(FlashcardConfigEntity)
    private readonly configRepo: Repository<FlashcardConfigEntity>,
  ) {}

  async getPlaylists(filter: string) {
    const searchTerms = this.sproutVideo.getSmartVersions(filter);
    if (searchTerms.length === 0) return [];
    return this.playlistCache.getPlaylistsForFilter(searchTerms);
  }

  async getPlaylistsByHierarchy(
    curriculum: string,
    unit: string,
    section: string,
  ) {
    const parts = [curriculum, unit, section].filter(Boolean);
    const filter = parts.join('.');
    if (!filter) return [];
    const searchTerms = this.sproutVideo.getSmartVersions(filter);
    if (searchTerms.length === 0) return [];
    return this.playlistCache.getPlaylistsForFilter(searchTerms);
  }

  async getPlaylistItems(playlistId: string) {
    const cached = await this.playlistCache.getPlaylistItems(playlistId);
    if (cached !== null) return cached;
    return this.sproutVideo.getPlaylistItems('', playlistId);
  }

  async getModuleInfo(
    courseId: string,
    moduleId: string,
    prefix?: string,
    canvasDomain?: string,
  ) {
    return this.canvas.getModuleInfo(courseId, moduleId, prefix, canvasDomain);
  }

  async getAllPlaylists() {
    const playlists = await this.playlistCache.getAllPlaylists();
    return playlists
      .filter((p) => !this.sproutVideo.isBlacklisted(p.title))
      .map((p) => ({ id: p.id, title: p.title }));
  }

  async getPlaylistCount(): Promise<number> {
    return this.playlistCache.getPlaylistCount();
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

  async getDeckProgress(
    courseId: string,
    userId: string,
    canvasDomain?: string,
    deckIds?: string[],
  ): Promise<Record<string, { completed: number }>> {
    const result: Record<string, { completed: number }> = {};
    const byDeck: Record<string, { completed: number; submittedAt: number }> = {};
    try {
      const progressAssignmentId =
        await this.courseSettings.getProgressAssignmentId(courseId, canvasDomain);
      const token = await this.courseSettings.getEffectiveCanvasToken(courseId);
      const sub = await this.canvas.getSubmissionWithComments(
        courseId,
        progressAssignmentId,
        userId,
        canvasDomain,
        token,
      );
      if (!sub?.comments?.length) return result;
      for (const c of sub.comments) {
        const raw = c.comment?.trim();
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw) as { deckIds?: string[]; scoreTotal?: number; submittedAt?: string };
          const ids = Array.isArray(parsed.deckIds) ? parsed.deckIds : [];
          const completed = typeof parsed.scoreTotal === 'number' ? parsed.scoreTotal : 0;
          const submittedAt = parsed.submittedAt ? new Date(parsed.submittedAt).getTime() : 0;
          for (const deckId of ids) {
            const id = String(deckId);
            if (deckIds && deckIds.length > 0 && !deckIds.includes(id)) continue;
            const existing = byDeck[id];
            if (!existing || submittedAt > existing.submittedAt) {
              byDeck[id] = { completed, submittedAt };
            }
          }
        } catch {
          // ignore non-JSON comments
        }
      }
      for (const id of Object.keys(byDeck)) {
        result[id] = { completed: byDeck[id].completed };
      }
    } catch {
      // best-effort
    }
    return result;
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
