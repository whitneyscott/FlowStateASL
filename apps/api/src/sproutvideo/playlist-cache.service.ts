import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { SproutVideoService } from './sproutvideo.service';
import { SproutPlaylistEntity } from './entities/sprout-playlist.entity';
import { SproutPlaylistVideoEntity } from './entities/sprout-playlist-video.entity';
import type { SproutPlaylistListItem } from './interfaces/sprout-playlist.interface';
import type { SproutVideoItem } from './interfaces/sprout-video-item.interface';

@Injectable()
export class PlaylistCacheService {
  constructor(
    private readonly sproutVideo: SproutVideoService,
    @InjectRepository(SproutPlaylistEntity)
    private readonly playlistRepo: Repository<SproutPlaylistEntity>,
    @InjectRepository(SproutPlaylistVideoEntity)
    private readonly videoRepo: Repository<SproutPlaylistVideoEntity>,
  ) {}

  async getPlaylistItems(playlistId: string): Promise<SproutVideoItem[] | null> {
    const videos = await this.videoRepo.find({
      where: { playlistId },
      order: { position: 'ASC' },
    });
    if (videos.length === 0) {
      return null;
    }
    return videos.map((v) => ({
      id: v.videoId,
      title: v.title,
      embed: v.embedCode ?? undefined,
    }));
  }

  async getAllPlaylists(): Promise<Array<{ id: string; title: string; sproutUpdatedAt: Date | null }>> {
    const rows = await this.playlistRepo.find({
      select: ['id', 'deckTitle', 'sproutUpdatedAt'],
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.deckTitle,
      sproutUpdatedAt: r.sproutUpdatedAt,
    }));
  }

  /** Returns playlists with video IDs, matching SproutPlaylist shape for CourseSettingsService.save */
  async getAllPlaylistsWithVideos(): Promise<
    Array<{ id: string; title: string; videos: string[]; updated_at?: string }>
  > {
    const rows = await this.playlistRepo.find({
      select: ['id', 'deckTitle', 'sproutUpdatedAt'],
    });
    const videoRows = await this.videoRepo.find({
      select: ['playlistId', 'videoId', 'position'],
      order: { playlistId: 'ASC', position: 'ASC' },
    });
    const videosByPlaylist = new Map<string, string[]>();
    for (const v of videoRows) {
      const arr = videosByPlaylist.get(v.playlistId) ?? [];
      arr.push(v.videoId);
      videosByPlaylist.set(v.playlistId, arr);
    }
    return rows.map((r) => ({
      id: r.id,
      title: r.deckTitle,
      videos: videosByPlaylist.get(r.id) ?? [],
      updated_at: r.sproutUpdatedAt?.toISOString(),
    }));
  }

  async getPlaylistsForFilter(searchTerms: string[]): Promise<SproutPlaylistListItem[]> {
    const normalized = searchTerms
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean);
    if (normalized.length === 0) return [];

    const conditions: string[] = [];
    const params: string[] = [];
    for (let i = 0; i < normalized.length; i++) {
      conditions.push(`LOWER(deck_title) LIKE $${i + 1}`);
      params.push(`${normalized[i]}%`);
    }

    const rows = await this.playlistRepo.query(
      `SELECT id, deck_title AS title FROM sprout_playlists WHERE (${conditions.join(' OR ')}) ORDER BY deck_title ASC`,
      params,
    ) as Array<{ id: string; title: string }>;

    return rows
      .map((r) => ({ id: String(r.id), title: String(r.title) }))
      .filter((p) => !this.sproutVideo.isBlacklisted(p.title));
  }

  async getPlaylistCount(): Promise<number> {
    try {
      return await this.playlistRepo.count();
    } catch (err) {
      console.error('[PlaylistCache] getPlaylistCount failed:', err);
      return 0;
    }
  }

  async getDistinctCurricula(): Promise<string[]> {
    try {
      const rows = await this.playlistRepo.query(`
        SELECT DISTINCT curriculum FROM sprout_playlists WHERE curriculum <> '' AND curriculum IS NOT NULL ORDER BY curriculum ASC
      `) as Array<{ curriculum: string }>;
      return rows.map((r) => String(r.curriculum)).filter(Boolean);
    } catch (err) {
      try {
        const rows = await this.playlistRepo.query(`
          SELECT DISTINCT TRIM(SPLIT_PART(title, '.', 1)) AS curriculum FROM sprout_playlists
          WHERE title IS NOT NULL AND TRIM(SPLIT_PART(title, '.', 1)) <> ''
          ORDER BY 1 ASC
        `) as Array<{ curriculum: string }>;
        return rows.map((r) => String(r.curriculum)).filter(Boolean);
      } catch (fallbackErr) {
        console.error('[PlaylistCache] getDistinctCurricula failed:', err, fallbackErr);
        return [];
      }
    }
  }

  async getDistinctUnits(curricula: string[]): Promise<string[]> {
    try {
      const normalized = curricula.map((c) => c.trim()).filter(Boolean);
      if (normalized.length === 0) {
        const rows = await this.playlistRepo.query(`
          SELECT DISTINCT unit FROM sprout_playlists WHERE unit <> '' AND unit IS NOT NULL ORDER BY unit ASC
        `) as Array<{ unit: string }>;
        return rows.map((r) => String(r.unit)).filter(Boolean);
      }

      const rows = await this.playlistRepo.query(
        `SELECT DISTINCT unit FROM sprout_playlists WHERE unit <> '' AND curriculum = ANY($1) ORDER BY unit ASC`,
        [normalized],
      ) as Array<{ unit: string }>;
      return rows.map((r) => String(r.unit)).filter(Boolean);
    } catch (err) {
      try {
        const normalized = curricula.map((c) => c.trim()).filter(Boolean);
        if (normalized.length === 0) {
          const rows = await this.playlistRepo.query(`
            SELECT DISTINCT TRIM(SPLIT_PART(title, '.', 2)) AS unit FROM sprout_playlists
            WHERE title IS NOT NULL AND TRIM(SPLIT_PART(title, '.', 2)) <> ''
            ORDER BY 1 ASC
          `) as Array<{ unit: string }>;
          return rows.map((r) => String(r.unit)).filter(Boolean);
        }
        const rows = await this.playlistRepo.query(
          `SELECT DISTINCT TRIM(SPLIT_PART(title, '.', 2)) AS unit FROM sprout_playlists
          WHERE TRIM(SPLIT_PART(title, '.', 1)) = ANY($1) AND TRIM(SPLIT_PART(title, '.', 2)) <> ''
          ORDER BY 1 ASC`,
          [normalized],
        ) as Array<{ unit: string }>;
        return rows.map((r) => String(r.unit)).filter(Boolean);
      } catch (fallbackErr) {
        console.error('[PlaylistCache] getDistinctUnits failed:', err, fallbackErr);
        return [];
      }
    }
  }

  async getPlaylistsByCurriculaAndUnits(
    curricula: string[],
    units: string[],
  ): Promise<Array<{ id: string; title: string }>> {
    try {
      const normalizedCurricula = curricula.map((c) => c.trim()).filter(Boolean);
      const normalizedUnits = units.map((u) => u.trim()).filter(Boolean);

      if (normalizedCurricula.length === 0 && normalizedUnits.length === 0) {
        try {
          const rows = await this.playlistRepo.find({
            select: ['id', 'deckTitle'],
            order: { deckTitle: 'ASC' },
          });
          return rows.map((r) => ({ id: r.id, title: r.deckTitle }));
        } catch {
          const rows = await this.playlistRepo.query(
            `SELECT id, title FROM sprout_playlists ORDER BY title ASC`,
          ) as Array<{ id: string; title: string }>;
          return rows.map((r) => ({ id: String(r.id), title: String(r.title) }));
        }
      }

      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (normalizedCurricula.length > 0) {
        conditions.push(`curriculum = ANY($${paramIndex})`);
        params.push(normalizedCurricula);
        paramIndex++;
      }
      if (normalizedUnits.length > 0) {
        conditions.push(`unit = ANY($${paramIndex})`);
        params.push(normalizedUnits);
        paramIndex++;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = await this.playlistRepo.query(
        `SELECT id, deck_title AS title FROM sprout_playlists ${where} ORDER BY deck_title ASC`,
        params,
      ) as Array<{ id: string; title: string }>;

      return rows.map((r) => ({ id: String(r.id), title: String(r.title) }));
    } catch (err) {
      try {
        const normalizedCurricula = curricula.map((c) => c.trim()).filter(Boolean);
        const normalizedUnits = units.map((u) => u.trim()).filter(Boolean);
        if (normalizedCurricula.length === 0 && normalizedUnits.length === 0) {
          const rows = await this.playlistRepo.query(
            `SELECT id, title FROM sprout_playlists ORDER BY title ASC`,
          ) as Array<{ id: string; title: string }>;
          return rows.map((r) => ({ id: String(r.id), title: String(r.title) }));
        }
        const conds: string[] = [];
        const prms: unknown[] = [];
        let idx = 1;
        if (normalizedCurricula.length > 0) {
          conds.push(`TRIM(SPLIT_PART(title, '.', 1)) = ANY($${idx})`);
          prms.push(normalizedCurricula);
          idx++;
        }
        if (normalizedUnits.length > 0) {
          conds.push(`TRIM(SPLIT_PART(title, '.', 2)) = ANY($${idx})`);
          prms.push(normalizedUnits);
          idx++;
        }
        const where = `WHERE ${conds.join(' AND ')}`;
        const rows = await this.playlistRepo.query(
          `SELECT id, COALESCE(NULLIF(TRIM(array_to_string((string_to_array(title, '.'))[4:], '.')), ''), title) AS title FROM sprout_playlists ${where} ORDER BY title ASC`,
          prms,
        ) as Array<{ id: string; title: string }>;
        return rows.map((r) => ({ id: String(r.id), title: String(r.title) }));
      } catch (fallbackErr) {
        console.error('[PlaylistCache] getPlaylistsByCurriculaAndUnits failed:', err, fallbackErr);
        return [];
      }
    }
  }

  async getDistinctUnitsByConstraints(
    curricula: string[],
    allowedUnits: string[],
  ): Promise<string[]> {
    const normalizedCurricula = curricula.map((c) => c.trim()).filter(Boolean);
    const normalizedAllowedUnits = allowedUnits.map((u) => u.trim()).filter(Boolean);
    const conditions: string[] = ["unit <> ''"];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (normalizedCurricula.length > 0) {
      conditions.push(`curriculum = ANY($${paramIndex})`);
      params.push(normalizedCurricula);
      paramIndex++;
    }
    if (normalizedAllowedUnits.length > 0) {
      conditions.push(`unit = ANY($${paramIndex})`);
      params.push(normalizedAllowedUnits);
      paramIndex++;
    }

    const rows = await this.playlistRepo.query(
      `SELECT DISTINCT unit FROM sprout_playlists WHERE ${conditions.join(' AND ')} ORDER BY unit ASC`,
      params,
    ) as Array<{ unit: string }>;
    return rows.map((r) => String(r.unit)).filter(Boolean);
  }

  async getDistinctSectionsByConstraints(
    curricula: string[],
    unit: string,
    allowedUnits: string[],
  ): Promise<string[]> {
    const normalizedCurricula = curricula.map((c) => c.trim()).filter(Boolean);
    const normalizedAllowedUnits = allowedUnits.map((u) => u.trim()).filter(Boolean);
    const normalizedUnit = unit.trim();
    if (!normalizedUnit) return [];

    const conditions: string[] = ["section <> ''", "unit = $1"];
    const params: unknown[] = [normalizedUnit];
    let paramIndex = 2;

    if (normalizedCurricula.length > 0) {
      conditions.push(`curriculum = ANY($${paramIndex})`);
      params.push(normalizedCurricula);
      paramIndex++;
    }
    if (normalizedAllowedUnits.length > 0) {
      conditions.push(`unit = ANY($${paramIndex})`);
      params.push(normalizedAllowedUnits);
      paramIndex++;
    }

    const rows = await this.playlistRepo.query(
      `SELECT DISTINCT section FROM sprout_playlists WHERE ${conditions.join(' AND ')} ORDER BY section ASC`,
      params,
    ) as Array<{ section: string }>;
    return rows.map((r) => String(r.section)).filter(Boolean);
  }

  async getPlaylistsByHierarchy(
    curricula: string[],
    unit: string,
    section: string,
    allowedUnits: string[],
  ): Promise<Array<{ id: string; title: string }>> {
    const normalizedCurricula = curricula.map((c) => c.trim()).filter(Boolean);
    const normalizedAllowedUnits = allowedUnits.map((u) => u.trim()).filter(Boolean);
    const normalizedUnit = unit.trim();
    const normalizedSection = section.trim();

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (normalizedCurricula.length > 0) {
      conditions.push(`curriculum = ANY($${paramIndex})`);
      params.push(normalizedCurricula);
      paramIndex++;
    }
    if (normalizedAllowedUnits.length > 0) {
      conditions.push(`unit = ANY($${paramIndex})`);
      params.push(normalizedAllowedUnits);
      paramIndex++;
    }
    if (normalizedUnit) {
      conditions.push(`unit = $${paramIndex}`);
      params.push(normalizedUnit);
      paramIndex++;
    }
    if (normalizedSection) {
      conditions.push(`section = $${paramIndex}`);
      params.push(normalizedSection);
      paramIndex++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await this.playlistRepo.query(
      `SELECT id, deck_title AS title FROM sprout_playlists ${where} ORDER BY deck_title ASC`,
      params,
    ) as Array<{ id: string; title: string }>;
    return rows.map((r) => ({ id: String(r.id), title: String(r.title) }));
  }

  async checkNeedsUpdate(cachedPlaylistUpdatedAt: Record<string, string>): Promise<boolean> {
    const playlistIds = Object.keys(cachedPlaylistUpdatedAt);
    if (playlistIds.length === 0) return false;

    const rows = await this.playlistRepo.find({
      where: { id: In(playlistIds) },
      select: ['id', 'sproutUpdatedAt'],
    });
    for (const r of rows) {
      const cached = cachedPlaylistUpdatedAt[r.id];
      if (!cached || !r.sproutUpdatedAt) continue;
      if (r.sproutUpdatedAt.getTime() > new Date(cached).getTime()) return true;
    }
    return false;
  }
}
