import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
    private readonly config: ConfigService,
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

  private async getStudentConstraints(
    courseId: string,
    canvasDomain?: string,
    canvasBaseUrl?: string,
    canvasAccessToken?: string | null,
  ): Promise<{ selectedCurriculums: string[]; selectedUnits: string[]; error?: string }> {
    const settings = await this.courseSettings.getForStudent(courseId, {
      canvasDomain,
      canvasBaseUrl,
      canvasAccessToken,
    });
    return {
      selectedCurriculums: settings.selectedCurriculums ?? [],
      selectedUnits: settings.selectedUnits ?? [],
      error: 'error' in settings ? settings.error : undefined,
    };
  }

  async getStudentUnits(
    courseId: string,
    canvasDomain?: string,
    showHidden?: boolean,
    canvasBaseUrl?: string,
    canvasAccessToken?: string | null,
  ): Promise<string[]> {
    const constraints = showHidden
      ? { selectedCurriculums: [] as string[], selectedUnits: [] as string[] }
      : await this.getStudentConstraints(courseId, canvasDomain, canvasBaseUrl, canvasAccessToken);
    return this.playlistCache.getDistinctUnitsByConstraints(constraints.selectedCurriculums, constraints.selectedUnits);
  }

  async getStudentSections(
    courseId: string,
    unit: string,
    canvasDomain?: string,
    showHidden?: boolean,
    canvasBaseUrl?: string,
    canvasAccessToken?: string | null,
  ): Promise<string[]> {
    const constraints = showHidden
      ? { selectedCurriculums: [] as string[], selectedUnits: [] as string[] }
      : await this.getStudentConstraints(courseId, canvasDomain, canvasBaseUrl, canvasAccessToken);
    return this.playlistCache.getDistinctSectionsByConstraints(constraints.selectedCurriculums, unit, constraints.selectedUnits);
  }

  async getStudentPlaylists(
    courseId: string,
    unit: string,
    section: string,
    canvasDomain?: string,
    showHidden?: boolean,
    canvasBaseUrl?: string,
    canvasAccessToken?: string | null,
  ): Promise<Array<{ id: string; title: string }>> {
    const constraints = showHidden
      ? { selectedCurriculums: [] as string[], selectedUnits: [] as string[] }
      : await this.getStudentConstraints(courseId, canvasDomain, canvasBaseUrl, canvasAccessToken);
    const rows = await this.playlistCache.getPlaylistsByHierarchy(
      constraints.selectedCurriculums,
      unit,
      section,
      constraints.selectedUnits,
    );
    return rows.filter((p) => !this.sproutVideo.isBlacklisted(p.title));
  }

  /** Batch playlists for students: uses same filter as teacher (curricula+units), returns unit/section for client-side filtering. No teacher role required. */
  async getStudentPlaylistsBatch(
    courseId: string,
    canvasDomain?: string,
    showHidden?: boolean,
    canvasBaseUrl?: string,
    canvasAccessToken?: string | null,
  ): Promise<{
    playlists: Array<{ id: string; title: string; unit: string; section: string }>;
    selectedCurriculums: string[];
    selectedUnits: string[];
    sproutAccountId?: string;
    error?: string;
  }> {
    const settings = await this.courseSettings.getForStudent(courseId, {
      canvasDomain,
      canvasBaseUrl,
      canvasAccessToken,
    });
    const selectedCurriculums = settings.selectedCurriculums ?? [];
    const selectedUnits = settings.selectedUnits ?? [];
    const error = 'error' in settings ? settings.error : undefined;

    const curricula = showHidden ? [] : selectedCurriculums;
    const units = showHidden ? [] : selectedUnits;
    const rows = await this.playlistCache.getPlaylistsByCurriculaAndUnitsWithHierarchy(
      curricula,
      units,
    );
    const playlists = rows
      .filter((p) => !this.sproutVideo.isBlacklisted(p.title))
      .map((p) => ({ id: p.id, title: p.title, unit: p.unit, section: p.section }));

    return {
      playlists,
      selectedCurriculums,
      selectedUnits,
      sproutAccountId: this.config.get<string>('SPROUT_ACCOUNT_ID') ?? undefined,
      ...(error && { error }),
    };
  }

  /** Bundled endpoint: returns units (and optionally sections/playlists) in one call to reduce round-trips. Uses getForStudent (announcement only). */
  async getStudentHub(
    courseId: string,
    unit: string | undefined,
    section: string | undefined,
    canvasDomain?: string,
    showHidden?: boolean,
    canvasBaseUrl?: string,
    canvasAccessToken?: string | null,
  ): Promise<{
    units?: string[];
    sections?: string[];
    playlists?: Array<{ id: string; title: string }>;
    selectedCurriculums: string[];
    selectedUnits: string[];
    sproutAccountId?: string;
    error?: string;
  }> {
    const settings = await this.courseSettings.getForStudent(courseId, {
      canvasDomain,
      canvasBaseUrl,
      canvasAccessToken,
    });
    const selectedCurriculums = settings.selectedCurriculums ?? [];
    const selectedUnits = settings.selectedUnits ?? [];
    const error = 'error' in settings ? settings.error : undefined;

    const result: {
      units?: string[];
      sections?: string[];
      playlists?: Array<{ id: string; title: string }>;
      selectedCurriculums: string[];
      selectedUnits: string[];
      sproutAccountId?: string;
      error?: string;
    } = {
      selectedCurriculums,
      selectedUnits,
      sproutAccountId: this.config.get<string>('SPROUT_ACCOUNT_ID') ?? undefined,
      ...(error && { error }),
    };

    result.units = await this.getStudentUnits(
      courseId,
      canvasDomain,
      showHidden,
      canvasBaseUrl,
      canvasAccessToken,
    );

    if (unit) {
      result.sections = await this.getStudentSections(
        courseId,
        unit,
        canvasDomain,
        showHidden,
        canvasBaseUrl,
        canvasAccessToken,
      );
    }
    if (unit) {
      result.playlists = await this.getStudentPlaylists(
        courseId,
        unit,
        section ?? '',
        canvasDomain,
        showHidden,
        canvasBaseUrl,
        canvasAccessToken,
      );
    }

    return result;
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
    canvasBaseUrl?: string,
    canvasAccessToken?: string,
  ): Promise<Record<string, { completed: number }>> {
    const result: Record<string, { completed: number }> = {};
    try {
      const canvasOverride = canvasBaseUrl ?? canvasDomain;
      const progressAssignmentId =
        await this.courseSettings.getProgressAssignmentId(courseId, canvasDomain, canvasBaseUrl);
      const token = await this.courseSettings.getEffectiveCanvasToken(courseId, canvasAccessToken);
      const sub = await this.canvas.getSubmission(
        courseId,
        progressAssignmentId,
        userId,
        canvasOverride,
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
