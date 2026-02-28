import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CanvasService } from '../canvas/canvas.service';
import { SproutVideoService } from '../sproutvideo/sproutvideo.service';
import type { SproutPlaylist } from '../sproutvideo/interfaces/sprout-playlist.interface';
import type { SproutVideoItem } from '../sproutvideo/interfaces/sprout-video-item.interface';
import { CourseSettingsEntity } from './entities/course-settings.entity';

interface AssignmentDescriptionData {
  v?: number;
  selectedCurriculums?: string[];
  selectedUnits?: string[];
  filteredPlaylists?: Array<{
    id: string;
    title: string;
    items?: Array<{ title: string; embed: string }>;
  }>;
  updatedAt?: string;
  playlistUpdatedAt?: Record<string, string>;
}

function segments(title: string): string[] {
  return title.split('.').map((p) => p.trim()).filter(Boolean);
}

function filterPlaylistsByCurriculumUnits(
  playlists: SproutPlaylist[],
  selectedCurriculums: string[],
  selectedUnits: string[],
): SproutPlaylist[] {
  return playlists.filter((p) => {
    const [c, u] = segments(p.title ?? '');
    if (selectedCurriculums.length > 0 && (!c || !selectedCurriculums.includes(c))) return false;
    if (selectedUnits.length > 0 && (!u || !selectedUnits.includes(u))) return false;
    return true;
  });
}

@Injectable()
export class CourseSettingsService {
  constructor(
    @InjectRepository(CourseSettingsEntity)
    private readonly repo: Repository<CourseSettingsEntity>,
    private readonly canvas: CanvasService,
    private readonly sproutVideo: SproutVideoService,
    private readonly config: ConfigService,
  ) {}

  async get(
    courseId: string,
    options?: { isTeacher?: boolean; canvasDomain?: string },
  ): Promise<{
    selectedCurriculums: string[];
    selectedUnits: string[];
    filteredPlaylists?: Array<{ id: string; title: string; items?: Array<{ title: string; embed: string }> }>;
    progressAssignmentId: string | null;
    hasCanvasToken: boolean;
    needsUpdate?: boolean;
  } | null> {
    const row = await this.repo.findOne({ where: { courseId } });
    if (!row) return null;

    const hasCanvasToken = !!(row.canvasApiToken?.trim?.());
    const tokenOverride = row.canvasApiToken ?? this.config.get<string>('CANVAS_API_TOKEN') ?? null;
    const domainOverride = options?.canvasDomain ?? this.config.get<string>('CANVAS_DOMAIN');

    if (!row.progressAssignmentId) {
      return {
        selectedCurriculums: Array.isArray(row.selectedCurriculums) ? row.selectedCurriculums : [],
        selectedUnits: Array.isArray(row.selectedUnits) ? row.selectedUnits : [],
        progressAssignmentId: null,
        hasCanvasToken,
      };
    }

    try {
      const assignment = await this.canvas.getAssignment(
        courseId,
        row.progressAssignmentId,
        domainOverride,
        tokenOverride,
      );
      if (!assignment?.description?.trim()) {
        return {
          selectedCurriculums: Array.isArray(row.selectedCurriculums) ? row.selectedCurriculums : [],
          selectedUnits: Array.isArray(row.selectedUnits) ? row.selectedUnits : [],
          progressAssignmentId: row.progressAssignmentId,
          hasCanvasToken,
        };
      }

      const parsed = JSON.parse(assignment.description) as AssignmentDescriptionData;
      if (!parsed || typeof parsed !== 'object') {
        return {
          selectedCurriculums: Array.isArray(row.selectedCurriculums) ? row.selectedCurriculums : [],
          selectedUnits: Array.isArray(row.selectedUnits) ? row.selectedUnits : [],
          progressAssignmentId: row.progressAssignmentId,
          hasCanvasToken,
        };
      }

      const selectedCurriculums = Array.isArray(parsed.selectedCurriculums) ? parsed.selectedCurriculums : [];
      const selectedUnits = Array.isArray(parsed.selectedUnits) ? parsed.selectedUnits : [];
      const filteredPlaylists = Array.isArray(parsed.filteredPlaylists) ? parsed.filteredPlaylists : [];

      let needsUpdate: boolean | undefined;
      if (options?.isTeacher) {
        needsUpdate = await this.checkNeedsUpdate(courseId, parsed.playlistUpdatedAt ?? {});
      }

      return {
        selectedCurriculums,
        selectedUnits,
        filteredPlaylists,
        progressAssignmentId: row.progressAssignmentId,
        hasCanvasToken,
        needsUpdate,
      };
    } catch {
      return {
        selectedCurriculums: Array.isArray(row.selectedCurriculums) ? row.selectedCurriculums : [],
        selectedUnits: Array.isArray(row.selectedUnits) ? row.selectedUnits : [],
        progressAssignmentId: row.progressAssignmentId,
        hasCanvasToken,
      };
    }
  }

  async checkNeedsUpdate(
    _courseId: string,
    cachedPlaylistUpdatedAt: Record<string, string>,
  ): Promise<boolean> {
    const playlistIds = new Set(Object.keys(cachedPlaylistUpdatedAt));
    if (playlistIds.size === 0) return false;

    const playlists = await this.sproutVideo.fetchAllPlaylists();
    for (const p of playlists) {
      if (!playlistIds.has(p.id)) continue;
      const updatedAt = p.updated_at;
      if (!updatedAt) continue;
      const cached = cachedPlaylistUpdatedAt[p.id];
      if (cached && new Date(updatedAt).getTime() > new Date(cached).getTime()) return true;
    }
    return false;
  }

  async save(
    courseId: string,
    selectedCurriculums: string[],
    selectedUnits: string[],
    canvasDomain?: string,
    canvasApiToken?: string,
  ): Promise<void> {
    const row = await this.repo.findOne({ where: { courseId } });
    const effectiveToken =
      canvasApiToken !== undefined
        ? (canvasApiToken?.trim() || null)
        : (row?.canvasApiToken ?? this.config.get<string>('CANVAS_API_TOKEN') ?? null);
    const progressAssignmentId = await this.canvas.ensureFlashcardProgressAssignment(
      courseId,
      canvasDomain,
      effectiveToken,
    );
    const tokenToSave =
      canvasApiToken !== undefined
        ? (canvasApiToken?.trim() || null)
        : (row?.canvasApiToken ?? null);

    const allPlaylists = await this.sproutVideo.fetchAllPlaylists();
    const filtered = filterPlaylistsByCurriculumUnits(allPlaylists, selectedCurriculums, selectedUnits);

    const filteredPlaylists: Array<{
      id: string;
      title: string;
      items: Array<{ title: string; embed: string }>;
    }> = [];
    const playlistUpdatedAt: Record<string, string> = {};

    for (const p of filtered) {
      if (this.sproutVideo.isBlacklisted(String(p.title ?? ''))) continue;
      const items = (await this.sproutVideo.getPlaylistItems('', p.id)) as SproutVideoItem[];
      filteredPlaylists.push({
        id: p.id,
        title: String(p.title ?? ''),
        items: items.map((it) => ({
          title: String(it.title ?? 'Vocabulary Item'),
          embed: String(it.embed ?? ''),
        })),
      });
      if (p.updated_at) playlistUpdatedAt[p.id] = p.updated_at;
    }

    const payload: AssignmentDescriptionData = {
      v: 1,
      selectedCurriculums: selectedCurriculums ?? [],
      selectedUnits: selectedUnits ?? [],
      filteredPlaylists,
      updatedAt: new Date().toISOString(),
      playlistUpdatedAt,
    };

    const description = JSON.stringify(payload);
    await this.canvas.updateAssignmentDescription(
      courseId,
      progressAssignmentId,
      description,
      canvasDomain,
      effectiveToken,
    );

    await this.repo.upsert(
      {
        courseId,
        selectedCurriculums: selectedCurriculums ?? [],
        selectedUnits: selectedUnits ?? [],
        progressAssignmentId,
        canvasApiToken: tokenToSave,
      },
      { conflictPaths: ['courseId'] },
    );
  }

  async getProgressAssignmentId(
    courseId: string,
    canvasDomain?: string,
  ): Promise<string> {
    const row = await this.repo.findOne({ where: { courseId } });
    if (row?.progressAssignmentId) return row.progressAssignmentId;
    const token = row?.canvasApiToken ?? this.config.get<string>('CANVAS_API_TOKEN') ?? null;
    const id = await this.canvas.ensureFlashcardProgressAssignment(
      courseId,
      canvasDomain,
      token,
    );
    await this.repo.upsert(
      {
        courseId,
        selectedCurriculums: row?.selectedCurriculums ?? [],
        selectedUnits: row?.selectedUnits ?? [],
        progressAssignmentId: id,
      },
      { conflictPaths: ['courseId'] },
    );
    return id;
  }
}
