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
      title: v.title,
      embed: v.embedCode ?? undefined,
    }));
  }

  async getAllPlaylists(): Promise<Array<{ id: string; title: string; sproutUpdatedAt: Date | null }>> {
    const rows = await this.playlistRepo.find({
      select: ['id', 'title', 'sproutUpdatedAt'],
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      sproutUpdatedAt: r.sproutUpdatedAt,
    }));
  }

  /** Returns playlists with video IDs, matching SproutPlaylist shape for CourseSettingsService.save */
  async getAllPlaylistsWithVideos(): Promise<
    Array<{ id: string; title: string; videos: string[]; updated_at?: string }>
  > {
    const rows = await this.playlistRepo.find({
      select: ['id', 'title', 'sproutUpdatedAt'],
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
      title: r.title,
      videos: videosByPlaylist.get(r.id) ?? [],
      updated_at: r.sproutUpdatedAt?.toISOString(),
    }));
  }

  async getPlaylistsForFilter(searchTerms: string[]): Promise<SproutPlaylistListItem[]> {
    const all = await this.getAllPlaylists();
    const result: SproutPlaylistListItem[] = [];
    for (const p of all) {
      const title = String(p.title ?? '');
      if (this.sproutVideo.isBlacklisted(title)) continue;
      for (const term of searchTerms) {
        if (title.toLowerCase().startsWith(term.toLowerCase())) {
          result.push({ title, id: p.id });
          break;
        }
      }
    }
    return result;
  }

  async getPlaylistCount(): Promise<number> {
    return this.playlistRepo.count();
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
