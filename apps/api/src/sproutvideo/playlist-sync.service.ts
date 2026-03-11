import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { SproutVideoService } from './sproutvideo.service';
import { SproutPlaylistEntity } from './entities/sprout-playlist.entity';
import { SproutPlaylistVideoEntity } from './entities/sprout-playlist-video.entity';
import { SyncMetadataEntity } from './entities/sync-metadata.entity';

/**
 * SproutVideo playlist sync service. Rate limiting env vars:
 * - SPROUTVIDEO_VIDEO_FETCH_DELAY_MS: delay used by list_videos pagination/retries (default 300)
 * - SPROUTVIDEO_PLAYLIST_DELAY_MS: delay between playlists (default 500)
 */
const SYNC_METADATA_KEY_LAST_SYNC = 'last_sync_at';

/** Default delay between playlists. Use SPROUTVIDEO_PLAYLIST_DELAY_MS env to override. */
const DEFAULT_PLAYLIST_DELAY_MS = 500;

/**
 * Parse dot-delimited title e.g. "TWA.01.01.Example Playlist Title"
 * Part 1 → curriculum, Part 2 → unit, Part 3 → section, Last segment → deck_title.
 * Returns null if fewer than 4 segments (log warning and skip).
 */
function parsePlaylistTitle(title: string): { curriculum: string; unit: string; section: string; deckTitle: string } | null {
  const parts = String(title ?? '').split('.').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 4) {
    console.warn(`[PlaylistSync] Skipping playlist title with <4 segments: "${title}"`);
    return null;
  }
  const curriculum = parts[0];
  const unit = parts[1];
  const section = parts[2];
  const deckTitle = parts.slice(3).join('.');
  return { curriculum, unit, section, deckTitle };
}

@Injectable()
export class PlaylistSyncService {
  constructor(
    private readonly sproutVideo: SproutVideoService,
    private readonly config: ConfigService,
    @InjectRepository(SproutPlaylistEntity)
    private readonly playlistRepo: Repository<SproutPlaylistEntity>,
    @InjectRepository(SproutPlaylistVideoEntity)
    private readonly videoRepo: Repository<SproutPlaylistVideoEntity>,
    @InjectRepository(SyncMetadataEntity)
    private readonly syncMetaRepo: Repository<SyncMetadataEntity>,
  ) {}

  private getPlaylistDelay(): number {
    const v = this.config.get<string>('SPROUTVIDEO_PLAYLIST_DELAY_MS');
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PLAYLIST_DELAY_MS;
  }

  private async delay(ms: number): Promise<void> {
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  }

  async sync(): Promise<{ playlists: number; videos: number; incremental: boolean }> {
    if (!this.config.get('SPROUT_KEY')) {
      throw new Error('SproutVideo not configured: SPROUT_KEY required');
    }

    let lastSyncAt: Date | null = null;
    const meta = await this.syncMetaRepo.findOne({ where: { key: SYNC_METADATA_KEY_LAST_SYNC } });
    if (meta?.value) {
      lastSyncAt = new Date(meta.value);
    }
    const incremental = lastSyncAt !== null;

    const playlists = await this.sproutVideo.fetchPlaylistsUpdatedSince(lastSyncAt);
    const syncedAt = new Date();

    const playlistDelay = this.getPlaylistDelay();

    let totalVideos = 0;
    let playlistIndex = 0;

    for (const p of playlists) {
      if (playlistIndex > 0) await this.delay(playlistDelay);

      const title = String(p.title ?? '');
      const parsed = parsePlaylistTitle(title);
      if (!parsed) continue;

      const sproutUpdatedAt = p.updated_at ? new Date(p.updated_at) : null;
      await this.playlistRepo.upsert(
        {
          id: p.id,
          title,
          curriculum: parsed.curriculum,
          unit: parsed.unit,
          section: parsed.section,
          deckTitle: parsed.deckTitle,
          sproutUpdatedAt,
          syncedAt,
        },
        { conflictPaths: ['id'] },
      );

      const videoRows = await this.sproutVideo.fetchVideosByPlaylistId(p.id);
      const videoIds = videoRows.map((v) => String(v.id));

      const existing = await this.videoRepo.find({
        where: { playlistId: p.id },
        select: ['videoId'],
      });
      const existingIds = new Set(existing.map((e) => e.videoId));
      const currentIds = new Set(videoIds.map(String));

      const toDelete = [...existingIds].filter((id) => !currentIds.has(id));
      if (toDelete.length > 0) {
        await this.videoRepo.delete({
          playlistId: p.id,
          videoId: In(toDelete),
        });
      }

      for (let i = 0; i < videoIds.length; i++) {
        const vid = String(videoIds[i]);
        const row = videoRows[i];
        const title = String(row?.title ?? 'Vocabulary Item');
        const embed = String(row?.embed_code ?? '');
        await this.videoRepo.upsert(
          {
            playlistId: p.id,
            videoId: vid,
            position: i,
            title,
            embedCode: embed || null,
          },
          { conflictPaths: ['playlistId', 'videoId'] },
        );
        totalVideos++;
      }
      playlistIndex++;
    }

    await this.syncMetaRepo.upsert(
      { key: SYNC_METADATA_KEY_LAST_SYNC, value: syncedAt.toISOString() },
      { conflictPaths: ['key'] },
    );

    return { playlists: playlists.length, videos: totalVideos, incremental };
  }
}
