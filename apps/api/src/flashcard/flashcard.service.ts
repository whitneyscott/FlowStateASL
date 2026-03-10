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
      .filter((p) => !this.isPlaylistBlacklisted(p))
      .map((p) => ({ id: p.id, title: p.title }));
  }

  async getPlaylistCount(): Promise<number> {
    return this.playlistCache.getPlaylistCount();
  }

  async getTeacherCurricula(options?: { showBlacklisted?: boolean }): Promise<string[]> {
    const all = await this.playlistCache.getDistinctCurricula();
    if (options?.showBlacklisted) return all;
    return all.filter((c) => !this.sproutVideo.isBlacklisted(c));
  }

  async getTeacherUnits(curricula: string[]): Promise<string[]> {
    return this.playlistCache.getDistinctUnits(curricula);
  }

  private isPlaylistBlacklisted(p: { title: string; curriculum?: string }): boolean {
    return (
      this.sproutVideo.isBlacklisted(p.title) ||
      this.sproutVideo.isBlacklisted(p.curriculum ?? '')
    );
  }

  async getTeacherPlaylists(
    curricula: string[],
    units: string[],
    options?: { showBlacklisted?: boolean },
  ): Promise<Array<{ id: string; title: string }>> {
    const rows = await this.playlistCache.getPlaylistsByCurriculaAndUnits(curricula, units);
    if (options?.showBlacklisted) {
      return rows.map((r) => ({ id: r.id, title: r.title }));
    }
    return rows
      .filter((p) => !this.isPlaylistBlacklisted(p))
      .map((r) => ({ id: r.id, title: r.title }));
  }

  private async getStudentConstraints(
    courseId: string,
    canvasDomain?: string,
    canvasBaseUrl?: string,
    canvasAccessToken?: string,
    override?: { selectedCurriculums: string[]; selectedUnits: string[] },
  ): Promise<{ selectedCurriculums: string[]; selectedUnits: string[] }> {
    if (override) return override;
    const settings = await this.courseSettings.get(courseId, {
      isTeacher: false,
      canvasDomain,
      canvasBaseUrl,
      canvasAccessToken: canvasAccessToken ?? undefined,
    });
    return {
      selectedCurriculums: settings?.selectedCurriculums ?? [],
      selectedUnits: settings?.selectedUnits ?? [],
    };
  }

  /** Student constraints with blacklisted curricula and units removed - students must NEVER see blacklisted items */
  private filterBlacklistedForStudent<T extends string>(items: T[]): T[] {
    return items.filter((x) => !this.sproutVideo.isBlacklisted(x));
  }

  async getStudentUnits(
    courseId: string,
    canvasDomain?: string,
    showHidden?: boolean,
    canvasBaseUrl?: string,
    canvasAccessToken?: string,
    constraintsOverride?: { selectedCurriculums: string[]; selectedUnits: string[] },
  ): Promise<string[]> {
    const { curricula, allowedUnits } = await this.getStudentCurriculaAndAllowedUnits(
      courseId,
      !!showHidden,
      canvasDomain,
      canvasBaseUrl,
      canvasAccessToken,
      constraintsOverride,
    );
    if (curricula.length === 0 && allowedUnits.length === 0) return [];
    const units = await this.playlistCache.getDistinctUnitsByConstraints(curricula, allowedUnits);
    return this.filterBlacklistedForStudent(units);
  }

  /** Curricula not selected by teacher, non-blacklisted */
  async getAdditionalCurricula(
    courseId: string,
    canvasDomain?: string,
    canvasBaseUrl?: string,
    canvasAccessToken?: string,
    constraintsOverride?: { selectedCurriculums: string[]; selectedUnits: string[] },
  ): Promise<string[]> {
    const constraints = await this.getStudentConstraints(
      courseId,
      canvasDomain,
      canvasBaseUrl,
      canvasAccessToken,
      constraintsOverride,
    );
    const all = await this.playlistCache.getDistinctCurricula();
    const nonBlacklisted = all.filter((c) => !this.sproutVideo.isBlacklisted(c));
    return nonBlacklisted.filter((c) => !constraints.selectedCurriculums.includes(c));
  }

  /** Units under additional curricula (not selected by teacher), non-blacklisted */
  async getAdditionalUnits(
    courseId: string,
    additionalCurricula: string[],
    canvasDomain?: string,
    canvasBaseUrl?: string,
  ): Promise<string[]> {
    if (additionalCurricula.length === 0) return [];
    const all = await this.playlistCache.getDistinctUnits(additionalCurricula);
    return all.filter((u) => !this.sproutVideo.isBlacklisted(u));
  }

  /**
   * For course materials (showHidden=false): returns teacher's selected curricula and units,
   * with blacklisted items removed. Students see ONLY what the teacher selected.
   * For additional materials (showHidden=true): returns all non-blacklisted curricula.
   */
  private async getStudentCurriculaAndAllowedUnits(
    courseId: string,
    showHidden: boolean,
    canvasDomain?: string,
    canvasBaseUrl?: string,
    canvasAccessToken?: string,
    constraintsOverride?: { selectedCurriculums: string[]; selectedUnits: string[] },
  ): Promise<{ curricula: string[]; allowedUnits: string[] }> {
    if (showHidden) {
      const allCurricula = await this.playlistCache.getDistinctCurricula();
      const safeCurricula = this.filterBlacklistedForStudent(allCurricula);
      return { curricula: safeCurricula, allowedUnits: [] };
    }
    const constraints = await this.getStudentConstraints(
      courseId,
      canvasDomain,
      canvasBaseUrl,
      canvasAccessToken,
      constraintsOverride,
    );
    const curricula = this.filterBlacklistedForStudent(constraints.selectedCurriculums);
    const allowedUnits = this.filterBlacklistedForStudent(constraints.selectedUnits);
    return { curricula, allowedUnits };
  }

  async getStudentSections(
    courseId: string,
    unit: string,
    canvasDomain?: string,
    showHidden?: boolean,
    canvasBaseUrl?: string,
    canvasAccessToken?: string,
    constraintsOverride?: { selectedCurriculums: string[]; selectedUnits: string[] },
  ): Promise<string[]> {
    if (this.sproutVideo.isBlacklisted(unit)) return [];
    const { curricula, allowedUnits } = await this.getStudentCurriculaAndAllowedUnits(
      courseId,
      !!showHidden,
      canvasDomain,
      canvasBaseUrl,
      canvasAccessToken,
      constraintsOverride,
    );
    if (curricula.length === 0) return [];
    return this.playlistCache.getDistinctSectionsByConstraints(curricula, unit, allowedUnits);
  }

  async getStudentSectionsForUnits(
    courseId: string,
    units: string[],
    canvasDomain?: string,
    showHidden?: boolean,
    canvasBaseUrl?: string,
    canvasAccessToken?: string,
    constraintsOverride?: { selectedCurriculums: string[]; selectedUnits: string[] },
  ): Promise<string[]> {
    const safeUnits = units.filter((u) => !this.sproutVideo.isBlacklisted(u));
    if (safeUnits.length === 0) return [];
    const { curricula, allowedUnits } = await this.getStudentCurriculaAndAllowedUnits(
      courseId,
      !!showHidden,
      canvasDomain,
      canvasBaseUrl,
      canvasAccessToken,
      constraintsOverride,
    );
    if (curricula.length === 0) return [];
    return this.playlistCache.getDistinctSectionsForUnits(curricula, safeUnits, allowedUnits);
  }

  async getStudentPlaylists(
    courseId: string,
    unit: string,
    section: string,
    canvasDomain?: string,
    showHidden?: boolean,
    canvasBaseUrl?: string,
    canvasAccessToken?: string,
    constraintsOverride?: { selectedCurriculums: string[]; selectedUnits: string[] },
  ): Promise<Array<{ id: string; title: string }>> {
    if (this.sproutVideo.isBlacklisted(unit) || this.sproutVideo.isBlacklisted(section)) return [];
    const { curricula, allowedUnits } = await this.getStudentCurriculaAndAllowedUnits(
      courseId,
      !!showHidden,
      canvasDomain,
      canvasBaseUrl,
      canvasAccessToken,
      constraintsOverride,
    );
    if (curricula.length === 0) return [];
    const rows = await this.playlistCache.getPlaylistsByHierarchy(curricula, unit, section, allowedUnits);
    return rows
      .filter((p) => !this.isPlaylistBlacklisted(p))
      .map((r) => ({ id: r.id, title: r.title }));
  }

  async getStudentPlaylistsMulti(
    courseId: string,
    units: string[],
    sections: string[],
    canvasDomain?: string,
    showHidden?: boolean,
    canvasBaseUrl?: string,
    canvasAccessToken?: string,
    constraintsOverride?: { selectedCurriculums: string[]; selectedUnits: string[] },
  ): Promise<Array<{ id: string; title: string }>> {
    const safeUnits = units.filter((u) => !this.sproutVideo.isBlacklisted(u));
    const safeSections = sections.filter((s) => !this.sproutVideo.isBlacklisted(s));
    if (safeUnits.length === 0 || safeSections.length === 0) return [];
    const { curricula, allowedUnits } = await this.getStudentCurriculaAndAllowedUnits(
      courseId,
      !!showHidden,
      canvasDomain,
      canvasBaseUrl,
      canvasAccessToken,
      constraintsOverride,
    );
    if (curricula.length === 0) return [];
    const rows = await this.playlistCache.getPlaylistsByUnitsAndSections(
      curricula,
      safeUnits,
      safeSections,
      allowedUnits,
    );
    return rows
      .filter((p) => !this.isPlaylistBlacklisted(p))
      .map((r) => ({ id: r.id, title: r.title }));
  }

  /** Sections for additional curricula + units */
  async getAdditionalSectionsForUnits(
    additionalCurricula: string[],
    additionalUnits: string[],
  ): Promise<string[]> {
    if (additionalCurricula.length === 0 || additionalUnits.length === 0) return [];
    return this.playlistCache.getDistinctSectionsForUnits(additionalCurricula, additionalUnits, []);
  }

  /** Playlists for additional curricula + units + sections */
  private async getAdditionalPlaylists(
    additionalCurricula: string[],
    additionalUnits: string[],
    additionalSections: string[],
  ): Promise<Array<{ id: string; title: string }>> {
    if (additionalCurricula.length === 0 || additionalUnits.length === 0 || additionalSections.length === 0) {
      return [];
    }
    const rows = await this.playlistCache.getPlaylistsByUnitsAndSections(
      additionalCurricula,
      additionalUnits,
      additionalSections,
      [],
    );
    return rows
      .filter((p) => !this.isPlaylistBlacklisted(p))
      .map((r) => ({ id: r.id, title: r.title }));
  }

  /** Bundled endpoint: returns units, sections (for selected units), and playlists (for selected units+sections).
   * When selectedCurriculums and selectedUnits are provided (from GET /api/course-settings), uses them directly.
   * Fallback to courseSettings.get() only when params are missing (backwards compatibility). */
  async getStudentHub(
    courseId: string,
    units: string[],
    sections: string[],
    canvasDomain?: string,
    showHidden?: boolean,
    canvasBaseUrl?: string,
    additionalCurricula: string[] = [],
    additionalUnits: string[] = [],
    additionalSections: string[] = [],
    canvasAccessToken?: string,
    selectedCurriculumsParam?: string[],
    selectedUnitsParam?: string[],
  ): Promise<{
    units: string[];
    sections: string[];
    playlists: Array<{ id: string; title: string }>;
    selectedCurriculums: string[];
    selectedUnits: string[];
    additionalCurricula: string[];
    additionalUnits: string[];
    additionalSections: string[];
    sproutAccountId?: string;
  }> {
    let selectedCurriculums: string[];
    let selectedUnits: string[];
    let settings: { selectedCurriculums?: string[]; selectedUnits?: string[]; sproutAccountId?: string } | null;

    if (selectedCurriculumsParam != null && selectedUnitsParam != null) {
      selectedCurriculums = selectedCurriculumsParam;
      selectedUnits = selectedUnitsParam;
      settings = { selectedCurriculums, selectedUnits };
    } else {
      settings = await this.courseSettings.get(courseId, {
        isTeacher: false,
        canvasDomain,
        canvasBaseUrl,
        canvasAccessToken: canvasAccessToken ?? undefined,
      });
      selectedCurriculums = settings?.selectedCurriculums ?? [];
      selectedUnits = settings?.selectedUnits ?? [];
    }

    const constraintsOverride = { selectedCurriculums, selectedUnits };

    /* Unit and Section divs always show course materials only (teacher's selection). showHidden only controls additional curricula/units. */
    const hubUnits = await this.getStudentUnits(
      courseId,
      canvasDomain,
      false,
      canvasBaseUrl,
      canvasAccessToken,
      constraintsOverride,
    );
    const hubSections =
      units.length > 0
        ? await this.getStudentSectionsForUnits(
            courseId,
            units,
            canvasDomain,
            false,
            canvasBaseUrl,
            canvasAccessToken,
            constraintsOverride,
          )
        : [];

    let hubPlaylists: Array<{ id: string; title: string }> = [];
    if (units.length > 0 && sections.length > 0) {
      hubPlaylists = await this.getStudentPlaylistsMulti(
        courseId,
        units,
        sections,
        canvasDomain,
        false,
        canvasBaseUrl,
        canvasAccessToken,
        constraintsOverride,
      );
    }

    let hubAdditionalCurricula: string[] = [];
    let hubAdditionalUnits: string[] = [];
    let hubAdditionalSections: string[] = [];
    if (showHidden) {
      hubAdditionalCurricula = await this.getAdditionalCurricula(
        courseId,
        canvasDomain,
        canvasBaseUrl,
        canvasAccessToken,
        constraintsOverride,
      );
      hubAdditionalUnits =
        hubAdditionalCurricula.length > 0
          ? await this.getAdditionalUnits(courseId, hubAdditionalCurricula, canvasDomain, canvasBaseUrl)
          : [];
    if (additionalCurricula.length > 0 && additionalUnits.length > 0) {
      hubAdditionalSections = await this.getAdditionalSectionsForUnits(additionalCurricula, additionalUnits);
    }
    }

    if (additionalCurricula.length > 0 && additionalUnits.length > 0) {
      const sectionsToUse = additionalSections.length > 0 ? additionalSections : hubAdditionalSections;
      if (sectionsToUse.length > 0) {
        const extra = await this.getAdditionalPlaylists(additionalCurricula, additionalUnits, sectionsToUse);
        const seen = new Set(hubPlaylists.map((p) => p.id));
        for (const p of extra) {
          if (!seen.has(p.id)) {
            seen.add(p.id);
            hubPlaylists.push(p);
          }
        }
      }
    }

    return {
      units: hubUnits,
      sections: hubSections,
      playlists: hubPlaylists,
      selectedCurriculums,
      selectedUnits,
      additionalCurricula: hubAdditionalCurricula,
      additionalUnits: hubAdditionalUnits,
      additionalSections: hubAdditionalSections,
      sproutAccountId: settings?.sproutAccountId,
    };
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
        await this.courseSettings.getProgressAssignmentId(courseId, canvasDomain, canvasBaseUrl, canvasAccessToken);
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
