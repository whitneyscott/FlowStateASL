import { Injectable, NotFoundException } from '@nestjs/common';
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
    throw new NotFoundException(
      `Playlist ${playlistId} is not available in cache yet. Please sync and try again.`,
    );
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

  async getTeacherCurricula(): Promise<string[]> {
    return this.playlistCache.getDistinctCurricula();
  }

  async getTeacherUnits(curricula: string[]): Promise<string[]> {
    return this.playlistCache.getDistinctUnits(curricula);
  }

  async getTeacherPlaylists(
    curricula: string[],
    units: string[],
  ): Promise<Array<{ id: string; title: string }>> {
    const rows = await this.playlistCache.getPlaylistsByCurriculaAndUnits(curricula, units);
    return rows.filter((p) => !this.sproutVideo.isBlacklisted(p.title));
  }

  private async getStudentConstraints(courseId: string, canvasDomain?: string): Promise<{
    selectedCurriculums: string[];
    selectedUnits: string[];
  }> {
    const settings = await this.courseSettings.get(courseId, {
      isTeacher: false,
      canvasDomain,
    });
    return {
      selectedCurriculums: settings?.selectedCurriculums ?? [],
      selectedUnits: settings?.selectedUnits ?? [],
    };
  }

  async getStudentUnits(courseId: string, canvasDomain?: string): Promise<string[]> {
    const { selectedCurriculums, selectedUnits } = await this.getStudentConstraints(courseId, canvasDomain);
    return this.playlistCache.getDistinctUnitsByConstraints(selectedCurriculums, selectedUnits);
  }

  async getStudentSections(
    courseId: string,
    unit: string,
    canvasDomain?: string,
  ): Promise<string[]> {
    const { selectedCurriculums, selectedUnits } = await this.getStudentConstraints(courseId, canvasDomain);
    return this.playlistCache.getDistinctSectionsByConstraints(selectedCurriculums, unit, selectedUnits);
  }

  async getStudentPlaylists(
    courseId: string,
    unit: string,
    section: string,
    canvasDomain?: string,
  ): Promise<Array<{ id: string; title: string }>> {
    const { selectedCurriculums, selectedUnits } = await this.getStudentConstraints(courseId, canvasDomain);
    const rows = await this.playlistCache.getPlaylistsByHierarchy(
      selectedCurriculums,
      unit,
      section,
      selectedUnits,
    );
    return rows.filter((p) => !this.sproutVideo.isBlacklisted(p.title));
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
    try {
      const progressAssignmentId =
        await this.courseSettings.getProgressAssignmentId(courseId, canvasDomain);
      const token = await this.courseSettings.getEffectiveCanvasToken(courseId);
      const sub = await this.canvas.getSubmission(
        courseId,
        progressAssignmentId,
        userId,
        canvasDomain,
        token,
      );
      const rawBody = sub?.body?.trim();
      if (!rawBody) return result;

      try {
        const parsed = JSON.parse(rawBody) as {
          results?: Record<string, { scoreTotal?: number }>;
        };
        const entries = parsed?.results ?? {};
        for (const [deckId, deckResult] of Object.entries(entries)) {
          const id = String(deckId);
          if (deckIds && deckIds.length > 0 && !deckIds.includes(id)) continue;
          const completed =
            deckResult && typeof deckResult.scoreTotal === 'number'
              ? deckResult.scoreTotal
              : 0;
          result[id] = { completed };
        }
      } catch {
        // ignore malformed body JSON
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
