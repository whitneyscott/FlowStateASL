import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { SproutVideoService } from './sproutvideo.service';
import { SproutPlaylistEntity } from './entities/sprout-playlist.entity';
import { SproutPlaylistVideoEntity } from './entities/sprout-playlist-video.entity';
import { SyncMetadataEntity } from './entities/sync-metadata.entity';
import type { SproutPlaylist } from './interfaces/sprout-playlist.interface';

/**
 * SproutVideo playlist sync service. Rate limiting env vars:
 * - SPROUTVIDEO_VIDEO_FETCH_DELAY_MS: delay between video fetches (default 300)
 * - SPROUTVIDEO_PLAYLIST_DELAY_MS: delay between playlists (default 500)
 * - SPROUTVIDEO_429_THRESHOLD: 429 count threshold to auto-increase delay (default 5)
 * - SPROUTVIDEO_429_WINDOW_MS: time window for 429 threshold in ms (default 60000)
 */
const SYNC_METADATA_KEY_LAST_SYNC = 'last_sync_at';

/** Default delay between video fetches. */
const DEFAULT_VIDEO_FETCH_DELAY_MS = 300;
/** Default delay between playlists. Use SPROUTVIDEO_PLAYLIST_DELAY_MS env to override. */
const DEFAULT_PLAYLIST_DELAY_MS = 500;
/** 429 count threshold: if exceeded in time window, increase delay for remainder of run. */
const DEFAULT_429_THRESHOLD = 5;
/** Time window (ms) for 429 threshold. Use SPROUTVIDEO_429_WINDOW_MS env to override. */
const DEFAULT_429_WINDOW_MS = 60_000;
/** Multiplier applied to base delay when 429 threshold exceeded. */
const DELAY_BOOST_MULTIPLIER = 2;

@Injectable()
export class PlaylistSyncService {
  private readonly logger = new Logger(PlaylistSyncService.name);

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

  private getVideoFetchDelay(): number {
    const v = this.config.get<string>('SPROUTVIDEO_VIDEO_FETCH_DELAY_MS');
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_VIDEO_FETCH_DELAY_MS;
  }

  private getPlaylistDelay(): number {
    const v = this.config.get<string>('SPROUTVIDEO_PLAYLIST_DELAY_MS');
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PLAYLIST_DELAY_MS;
  }

  private get429Threshold(): number {
    const v = this.config.get<string>('SPROUTVIDEO_429_THRESHOLD');
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n >= 1 ? n : DEFAULT_429_THRESHOLD;
  }

  private get429WindowMs(): number {
    const v = this.config.get<string>('SPROUTVIDEO_429_WINDOW_MS');
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_429_WINDOW_MS;
  }

  /**
   * Parse Retry-After header: seconds (integer) or HTTP-date. Returns ms to wait, or null.
   */
  private parseRetryAfter(header: string | null): number | null {
    if (!header?.trim()) return null;
    const s = header.trim();
    const seconds = parseInt(s, 10);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    const date = new Date(s);
    if (!Number.isNaN(date.getTime())) {
      const ms = date.getTime() - Date.now();
      return ms > 0 ? ms : 1000;
    }
    return null;
  }

  private async delay(ms: number): Promise<void> {
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  }

  async sync(): Promise<{ playlists: number; videos: number; incremental: boolean }> {
    const apiKey = this.config.get('SPROUT_KEY');
    if (!apiKey) {
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

    let baseDelay = this.getVideoFetchDelay();
    const playlistDelay = this.getPlaylistDelay();
    const threshold429 = this.get429Threshold();
    const window429Ms = this.get429WindowMs();
    const timestamps429: number[] = [];
    let total429 = 0;

    const record429 = (): void => {
      total429++;
      timestamps429.push(Date.now());
      const cutoff = Date.now() - window429Ms;
      while (timestamps429.length > 0 && timestamps429[0] < cutoff) timestamps429.shift();
    };

    const current429InWindow = (): number => {
      const cutoff = Date.now() - window429Ms;
      return timestamps429.filter((t) => t >= cutoff).length;
    };

    const fetchVideoWithRetry = async (
      vid: string,
    ): Promise<{ title: string; embed: string }> => {
      const maxRetries = 5;
      let backoff = baseDelay;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let vRes: Response;
        try {
          vRes = await fetch(
            `https://api.sproutvideo.com/v1/videos/${vid}`,
            { headers: { 'SproutVideo-Api-Key': apiKey } },
          );
        } catch (err) {
          if (attempt === maxRetries) throw err;
          await this.delay(backoff);
          backoff *= 2;
          continue;
        }

        if (vRes.ok) {
          const vData = (await vRes.json()) as { title?: string; embed_code?: string };
          return {
            title: String(vData.title ?? 'Vocabulary Item'),
            embed: String(vData.embed_code ?? ''),
          };
        }

        const is429 = vRes.status === 429;
        const isRetryable = is429 || (vRes.status >= 500 && vRes.status < 600);

        if (is429) {
          record429();
          const count = current429InWindow();
          if (count >= threshold429 && baseDelay < 2000) {
            baseDelay = Math.min(baseDelay * DELAY_BOOST_MULTIPLIER, 2000);
            this.logger.warn(
              `429 threshold (${threshold429}) exceeded in window; increasing delay to ${baseDelay}ms`,
            );
          }
        }

        if (!isRetryable || attempt === maxRetries) {
          return { title: 'Vocabulary Item', embed: '' };
        }

        let waitMs = backoff;
        if (is429) {
          const retryAfter = this.parseRetryAfter(vRes.headers.get('Retry-After'));
          if (retryAfter !== null) waitMs = retryAfter;
        }
        await this.delay(waitMs);
        backoff *= 2;
      }
      return { title: 'Vocabulary Item', embed: '' };
    };

    let totalVideos = 0;
    let playlistIndex = 0;

    for (const p of playlists) {
      if (playlistIndex > 0) await this.delay(playlistDelay);

      const sproutUpdatedAt = p.updated_at ? new Date(p.updated_at) : null;
      await this.playlistRepo.upsert(
        {
          id: p.id,
          title: String(p.title ?? ''),
          sproutUpdatedAt,
          syncedAt,
        },
        { conflictPaths: ['id'] },
      );

      const videoIds = Array.isArray(p.videos) ? p.videos : [];
      const items: Array<{ title: string; embed: string }> = [];
      for (let i = 0; i < videoIds.length; i++) {
        if (i > 0) await this.delay(baseDelay);
        const vid = String(videoIds[i]);
        const item = await fetchVideoWithRetry(vid);
        items.push(item);
      }

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
        const { title, embed } = items[i] ?? { title: 'Vocabulary Item', embed: '' };
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

    if (total429 > 0) {
      this.logger.log(`Sync completed with ${total429} total 429 responses`);
    }

    await this.syncMetaRepo.upsert(
      { key: SYNC_METADATA_KEY_LAST_SYNC, value: syncedAt.toISOString() },
      { conflictPaths: ['key'] },
    );

    return { playlists: playlists.length, videos: totalVideos, incremental };
  }
}
