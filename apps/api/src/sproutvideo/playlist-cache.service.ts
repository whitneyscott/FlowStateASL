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

  /** Appends curriculum NOT IN blacklist (exact match); returns next param index. */
  private appendBlacklistNotCondition(
    conditions: string[],
    params: unknown[],
    paramIndex: number,
  ): number {
    const blacklist = this.sproutVideo.getBlacklistForSql();
    if (blacklist.length === 0) return paramIndex;
    conditions.push(`curriculum != ALL($${paramIndex}::text[])`);
    params.push(blacklist);
    return paramIndex + 1;
  }

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
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;
    paramIndex = this.appendBlacklistNotCondition(conditions, params, paramIndex);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await this.playlistRepo.query(
      `SELECT id, deck_title AS title, sprout_updated_at AS "sproutUpdatedAt" FROM sprout_playlists ${where} ORDER BY deck_title ASC`,
      params,
    ) as Array<{ id: string; title: string; sproutUpdatedAt: Date | null }>;
    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
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

    const likeConditions: string[] = [];
    const params: string[] = [];
    for (let i = 0; i < normalized.length; i++) {
      likeConditions.push(`LOWER(deck_title) LIKE $${i + 1}`);
      params.push(`${normalized[i]}%`);
    }
    const conditions: string[] = [`(${likeConditions.join(' OR ')})`];
    this.appendBlacklistNotCondition(conditions, params, params.length + 1);
    const where = `WHERE ${conditions.join(' AND ')}`;
    const rows = await this.playlistRepo.query(
      `SELECT id, deck_title AS title FROM sprout_playlists ${where} ORDER BY deck_title ASC`,
      params,
    ) as Array<{ id: string; title: string }>;

    return rows.map((r) => ({ id: String(r.id), title: String(r.title) }));
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
    const conditions: string[] = ["curriculum <> ''", 'curriculum IS NOT NULL'];
    const params: unknown[] = [];
    let paramIndex = 1;
    paramIndex = this.appendBlacklistNotCondition(conditions, params, paramIndex);
    const where = `WHERE ${conditions.join(' AND ')}`;
    const rows = await this.playlistRepo.query(
      `SELECT DISTINCT curriculum FROM sprout_playlists ${where} ORDER BY curriculum ASC`,
      params,
    ) as Array<{ curriculum: string }>;
    return rows.map((r) => String(r.curriculum)).filter(Boolean);
  }

  async getDistinctUnits(curricula: string[]): Promise<string[]> {
    const normalized = curricula.map((c) => c.trim()).filter(Boolean);
    const conditions: string[] = ["unit <> ''", 'unit IS NOT NULL'];
    const params: unknown[] = [];
    let paramIndex = 1;
    if (normalized.length > 0) {
      conditions.push(`curriculum = ANY($${paramIndex})`);
      params.push(normalized);
      paramIndex++;
    }
    paramIndex = this.appendBlacklistNotCondition(conditions, params, paramIndex);
    const where = `WHERE ${conditions.join(' AND ')}`;
    const rows = await this.playlistRepo.query(
      `SELECT DISTINCT unit FROM sprout_playlists ${where} ORDER BY unit ASC`,
      params,
    ) as Array<{ unit: string }>;
    return rows.map((r) => String(r.unit)).filter(Boolean);
  }

  async getPlaylistsByCurriculaAndUnits(
    curricula: string[],
    units: string[],
  ): Promise<Array<{ id: string; title: string }>> {
    const normalizedCurricula = curricula.map((c) => c.trim()).filter(Boolean);
    const normalizedUnits = units.map((u) => u.trim()).filter(Boolean);
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
    paramIndex = this.appendBlacklistNotCondition(conditions, params, paramIndex);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await this.playlistRepo.query(
      `SELECT id, deck_title AS title FROM sprout_playlists ${where} ORDER BY deck_title ASC`,
      params,
    ) as Array<{ id: string; title: string }>;
    return rows.map((r) => ({ id: String(r.id), title: String(r.title) }));
  }

  /** Same filtering as getPlaylistsByCurriculaAndUnits but returns curriculum, unit, section for frontend filtering. */
  async getPlaylistsByCurriculaAndUnitsWithHierarchy(
    curricula: string[],
    units: string[],
  ): Promise<Array<{ id: string; title: string; curriculum: string; unit: string; section: string }>> {
    const normalizedCurricula = curricula.map((c) => c.trim()).filter(Boolean);
    const normalizedUnits = units.map((u) => u.trim()).filter(Boolean);
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
    paramIndex = this.appendBlacklistNotCondition(conditions, params, paramIndex);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await this.playlistRepo.query(
      `SELECT id, deck_title AS title, curriculum, unit, section FROM sprout_playlists ${where} ORDER BY deck_title ASC`,
      params,
    ) as Array<{ id: string; title: string; curriculum: string; unit: string; section: string }>;
    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      curriculum: String(r.curriculum ?? ''),
      unit: String(r.unit ?? ''),
      section: String(r.section ?? ''),
    }));
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
    paramIndex = this.appendBlacklistNotCondition(conditions, params, paramIndex);
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
    paramIndex = this.appendBlacklistNotCondition(conditions, params, paramIndex);
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
    paramIndex = this.appendBlacklistNotCondition(conditions, params, paramIndex);
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
